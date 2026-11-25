using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace CyberPad.Install
{
    /// <summary>
    /// The folders the rules need. Tests build one pointing into a temp folder; <see cref="FromSystem"/>
    /// reads the real ones. Every folder is stored normalised (full path, no trailing separator).
    /// </summary>
    public sealed class InstallEnvironment
    {
        public InstallEnvironment(
            string localApplicationData,
            string notesFolder,
            string userProfile,
            string? desktop,
            string? documents,
            string? downloads,
            string? startup,
            string? windows,
            string? programFiles,
            string? programFilesX86,
            string temp)
        {
            LocalApplicationData = Required(localApplicationData, nameof(localApplicationData));
            NotesFolder = Required(notesFolder, nameof(notesFolder));
            UserProfile = Required(userProfile, nameof(userProfile));
            Desktop = PathText.NormaliseFolder(desktop);
            Documents = PathText.NormaliseFolder(documents);
            Downloads = PathText.NormaliseFolder(downloads);
            Startup = PathText.NormaliseFolder(startup);
            Windows = PathText.NormaliseFolder(windows);
            ProgramFiles = PathText.NormaliseFolder(programFiles);
            ProgramFilesX86 = PathText.NormaliseFolder(programFilesX86);
            Temp = Required(temp, nameof(temp));

            var shared = new List<string> { UserProfile };
            AddIfSet(shared, Desktop);
            AddIfSet(shared, Documents);
            AddIfSet(shared, Downloads);
            SharedFolders = shared;

            var sharedTrees = new List<string> { Temp };
            AddIfSet(sharedTrees, Startup);
            SharedTrees = sharedTrees;

            var admin = new List<string>();
            AddIfSet(admin, Windows);
            AddIfSet(admin, ProgramFiles);
            AddIfSet(admin, ProgramFilesX86);
            AdminFolders = admin;
        }

        public string LocalApplicationData { get; }

        /// <summary>Where CyberPad keeps notes and settings: <c>%LOCALAPPDATA%\CyberPad</c> on a real system.</summary>
        public string NotesFolder { get; }

        public string UserProfile { get; }

        public string? Desktop { get; }

        public string? Documents { get; }

        public string? Downloads { get; }

        /// <summary>The user's Startup folder (programs placed there run at sign-in).</summary>
        public string? Startup { get; }

        public string? Windows { get; }

        public string? ProgramFiles { get; }

        public string? ProgramFilesX86 { get; }

        public string Temp { get; }

        /// <summary><c>%LOCALAPPDATA%\Programs\CyberPad</c>.</summary>
        public string DefaultInstallFolder => LocalApplicationData + @"\Programs\" + InstallLayout.SubfolderName;

        /// <summary>The folders that may not be chosen themselves: profile, Desktop, Documents, Downloads.</summary>
        public IReadOnlyList<string> SharedFolders { get; }

        /// <summary>Folders that may not be chosen, nor anything inside them: temp and Startup.</summary>
        public IReadOnlyList<string> SharedTrees { get; }

        /// <summary>Folders that need administrator rights: Windows and Program Files.</summary>
        public IReadOnlyList<string> AdminFolders { get; }

        /// <summary>Reads the real folders of the signed-in user, with any 8.3 short names expanded.</summary>
        public static InstallEnvironment FromSystem()
        {
            string local = Long(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
            string profile = Long(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            if (PathText.NormaliseFolder(local) == null || PathText.NormaliseFolder(profile) == null)
            {
                throw new InstallException(InstallMessages.NoUserFolders);
            }

            // A 32-bit process sees Program Files (x86) as "ProgramFiles"; ProgramW6432 names the 64-bit one.
            string? programFiles64 = Environment.GetEnvironmentVariable("ProgramW6432");
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

            try
            {
                return new InstallEnvironment(
                    local,
                    Path.Combine(local, InstallLayout.NotesFolderName),
                    profile,
                    Long(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)),
                    Long(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)),
                    Long(KnownFolders.Downloads() ?? Path.Combine(profile, "Downloads")),
                    Long(Environment.GetFolderPath(Environment.SpecialFolder.Startup)),
                    Long(Environment.GetFolderPath(Environment.SpecialFolder.Windows)),
                    Long(string.IsNullOrEmpty(programFiles64) ? programFiles : programFiles64!),
                    Long(programFilesX86),
                    Long(Path.GetTempPath())); // %TEMP% is often written with 8.3 names, e.g. C:\Users\JOHNSM~1\...
            }
            catch (ArgumentException ex)
            {
                throw new InstallException(InstallMessages.NoUserFolders, ex);
            }
        }

        private static string Required(string value, string name) =>
            PathText.NormaliseFolder(value) ?? throw new ArgumentException("A full local folder path is required.", name);

        private static void AddIfSet(List<string> list, string? folder)
        {
            if (folder != null)
            {
                list.Add(folder);
            }
        }

        /// <summary>The long form of an existing folder (so the rules compare like with like), or the input unchanged.</summary>
        private static string Long(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return path;
            }

            var buffer = new StringBuilder(1024);
            uint length = KnownFolders.GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
            return length == 0 || length >= buffer.Capacity ? path : buffer.ToString();
        }

        private static class KnownFolders
        {
            private static readonly Guid DownloadsId = new Guid("374DE290-123F-4565-9164-39C4925E467B");

            public static string? Downloads()
            {
                IntPtr buffer = IntPtr.Zero;
                try
                {
                    int hr = SHGetKnownFolderPath(DownloadsId, 0, IntPtr.Zero, out buffer);
                    return hr == 0 ? Marshal.PtrToStringUni(buffer) : null;
                }
                finally
                {
                    if (buffer != IntPtr.Zero)
                    {
                        Marshal.FreeCoTaskMem(buffer);
                    }
                }
            }

            [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
            private static extern int SHGetKnownFolderPath(
                [MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
            public static extern uint GetLongPathNameW(string lpszShortPath, StringBuilder lpszLongPath, uint cchBuffer);
        }
    }
}
