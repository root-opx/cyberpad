using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;

namespace CyberPad.Install
{
    public sealed class UninstallResult
    {
        internal UninstallResult(string installDir, IReadOnlyList<string> notDeleted, bool filesLeftInPlace, bool associationsNotRefreshed)
        {
            InstallDir = installDir;
            NotDeleted = notDeleted;
            FilesLeftInPlace = filesLeftInPlace;
            AssociationsNotRefreshed = associationsNotRefreshed;
        }

        /// <summary>The install folder (empty when the entry named no usable folder).</summary>
        public string InstallDir { get; }

        /// <summary>Files, folders, the shortcut and registry keys that should have been removed but could not be.</summary>
        public IReadOnlyList<string> NotDeleted { get; }

        /// <summary>
        /// True when the install's file list was missing or invalid: only the entry and the shortcut were
        /// removed and no file was deleted.
        /// </summary>
        public bool FilesLeftInPlace { get; }

        /// <summary>True when Explorer could not be told that the "Open with" entry is gone (harmless; it notices later).</summary>
        public bool AssociationsNotRefreshed { get; }

        public string Message
        {
            get
            {
                if (FilesLeftInPlace)
                {
                    return InstallMessages.EntryRemovedFilesLeft(InstallDir.Length > 0 ? InstallDir : "the install folder");
                }

                return NotDeleted.Count == 0 ? InstallMessages.Removed : InstallMessages.RemovedWithLeftoversPrefix + InstallDir;
            }
        }
    }

    public sealed class NotesDeletionResult
    {
        internal NotesDeletionResult(string notesFolder, IReadOnlyList<string> notDeleted)
        {
            NotesFolder = notesFolder;
            NotDeleted = notDeleted;
        }

        public string NotesFolder { get; }

        public IReadOnlyList<string> NotDeleted { get; }
    }

    /// <summary>Removes what setup added, and nothing else (spec, "Uninstalling").</summary>
    public sealed class Uninstaller
    {
        public const int MaxNotesDepth = 64;
        public const int MaxNotesEntries = 200000;

        private const string ExtendedPrefix = @"\\?\";

        private readonly IRegistry _registry;
        private readonly IShortcuts _shortcuts;
        private readonly IShellNotify _notify;
        private readonly IFileSystemProbe _probe;
        private readonly InstallEnvironment _env;

        public Uninstaller(IRegistry registry, IShortcuts shortcuts, IShellNotify notify, IFileSystemProbe probe, InstallEnvironment env)
        {
            _registry = registry ?? throw new ArgumentNullException(nameof(registry));
            _shortcuts = shortcuts ?? throw new ArgumentNullException(nameof(shortcuts));
            _notify = notify ?? throw new ArgumentNullException(nameof(notify));
            _probe = probe ?? throw new ArgumentNullException(nameof(probe));
            _env = env ?? throw new ArgumentNullException(nameof(env));
        }

        /// <summary>Caps for the notes-folder walk; tests lower them.</summary>
        internal int NotesDepthLimit { get; set; } = MaxNotesDepth;

        internal int NotesEntryLimit { get; set; } = MaxNotesEntries;

