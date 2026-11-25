using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;

namespace CyberPad.Install
{
    /// <summary>
    /// Unpacks the program files carried in the setup file. Every entry name is checked before anything
    /// is written; the entry count and the real number of bytes written are capped.
    /// </summary>
    public sealed class PayloadExtractor
    {
        public const int DefaultMaxEntries = 2000;
        public const long DefaultMaxTotalBytes = 1L << 30;

        private const int BufferSize = 81920;

        private readonly int _maxEntries;
        private readonly long _maxTotalBytes;

        public PayloadExtractor()
            : this(DefaultMaxEntries, DefaultMaxTotalBytes)
        {
        }

        /// <summary>Smaller caps, for tests.</summary>
        internal PayloadExtractor(int maxEntries, long maxTotalBytes)
        {
            _maxEntries = maxEntries;
            _maxTotalBytes = maxTotalBytes;
        }

        /// <summary>
        /// Unpacks <paramref name="zip"/> into <paramref name="installDir"/> (a full local path), which must
        /// not already hold any of the payload's files. Returns the relative paths written. On failure
        /// every file and folder this call created is removed again and an <see cref="InstallException"/>
        /// is thrown.
        /// </summary>
        public IReadOnlyList<string> Extract(Stream zip, string installDir, IProgress<int>? progress)
        {
            string dir = PathText.NormaliseFolder(installDir) ?? throw new ArgumentException("A full local folder path is required.", nameof(installDir));
            var journal = new FileJournal(dir, new FileSystemProbe(), Array.Empty<string>());
            bool done = false;
            try
            {
                journal.EnsureInstallDirectory();
                PayloadExtraction result = Extract(zip, journal, progress);
                journal.Commit();
                done = true;
                return result.Files;
            }
            finally
            {
                if (!done)
                {
                    journal.Rollback();
                }
            }
        }

        internal PayloadExtraction Extract(Stream zip, FileJournal journal, IProgress<int>? progress)
        {
            if (zip == null)
            {
                throw new ArgumentNullException(nameof(zip));
            }

            ZipArchive archive = Damaged(() => new ZipArchive(zip, ZipArchiveMode.Read, leaveOpen: true));
            using (archive)
            {
                List<KeyValuePair<ZipArchiveEntry, string>> files = Validate(archive, journal.InstallDir);
                var written = new List<string>(files.Count);
                long total = 0;
                for (int i = 0; i < files.Count; i++)
                {
                    total = CopyEntry(files[i].Key, files[i].Value, journal, total);
                    written.Add(files[i].Value);
                    progress?.Report((i + 1) * 100 / files.Count);
                }

                return new PayloadExtraction(written, total);
            }
        }

        private List<KeyValuePair<ZipArchiveEntry, string>> Validate(ZipArchive archive, string installDir)
        {
            IReadOnlyCollection<ZipArchiveEntry> entries = Damaged(() => archive.Entries);
            if (entries.Count > _maxEntries)
            {
                throw new InstallException(InstallMessages.PayloadDamaged);
            }

            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var fileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var files = new List<KeyValuePair<ZipArchiveEntry, string>>();
            long declared = 0;
            foreach (ZipArchiveEntry entry in entries)
            {
                string name = entry.FullName;
                bool isDirectory = name.Length > 0 && PathText.IsSeparator(name[name.Length - 1]);
                string? normalised = RelativePath.Normalise(isDirectory ? name.Substring(0, name.Length - 1) : name);
                if (normalised == null || !names.Add(normalised) || (!isDirectory && RelativePath.IsReservedForSetup(normalised)))
                {
                    throw new InstallException(InstallMessages.PayloadDamaged);
                }

                RelativePath.Combine(installDir, normalised, InstallMessages.PayloadDamaged);
                if (isDirectory)
                {
                    continue; // folders are created as files need them
                }

                if (entry.Length < 0)
                {
                    throw new InstallException(InstallMessages.PayloadDamaged);
                }

                declared += entry.Length;
                if (declared > _maxTotalBytes)
                {
                    throw new InstallException(InstallMessages.PayloadDamaged);
                }

                fileNames.Add(normalised);
                files.Add(new KeyValuePair<ZipArchiveEntry, string>(entry, normalised));
            }

            // A file may not also be used as a folder ("a" and "a\b").
            foreach (KeyValuePair<ZipArchiveEntry, string> file in files)
            {
                for (int slash = file.Value.IndexOf('\\'); slash >= 0; slash = file.Value.IndexOf('\\', slash + 1))
                {
                    if (fileNames.Contains(file.Value.Substring(0, slash)))
                    {
                        throw new InstallException(InstallMessages.PayloadDamaged);
                    }
                }
            }

            return files;
        }

        /// <summary>Opens an entry's data; tests replace it to feed more bytes than the header declares.</summary>
        internal Func<ZipArchiveEntry, Stream> OpenEntry { get; set; } = entry => entry.Open();

        private long CopyEntry(ZipArchiveEntry entry, string relative, FileJournal journal, long total)
        {
            long declared = entry.Length;
            using (Stream source = Damaged(() => OpenEntry(entry)))
            {
                Stream target = journal.CreateFile(relative, out string fullPath);
                bool complete = false;
                try
                {
                    var buffer = new byte[BufferSize];
                    long entryBytes = 0;
                    while (true)
                    {
                        int read = Damaged(() => source.Read(buffer, 0, buffer.Length));
                        if (read == 0)
                        {
                            break;
                        }

                        // The real byte count is what is capped; the header's sizes are not trusted.
                        total += read;
                        entryBytes += read;
                        if (total > _maxTotalBytes || entryBytes > declared)
                        {
                            throw new InstallException(InstallMessages.PayloadDamaged);
                        }

                        WriteFailed(() => target.Write(buffer, 0, read));
                    }

                    if (entryBytes != declared)
                    {
                        throw new InstallException(InstallMessages.PayloadDamaged);
                    }

                    WriteFailed(target.Flush);
                    complete = true;
                }
                finally
                {
                    target.Dispose();
                    if (!complete)
                    {
                        journal.DiscardCreatedFile(fullPath);
                    }
                }
            }

            return total;
        }

        private static T Damaged<T>(Func<T> action)
        {
            try
            {
                return action();
            }
            catch (InvalidDataException ex)
            {
                throw new InstallException(InstallMessages.PayloadDamaged, ex);
            }
            catch (NotSupportedException ex)
            {
                throw new InstallException(InstallMessages.PayloadDamaged, ex);
            }
            catch (IOException ex)
            {
                throw new InstallException(InstallMessages.PayloadDamaged, ex);
            }
        }

        private static void WriteFailed(Action action)
        {
            try
            {
                action();
            }
            catch (IOException ex)
            {
                throw new InstallException(InstallMessages.WriteFailed, ex);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new InstallException(InstallMessages.WriteFailed, ex);
            }
        }
    }

    internal sealed class PayloadExtraction
    {
        public PayloadExtraction(IReadOnlyList<string> files, long totalBytes)
        {
            Files = files;
            TotalBytes = totalBytes;
        }

        public IReadOnlyList<string> Files { get; }

        public long TotalBytes { get; }
    }
}
