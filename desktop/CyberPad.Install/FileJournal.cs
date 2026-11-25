using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace CyberPad.Install
{
    /// <summary>
    /// Every file-system change setup makes in the install folder goes through here, so a failed run can
    /// be undone: created files and folders are recorded, and a file that is replaced or removed is first
    /// moved into a backup folder inside the install folder. <see cref="Commit"/> deletes the backups;
    /// <see cref="Rollback"/> puts everything back.
    /// </summary>
    internal sealed class FileJournal
    {
        /// <summary>Backup folders are named this followed by 32 hex digits.</summary>
        internal const string BackupFolderPrefix = ".cyberpad-setup-";

        private readonly IFileSystemProbe _probe;
        private readonly HashSet<string> _replaceable;
        private readonly List<Entry> _entries = new List<Entry>();
        private string? _backupDir;
        private int _backupCount;
        private bool _committed;

        public FileJournal(string installDir, IFileSystemProbe probe, IEnumerable<string> replaceable)
        {
            InstallDir = installDir;
            _probe = probe;
            _replaceable = new HashSet<string>(replaceable, StringComparer.OrdinalIgnoreCase);
        }

        public string InstallDir { get; }

        /// <summary>Creates the install folder and any missing folders above it.</summary>
        public void EnsureInstallDirectory()
        {
            foreach (string prefix in PathText.PrefixesBelowDrive(InstallDir))
            {
                EnsureDirectory(prefix);
            }
        }

        /// <summary>
        /// Creates a new file at <paramref name="relative"/> (already validated). An existing file there is
        /// moved to the backup folder first, but only if it is one the old install wrote; any other
        /// existing file stops the install.
        /// </summary>
        public Stream CreateFile(string relative, out string fullPath)
        {
            string full = RelativePath.Combine(InstallDir, relative, InstallMessages.WriteFailed);
            EnsureParentDirectories(full);

            if (_probe.DirectoryExists(full))
            {
                throw new InstallException(InstallMessages.FilesInTheWay);
            }

            if (_probe.FileExists(full))
            {
                if (!_replaceable.Contains(relative))
                {
                    throw new InstallException(InstallMessages.FilesInTheWay);
                }

                if (_probe.IsReparsePoint(full))
                {
                    throw new InstallException(InstallMessages.WriteFailed);
                }

                MoveToBackup(full, isRemoval: false);
            }

            Stream stream = Io(() => new FileStream(full, FileMode.CreateNew, FileAccess.Write, FileShare.None));
            _entries.Add(new Entry(EntryKind.CreatedFile, full, null));
            fullPath = full;
            return stream;
        }

        /// <summary>
        /// Deletes a file this run just created, when writing it failed half-way. Never throws, so the
        /// original error is kept; if the delete fails here, <see cref="Rollback"/> tries again.
        /// </summary>
        public void DiscardCreatedFile(string fullPath)
        {
            TryIo(() =>
            {
                if (File.Exists(fullPath))
                {
                    File.Delete(fullPath);
                }
            });
        }

        /// <summary>
        /// Removes a file of the old install that the new one no longer has, by moving it to the backup
        /// folder. Missing files, links, and files below a link are left alone.
        /// </summary>
        public void RemoveOldFile(string relative)
        {
            string full = RelativePath.Combine(InstallDir, relative, InstallMessages.WriteFailed);
            if (!IsPlainPathBelowInstallDir(full) || !_probe.FileExists(full))
            {
                return;
            }

            MoveToBackup(full, isRemoval: true);
        }

        /// <summary>Undoes every recorded change in reverse order. Returns false if something could not be undone.</summary>
        public bool Rollback()
        {
            if (_committed)
            {
                // Once Commit has started the backups may be gone: undoing now would delete the new files
                // with nothing to put back. The new install stays.
                return true;
            }

            bool complete = true;
            for (int i = _entries.Count - 1; i >= 0; i--)
            {
                Entry entry = _entries[i];
                try
                {
                    switch (entry.Kind)
                    {
                        case EntryKind.CreatedFile:
                            if (File.Exists(entry.Path))
                            {
                                File.Delete(entry.Path);
                            }

                            break;
                        case EntryKind.MovedToBackup:
                        case EntryKind.RemovedToBackup:
                            File.Move(entry.Backup!, entry.Path);
                            break;
                        case EntryKind.CreatedDirectory:
                            if (Directory.Exists(entry.Path) && IsEmpty(entry.Path))
                            {
                                Directory.Delete(entry.Path, false);
                            }
                            else if (Directory.Exists(entry.Path))
                            {
                                complete = false;
                            }

                            break;
                    }
                }
                catch (IOException)
                {
                    complete = false;
                }
                catch (UnauthorizedAccessException)
                {
                    complete = false;
                }
            }

            _entries.Clear();
            return complete;
        }

        /// <summary>
        /// Keeps the changes: deletes the backups, then folders that removed old files leave empty.
        /// Never throws: every clean-up step that fails adds its path to the returned leftovers. After this
        /// is called, <see cref="Rollback"/> does nothing.
        /// </summary>
        public IReadOnlyList<string> Commit()
        {
            _committed = true;
            var leftovers = new List<string>();
            var emptiedFolders = new List<string>();
            foreach (Entry entry in _entries)
            {
                if (entry.Kind != EntryKind.MovedToBackup && entry.Kind != EntryKind.RemovedToBackup)
                {
                    continue;
                }

                if (!CleanUp(() =>
                    {
                        CommitStep?.Invoke(entry.Backup!);
                        File.Delete(entry.Backup!);
                    }))
                {
                    leftovers.Add(entry.Backup!);
                }

                if (entry.Kind == EntryKind.RemovedToBackup)
                {
                    for (string? dir = PathText.Parent(entry.Path);
                         dir != null && PathText.IsStrictlyInside(dir, InstallDir);
                         dir = PathText.Parent(dir))
                    {
                        emptiedFolders.Add(dir);
                    }
                }
            }

            if (_backupDir != null)
            {
                emptiedFolders.Add(_backupDir);
            }

            foreach (string dir in emptiedFolders.Distinct(StringComparer.OrdinalIgnoreCase).OrderByDescending(d => d.Length))
            {
                bool cleaned = CleanUp(() =>
                {
                    CommitStep?.Invoke(dir);
                    if (Directory.Exists(dir) && !_probe.IsReparsePoint(dir) && IsEmpty(dir))
                    {
                        Directory.Delete(dir, false);
                    }
                });
                if (!cleaned)
                {
                    leftovers.Add(dir);
                }
            }

            _entries.Clear();
            return leftovers;
        }

        /// <summary>Called before each clean-up step of <see cref="Commit"/>; tests throw from it.</summary>
        internal Action<string>? CommitStep { get; set; }

        /// <summary>
        /// Runs one clean-up step of a commit. The install is already complete at this point, so any failure,
        /// whatever its type, is reported as a leftover (by the caller) rather than allowed to undo it.
        /// </summary>
        private static bool CleanUp(Action step)
        {
            try
            {
                step();
                return true;
            }
#pragma warning disable CA1031 // Commit must never throw; the failure is returned as a leftover path, not swallowed.
            catch (Exception)
#pragma warning restore CA1031
            {
                return false;
            }
        }

        private void EnsureParentDirectories(string fullFile)
        {
            string? parent = PathText.Parent(fullFile);
            var missing = new Stack<string>();
            while (parent != null && PathText.IsStrictlyInside(parent, InstallDir))
            {
                missing.Push(parent);
                parent = PathText.Parent(parent);
            }

            while (missing.Count > 0)
            {
                EnsureDirectory(missing.Pop());
            }
        }

        private void EnsureDirectory(string dir)
        {
            if (_probe.DirectoryExists(dir))
            {
                if (_probe.IsReparsePoint(dir))
                {
                    throw new InstallException(InstallMessages.WriteFailed);
                }

                return;
            }

            if (_probe.FileExists(dir))
            {
                throw new InstallException(InstallMessages.FilesInTheWay);
            }

            Io(() => Directory.CreateDirectory(dir));
            _entries.Add(new Entry(EntryKind.CreatedDirectory, dir, null));
        }

        private bool IsPlainPathBelowInstallDir(string full)
        {
            for (string? dir = PathText.Parent(full); dir != null && PathText.IsStrictlyInside(dir, InstallDir); dir = PathText.Parent(dir))
            {
                if (_probe.IsReparsePoint(dir))
                {
                    return false;
                }
            }

            return !_probe.IsReparsePoint(full);
        }

        private void MoveToBackup(string full, bool isRemoval)
        {
            if (_backupDir == null)
            {
                string dir = InstallDir + "\\" + BackupFolderPrefix + Guid.NewGuid().ToString("N");

                // A fresh, random name: anything already there (a folder, a file, a planted link) stops the install.
                if (_probe.DirectoryExists(dir) || _probe.FileExists(dir) || _probe.IsReparsePoint(dir))
                {
                    throw new InstallException(InstallMessages.WriteFailed);
                }

                Io(() => Directory.CreateDirectory(dir));
                if (_probe.IsReparsePoint(dir))
                {
                    throw new InstallException(InstallMessages.WriteFailed);
                }
                _entries.Add(new Entry(EntryKind.CreatedDirectory, dir, null));
                _backupDir = dir;
            }

            string backup = _backupDir + "\\" + (++_backupCount).ToString(System.Globalization.CultureInfo.InvariantCulture) + ".bak";
            Io(() =>
            {
                File.Move(full, backup);
                return true;
            });
            _entries.Add(new Entry(isRemoval ? EntryKind.RemovedToBackup : EntryKind.MovedToBackup, full, backup));
        }

        private static bool IsEmpty(string dir) => !Directory.EnumerateFileSystemEntries(dir).Any();

        private static T Io<T>(Func<T> action)
        {
            try
            {
                return action();
            }
            catch (IOException ex)
            {
                throw new InstallException(InstallMessages.WriteFailed, ex);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new InstallException(InstallMessages.WriteFailed, ex);
            }
            catch (System.Security.SecurityException ex)
            {
                throw new InstallException(InstallMessages.WriteFailed, ex);
            }
        }

        private static bool TryIo(Action action)
        {
            try
            {
                action();
                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
        }

        private enum EntryKind
        {
            CreatedDirectory,
            CreatedFile,
            MovedToBackup,
            RemovedToBackup,
        }

        private sealed class Entry
        {
            public Entry(EntryKind kind, string path, string? backup)
            {
                Kind = kind;
                Path = path;
                Backup = backup;
            }

            public EntryKind Kind { get; }

            public string Path { get; }

            public string? Backup { get; }
        }
    }
}