        /// <summary>
        /// Uninstalls the install named by the uninstall entry. Deletes exactly the manifest's files, the
        /// manifest and <c>Uninstall.exe</c>, folders left empty, the shortcut and the two registry keys.
        /// When the entry exists but its folder or file list is not valid, no file is deleted: only the
        /// entry and the shortcut are removed.
        /// </summary>
        public UninstallResult Uninstall()
        {
            if (!Installer.HasUninstallEntry(_registry))
            {
                throw new InstallException(InstallMessages.NotInstalled);
            }

            ExistingInstall? existing = Installer.FindExisting(_registry, _probe, _env);
            if (existing == null)
            {
                return RemoveEntryOnly();
            }

            string dir = existing.InstallDir;
            string exe = dir + "\\" + InstallLayout.AppFileName;
            bool appListed = existing.Manifest.Files.Any(f => PathText.AreSame(f, InstallLayout.AppFileName));
            Installer.CheckAppReplaceable(_probe, exe, appListed, InstallMessages.CloseToUninstall, InstallMessages.CannotDeleteApp);

            var notDeleted = new List<string>();
            var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var remaining = new List<string>();
            foreach (string file in existing.Manifest.Files)
            {
                if (!DeleteListedFile(dir, file, notDeleted, folders))
                {
                    remaining.Add(file);
                }
            }

            if (remaining.Count == 0)
            {
                DeleteListedFile(dir, InstallManifest.FileName, notDeleted, folders);
            }
            else
            {
                // Keep a manifest that lists exactly what is left, so a later setup or uninstall still knows
                // which of the remaining files are CyberPad's.
                RewriteManifest(dir, new InstallManifest(existing.Version, remaining), notDeleted);
            }

            DeleteListedFile(dir, InstallLayout.UninstallerFileName, notDeleted, folders);

            foreach (string folder in folders.OrderByDescending(f => f.Length))
            {
                RemoveIfEmpty(folder, notDeleted);
            }

            RemoveEmptyBackupFolders(dir, notDeleted);
            RemoveIfEmpty(dir, notDeleted);

            RemoveShortcutIfOurs(exe, notDeleted);
            DeleteRegistryKeys(notDeleted);
            bool notified = TryNotify();
            return new UninstallResult(dir, notDeleted, filesLeftInPlace: false, associationsNotRefreshed: !notified);
        }

        /// <summary>
        /// Deletes the notes and settings folder. Call only after the user's second confirmation. The path
        /// comes from <see cref="InstallEnvironment"/> and must be exactly
        /// <c>&lt;LocalApplicationData&gt;\CyberPad</c>; no part of it may be a link. Inside it, every path is
        /// used in its extended form (<c>\\?\</c>) so no name is altered by Windows path normalisation;
        /// links are deleted as links and never entered; names that normalisation would change (a trailing
        /// dot or space, a device name, an 8.3 alias) are left alone and reported.
        /// </summary>
        public NotesDeletionResult DeleteNotesFolder()
        {
            string expected = _env.LocalApplicationData + "\\" + InstallLayout.NotesFolderName;
            string notes = _env.NotesFolder;
            if (!string.Equals(notes, expected, StringComparison.Ordinal))
            {
                throw new InstallException(InstallMessages.NotesFolderRefused);
            }

            foreach (string prefix in PathText.PrefixesBelowDrive(notes))
            {
                if (_probe.IsReparsePoint(prefix))
                {
                    throw new InstallException(InstallMessages.NotesFolderRefused);
                }
            }

            var notDeleted = new List<string>();
            if (!_probe.DirectoryExists(notes))
            {
                return new NotesDeletionResult(notes, notDeleted);
            }

            DeleteDirectoryTree(ExtendedPrefix + notes, 0, notDeleted, new Budget(NotesEntryLimit));
            return new NotesDeletionResult(notes, notDeleted);
        }

        // ---- the install folder ------------------------------------------------------------------------

        private UninstallResult RemoveEntryOnly()
        {
            object? location;
            try
            {
                location = _registry.GetValue(RegistryKeyId.UninstallEntry, "InstallLocation");
            }
            catch (IOException)
            {
                location = null;
            }
            catch (UnauthorizedAccessException)
            {
                location = null;
            }
            catch (SecurityException)
            {
                location = null;
            }

            string? folder = location is string text ? PathText.NormaliseFolder(text) : null;
            var notDeleted = new List<string>();
            if (folder != null)
            {
                RemoveShortcutIfOurs(folder + "\\" + InstallLayout.AppFileName, notDeleted);
            }

            DeleteRegistryKeys(notDeleted);
            bool notified = TryNotify();
            return new UninstallResult(folder ?? string.Empty, notDeleted, filesLeftInPlace: true, associationsNotRefreshed: !notified);
        }

