using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;

namespace CyberPad.Install
{
    /// <summary>Why uninstall removed only the entry and deleted no file.</summary>
    public enum EntryOnlyReason
    {
        /// <summary>A full uninstall: files were deleted.</summary>
        None,

        /// <summary>The folder passes the rules, but its file list is missing or damaged.</summary>
        FileListMissing,

        /// <summary>The folder is unknown, gone, or refused by the folder rules.</summary>
        FolderNotChecked,
    }

    public sealed class UninstallResult
    {
        internal UninstallResult(
            string installDir,
            IReadOnlyList<string> notDeleted,
            EntryOnlyReason entryOnly,
            bool shortcutRemoved,
            bool installFolderRemains,
            bool associationsNotRefreshed)
        {
            InstallDir = installDir;
            NotDeleted = notDeleted;
            EntryOnly = entryOnly;
            ShortcutRemoved = shortcutRemoved;
            InstallFolderRemains = installFolderRemains;
            AssociationsNotRefreshed = associationsNotRefreshed;
        }

        /// <summary>The install folder (empty when the entry named no usable folder).</summary>
        public string InstallDir { get; }

        /// <summary>Files, folders, the shortcut and registry keys that should have been removed but could not be.</summary>
        public IReadOnlyList<string> NotDeleted { get; }

        /// <summary>Not <see cref="EntryOnlyReason.None"/> when no file was deleted: only the entry (and our shortcut) went.</summary>
        public EntryOnlyReason EntryOnly { get; }

        /// <summary>True when the install's file list was missing or the folder could not be checked.</summary>
        public bool FilesLeftInPlace => EntryOnly != EntryOnlyReason.None;

        /// <summary>True when the Start menu shortcut was deleted.</summary>
        public bool ShortcutRemoved { get; }

        /// <summary>True when the install folder still exists afterwards.</summary>
        public bool InstallFolderRemains { get; }

        /// <summary>True when Explorer could not be told that the "Open with" entry is gone (harmless; it notices later).</summary>
        public bool AssociationsNotRefreshed { get; }

        public string Message
        {
            get
            {
                switch (EntryOnly)
                {
                    case EntryOnlyReason.FileListMissing:
                        return InstallMessages.FileListMissing(InstallDir) + (ShortcutRemoved ? InstallMessages.ShortcutRemovedToo : string.Empty);
                    case EntryOnlyReason.FolderNotChecked:
                        return InstallMessages.FolderNotChecked + (ShortcutRemoved ? InstallMessages.ShortcutRemovedToo : string.Empty);
                }

                if (NotDeleted.Count == 0)
                {
                    return InstallMessages.Removed;
                }

                return InstallFolderRemains ? InstallMessages.RemovedWithLeftoversPrefix + InstallDir : InstallMessages.RemovedButShortcutOrEntryLeft;
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
        private const string ShortcutLabel = "Start menu shortcut " + InstallLayout.DisplayName + ".lnk";
        private const int BackupHexDigits = 32;
        private const int MaxBackupFolders = 100;
        private const int MaxBackupFiles = 10000;

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
        /// manifest and <c>Uninstall.exe</c>, setup's own backup leftovers, folders left empty, the shortcut and
        /// the registry keys (an "Open with" entry that existed before setup is put back instead). When the
        /// entry exists but its folder or file list is not valid, no file is deleted: only the entry and the
        /// shortcut are removed.
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

            List<string> backupLeftovers = RemoveBackupFolders(dir, notDeleted);
            RemoveIfEmpty(dir, notDeleted);
            ReportSetupLeftovers(dir, backupLeftovers, notDeleted);

            bool shortcutRemoved = RemoveShortcutIfOurs(exe, notDeleted);
            DeleteRegistryKeys(OpenCommandOf(dir), notDeleted);
            bool notified = TryNotify();
            return new UninstallResult(dir, notDeleted, EntryOnlyReason.None, shortcutRemoved, _probe.DirectoryExists(dir), !notified);
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
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException)
            {
                location = null;
            }

            string? folder = location is string text ? PathText.NormaliseFolder(text) : null;

            // The folder passes the rules (it exists, is not refused, and holds no valid install): only its file
            // list is missing or damaged. Anything else means the folder itself could not be checked.
            EntryOnlyReason reason = EntryOnlyReason.FolderNotChecked;
            if (folder != null && _probe.DirectoryExists(folder))
            {
                // A refusal that names the CyberPad subfolder still means the folder itself passed the rules.
                InstallPathResult result = InstallPathPolicy.Evaluate(folder, _probe, _env, probeWrite: false);
                bool folderPassed = result.IsUsable
                    ? result.Kind != InstallPathKind.WillCreate
                    : result.FullPath != null && PathText.IsStrictlyInside(result.FullPath, folder);
                if (folderPassed)
                {
                    reason = EntryOnlyReason.FileListMissing;
                }
            }

            var notDeleted = new List<string>();
            bool shortcutRemoved = folder != null && RemoveShortcutIfOurs(folder + "\\" + InstallLayout.AppFileName, notDeleted);
            DeleteRegistryKeys(folder == null ? null : OpenCommandOf(folder), notDeleted);
            bool notified = TryNotify();
            return new UninstallResult(
                folder ?? string.Empty, notDeleted, reason, shortcutRemoved, folder != null && _probe.DirectoryExists(folder), !notified);
        }

