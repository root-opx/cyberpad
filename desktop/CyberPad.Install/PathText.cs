using System;
using System.Collections.Generic;
using System.IO;

namespace CyberPad.Install
{
    /// <summary>
    /// Path-string helpers shared by the rules. All comparisons are ordinal and case-insensitive on
    /// normalised full paths (no trailing separator except on a drive root).
    /// </summary>
    internal static class PathText
    {
        private static readonly string[] ReservedDeviceNames =
        {
            "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
            "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "COM\u00B9", "COM\u00B2", "COM\u00B3",
            "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
            "LPT\u00B9", "LPT\u00B2", "LPT\u00B3",
        };

        private const string InvalidNameChars = "<>:\"|?*";

        public static bool IsSeparator(char c) => c == '\\' || c == '/';

        public static bool IsAsciiLetter(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');

        public static bool HasControlCharacter(string s)
        {
            foreach (char c in s)
            {
                if (char.IsControl(c))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// One file or folder name: not empty, not "." or "..", no trailing dot or space, no characters
        /// Windows forbids, no control characters, not a reserved device name (with or without an
        /// extension), and not an 8.3 short-name alias ("~" followed by a digit), which could name a
        /// different folder than it appears to. <paramref name="allowShortNameLookAlike"/> skips only that last
        /// rule (for the part of a path above the user's profile, which setup does not choose).
        /// </summary>
        public static bool IsValidSegment(string segment, bool allowShortNameLookAlike = false)
        {
            if (segment.Length == 0)
            {
                return false;
            }

            char last = segment[segment.Length - 1];
            if (last == '.' || last == ' ')
            {
                return false; // also rejects "." and ".."
            }

            for (int i = 0; i < segment.Length; i++)
            {
                char c = segment[i];
                if (char.IsControl(c) || InvalidNameChars.IndexOf(c) >= 0 || IsSeparator(c))
                {
                    return false;
                }

                if (!allowShortNameLookAlike && c == '~' && i + 1 < segment.Length && char.IsDigit(segment[i + 1]))
                {
                    return false;
                }
            }

            return !IsReservedDeviceName(segment);
        }

        public static bool IsReservedDeviceName(string segment)
        {
            int dot = segment.IndexOf('.');
            string stem = (dot >= 0 ? segment.Substring(0, dot) : segment).TrimEnd(' ');
            foreach (string name in ReservedDeviceNames)
            {
                if (string.Equals(stem, name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>Removes trailing separators, keeping the one after a drive ("C:\").</summary>
        public static string TrimTrailingSeparators(string fullPath)
        {
            int end = fullPath.Length;
            while (end > 3 && IsSeparator(fullPath[end - 1]))
            {
                end--;
            }

            return fullPath.Substring(0, end);
        }

        /// <summary>True for a normalised drive-absolute path such as "C:\" or "C:\a\b".</summary>
        public static bool IsDriveAbsolute(string path) =>
            path.Length >= 3 && IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\';

        public static bool AreSame(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        /// <summary>True when <paramref name="path"/> is <paramref name="folder"/> or below it.</summary>
        public static bool IsSameOrInside(string path, string folder) =>
            AreSame(path, folder) || IsStrictlyInside(path, folder);

        /// <summary>True when <paramref name="path"/> is below <paramref name="folder"/> (not equal).</summary>
        public static bool IsStrictlyInside(string path, string folder)
        {
            string prefix = folder.Length > 0 && folder[folder.Length - 1] == '\\' ? folder : folder + "\\";
            return path.Length > prefix.Length && path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Normalises a trusted, drive-absolute folder (from the environment, or one already validated)
        /// to the comparison form. Returns null when the value is empty or not drive-absolute.
        /// </summary>
        public static string? NormaliseFolder(string? folder)
        {
            if (string.IsNullOrEmpty(folder))
            {
                return null;
            }

            string value = folder!;
            if (value.Length < 3 || !IsAsciiLetter(value[0]) || value[1] != ':' || !IsSeparator(value[2]) ||
                HasControlCharacter(value))
            {
                return null;
            }

            string full;
            try
            {
                full = Path.GetFullPath(value);
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (NotSupportedException)
            {
                return null;
            }
            catch (PathTooLongException)
            {
                return null;
            }

            full = TrimTrailingSeparators(full);
            return IsDriveAbsolute(full) ? full : null;
        }

        /// <summary>
        /// The prefixes of a normalised path below its drive, outermost first:
        /// "C:\a\b" gives "C:\a", "C:\a\b".
        /// </summary>
        public static IEnumerable<string> PrefixesBelowDrive(string fullPath)
        {
            for (int i = 3; i < fullPath.Length; i++)
            {
                if (fullPath[i] == '\\')
                {
                    yield return fullPath.Substring(0, i);
                }
            }

            if (fullPath.Length > 3)
            {
                yield return fullPath;
            }
        }

        /// <summary>
        /// True when the name matches exactly <paramref name="prefix"/> followed by <paramref name="hexDigits"/>
        /// lowercase hex digits and then <paramref name="suffix"/>.
        /// </summary>
        public static bool IsPrefixHexSuffix(string name, string prefix, int hexDigits, string suffix)
        {
            if (name == null || name.Length != prefix.Length + hexDigits + suffix.Length ||
                !name.StartsWith(prefix, StringComparison.Ordinal) || !name.EndsWith(suffix, StringComparison.Ordinal))
            {
                return false;
            }

            for (int i = prefix.Length; i < prefix.Length + hexDigits; i++)
            {
                char c = name[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>The parent of a normalised path, or null for a drive root.</summary>
        public static string? Parent(string fullPath)
        {
            if (fullPath.Length <= 3)
            {
                return null;
            }

            int slash = fullPath.LastIndexOf('\\');
            if (slash < 2)
            {
                return null;
            }

            return slash == 2 ? fullPath.Substring(0, 3) : fullPath.Substring(0, slash);
        }
    }
}