        /// <summary>Deletes one listed file. Returns false when it is still there afterwards.</summary>
        private bool DeleteListedFile(string dir, string relative, List<string> notDeleted, HashSet<string> folders)
        {
            string? normalised = RelativePath.Normalise(relative);
            if (normalised == null)
            {
                return true; // the manifest was validated; this cannot happen
            }

            string full;
            try
            {
                full = Path.GetFullPath(Path.Combine(dir, normalised));
            }
            catch (ArgumentException)
            {
                return true;
            }
            catch (NotSupportedException)
            {
                return true;
            }
            catch (PathTooLongException)
            {
                notDeleted.Add(dir + "\\" + normalised);
                return false;
            }

            if (!PathText.IsStrictlyInside(full, dir))
            {
                return true;
            }

            // Every folder between the install folder and the file must be a real folder, not a link.
            for (string? parent = PathText.Parent(full); parent != null && PathText.IsStrictlyInside(parent, dir); parent = PathText.Parent(parent))
            {
                if (_probe.IsReparsePoint(parent))
                {
                    notDeleted.Add(full);
                    return false;
                }

                folders.Add(parent);
            }

            if (!_probe.FileExists(full))
            {
                if (_probe.DirectoryExists(full))
                {
                    notDeleted.Add(full);
                    return false;
                }

                return true;
            }

            if (_probe.IsReparsePoint(full))
            {
                notDeleted.Add(full);
                return false;
            }

            Installer.ClearReadOnly(full); // a file setup wrote, inside the validated folder
            return TryDelete(() => File.Delete(full), full, notDeleted);
        }

        private static void RewriteManifest(string dir, InstallManifest manifest, List<string> notDeleted)
        {
            string path = dir + "\\" + InstallManifest.FileName;
            string temp = dir + "\\" + InstallManifest.FileName + "." + Guid.NewGuid().ToString("N") + ".tmp";
            bool written = TryDelete(
                () =>
                {
                    // CreateNew on a fresh random name, then swap: the old manifest is deleted as a name
                    // (never written through), so a link or hard link in its place cannot redirect the write.
                    using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        manifest.Write(stream);
                    }

                    File.Delete(path);
                    File.Move(temp, path);
                },
                path,
                notDeleted);
            if (!written)
            {
                TryDelete(() => File.Delete(temp), temp, new List<string>());
            }
        }

        private void RemoveIfEmpty(string folder, List<string> notDeleted)
        {
            if (_probe.DirectoryExists(folder) && !_probe.IsReparsePoint(folder) && _probe.IsEmptyDirectory(folder))
            {
                TryDelete(() => Directory.Delete(folder, false), folder, notDeleted);
            }
        }

        /// <summary>Removes empty backup folders an interrupted setup left behind (never their contents).</summary>
        private void RemoveEmptyBackupFolders(string dir, List<string> notDeleted)
        {
            string[] candidates;
            try
            {
                candidates = Directory.GetDirectories(dir, FileJournal.BackupFolderPrefix + "*", SearchOption.TopDirectoryOnly);
            }
            catch (IOException)
            {
                return;
            }
            catch (UnauthorizedAccessException)
            {
                return;
            }

            foreach (string candidate in candidates.Take(100))
            {
                string name = Path.GetFileName(candidate);
                if (name.Length == FileJournal.BackupFolderPrefix.Length + 32 && PathText.IsValidSegment(name))
                {
                    RemoveIfEmpty(dir + "\\" + name, notDeleted);
                }
            }
        }

        private void RemoveShortcutIfOurs(string exe, List<string> notDeleted)
        {
            const string label = "Start menu shortcut " + InstallLayout.DisplayName + ".lnk";
            ShortcutInfo? shortcut;
            try
            {
                shortcut = _shortcuts.TryRead();
            }
            catch (IOException)
            {
                notDeleted.Add(label); // unreadable: left alone, since it cannot be shown to be ours
                return;
            }
            catch (UnauthorizedAccessException)
            {
                notDeleted.Add(label);
                return;
            }

            if (shortcut != null && PathText.AreSame(shortcut.TargetPath, exe))
            {
                TryDelete(_shortcuts.Delete, label, notDeleted);
            }
        }

