using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace CyberPad.Install
{
    /// <summary>
    /// The list of files setup wrote, kept in <c>install.manifest</c> in the install folder:
    /// <code>
    /// CyberPad-Install 1
    /// version=1.0.0
    /// CyberPad.exe
    /// wwwroot\index.html
    /// </code>
    /// UTF-8 without BOM, "\n" after every line. It lists the payload files only; the manifest itself
    /// and <c>Uninstall.exe</c> are implied. Reading is strict: anything unexpected makes it invalid.
    /// </summary>
    public sealed class InstallManifest
    {
        public const string FileName = "install.manifest";
        public const string Header = "CyberPad-Install 1";
        public const string VersionPrefix = "version=";
        public const int MaxVersionLength = 20;
        public const int MaxPaths = 2000;
        public const int MaxBytes = 256 * 1024;

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        private readonly List<string> _files;

        /// <summary>Builds a manifest; throws <see cref="ArgumentException"/> when a value breaks a rule.</summary>
        public InstallManifest(string version, IEnumerable<string> files)
        {
            if (!IsValidVersion(version))
            {
                throw new ArgumentException("The version must be digits separated by dots, at most 20 characters.", nameof(version));
            }

            Version = version;
            _files = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string file in files)
            {
                string? normalised = RelativePath.Normalise(file);
                if (normalised == null || RelativePath.IsReservedForSetup(normalised) || !seen.Add(normalised))
                {
                    throw new ArgumentException("A manifest path is not valid or is listed twice.", nameof(files));
                }

                _files.Add(normalised);
            }

            if (_files.Count > MaxPaths)
            {
                throw new ArgumentException("A manifest lists at most 2,000 paths.", nameof(files));
            }
        }

        public string Version { get; }

        /// <summary>Relative, backslash-separated paths of the files setup wrote.</summary>
        public IReadOnlyList<string> Files => _files;

        public static bool IsValidVersion(string? version)
        {
            if (string.IsNullOrEmpty(version) || version!.Length > MaxVersionLength)
            {
                return false;
            }

            bool expectDigit = true;
            foreach (char c in version)
            {
                if (c >= '0' && c <= '9')
                {
                    expectDigit = false;
                }
                else if (c == '.' && !expectDigit)
                {
                    expectDigit = true;
                }
                else
                {
                    return false;
                }
            }

            return !expectDigit;
        }

        public byte[] ToBytes()
        {
            var text = new StringBuilder();
            text.Append(Header).Append('\n');
            text.Append(VersionPrefix).Append(Version).Append('\n');
            foreach (string file in _files)
            {
                text.Append(file).Append('\n');
            }

            return StrictUtf8.GetBytes(text.ToString());
        }

        public void Write(Stream destination)
        {
            byte[] bytes = ToBytes();
            destination.Write(bytes, 0, bytes.Length);
        }

        /// <summary>
        /// Reads the manifest in <paramref name="installDir"/> (a normalised full path), or returns null
        /// when it is missing, a link, unreadable or invalid.
        /// </summary>
        public static InstallManifest? TryReadFrom(string installDir, IFileSystemProbe probe)
        {
            string path = installDir + "\\" + FileName;
            if (!probe.FileExists(path) || probe.IsReparsePoint(path))
            {
                return null;
            }

            Stream? stream = probe.TryOpenRead(path);
            if (stream == null)
            {
                return null;
            }

            using (stream)
            {
                return TryRead(stream);
            }
        }

        /// <summary>Parses a manifest, reading at most <see cref="MaxBytes"/> + 1 bytes. Returns null if invalid.</summary>
        public static InstallManifest? TryRead(Stream source)
        {
            byte[]? bytes = ReadCapped(source);
            if (bytes == null || bytes.Length == 0 || Array.IndexOf(bytes, (byte)0) >= 0)
            {
                return null;
            }

            string text;
            try
            {
                text = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                return null;
            }

            if (text[0] == '﻿' || text[text.Length - 1] != '\n')
            {
                return null;
            }

            string[] lines = text.Substring(0, text.Length - 1).Split('\n');
            if (lines.Length < 2 || lines.Length - 2 > MaxPaths || !string.Equals(lines[0], Header, StringComparison.Ordinal))
            {
                return null;
            }

            if (!lines[1].StartsWith(VersionPrefix, StringComparison.Ordinal))
            {
                return null;
            }

            string version = lines[1].Substring(VersionPrefix.Length);
            if (!IsValidVersion(version))
            {
                return null;
            }

            var files = new List<string>(lines.Length - 2);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 2; i < lines.Length; i++)
            {
                string? normalised = RelativePath.Normalise(lines[i]);
                if (normalised == null || RelativePath.IsReservedForSetup(normalised) || !seen.Add(normalised))
                {
                    return null;
                }

                files.Add(normalised);
            }

            return new InstallManifest(version, files);
        }

        private static byte[]? ReadCapped(Stream source)
        {
            var buffer = new byte[MaxBytes + 1];
            int total = 0;
            try
            {
                while (total < buffer.Length)
                {
                    int read = source.Read(buffer, total, buffer.Length - total);
                    if (read == 0)
                    {
                        break;
                    }

                    total += read;
                }
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }

            if (total > MaxBytes)
            {
                return null;
            }

            var result = new byte[total];
            Array.Copy(buffer, result, total);
            return result;
        }
    }
}
