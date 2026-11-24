using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Bridge;

/// <summary>A note was linked to a file. Carries the opaque link id and the file name only, never a path.</summary>
public sealed record FileLinkResult(string LinkId, string Name);

/// <summary>A file was opened. <paramref name="AlreadyLinked"/>: the file was already linked, and LinkId is that link.</summary>
public sealed record FileOpenResult(string LinkId, string Name, LinkFormat Format, string Text, bool AlreadyLinked);

/// <summary>The page named a link id the host does not know. The dispatcher answers with a rejection.</summary>
public sealed class UnknownLinkException : Exception
{
    public UnknownLinkException() : base("unknown link") { }
}

/// <summary>The chosen file is linked to another note. <see cref="LinkId"/> is that other link.</summary>
public sealed class FileAlreadyLinkedException : StoreException
{
    public const string Reason = "That file is already linked to another note.";

    public FileAlreadyLinkedException(string linkId) : base(Reason)
    {
        LinkId = linkId;
    }

    public string LinkId { get; }
}