        private void DeleteRegistryKeys(List<string> notDeleted)
        {
            foreach (RegistryKeyId root in RegistryKeys.Roots)
            {
                TryDelete(() => _registry.DeleteTree(root), @"HKEY_CURRENT_USER\" + RegistryKeys.PathOf(root), notDeleted);
            }
        }

        private bool TryNotify()
        {
            try
            {
                _notify.AssociationsChanged();
                return true;
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException ||
                                       ex is ExternalException || ex is TypeLoadException)
            {
                return false; // reported through UninstallResult.AssociationsNotRefreshed
            }
        }

        // ---- the notes folder --------------------------------------------------------------------------

        /// <summary>
        /// Deletes the contents of <paramref name="extendedDir"/> (a <c>\\?\</c> path) and then the folder
        /// itself. Its attributes are read again right before it is entered, and a link is never entered.
        /// </summary>
        private void DeleteDirectoryTree(string extendedDir, int depth, List<string> notDeleted, Budget budget)
        {
            FileAttributes? attributes = ReadAttributes(extendedDir);
            if (depth > NotesDepthLimit || attributes == null ||
                (attributes.Value & FileAttributes.ReparsePoint) != 0 || (attributes.Value & FileAttributes.Directory) == 0)
            {
                notDeleted.Add(Display(extendedDir));
                return;
            }

            var names = new List<string>();
            try
            {
                foreach (FileSystemInfo info in new DirectoryInfo(extendedDir).EnumerateFileSystemInfos())
                {
                    if (!budget.Take())
                    {
                        notDeleted.Add(Display(extendedDir));
                        return;
                    }

                    names.Add(info.Name);
                }
            }
            catch (IOException)
            {
                notDeleted.Add(Display(extendedDir));
                return;
            }
            catch (UnauthorizedAccessException)
            {
                notDeleted.Add(Display(extendedDir));
                return;
            }
            catch (SecurityException)
            {
                notDeleted.Add(Display(extendedDir));
                return;
            }

            foreach (string name in names)
            {
                string child = extendedDir + "\\" + name;

                // A name Windows would normalise (trailing dot or space, device name, 8.3 alias) could name a
                // different entry than the one enumerated; it is never touched.
                if (!PathText.IsValidSegment(name))
                {
                    notDeleted.Add(Display(child));
                    continue;
                }

                FileAttributes? childAttributes = ReadAttributes(child);
                if (childAttributes == null)
                {
                    notDeleted.Add(Display(child));
                    continue;
                }

                bool isDirectory = (childAttributes.Value & FileAttributes.Directory) != 0;
                if ((childAttributes.Value & FileAttributes.ReparsePoint) != 0)
                {
                    // Delete the link itself; without recursion this never touches its target.
                    TryDelete(() => DeleteEntry(child, isDirectory), Display(child), notDeleted);
                }
                else if (isDirectory)
                {
                    DeleteDirectoryTree(child, depth + 1, notDeleted, budget);
                }
                else
                {
                    TryDelete(
                        () =>
                        {
                            if ((childAttributes.Value & FileAttributes.ReadOnly) != 0)
                            {
                                File.SetAttributes(child, childAttributes.Value & ~FileAttributes.ReadOnly);
                            }

                            File.Delete(child);
                        },
                        Display(child),
                        notDeleted);
                }
            }

            TryDelete(() => Directory.Delete(extendedDir, false), Display(extendedDir), notDeleted);
        }

        private static void DeleteEntry(string extendedPath, bool isDirectory)
        {
            if (isDirectory)
            {
                Directory.Delete(extendedPath, false);
            }
            else
            {
                File.Delete(extendedPath);
            }
        }

        private static FileAttributes? ReadAttributes(string path)
        {
            try
            {
                return File.GetAttributes(path);
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
            catch (SecurityException)
            {
                return null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        private static string Display(string extendedPath) =>
            extendedPath.StartsWith(ExtendedPrefix, StringComparison.Ordinal) ? extendedPath.Substring(ExtendedPrefix.Length) : extendedPath;

        private static bool TryDelete(Action delete, string path, List<string> notDeleted)
        {
            try
            {
                delete();
                return true;
            }
            catch (IOException)
            {
                notDeleted.Add(path);
            }
            catch (UnauthorizedAccessException)
            {
                notDeleted.Add(path);
            }
            catch (SecurityException)
            {
                notDeleted.Add(path);
            }

            return false;
        }

        private sealed class Budget
        {
            private int _left;

            public Budget(int left)
            {
                _left = left;
            }

            public bool Take() => _left-- > 0;
        }
    }
}