        /// <summary>The open command setup registered for <paramref name="dir"/>, or null if it cannot be built.</summary>
        private static string? OpenCommandOf(string dir)
        {
            try
            {
                return CommandLine.OpenCommand(dir);
            }
            catch (ArgumentException)
            {
                return null;
            }
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

        /// <summary>
        /// Writes the shorter manifest to a new file with a random name, then swaps it in with
        /// <see cref="File.Replace(string, string, string)"/>. The old manifest is replaced as a name (never
        /// written through), and at no point is there no manifest: if the swap fails, the old one stays, or
        /// the new one is kept under its temporary name.
        /// </summary>
        private static void RewriteManifest(string dir, InstallManifest manifest, List<string> notDeleted)
        {
            string path = dir + "\\" + InstallManifest.FileName;
            string temp = dir + "\\" + InstallManifest.FileName + "." + Guid.NewGuid().ToString("N") + ".tmp";
            bool written = TryDelete(
                () =>
                {
                    using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        manifest.Write(stream);
                    }
                },
                path,
                notDeleted);
            if (!written)
            {
                TryDelete(() => File.Delete(temp), temp, new List<string>());
                return;
            }

            bool replaced = TryDelete(() => File.Replace(temp, path, null), path, notDeleted);
            if (replaced)
            {
                return;
            }

            if (File.Exists(path))
            {
                TryDelete(() => File.Delete(temp), temp, new List<string>()); // the old manifest is still there
            }
            else if (!TryDelete(() => File.Move(temp, path), path, new List<string>()))
            {
                notDeleted.Add(temp); // the new list is kept under its temporary name
            }
        }

        private void RemoveIfEmpty(string folder, List<string> notDeleted)
        {
            if (_probe.DirectoryExists(folder) && !_probe.IsReparsePoint(folder) && _probe.IsEmptyDirectory(folder))
            {
                TryDelete(() => Directory.Delete(folder, false), folder, notDeleted);
            }
        }

