using System.ComponentModel;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop;

/// <summary>The real host behind the page bridge: disk I/O on worker threads, dialogs on the UI thread.</summary>
public sealed partial class HostActions : IHostActions
{
    private readonly NoteStore _store;
    private readonly LinkStore _links;
    private readonly LinkedFiles _files;
    private readonly OpenRequestQueue _openQueue;
    private readonly Action<string> _log;
    private readonly Control _ui;
    private readonly Action _onFlushed;
    private readonly Action _onFlushFailed;
    private readonly Action<HostTheme> _applyTheme;
    private int _dialogOpen;
    private TaskCompletionSource<string?>? _pendingDialog;

    internal const string WindowClosedMessage = "The window closed before the export could finish.";
    internal const string DataFolderMessage = "Choose a folder outside the CyberPad data folder.";

    /// <summary>True while a Save or Open dialog (export or file) is posted or showing.</summary>
    public bool IsDialogOpen => Volatile.Read(ref _dialogOpen) == 1;

    /// <summary>Raised from any thread after a dialog closed (the window may then post queued open requests).</summary>
    public event Action? DialogClosed;

    /// <summary>Raised from any thread after every <see cref="OpenFileAsync"/> finished, however it ended.</summary>
    public event Action? OpenCompleted;

    /// <param name="ui">The window that owns the Save dialog; its thread is the UI thread.</param>
    /// <param name="onFlushed">Called (from any thread) when the page reports it has sealed and saved its notes.</param>
    /// <param name="onFlushFailed">Called (from any thread) when the page reports its latest changes could not be saved.</param>
    /// <param name="applyTheme">Called on the UI thread with the theme the page asked for.</param>
    /// <param name="log">Content-free diagnostics only (type names and reasons, never paths or text).</param>
    public HostActions(NoteStore store, LinkStore links, LinkedFiles files, OpenRequestQueue openQueue, string version,
        Control ui, Action onFlushed, Action onFlushFailed, Action<HostTheme> applyTheme, Action<string>? log = null)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(links);
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(openQueue);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);
        ArgumentNullException.ThrowIfNull(ui);
        ArgumentNullException.ThrowIfNull(onFlushed);
        ArgumentNullException.ThrowIfNull(onFlushFailed);
        ArgumentNullException.ThrowIfNull(applyTheme);
        _store = store;
        _links = links;
        _files = files;
        _openQueue = openQueue;
        _log = log ?? (_ => { });
        Version = version;
        _ui = ui;
        _onFlushed = onFlushed;
        _onFlushFailed = onFlushFailed;
        _applyTheme = applyTheme;
    }

    public string Version { get; }

    public string DataDir => _store.DataDir;

    public Task<(string? Main, string? Backup)> LoadAsync() => Task.Run(_store.Load);

    public Task SaveAsync(string data) => Task.Run(() => _store.Save(data));

    public Task QuarantineAsync() => Task.Run(() => { _store.Quarantine(DateTimeOffset.UtcNow); });

    public Task SetThemeAsync(HostTheme theme)
    {
        // A closed window is not an error: there is no title bar left to colour.
        if (_ui.IsDisposed || !_ui.IsHandleCreated) return Task.CompletedTask;
        return ApplyThemeOnUiAsync(_ui, _applyTheme, theme, _log);
    }

    /// <summary>
    /// Runs <paramref name="apply"/> on the UI thread (the window handle may only be used there). Only "the window closed
    /// before it ran" is absorbed; any other exception from the callback reaches the caller and is answered as rejected.
    /// </summary>
    internal static async Task ApplyThemeOnUiAsync(ISynchronizeInvoke ui, Action<HostTheme> apply, HostTheme theme, Action<string> log)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            await PostToUiAsync(ui, () => { apply(theme); return true; }, tcs).ConfigureAwait(false);
        }
        // Recognised by message: depends on WindowClosedMessage, thrown by PostToUiAsync/CancelPendingDialog when the window is gone.
        catch (StoreException ex) when (ex.Message == WindowClosedMessage)
        {
            log("theme: window closed");
        }
    }

    public async Task<string?> ExportAsync(ExportKind kind, string safeName, string text)
    {
        // Exports are not serialized by the dispatcher (they wait on the user); never stack a second dialog.
        var path = await RunDialogAsync(() => AskForPath(kind, safeName), "Another export is already open.").ConfigureAwait(false);
        if (path is null) return null;
        // An export must never replace notes.json, its backup, or anything else the host owns.
        if (IsInsideDataDir(path, DataDir)) throw new StoreException(DataFolderMessage);
        await Task.Run(() => AtomicFile.Write(path, text)).ConfigureAwait(false);
        return Path.GetFileName(path);
    }

    /// <summary>
    /// Runs a modal dialog on the UI thread, one at a time (exports and file dialogs share the slot).
    /// <see cref="CancelPendingDialog"/> fails it if the window closes first.
    /// </summary>
    private async Task<string?> RunDialogAsync(Func<string?> dialog, string busyMessage)
    {
        if (Interlocked.Exchange(ref _dialogOpen, 1) == 1) throw new StoreException(busyMessage);
        try
        {
            var tcs = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
            Volatile.Write(ref _pendingDialog, tcs);
            try
            {
                return await PostToUiAsync(_ui, dialog, tcs).ConfigureAwait(false);
            }
            finally
            {
                Interlocked.CompareExchange(ref _pendingDialog, null, tcs);
            }
        }
        finally
        {
            Volatile.Write(ref _dialogOpen, 0);
            RaiseSafely(DialogClosed);
        }
    }

    private void RaiseSafely(Action? handler)
    {
        try
        {
            handler?.Invoke();
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            _log($"host: notify failed {ex.GetType().Name}");
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

    public void FlushFailed() => _onFlushFailed();

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
