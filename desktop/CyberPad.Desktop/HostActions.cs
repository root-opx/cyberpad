using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop;

/// <summary>The real host behind the page bridge: disk I/O on worker threads, dialogs on the UI thread.</summary>
public sealed class HostActions : IHostActions
{
    private readonly NoteStore _store;
    private readonly Control _ui;
    private readonly Action _onFlushed;
    private int _exportOpen;

    /// <param name="ui">The window that owns the Save dialog; its thread is the UI thread.</param>
    /// <param name="onFlushed">Called (from any thread) when the page reports it has sealed and saved its notes.</param>
    public HostActions(NoteStore store, string version, Control ui, Action onFlushed)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);
        ArgumentNullException.ThrowIfNull(ui);
        ArgumentNullException.ThrowIfNull(onFlushed);
        _store = store;
        Version = version;
        _ui = ui;
        _onFlushed = onFlushed;
    }

    public string Version { get; }

    public string DataDir => _store.DataDir;

    public Task<(string? Main, string? Backup)> LoadAsync() => Task.Run(_store.Load);

    public Task SaveAsync(string data) => Task.Run(() => _store.Save(data));

    public Task QuarantineAsync() => Task.Run(() => { _store.Quarantine(DateTimeOffset.UtcNow); });

    public async Task<string?> ExportAsync(ExportKind kind, string safeName, string text)
    {
        // Exports are not serialized by the dispatcher (they wait on the user); never stack a second Save dialog.
        if (Interlocked.Exchange(ref _exportOpen, 1) == 1) throw new StoreException("Another export is already open.");
        try
        {
            var path = await OnUiThreadAsync(() => AskForPath(kind, safeName)).ConfigureAwait(false);
            if (path is null) return null;
            // An export must never replace notes.json, its backup, or anything else the host owns.
            if (IsInsideDataDir(path, DataDir)) throw new StoreException("Choose a folder outside the CyberPad data folder.");
            await Task.Run(() => AtomicFile.Write(path, text)).ConfigureAwait(false);
            return Path.GetFileName(path);
        }
        finally
        {
            Volatile.Write(ref _exportOpen, 0);
        }
    }

    /// <summary>
    /// True when <paramref name="path"/> is the data folder or anything below it. Full paths, compared
    /// case-insensitively, with a trailing separator on the folder so that a sibling such as "CyberPad2" is not matched.
    /// </summary>
    public static bool IsInsideDataDir(string path, string dataDir)
    {
        ArgumentException.ThrowIfNullOrEmpty(path);
        ArgumentException.ThrowIfNullOrEmpty(dataDir);
        var folder = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataDir)) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(path);
        return full.StartsWith(folder, StringComparison.OrdinalIgnoreCase)
            || string.Equals(Path.TrimEndingDirectorySeparator(full) + Path.DirectorySeparatorChar, folder, StringComparison.OrdinalIgnoreCase);
    }

    public void Flushed() => _onFlushed();

    private string? AskForPath(ExportKind kind, string safeName)
    {
        using var dialog = new SaveFileDialog
        {
            Filter = ExportKinds.DialogFilter(kind),
            FileName = safeName,
            OverwritePrompt = true,
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            DefaultExt = ExportKinds.Extension(kind).TrimStart('.'),
            AddExtension = true,
            RestoreDirectory = true,
        };
        return dialog.ShowDialog(_ui) == DialogResult.OK && dialog.FileName.Length > 0 ? dialog.FileName : null;
    }

    /// <summary>Runs <paramref name="func"/> on the UI thread without blocking the caller's thread.</summary>
    private Task<T> OnUiThreadAsync<T>(Func<T> func)
    {
        if (!_ui.InvokeRequired) return Task.FromResult(func());

        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ui.BeginInvoke(() =>
        {
            try
            {
                tcs.SetResult(func());
            }
            catch (Exception ex)
            {
                // Not swallowed: the exception is handed to the awaiting caller, which reports it.
                tcs.SetException(ex);
            }
        });
        return tcs.Task;
    }
}
