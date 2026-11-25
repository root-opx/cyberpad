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

    /// <summary>
    /// Opens <paramref name="path"/> itself (a link is not followed) for reading without delete sharing,
    /// so nothing can delete it until the handle is disposed.
    /// </summary>
    public SafeFileHandle HoldWithoutDeleteSharing(string path)
    {
        Assert.StartsWith(Root + "\\", path, StringComparison.OrdinalIgnoreCase);
        return Native.OpenWithoutDeleteSharing(path);
    }

    public void Dispose()
    {
        foreach (string junction in _junctions.AsEnumerable().Reverse())
        {
            try { if (Directory.Exists(junction)) Directory.Delete(junction, recursive: false); }
            catch (IOException) { /* best-effort temp cleanup */ }
        }

        // The extended form, so names such as "x." are removed exactly; .NET removes any remaining link
        // as a link without entering it.
        try { Directory.Delete(Extended + Root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    public const string Extended = @"\\?\";

    /// <summary>Every file and folder below the root with a hash of each file, to compare states. Links are listed, never entered.</summary>
    public string Dump()
    {
        var lines = new List<string>();
        Walk(Extended + Root, lines);
        lines.Sort(StringComparer.OrdinalIgnoreCase);
        return string.Join("\n", lines);
    }

    private void Walk(string extendedDir, List<string> lines)
    {
        foreach (var info in new DirectoryInfo(extendedDir).GetFileSystemInfos())
        {
            string path = extendedDir + "\\" + info.Name;
            string rel = path.Substring(Extended.Length + Root.Length + 1);
            bool isLink = (info.Attributes & FileAttributes.ReparsePoint) != 0;
            if (info is DirectoryInfo)
            {
                lines.Add(rel + "\\" + (isLink ? " [link]" : string.Empty));
                if (!isLink) Walk(path, lines);
            }
            else
            {
                lines.Add(rel + " " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))));
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

        public static SafeFileHandle OpenWithoutDeleteSharing(string path)
        {
            // GENERIC_READ (an attribute-only handle would not take part in sharing checks), share read and
            // write but not delete, opening a link itself rather than its target.
            SafeFileHandle handle = CreateFileW(path, 0x80000000, 0x1 | 0x2, IntPtr.Zero, OpenExisting, FlagBackupSemantics | FlagOpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            return handle;
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
    /// <summary>The fake profile below a test root.</summary>
    public static string ProfileOf(string root) => root + @"\Profile";

    /// <summary>The fake %LOCALAPPDATA% below a test root (inside the fake profile, as on a real machine).</summary>
    public static string LocalOf(string root) => root + @"\Profile\AppData\Local";

    public static InstallEnvironment Under(string root, string? notesFolder = null) => new(
        localApplicationData: LocalOf(root),
        notesFolder: notesFolder ?? LocalOf(root) + @"\CyberPad",
        userProfile: ProfileOf(root),
        desktop: ProfileOf(root) + @"\Desktop",
        documents: ProfileOf(root) + @"\Documents",
        downloads: ProfileOf(root) + @"\Downloads",
        startup: ProfileOf(root) + @"\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup",
        windows: root + @"\Windows",
        programFiles: root + @"\Program Files",
        programFilesX86: root + @"\Program Files (x86)",
        temp: LocalOf(root) + @"\Temp");

    public const string TypicalStartup = @"C:\Users\u\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup";

    /// <summary>A typical machine layout, for rules tested against the fake probe.</summary>
    public static InstallEnvironment Typical() => ForProfile(@"C:\Users\u");

    /// <summary>The typical layout for another profile folder name.</summary>
    public static InstallEnvironment ForProfile(string profile) => new(
        localApplicationData: profile + @"\AppData\Local",
        notesFolder: profile + @"\AppData\Local\CyberPad",
        userProfile: profile,
        desktop: profile + @"\Desktop",
        documents: profile + @"\Documents",
        downloads: profile + @"\Downloads",
        startup: profile + @"\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup",
        windows: @"C:\Windows",
        programFiles: @"C:\Program Files",
        programFilesX86: @"C:\Program Files (x86)",
        temp: profile + @"\AppData\Local\Temp");
}

/// <summary>The real probe, with the write check replaceable per test.</summary>
internal sealed class OverridingProbe : IFileSystemProbe
{
    private readonly FileSystemProbe _real = new();

    public Func<string, FileWriteCheck?>? WritableOverride { get; set; }

    public DriveKind GetDriveKind(string root) => _real.GetDriveKind(root);
    public bool DirectoryExists(string path) => _real.DirectoryExists(path);
    public bool FileExists(string path) => _real.FileExists(path);
    public bool IsEmptyDirectory(string path) => _real.IsEmptyDirectory(path);
    public bool IsReparsePoint(string path) => _real.IsReparsePoint(path);
    public bool CanCreateFileIn(string directory) => _real.CanCreateFileIn(directory);
    public FileWriteCheck CheckWritable(string file) => WritableOverride?.Invoke(file) ?? _real.CheckWritable(file);
    public Stream? TryOpenRead(string file) => _real.TryOpenRead(file);
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
    /// <summary>How many times the write test ran (it creates a file on a real disk).</summary>
    public int WriteProbes { get; private set; }

    public bool CanCreateFileIn(string directory)
    {
        WriteProbes++;
        return (_dirs.Contains(directory) || directory.Length == 3) && !ReadOnlyDirs.Contains(directory);
    }

    public FileWriteCheck CheckWritable(string file) =>
        !_files.ContainsKey(file) ? FileWriteCheck.Missing : LockedFiles.Contains(file) ? FileWriteCheck.InUse : FileWriteCheck.Writable;
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
        Assert.True(RegistryKeys.IsDeletable(root));
        if (FailDeletes) throw new UnauthorizedAccessException("injected");
        Keys.Remove(root);
        if (root == RegistryKeyId.OpenWithApplication)
        {
            Keys.Remove(RegistryKeyId.OpenWithCommand);
            Keys.Remove(RegistryKeyId.OpenWithSupportedTypes);
        }
    }

    public void DeleteValue(RegistryKeyId key, string name)
    {
        if (FailDeletes) throw new UnauthorizedAccessException("injected");
        if (Keys.TryGetValue(key, out var values)) values.Remove(name);
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

    /// <summary>Simulates a corrupt .lnk: reading throws, as StartMenuShortcuts does for a COM failure.</summary>
    public bool Unreadable { get; set; }

    /// <summary>When set, TryRead throws this instead (any exception type a shell component might raise).</summary>
    public Exception? ReadThrows { get; set; }

    public ShortcutInfo? TryRead() =>
        ReadThrows != null ? throw ReadThrows : Unreadable ? throw new IOException("injected: corrupt shortcut") : Current;

    public void Create(ShortcutInfo shortcut)
    {
        if (FailNextCreate)
        {
            FailNextCreate = false;
            throw new IOException("injected");
        }

        Current = shortcut;
        Unreadable = false; // saving a new shortcut replaces the corrupt file
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