        /// <summary>
        /// Removes what an interrupted setup left in the install folder: inside each real (not link) folder
        /// named exactly <c>.cyberpad-setup-&lt;32 hex digits&gt;</c>, the files named exactly
        /// <c>&lt;digits&gt;.bak</c> (setup's backups), then the folder if that left it empty. Nothing else
        /// inside is touched. Returns the backup folders still there.
        /// </summary>
        private List<string> RemoveBackupFolders(string dir, List<string> notDeleted)
        {
            var left = new List<string>();
            foreach (string name in TopLevelNames(dir, MaxBackupFolders * 10).Where(IsBackupFolderName).Take(MaxBackupFolders))
            {
                string folder = dir + "\\" + name;
                if (!_probe.DirectoryExists(folder) || _probe.IsReparsePoint(folder))
                {
                    continue; // not setup's: a link or a file with that name is left alone
                }

                foreach (string file in TopLevelNames(folder, MaxBackupFiles).Where(IsBackupFileName))
                {
                    string full = folder + "\\" + file;
                    FileAttributes? attributes = ReadAttributes(full);
                    if (attributes == null || (attributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                    {
                        continue;
                    }

                    TryDelete(
                        () =>
                        {
                            if ((attributes.Value & FileAttributes.ReadOnly) != 0)
                            {
                                File.SetAttributes(full, attributes.Value & ~FileAttributes.ReadOnly);
                            }

                            File.Delete(full);
                        },
                        full,
                        notDeleted);
                }

                RemoveIfEmpty(folder, notDeleted);
                if (_probe.DirectoryExists(folder))
                {
                    left.Add(folder);
                }
            }

            return left;
        }

        /// <summary>
        /// When the install folder is still there only because of setup's own leftovers (backup folders, or
        /// files already reported), the leftover backup folders are reported too, so the message says that
        /// some files could not be deleted rather than that everything went.
        /// </summary>
        private void ReportSetupLeftovers(string dir, List<string> backupLeftovers, List<string> notDeleted)
        {
            if (backupLeftovers.Count == 0 || !_probe.DirectoryExists(dir))
            {
                return;
            }

            var setupNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string path in backupLeftovers.Concat(notDeleted))
            {
                if (PathText.IsStrictlyInside(path, dir))
                {
                    string relative = path.Substring(dir.Length + 1);
                    int slash = relative.IndexOf('\\');
                    setupNames.Add(slash < 0 ? relative : relative.Substring(0, slash));
                }
            }

            if (TopLevelNames(dir, 1000).All(setupNames.Contains))
            {
                foreach (string folder in backupLeftovers.Where(f => !notDeleted.Contains(f, StringComparer.OrdinalIgnoreCase)))
                {
                    notDeleted.Add(folder);
                }
            }
        }

        private static bool IsBackupFolderName(string name) =>
            PathText.IsPrefixHexSuffix(name, FileJournal.BackupFolderPrefix, BackupHexDigits, string.Empty);

        private static bool IsBackupFileName(string name)
        {
            const string suffix = ".bak";
            if (name.Length <= suffix.Length || name.Length > suffix.Length + 10 || !name.EndsWith(suffix, StringComparison.Ordinal))
            {
                return false;
            }

            for (int i = 0; i < name.Length - suffix.Length; i++)
            {
                if (name[i] < '0' || name[i] > '9')
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>The names directly inside <paramref name="folder"/>, at most <paramref name="limit"/>; empty when it cannot be read.</summary>
        private static List<string> TopLevelNames(string folder, int limit)
        {
            var names = new List<string>();
            try
            {
                foreach (string entry in Directory.EnumerateFileSystemEntries(folder))
                {
                    if (names.Count >= limit)
                    {
                        break;
                    }

                    names.Add(Path.GetFileName(entry));
                }
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException)
            {
                names.Clear();
            }

            return names;
        }

        /// <summary>Deletes the shortcut when it points at this install. Never throws: a failure is reported.</summary>
        private bool RemoveShortcutIfOurs(string exe, List<string> notDeleted)
        {
            ShortcutInfo? shortcut;
            try
            {
                shortcut = _shortcuts.TryRead();
            }
            catch (Exception ex) when (!CriticalExceptions.IsCritical(ex))
            {
                notDeleted.Add(ShortcutLabel); // unreadable: left alone, since it cannot be shown to be ours
                return false;
            }

            if (shortcut == null || !PathText.AreSame(shortcut.TargetPath, exe))
            {
                return false;
            }

            try
            {
                _shortcuts.Delete();
                return true;
            }
            catch (Exception ex) when (!CriticalExceptions.IsCritical(ex))
            {
                notDeleted.Add(ShortcutLabel);
                return false;
            }
        }

        /// <summary>
        /// Puts back (or removes) the "Open with" registration, then deletes the uninstall entry, which holds
        /// the record of what the registration was before setup.
        /// </summary>
        private void DeleteRegistryKeys(string? ourOpenCommand, List<string> notDeleted)
        {
            TryDelete(
                () => OpenWithRegistration.Remove(_registry, ourOpenCommand),
                @"HKEY_CURRENT_USER\" + RegistryKeys.OpenWithApplicationPath,
                notDeleted);
            TryDelete(
                () => _registry.DeleteTree(RegistryKeyId.UninstallEntry),
                @"HKEY_CURRENT_USER\" + RegistryKeys.UninstallEntryPath,
                notDeleted);
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

            TryDelete(
                () =>
                {
                    // A real folder (checked above, not a link) that is read-only cannot be deleted until cleared.
                    if ((attributes.Value & FileAttributes.ReadOnly) != 0)
                    {
                        File.SetAttributes(extendedDir, attributes.Value & ~FileAttributes.ReadOnly);
                    }

                    Directory.Delete(extendedDir, false);
                },
                Display(extendedDir),
                notDeleted);
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
