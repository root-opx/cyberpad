using System.Globalization;
using System.Text;

namespace CyberPad.Desktop.Storage;

/// <summary>Persists the page's serialized state with a one-generation backup. Never logs or reports content.</summary>
public sealed class NoteStore
{
    public const string MainFile = "notes.json";
    public const string BackupFile = "notes.json.bak";
    public const string TempFile = "notes.json.tmp";

    /// <summary>
    /// Largest notes file Load reads: a 64 MB-character state is at most 3 bytes per UTF-16 char in UTF-8, plus slack.
    /// Anything bigger was not written by CyberPad and is refused before it is read into memory.
    /// </summary>
    public const long MaxFileBytes = 3L * 64 * 1024 * 1024 + 1024 * 1024;

    private readonly long _maxFileBytes;
    private readonly Action<int> _sleep;

    public NoteStore(string dataDir) : this(dataDir, MaxFileBytes, null) { }

    /// <param name="maxFileBytes">Load limit (tests use a small one).</param>
    /// <param name="sleep">Waits between swap retries (tests record the calls instead).</param>
    internal NoteStore(string dataDir, long maxFileBytes = MaxFileBytes, Action<int>? sleep = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDir);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxFileBytes, 1);
        DataDir = dataDir;
        _maxFileBytes = maxFileBytes;
        _sleep = sleep ?? Thread.Sleep;
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
                SharingRetry.Run(() => File.Replace(TempPath, MainPath, BackupPath), _sleep);
            else
                SharingRetry.Run(() => File.Move(TempPath, MainPath), _sleep);
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

    private string? ReadIfExists(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            // Checked on the open handle, so the size read is the size of the file being read.
            if (stream.Length > _maxFileBytes) throw new StoreException("The notes file is too large to open.");
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException("The notes file could not be read.", ex);
        }
    }
}
