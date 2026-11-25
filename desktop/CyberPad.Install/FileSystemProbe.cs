using System;
using System.IO;
using System.Linq;
using System.Security;

namespace CyberPad.Install
{
    /// <summary>The real <see cref="IFileSystemProbe"/>. Read-only apart from <see cref="CanCreateFileIn"/>, which creates and deletes one temporary file.</summary>
    public sealed class FileSystemProbe : IFileSystemProbe
    {
        public DriveKind GetDriveKind(string root)
        {
            try
            {
                switch (new DriveInfo(root).DriveType)
                {
                    case DriveType.Fixed:
                        return DriveKind.Fixed;
                    case DriveType.Removable:
                        return DriveKind.Removable;
                    case DriveType.Network:
                        return DriveKind.Network;
                    case DriveType.CDRom:
                        return DriveKind.CdRom;
                    case DriveType.Ram:
                        return DriveKind.Ram;
                    case DriveType.NoRootDirectory:
                        return DriveKind.NoRootDirectory;
                    default:
                        return DriveKind.Unknown;
                }
            }
            catch (ArgumentException)
            {
                return DriveKind.Unknown;
            }
            catch (IOException)
            {
                return DriveKind.Unknown;
            }
            catch (UnauthorizedAccessException)
            {
                return DriveKind.Unknown;
            }
        }

        public bool DirectoryExists(string path) => Directory.Exists(path);

        public bool FileExists(string path) => File.Exists(path);

        public bool IsEmptyDirectory(string path)
        {
            try
            {
                return Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any();
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

        public bool IsReparsePoint(string path)
        {
            try
            {
                return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
            catch (IOException)
            {
                return true; // cannot tell: treat as a link, which refuses the folder
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
            catch (ArgumentException)
            {
                return true;
            }
        }

        public bool CanCreateFileIn(string directory)
        {
            string probe = Path.Combine(directory, ".cyberpad-write-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose))
                {
                    return true;
                }
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (SecurityException)
            {
                return false;
            }
        }

        public bool CanOpenForWriting(string file)
        {
            try
            {
                using (new FileStream(file, FileMode.Open, FileAccess.Write, FileShare.None))
                {
                    return true;
                }
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

        public Stream? TryOpenRead(string file)
        {
            try
            {
                return new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }
    }
}
