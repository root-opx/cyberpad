using System;
using System.IO;

namespace CyberPad.Install
{
    public enum InstallPathKind
    {
        /// <summary>The folder cannot be used; see the message.</summary>
        Refused,

        /// <summary>The folder does not exist and will be created.</summary>
        WillCreate,

        /// <summary>The folder exists and is empty.</summary>
        EmptyFolder,

        /// <summary>The folder holds a CyberPad install with a valid manifest; installing updates it.</summary>
        ExistingInstall,

        /// <summary>The chosen folder had other files, so the <c>CyberPad</c> folder inside it is used.</summary>
        UsesSubfolder,
    }

    public sealed class InstallPathResult
    {
        internal InstallPathResult(bool isUsable, string? fullPath, InstallPathKind kind, InstallPathKind folderKind, string message)
        {
            IsUsable = isUsable;
            FullPath = fullPath;
            Kind = kind;
            FolderKind = folderKind;
            Message = message;
        }

        public bool IsUsable { get; }

        /// <summary>The resolved folder to install into (the subfolder for <see cref="InstallPathKind.UsesSubfolder"/>); null when the input could not be resolved.</summary>
        public string? FullPath { get; }

        public InstallPathKind Kind { get; }

        /// <summary>
        /// The state of <see cref="FullPath"/> itself: equal to <see cref="Kind"/> except for
        /// <see cref="InstallPathKind.UsesSubfolder"/>, where it tells whether the subfolder will be created,
        /// is empty, or is an existing install.
        /// </summary>
        public InstallPathKind FolderKind { get; }

        /// <summary>The status line to show under the folder field, or the reason the folder cannot be used.</summary>
        public string Message { get; }
    }

    /// <summary>The rules for the folder the user chooses (spec, "Choosing the folder").</summary>
    public static class InstallPathPolicy
    {
        public const int MaxPathLength = 180;

        /// <summary>Raw input longer than this is refused before any parsing.</summary>
        public const int MaxInputLength = 1024;

        /// <param name="input">The text the user typed or picked.</param>
        /// <param name="probe">File-system questions.</param>
        /// <param name="env">The user's folders.</param>
        /// <param name="probeWrite">
        /// True to check that a file can be created there (creates and deletes one temporary file). The setup
        /// window passes false while the user types, so nothing is written; <see cref="Installer.Install"/>
        /// always checks with true.
        /// </param>
        public static InstallPathResult Evaluate(string? input, IFileSystemProbe probe, InstallEnvironment env, bool probeWrite = true)
        {
            if (probe == null)
            {
                throw new ArgumentNullException(nameof(probe));
            }

            if (env == null)
            {
                throw new ArgumentNullException(nameof(env));
            }

            return Check(input, probe, env, allowSubfolder: true, probeWrite);
        }

