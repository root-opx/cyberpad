using System.ComponentModel;
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
    private TaskCompletionSource<string?>? _pendingDialog;

    internal const string WindowClosedMessage = "The window closed before the export could finish.";

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
            var dialog = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
            Volatile.Write(ref _pendingDialog, dialog);
            string? path;
            try
            {
                path = await PostToUiAsync(_ui, () => AskForPath(kind, safeName), dialog).ConfigureAwait(false);
            }
            finally
            {
                Interlocked.CompareExchange(ref _pendingDialog, null, dialog);
            }
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

    /// <summary>
    /// Fails an export whose Save dialog has been posted but not yet answered. The window calls this when it closes,
    /// so the page's request ends with a failure instead of waiting forever. Safe to call from any thread, any time.
    /// </summary>
    public void CancelPendingDialog() =>
        Volatile.Read(ref _pendingDialog)?.TrySetException(new StoreException(WindowClosedMessage));

    private string? AskForPath(ExportKind kind, string safeName)
    {
        if (_ui.IsDisposed || !_ui.IsHandleCreated) throw new StoreException(WindowClosedMessage);
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

    /// <summary>
    /// Posts <paramref name="func"/> to the UI thread and completes <paramref name="tcs"/> with its result or exception.
    /// It always posts, never runs inline, even when already on the UI thread. The caller is typically still inside
    /// WebView2's WebMessageReceived handler, and a modal dialog must not run its message loop there (it would hold
    /// back later page messages, such as autosaves, until the dialog closes). If the window is gone, the task faults
    /// with a <see cref="StoreException"/>; if <paramref name="tcs"/> is completed before the post runs (the window
    /// is closing), <paramref name="func"/> is skipped.
    /// </summary>
    internal static Task<T> PostToUiAsync<T>(ISynchronizeInvoke ui, Func<T> func, TaskCompletionSource<T> tcs)
    {
        try
        {
            ui.BeginInvoke(new Action(() =>
            {
                if (tcs.Task.IsCompleted) return;
                try
                {
                    tcs.TrySetResult(func());
                }
                catch (Exception ex)
                {
                    // Not swallowed: the exception is handed to the awaiting caller, which reports it.
                    tcs.TrySetException(ex);
                }
            }), null);
        }
        catch (InvalidOperationException ex)
        {
            // No window handle, or the window was disposed (ObjectDisposedException derives from this).
            tcs.TrySetException(new StoreException(WindowClosedMessage, ex));
        }
        return tcs.Task;
    }
}
