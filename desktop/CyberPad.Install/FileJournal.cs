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
        private const string BackupFolderPrefix = ".cyberpad-setup-";

        private readonly IFileSystemProbe _probe;
        private readonly HashSet<string> _replaceable;
        private readonly List<Entry> _entries = new List<Entry>();
        private string? _backupDir;
        private int _backupCount;

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
        /// Returns the paths that could not be cleaned up.
        /// </summary>
        public IReadOnlyList<string> Commit()
        {
            var leftovers = new List<string>();
            var emptiedFolders = new List<string>();
            foreach (Entry entry in _entries)
            {
                if (entry.Kind != EntryKind.MovedToBackup && entry.Kind != EntryKind.RemovedToBackup)
                {
                    continue;
                }

                if (!TryIo(() => File.Delete(entry.Backup!)))
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
                if (Directory.Exists(dir) && !_probe.IsReparsePoint(dir) && IsEmpty(dir) &&
                    !TryIo(() => Directory.Delete(dir, false)))
                {
                    leftovers.Add(dir);
                }
            }

            _entries.Clear();
            return leftovers;
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
                Io(() => Directory.CreateDirectory(dir));
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