        private static InstallPathResult Check(string? input, IFileSystemProbe probe, InstallEnvironment env, bool allowSubfolder, bool probeWrite)
        {
            string? full = Resolve(input, out string? failure);
            if (full == null)
            {
                return Refuse(null, failure!);
            }

            if (probe.GetDriveKind(full.Substring(0, 3)) != DriveKind.Fixed)
            {
                return Refuse(full, InstallMessages.LocalDrive);
            }

            if (full.Length == 3)
            {
                return Refuse(full, InstallMessages.SharedFolder);
            }

            // The most specific reason wins: shared, notes and admin folders are named before the general
            // "inside your own user folder" rule. Shared folders come first so the profile itself (a parent
            // of the notes folder) gets the "folder of its own" message.
            foreach (string shared in env.SharedFolders)
            {
                if (PathText.AreSame(full, shared))
                {
                    return Refuse(full, InstallMessages.SharedFolder);
                }
            }

            foreach (string tree in env.SharedTrees)
            {
                if (PathText.IsSameOrInside(full, tree))
                {
                    return Refuse(full, InstallMessages.SharedFolder);
                }
            }

            if (PathText.IsSameOrInside(full, env.NotesFolder) || PathText.IsStrictlyInside(env.NotesFolder, full))
            {
                return Refuse(full, InstallMessages.NotesFolder);
            }

            foreach (string admin in env.AdminFolders)
            {
                if (PathText.IsSameOrInside(full, admin))
                {
                    return Refuse(full, InstallMessages.NeedsAdmin);
                }
            }

            // Folders outside the profile (C:\Tools, another drive) usually inherit write access for other
            // accounts, who could then replace CyberPad.exe or Uninstall.exe. This rule also closes the
            // textual rules' blind spot for subst and mapped drive letters: a path on any letter other than
            // the profile's is refused here, whatever folder that letter really points at.
            if (!PathText.IsStrictlyInside(full, env.UserProfile))
            {
                return Refuse(full, InstallMessages.OutsideProfile);
            }

            // No existing part below the drive may be a link; remember the deepest existing part.
            string deepestExisting = full.Substring(0, 3);
            bool deepestIsFile = false;
            foreach (string prefix in PathText.PrefixesBelowDrive(full))
            {
                bool isDirectory = probe.DirectoryExists(prefix);
                bool isFile = !isDirectory && probe.FileExists(prefix);
                if (!isDirectory && !isFile)
                {
                    break;
                }

                if (probe.IsReparsePoint(prefix))
                {
                    return Refuse(full, InstallMessages.Link);
                }

                deepestExisting = prefix;
                deepestIsFile = isFile;
                if (isFile)
                {
                    break;
                }
            }

            if (deepestIsFile)
            {
                return Refuse(full, InstallMessages.CannotWrite);
            }

            if (!PathText.AreSame(deepestExisting, full))
            {
                return !probeWrite || probe.CanCreateFileIn(deepestExisting)
                    ? Usable(full, InstallPathKind.WillCreate, InstallMessages.WillCreate)
                    : Refuse(full, InstallMessages.CannotWrite);
            }

            InstallPathKind kind;
            string message;
            if (probe.IsEmptyDirectory(full))
            {
                kind = InstallPathKind.EmptyFolder;
                message = InstallMessages.WillInstallHere;
            }
            else if (InstallManifest.TryReadFrom(full, probe) != null)
            {
                kind = InstallPathKind.ExistingInstall;
                message = InstallMessages.WillUpdate;
            }
            else if (allowSubfolder)
            {
                InstallPathResult sub = Check(full + "\\" + InstallLayout.SubfolderName, probe, env, allowSubfolder: false, probeWrite);
                return sub.IsUsable
                    ? new InstallPathResult(true, sub.FullPath, InstallPathKind.UsesSubfolder, sub.FolderKind, sub.Message)
                    : sub;
            }
            else
            {
                return Refuse(full, InstallMessages.SubfolderOccupied);
            }

            return !probeWrite || probe.CanCreateFileIn(full) ? Usable(full, kind, message) : Refuse(full, InstallMessages.CannotWrite);
        }

        /// <summary>
        /// Checks the text of the path and resolves it. Returns the normalised full path, or null with
        /// the message for the rule it breaks.
        /// </summary>
        internal static string? Resolve(string? input, out string? failure)
        {
            failure = null;
            if (string.IsNullOrEmpty(input))
            {
                failure = InstallMessages.LocalDrive;
                return null;
            }

            string value = input!;
            if (value.Length > MaxInputLength)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }

            // UNC (\\server\share), device (\\.\, \\?\) and NT (\??\) paths, rooted and relative paths.
            if (PathText.IsSeparator(value[0]) ||
                value.Length < 3 || !PathText.IsAsciiLetter(value[0]) || value[1] != ':' || !PathText.IsSeparator(value[2]))
            {
                failure = InstallMessages.LocalDrive;
                return null;
            }

            // Any ":" after the drive is alternate-data-stream syntax. "%" would be expanded by Explorer
            // inside the registered open command, so it is refused too.
            if (PathText.HasControlCharacter(value) || value.IndexOf(':', 2) >= 0 || value.IndexOf('%') >= 0)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }

            foreach (string segment in value.Substring(3).Split('\\', '/'))
            {
                if (segment.Length > 0 && !PathText.IsValidSegment(segment))
                {
                    failure = InstallMessages.TooLongOrBadCharacters;
                    return null;
                }
            }

            string full;
            try
            {
                full = Path.GetFullPath(value);
            }
            catch (ArgumentException)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }
            catch (NotSupportedException)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }
            catch (PathTooLongException)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }
            catch (System.Security.SecurityException)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }

            full = PathText.TrimTrailingSeparators(full);
            if (!PathText.IsDriveAbsolute(full) || full.IndexOf('/') >= 0 || full.IndexOf("\\\\", StringComparison.Ordinal) >= 0)
            {
                failure = InstallMessages.LocalDrive;
                return null;
            }

            if (full.Length > MaxPathLength)
            {
                failure = InstallMessages.TooLongOrBadCharacters;
                return null;
            }

            return full;
        }

        private static InstallPathResult Refuse(string? full, string message) =>
            new InstallPathResult(false, full, InstallPathKind.Refused, InstallPathKind.Refused, message);

        private static InstallPathResult Usable(string full, InstallPathKind kind, string message) =>
            new InstallPathResult(true, full, kind, kind, message);
    }
}
