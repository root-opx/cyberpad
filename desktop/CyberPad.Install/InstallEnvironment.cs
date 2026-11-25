using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

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
            Windows = PathText.NormaliseFolder(windows);
            ProgramFiles = PathText.NormaliseFolder(programFiles);
            ProgramFilesX86 = PathText.NormaliseFolder(programFilesX86);
            Temp = Required(temp, nameof(temp));

            var shared = new List<string> { UserProfile };
            AddIfSet(shared, Desktop);
            AddIfSet(shared, Documents);
            AddIfSet(shared, Downloads);
            SharedFolders = shared;

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

        public string? Windows { get; }

        public string? ProgramFiles { get; }

        public string? ProgramFilesX86 { get; }

        public string Temp { get; }

        /// <summary><c>%LOCALAPPDATA%\Programs\CyberPad</c>.</summary>
        public string DefaultInstallFolder => LocalApplicationData + @"\Programs\" + InstallLayout.SubfolderName;

        /// <summary>The folders that may not be chosen themselves: profile, Desktop, Documents, Downloads.</summary>
        public IReadOnlyList<string> SharedFolders { get; }

        /// <summary>Folders that need administrator rights: Windows and Program Files.</summary>
        public IReadOnlyList<string> AdminFolders { get; }

        /// <summary>Reads the real folders of the signed-in user.</summary>
        public static InstallEnvironment FromSystem()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
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
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    KnownFolders.Downloads() ?? Path.Combine(profile, "Downloads"),
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    string.IsNullOrEmpty(programFiles64) ? programFiles : programFiles64,
                    programFilesX86,
                    Path.GetTempPath());
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
        }
    }
}
