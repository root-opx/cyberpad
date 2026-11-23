using System.Globalization;

namespace CyberPad.Desktop.Storage;

/// <summary>Persists the page's serialized state with a one-generation backup. Never logs or reports content.</summary>
public sealed class NoteStore
{
    public const string MainFile = "notes.json";
    public const string BackupFile = "notes.json.bak";
    public const string TempFile = "notes.json.tmp";

    public NoteStore(string dataDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDir);
        DataDir = dataDir;
    }

    public string DataDir { get; }

    private string MainPath => Path.Combine(DataDir, MainFile);
    private string BackupPath => Path.Combine(DataDir, BackupFile);
    private string TempPath => Path.Combine(DataDir, TempFile);

    public (string? Main, string? Backup) Load() => (ReadIfExists(MainPath), ReadIfExists(BackupPath));

    public void Save(string data)
    {
        ArgumentNullException.ThrowIfNull(data);
        try
        {
            Directory.CreateDirectory(DataDir);
            AtomicFile.WriteDurably(TempPath, data);
            if (File.Exists(MainPath))
                File.Replace(TempPath, MainPath, BackupPath);
            else
                File.Move(TempPath, MainPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (File.Exists(TempPath)) AtomicFile.DeleteQuietly(TempPath);
            throw new StoreException("The notes could not be saved to disk.", ex);
        }
    }

    /// <summary>Renames (never deletes) unreadable store files so they can be recovered by hand.</summary>
    public IReadOnlyList<string> Quarantine(DateTimeOffset now)
    {
        var stamp = now.UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        var moved = new List<string>();
        try
        {
            Move(MainPath, $"notes.unreadable-{stamp}.json", moved);
            Move(BackupPath, $"notes.unreadable-{stamp}.bak.json", moved);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException("The unreadable notes files could not be set aside.", ex);
        }
        return moved;
    }

    private void Move(string source, string newName, List<string> moved)
    {
        if (!File.Exists(source)) return;
        File.Move(source, Path.Combine(DataDir, newName), overwrite: false);
        moved.Add(newName);
    }

    private static string? ReadIfExists(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException("The notes file could not be read.", ex);
        }
    }
}
