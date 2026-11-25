using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security;

namespace CyberPad.Install
{
    public sealed class UninstallResult
    {
        internal UninstallResult(string installDir, IReadOnlyList<string> notDeleted)
        {
            InstallDir = installDir;
            NotDeleted = notDeleted;
        }

        public string InstallDir { get; }

        /// <summary>Files, folders and registry keys that should have been removed but could not be.</summary>
        public IReadOnlyList<string> NotDeleted { get; }

        public string Message => NotDeleted.Count == 0
            ? InstallMessages.Removed
            : InstallMessages.RemovedWithLeftoversPrefix + InstallDir;
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

        /// <summary>
        /// Uninstalls the install named by the uninstall entry. Deletes exactly the manifest's files, the
        /// manifest and <c>Uninstall.exe</c>, folders left empty, the shortcut and the two registry keys.
        /// </summary>
        public UninstallResult Uninstall()
        {
            ExistingInstall existing = Installer.FindExisting(_registry, _probe, _env)
                ?? throw new InstallException(InstallMessages.NotInstalled);
            string dir = existing.InstallDir;
            string exe = dir + "\\" + InstallLayout.AppFileName;

            if (_probe.FileExists(exe) && !_probe.CanOpenForWriting(exe))
            {
                throw new InstallException(InstallMessages.CloseToUninstall);
            }

            var notDeleted = new List<string>();
            var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string file in existing.Manifest.Files)
            {
                DeleteListedFile(dir, file, notDeleted, folders);
            }

            DeleteListedFile(dir, InstallManifest.FileName, notDeleted, folders);
            DeleteListedFile(dir, InstallLayout.UninstallerFileName, notDeleted, folders);

            foreach (string folder in folders.OrderByDescending(f => f.Length))
            {
                RemoveIfEmpty(folder, notDeleted);
            }

            RemoveIfEmpty(dir, notDeleted);

            try
            {
                ShortcutInfo? shortcut = _shortcuts.TryRead();
                if (shortcut != null && PathText.AreSame(shortcut.TargetPath, exe))
                {
                    _shortcuts.Delete();
                }
            }
            catch (IOException)
            {
                notDeleted.Add(InstallLayout.DisplayName + ".lnk");
            }
            catch (UnauthorizedAccessException)
            {
                notDeleted.Add(InstallLayout.DisplayName + ".lnk");
            }

            foreach (RegistryKeyId root in RegistryKeys.Roots)
            {
                try
                {
                    _registry.DeleteTree(root);
                }
                catch (IOException)
                {
                    notDeleted.Add(@"HKEY_CURRENT_USER\" + RegistryKeys.PathOf(root));
                }
                catch (UnauthorizedAccessException)
                {
                    notDeleted.Add(@"HKEY_CURRENT_USER\" + RegistryKeys.PathOf(root));
                }
                catch (SecurityException)
                {
                    notDeleted.Add(@"HKEY_CURRENT_USER\" + RegistryKeys.PathOf(root));
                }
            }

            _notify.AssociationsChanged();
            return new UninstallResult(dir, notDeleted);
        }

        /// <summary>
        /// Deletes the notes and settings folder. Call only after the user's second confirmation. The path
        /// comes from <see cref="InstallEnvironment"/> and must be exactly
        /// <c>&lt;LocalApplicationData&gt;\CyberPad</c>; no part of it may be a link. Links found inside are
        /// deleted as links, never followed.
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

            var budget = new Budget(MaxNotesEntries);
            DeleteContents(notes, 0, notDeleted, budget);
            TryDelete(() => Directory.Delete(notes, false), notes, notDeleted);
            return new NotesDeletionResult(notes, notDeleted);
        }

        private void DeleteListedFile(string dir, string relative, List<string> notDeleted, HashSet<string> folders)
        {
            string? normalised = RelativePath.Normalise(relative);
            if (normalised == null)
            {
                return; // the manifest was validated; this cannot happen
            }

            string full = Path.GetFullPath(Path.Combine(dir, normalised));
            if (!PathText.IsStrictlyInside(full, dir))
            {
                return;
            }

            // Every folder between the install folder and the file must be a real folder, not a link.
            for (string? parent = PathText.Parent(full); parent != null && PathText.IsStrictlyInside(parent, dir); parent = PathText.Parent(parent))
            {
                if (_probe.IsReparsePoint(parent))
                {
                    notDeleted.Add(full);
                    return;
                }

                folders.Add(parent);
            }

            if (!_probe.FileExists(full))
            {
                if (_probe.DirectoryExists(full))
                {
                    notDeleted.Add(full);
                }

                return;
            }

            if (_probe.IsReparsePoint(full))
            {
                notDeleted.Add(full);
                return;
            }

            TryDelete(() => File.Delete(full), full, notDeleted);
        }

        private void RemoveIfEmpty(string folder, List<string> notDeleted)
        {
            if (_probe.DirectoryExists(folder) && !_probe.IsReparsePoint(folder) && _probe.IsEmptyDirectory(folder))
            {
                TryDelete(() => Directory.Delete(folder, false), folder, notDeleted);
            }
        }

        private static void DeleteContents(string dir, int depth, List<string> notDeleted, Budget budget)
        {
            if (depth > MaxNotesDepth)
            {
                notDeleted.Add(dir);
                return;
            }

            FileSystemInfo[] entries;
            try
            {
                entries = new DirectoryInfo(dir).GetFileSystemInfos();
            }
            catch (IOException)
            {
                notDeleted.Add(dir);
                return;
            }
            catch (UnauthorizedAccessException)
            {
                notDeleted.Add(dir);
                return;
            }

            foreach (FileSystemInfo entry in entries)
            {
                if (!budget.Take())
                {
                    notDeleted.Add(dir);
                    return;
                }

                string path = entry.FullName;
                bool isLink = (entry.Attributes & FileAttributes.ReparsePoint) != 0;
                if (entry is DirectoryInfo)
                {
                    if (!isLink)
                    {
                        DeleteContents(path, depth + 1, notDeleted, budget);
                    }

                    // Without recursion this removes a junction or folder link itself, not its target.
                    TryDelete(() => Directory.Delete(path, false), path, notDeleted);
                }
                else
                {
                    TryDelete(
                        () =>
                        {
                            if (!isLink && (entry.Attributes & FileAttributes.ReadOnly) != 0)
                            {
                                File.SetAttributes(path, entry.Attributes & ~FileAttributes.ReadOnly);
                            }

                            File.Delete(path);
                        },
                        path,
                        notDeleted);
                }
            }
        }

        private static void TryDelete(Action delete, string path, List<string> notDeleted)
        {
            try
            {
                delete();
            }
            catch (IOException)
            {
                notDeleted.Add(path);
            }
            catch (UnauthorizedAccessException)
            {
                notDeleted.Add(path);
            }
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
