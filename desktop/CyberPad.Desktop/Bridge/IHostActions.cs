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

    void Flushed();
}
