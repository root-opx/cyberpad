using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Bridge;

/// <summary>What the host can do on behalf of the page. Implemented by the real host and by test fakes.</summary>
public interface IHostActions
{
    string Version { get; }
    string DataDir { get; }
    Task<(string? Main, string? Backup)> LoadAsync();

    /// <exception cref="CyberPad.Desktop.Storage.StoreException">The write failed; the message is a safe user-facing reason.</exception>
    Task SaveAsync(string data);

    Task QuarantineAsync();

    /// <returns>The chosen file name, or null if the user cancelled.</returns>
    /// <exception cref="CyberPad.Desktop.Storage.StoreException">The write failed; the message is a safe user-facing reason.</exception>
    Task<string?> ExportAsync(ExportKind kind, string safeName, string text);

    // ---- file-linked notes. The page never sees a path: link ids in, file names out. ----
    // Link methods throw UnknownLinkException for an unknown id and StoreException for a user-facing failure.

    /// <summary>Asks for a path (Save dialog), writes the text there and links it. Null means the user cancelled.</summary>
    /// <param name="relinkId">When set, the existing link is moved onto the new file.</param>
    Task<FileLinkResult?> SaveAsFileAsync(LinkFormat format, string safeName, string text, string? relinkId);

    /// <summary>Opens the next queued path, otherwise asks with the Open dialog. Null means the user cancelled.</summary>
    Task<FileOpenResult?> OpenFileAsync();

    Task<WriteOutcome> WriteFileAsync(string linkId, string text, bool force);

    /// <returns>The file's text, or null if the file is missing.</returns>
    Task<string?> ReadFileAsync(string linkId);

    /// <summary>
    /// True when <paramref name="text"/>, encoded the way the link's record says, hashes to the record's SHA-256 (the last
    /// content CyberPad wrote or the user adopted). Reads no file, writes nothing.
    /// </summary>
    Task<bool> MatchesLastWriteAsync(string linkId, string text);

    Task<IReadOnlyDictionary<string, FileStatus>> CheckFilesAsync(IReadOnlyList<string> linkIds);

    Task UnlinkFileAsync(string linkId);

    Task RevealFileAsync(string linkId);

    /// <summary>Drops every link whose id is not in <paramref name="keep"/>.</summary>
    Task PruneLinksAsync(IReadOnlyList<string> keep);

    /// <summary>The page sealed and saved everything it had: the pending close may go ahead.</summary>
    void Flushed();

    /// <summary>The page could not save its latest changes: the pending close must ask the user first.</summary>
    void FlushFailed();
}
