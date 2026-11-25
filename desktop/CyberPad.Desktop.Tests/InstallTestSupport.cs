using System.ComponentModel;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using CyberPad.Install;
using Microsoft.Win32.SafeHandles;

namespace CyberPad.Desktop.Tests;

/// <summary>
/// The install tests do a lot of file I/O; they run on their own, after the parallel tests, so they
/// cannot starve the timing-sensitive tests elsewhere in this project.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class InstallTestCollection
{
    public const string Name = "Install";
}

/// <summary>
/// A unique folder under the temp folder, with its 8.3 parts expanded (the install rules refuse short
/// names). Junctions made in it are removed as links before the folder is deleted.
/// </summary>
internal sealed class InstallTempDir : IDisposable
{
    private readonly List<string> _junctions = new();

    public InstallTempDir()
    {
        string temp = LongPath(Path.GetTempPath());
        Root = Path.Combine(temp, "cyberpad-install-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
    }

    public string Root { get; }

    public string Path_(params string[] parts) => Path.Combine(new[] { Root }.Concat(parts).ToArray());

    /// <summary>Makes <paramref name="link"/> a directory junction to <paramref name="target"/>; both inside <see cref="Root"/>. No admin rights needed.</summary>
    public void CreateJunction(string link, string target)
    {
        Assert.StartsWith(Root + "\\", link, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith(Root + "\\", target, StringComparison.OrdinalIgnoreCase);
        Directory.CreateDirectory(link);
        _junctions.Add(link);
        Native.MakeJunction(link, target);
        Assert.True((File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0);
    }

    public void Dispose()
    {
        foreach (string junction in _junctions.AsEnumerable().Reverse())
        {
            try { if (Directory.Exists(junction)) Directory.Delete(junction, recursive: false); }
            catch (IOException) { /* best-effort temp cleanup */ }
        }

        try { Directory.Delete(Root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    /// <summary>Every file and folder below the root with a hash of each file, to compare states.</summary>
    public string Dump()
    {
        var lines = new List<string>();
        Walk(Root, lines);
        lines.Sort(StringComparer.OrdinalIgnoreCase);
        return string.Join("\n", lines);
    }

    private void Walk(string dir, List<string> lines)
    {
        foreach (var info in new DirectoryInfo(dir).GetFileSystemInfos())
        {
            string rel = info.FullName.Substring(Root.Length + 1);
            bool isLink = (info.Attributes & FileAttributes.ReparsePoint) != 0;
            if (info is DirectoryInfo)
            {
                lines.Add(rel + "\\" + (isLink ? " [link]" : string.Empty));
                if (!isLink) Walk(info.FullName, lines);
            }
            else
            {
                lines.Add(rel + " " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(info.FullName))));
            }
        }
    }

    private static string LongPath(string path)
    {
        var buffer = new StringBuilder(1024);
        uint length = Native.GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
        if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        return buffer.ToString().TrimEnd('\\');
    }

    private static class Native
    {
        private const uint GenericWrite = 0x40000000;
        private const uint OpenExisting = 3;
        private const uint FlagBackupSemantics = 0x02000000;
        private const uint FlagOpenReparsePoint = 0x00200000;
        private const uint FsctlSetReparsePoint = 0x000900A4;
        private const uint ReparseTagMountPoint = 0xA0000003;

        public static void MakeJunction(string link, string target)
        {
            string substitute = @"\??\" + target;
            byte[] sub = Encoding.Unicode.GetBytes(substitute);
            byte[] print = Encoding.Unicode.GetBytes(target);
            int pathBytes = sub.Length + 2 + print.Length + 2;
            var data = new byte[8 + 8 + pathBytes];
            BitConverter.GetBytes(ReparseTagMountPoint).CopyTo(data, 0);
            BitConverter.GetBytes((ushort)(8 + pathBytes)).CopyTo(data, 4);
            BitConverter.GetBytes((ushort)0).CopyTo(data, 8);
            BitConverter.GetBytes((ushort)sub.Length).CopyTo(data, 10);
            BitConverter.GetBytes((ushort)(sub.Length + 2)).CopyTo(data, 12);
            BitConverter.GetBytes((ushort)print.Length).CopyTo(data, 14);
            sub.CopyTo(data, 16);
            print.CopyTo(data, 16 + sub.Length + 2);

            using SafeFileHandle handle = CreateFileW(link, GenericWrite, 0, IntPtr.Zero, OpenExisting, FlagBackupSemantics | FlagOpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!DeviceIoControl(handle, FsctlSetReparsePoint, data, (uint)data.Length, IntPtr.Zero, 0, out _, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        public static extern uint GetLongPathNameW(string lpszShortPath, StringBuilder lpszLongPath, uint cchBuffer);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[] inBuffer, uint inSize, IntPtr outBuffer, uint outSize, out uint returned, IntPtr overlapped);
    }
}

/// <summary>Builds zip payloads in memory.</summary>
internal static class TestZips
{
    public static MemoryStream Build(params (string Name, string Content)[] entries) =>
        BuildBytes(entries.Select(e => (e.Name, Encoding.UTF8.GetBytes(e.Content))).ToArray());

    public static MemoryStream BuildBytes(params (string Name, byte[] Content)[] entries)
    {
        var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                ZipArchiveEntry entry = zip.CreateEntry(name);
                if (name.EndsWith('/')) continue;
                using Stream s = entry.Open();
                s.Write(content);
            }
        }

        ms.Position = 0;
        return ms;
    }
}

/// <summary>An <see cref="InstallEnvironment"/> whose folders are all below a test root.</summary>
internal static class TestEnvironments
{
    public static InstallEnvironment Under(string root, string? notesFolder = null) => new(
        localApplicationData: root + @"\Local",
        notesFolder: notesFolder ?? root + @"\Local\CyberPad",
        userProfile: root + @"\Profile",
        desktop: root + @"\Profile\Desktop",
        documents: root + @"\Profile\Documents",
        downloads: root + @"\Profile\Downloads",
        windows: root + @"\Windows",
        programFiles: root + @"\Program Files",
        programFilesX86: root + @"\Program Files (x86)",
        temp: root + @"\Temp");

    /// <summary>A typical machine layout, for rules tested against the fake probe.</summary>
    public static InstallEnvironment Typical() => new(
        localApplicationData: @"C:\Users\u\AppData\Local",
        notesFolder: @"C:\Users\u\AppData\Local\CyberPad",
        userProfile: @"C:\Users\u",
        desktop: @"C:\Users\u\Desktop",
        documents: @"C:\Users\u\Documents",
        downloads: @"C:\Users\u\Downloads",
        windows: @"C:\Windows",
        programFiles: @"C:\Program Files",
        programFilesX86: @"C:\Program Files (x86)",
        temp: @"C:\Users\u\AppData\Local\Temp");
}

/// <summary>An in-memory file system for the folder rules.</summary>
internal sealed class FakeProbe : IFileSystemProbe
{
    private readonly HashSet<string> _dirs = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, byte[]> _files = new(StringComparer.OrdinalIgnoreCase);

    public Dictionary<string, DriveKind> Drives { get; } = new(StringComparer.OrdinalIgnoreCase) { [@"C:\"] = DriveKind.Fixed };
    public HashSet<string> ReparsePoints { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> ReadOnlyDirs { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> LockedFiles { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Adds a folder and its parents.</summary>
    public FakeProbe Dir(string path)
    {
        for (string? p = path; p != null && p.Length > 3; p = Path.GetDirectoryName(p)) _dirs.Add(p);
        return this;
    }

    public FakeProbe File(string path, string content = "x")
    {
        Dir(Path.GetDirectoryName(path)!);
        _files[path] = Encoding.UTF8.GetBytes(content);
        return this;
    }

    public FakeProbe Install(string dir, string version = "1.0.0") =>
        File(dir + @"\" + InstallManifest.FileName, $"CyberPad-Install 1\nversion={version}\nCyberPad.exe\n").File(dir + @"\CyberPad.exe");

    public DriveKind GetDriveKind(string root) => Drives.TryGetValue(root, out var kind) ? kind : DriveKind.NoRootDirectory;
    public bool DirectoryExists(string path) => _dirs.Contains(path);
    public bool FileExists(string path) => _files.ContainsKey(path);
    public bool IsEmptyDirectory(string path) =>
        _dirs.Contains(path) && !_dirs.Concat(_files.Keys).Any(p => p.StartsWith(path + @"\", StringComparison.OrdinalIgnoreCase));
    public bool IsReparsePoint(string path) => ReparsePoints.Contains(path);
    public bool CanCreateFileIn(string directory) => _dirs.Contains(directory) || directory.Length == 3 ? !ReadOnlyDirs.Contains(directory) : false;
    public bool CanOpenForWriting(string file) => _files.ContainsKey(file) && !LockedFiles.Contains(file);
    public Stream? TryOpenRead(string file) => _files.TryGetValue(file, out var bytes) ? new MemoryStream(bytes, writable: false) : null;
}

internal sealed class FakeRegistry : IRegistry
{
    public Dictionary<RegistryKeyId, SortedDictionary<string, object>> Keys { get; } = new();

    /// <summary>Makes the next write of this value throw <see cref="IOException"/> once.</summary>
    public (RegistryKeyId Key, string Name)? FailOnceOn { get; set; }

    public bool FailDeletes { get; set; }

    public bool KeyExists(RegistryKeyId key) => Keys.ContainsKey(key);

    public IReadOnlyList<string> GetValueNames(RegistryKeyId key) =>
        Keys.TryGetValue(key, out var values) ? values.Keys.ToList() : new List<string>();

    public object? GetValue(RegistryKeyId key, string name) =>
        Keys.TryGetValue(key, out var values) && values.TryGetValue(name, out var v) ? v : null;

    public void CreateKey(RegistryKeyId key)
    {
        if (key is RegistryKeyId.OpenWithCommand or RegistryKeyId.OpenWithSupportedTypes) CreateKey(RegistryKeyId.OpenWithApplication);
        if (!Keys.ContainsKey(key)) Keys[key] = new SortedDictionary<string, object>(StringComparer.OrdinalIgnoreCase);
    }

    public void SetString(RegistryKeyId key, string name, string value) => Set(key, name, value);

    public void SetDword(RegistryKeyId key, string name, int value) => Set(key, name, value);

    public void DeleteTree(RegistryKeyId root)
    {
        Assert.True(RegistryKeys.IsRoot(root));
        if (FailDeletes) throw new UnauthorizedAccessException("injected");
        Keys.Remove(root);
        if (root == RegistryKeyId.OpenWithApplication)
        {
            Keys.Remove(RegistryKeyId.OpenWithCommand);
            Keys.Remove(RegistryKeyId.OpenWithSupportedTypes);
        }
    }

    public string Dump() => string.Join("\n", Keys.OrderBy(k => k.Key)
        .SelectMany(k => new[] { k.Key + ":" }.Concat(k.Value.Select(v => $"  {v.Key}={v.Value} ({v.Value.GetType().Name})"))));

    private void Set(RegistryKeyId key, string name, object value)
    {
        if (FailOnceOn is { } fail && fail.Key == key && fail.Name == name)
        {
            FailOnceOn = null;
            throw new IOException("injected");
        }

        CreateKey(key);
        Keys[key][name] = value;
    }
}

internal sealed class FakeShortcuts : IShortcuts
{
    public ShortcutInfo? Current { get; set; }
    public bool FailNextCreate { get; set; }

    public ShortcutInfo? TryRead() => Current;

    public void Create(ShortcutInfo shortcut)
    {
        if (FailNextCreate)
        {
            FailNextCreate = false;
            throw new IOException("injected");
        }

        Current = shortcut;
    }

    public void Delete() => Current = null;

    public string Dump() => Current == null ? "(none)" : $"{Current.TargetPath}|{Current.WorkingDirectory}|{Current.IconPath}";
}

internal sealed class FakeNotify : IShellNotify
{
    public int Calls { get; private set; }
    public bool FailNext { get; set; }

    public void AssociationsChanged()
    {
        if (FailNext)
        {
            FailNext = false;
            throw new IOException("injected");
        }

        Calls++;
    }
}

/// <summary>Records progress synchronously.</summary>
internal sealed class ListProgress : IProgress<int>
{
    public List<int> Values { get; } = new();
    public void Report(int value) => Values.Add(value);
}
