using System.IO;

namespace CyberPad.Install
{
    public enum DriveKind
    {
        Unknown,
        Fixed,
        Removable,
        Network,
        CdRom,
        Ram,
        NoRootDirectory,
    }

    /// <summary>
    /// Read-only questions about the file system, so the rules can be tested with a fake. Every member
    /// takes a normalised full path and never throws for a missing path.
    /// </summary>
    public interface IFileSystemProbe
    {
        /// <summary>The type of the drive whose root is given ("C:\").</summary>
        DriveKind GetDriveKind(string root);

        bool DirectoryExists(string path);

        bool FileExists(string path);

        /// <summary>True when the folder exists and holds no file or folder.</summary>
        bool IsEmptyDirectory(string path);

        /// <summary>True when the path is a link, junction or other reparse point. Fails closed (true) when it cannot tell.</summary>
        bool IsReparsePoint(string path);

        /// <summary>True when a new file can be created in the existing folder.</summary>
        bool CanCreateFileIn(string directory);

        /// <summary>True when the existing file can be opened for writing (false while a running program holds it).</summary>
        bool CanOpenForWriting(string file);

        /// <summary>Opens an existing file for reading, or returns null when it cannot.</summary>
        Stream? TryOpenRead(string file);
    }
}
