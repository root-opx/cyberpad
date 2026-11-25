using System;
using System.IO;

namespace CyberPad.Install
{
    /// <summary>
    /// Rules for a path relative to the install folder, as found in a payload entry name or a manifest
    /// line: relative, at most 200 characters, every segment a valid name (no empty, "." or ".." segment,
    /// no drive, root or ":", no control characters, no trailing dot or space, no reserved device name).
    /// Forward slashes are normalised to backslashes.
    /// </summary>
    public static class RelativePath
    {
        public const int MaxLength = 200;

        /// <summary>
        /// Returns the normalised form (backslash-separated), or null when the name breaks a rule.
        /// </summary>
        public static string? Normalise(string? name)
        {
            if (string.IsNullOrEmpty(name) || name!.Length > MaxLength)
            {
                return null;
            }

            string value = name.Replace('/', '\\');
            if (value[0] == '\\' || value.IndexOf(':') >= 0)
            {
                return null; // rooted, drive, or alternate data stream
            }

            foreach (string segment in value.Split('\\'))
            {
                if (!PathText.IsValidSegment(segment))
                {
                    return null; // also rejects empty segments, so no trailing separator and no "a\\b"
                }
            }

            return value;
        }

        /// <summary>
        /// True for the two files setup writes itself; neither may appear in a payload or a manifest list.
        /// </summary>
        public static bool IsReservedForSetup(string normalised) =>
            PathText.AreSame(normalised, InstallManifest.FileName) ||
            PathText.AreSame(normalised, InstallLayout.UninstallerFileName);

        /// <summary>
        /// Joins a normalised relative path to a normalised install folder and checks the result is
        /// strictly inside it. Throws <see cref="InstallException"/> otherwise.
        /// </summary>
        internal static string Combine(string installDir, string normalisedRelative, string failureMessage)
        {
            string full;
            try
            {
                full = Path.GetFullPath(Path.Combine(installDir, normalisedRelative));
            }
            catch (ArgumentException ex)
            {
                throw new InstallException(failureMessage, ex);
            }
            catch (NotSupportedException ex)
            {
                throw new InstallException(failureMessage, ex);
            }
            catch (PathTooLongException ex)
            {
                throw new InstallException(failureMessage, ex);
            }

            if (!PathText.IsStrictlyInside(full, installDir))
            {
                throw new InstallException(failureMessage);
            }

            return full;
        }
    }
}
