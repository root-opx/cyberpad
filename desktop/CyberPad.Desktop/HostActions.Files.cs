using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop;

// File-linked notes. The page only ever names link ids; paths stay in the host (LinkStore).
// Locking rule: _linkGate guards every lookup and every mutation+persist of the LinkStore from here, so a
// check-then-add pair is atomic. It is never held across a dialog or a file read/write.
public sealed partial class HostActions
{
    internal const string NotFoundMessage = "The file could not be found.";
    internal static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(2);

    private const int MaxParallelChecks = 8;

    private readonly object _linkGate = new();
    private readonly HashSet<string> _sessionLinkIds = new(StringComparer.Ordinal);
    private string? _lastFolder;

    /// <summary>Test seam: replaces the whole UI-thread Save dialog step. Returns the chosen path, or null for cancel.</summary>
    internal Func<LinkFormat, string, string?>? AskSavePath { get; set; }

    /// <summary>Test seam: replaces the whole UI-thread Open dialog step. Returns the chosen path, or null for cancel.</summary>
    internal Func<string?>? AskOpenPath { get; set; }

    public async Task<FileLinkResult?> SaveAsFileAsync(LinkFormat format, string safeName, string text, string? relinkId)
    {
        if (relinkId is not null) RequireLink(relinkId); // fail before the user picks a file

        var seam = AskSavePath;
        var chosen = seam is not null
            ? seam(format, safeName)
            : await RunDialogAsync(() => AskForSavePath(format, safeName), "Another dialog is already open.").ConfigureAwait(false);
        if (chosen is null) return null;

        if (!FilePathPolicy.TryNormalize(chosen, out var fullPath, out var chosenFormat))
            throw new StoreException(FilePathPolicy.UnsupportedMessage);
        if (chosenFormat != format)
            throw new StoreException($"Choose a file ending in {LinkFormats.Extension(format)}.");
        if (IsInsideDataDir(fullPath, DataDir)) throw new StoreException(DataFolderMessage);

        // Refuse before writing: never overwrite a file another note is linked to.
        ThrowIfLinkedToAnother(fullPath, relinkId);

        var record = await Task.Run(() => _files.WriteNew(fullPath, format, text)).ConfigureAwait(false);

        string linkId;
        lock (_linkGate)
        {
            ThrowIfLinkedToAnotherLocked(fullPath, relinkId); // an ungated Open may have linked it meanwhile
            if (relinkId is not null)
            {
                if (!_links.TryGet(relinkId, out _)) throw new UnknownLinkException();
                _links.Update(relinkId, record);
                linkId = relinkId;
            }
            else
            {
                linkId = _links.Add(record);
                _sessionLinkIds.Add(linkId);
            }
        }
        RememberFolder(fullPath);
        return new FileLinkResult(linkId, Path.GetFileName(fullPath));
    }

    public async Task<FileOpenResult?> OpenFileAsync()
    {
        try
        {
            return await OpenCoreAsync().ConfigureAwait(false);
        }
        finally
        {
            RaiseSafely(OpenCompleted);
        }
    }

    private async Task<FileOpenResult?> OpenCoreAsync()
    {
        string? chosen;
        if (_openQueue.TryDequeue(out var queued)) chosen = queued;
        else if (AskOpenPath is { } seam) chosen = seam();
        else chosen = await RunDialogAsync(AskForOpenPath, "Another dialog is already open.").ConfigureAwait(false);
        if (chosen is null) return null;

        // Queued paths (command line, pipe) are untrusted too: the same policy as a dialog result.
        if (!FilePathPolicy.TryNormalize(chosen, out var fullPath, out var format))
            throw new StoreException(FilePathPolicy.UnsupportedMessage);
        if (IsInsideDataDir(fullPath, DataDir)) throw new StoreException(DataFolderMessage);

        var name = Path.GetFileName(fullPath);
        string? existingId;
        LinkRecord? existing = null;
        lock (_linkGate)
        {
            existingId = _links.FindByPath(fullPath);
            if (existingId is not null) _links.TryGet(existingId, out existing);
        }
        if (existingId is not null && existing is not null)
            return await OpenLinkedAsync(existingId, existing, name, fullPath).ConfigureAwait(false);

        var (record, text) = await Task.Run(() => ReadNewMapped(fullPath, format)).ConfigureAwait(false);

        string linkId;
        bool already;
        lock (_linkGate)
        {
            var raced = _links.FindByPath(fullPath);
            if (raced is not null)
            {
                // Linked by a concurrent save as: that link wins, and we just read its current text.
                _links.Update(raced, record);
                linkId = raced;
                already = true;
            }
            else
            {
                linkId = _links.Add(record);
                _sessionLinkIds.Add(linkId);
                already = false;
            }
        }
        return Remembered(new FileOpenResult(linkId, name, record.Format, text, already), fullPath);
    }

    private async Task<FileOpenResult> OpenLinkedAsync(string linkId, LinkRecord record, string name, string fullPath)
    {
        var (text, refreshed) = await Task.Run(() =>
        {
            var t = _files.ReadCurrent(record, out var fresh);
            return (t, fresh);
        }).ConfigureAwait(false);
        if (text is null) throw new StoreException(NotFoundMessage);
        PersistRefreshed(linkId, record, refreshed);
        return Remembered(new FileOpenResult(linkId, name, record.Format, text, AlreadyLinked: true), fullPath);
    }

    private FileOpenResult Remembered(FileOpenResult result, string fullPath)
    {
        RememberFolder(fullPath);
        return result;
    }

    private (LinkRecord Record, string Text) ReadNewMapped(string fullPath, LinkFormat format)
    {
        try
        {
            return _files.ReadNew(fullPath, format);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            throw new StoreException(NotFoundMessage, ex);
        }
    }

    public async Task<WriteOutcome> WriteFileAsync(string linkId, string text, bool force)
    {
        var record = RequireLink(linkId);
        var (outcome, updated) = await Task.Run(() =>
        {
            var o = _files.Write(record, text, force, out var u);
            return (o, u);
        }).ConfigureAwait(false);
        if (outcome == WriteOutcome.Written) PersistRefreshed(linkId, record, updated);
        return outcome;
    }

    public async Task<string?> ReadFileAsync(string linkId)
    {
        var record = RequireLink(linkId);
        var (text, refreshed) = await Task.Run(() =>
        {
            var t = _files.ReadCurrent(record, out var fresh);
            return (t, fresh);
        }).ConfigureAwait(false);
        if (text is not null) PersistRefreshed(linkId, record, refreshed);
        return text;
    }

    public async Task<IReadOnlyDictionary<string, FileStatus>> CheckFilesAsync(IReadOnlyList<string> linkIds)
    {
        ArgumentNullException.ThrowIfNull(linkIds);
        var records = new Dictionary<string, LinkRecord>(StringComparer.Ordinal);
        foreach (var id in linkIds)
        {
            if (!records.ContainsKey(id)) records[id] = RequireLink(id);
        }

        var results = new ConcurrentDictionary<string, FileStatus>(StringComparer.Ordinal);
        var options = new ParallelOptions { MaxDegreeOfParallelism = MaxParallelChecks };
        // Each Check blocks its pool thread for at most CheckTimeout; the whole batch runs off the UI thread.
        await Parallel.ForEachAsync(records, options, (entry, _) =>
        {
            var status = _files.Check(entry.Value, out var refreshed, CheckTimeout);
            results[entry.Key] = status;
            if (status == FileStatus.Ok) PersistRefreshed(entry.Key, entry.Value, refreshed);
            return ValueTask.CompletedTask;
        }).ConfigureAwait(false);
        return results;
    }

    public Task UnlinkFileAsync(string linkId)
    {
        lock (_linkGate)
        {
            if (!_links.Remove(linkId)) throw new UnknownLinkException();
        }
        return Task.CompletedTask;
    }

    public Task RevealFileAsync(string linkId)
    {
        var record = RequireLink(linkId);
        return Task.Run(() =>
        {
            if (!File.Exists(record.Path)) throw new StoreException(NotFoundMessage);
            var info = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
            info.ArgumentList.Add("/select,");
            info.ArgumentList.Add(record.Path);
            try
            {
                using var process = Process.Start(info);
            }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
            {
                throw new StoreException("The folder could not be opened.", ex);
            }
        });
    }

    public Task PruneLinksAsync(IReadOnlyList<string> keep)
    {
        ArgumentNullException.ThrowIfNull(keep);
        return Task.Run(() =>
        {
            lock (_linkGate)
            {
                // A link added this session may belong to a note the page has not saved yet: never prune it.
                var set = new HashSet<string>(keep, StringComparer.Ordinal);
                set.UnionWith(_sessionLinkIds);
                _links.Prune(set);
            }
        });
    }

    private LinkRecord RequireLink(string linkId)
    {
        lock (_linkGate)
        {
            if (linkId is not null && _links.TryGet(linkId, out var record)) return record;
        }
        throw new UnknownLinkException();
    }

    private void ThrowIfLinkedToAnother(string fullPath, string? ownLinkId)
    {
        lock (_linkGate) ThrowIfLinkedToAnotherLocked(fullPath, ownLinkId);
    }

    private void ThrowIfLinkedToAnotherLocked(string fullPath, string? ownLinkId)
    {
        var other = _links.FindByPath(fullPath);
        if (other is not null && !string.Equals(other, ownLinkId, StringComparison.Ordinal))
            throw new FileAlreadyLinkedException(other);
    }

    /// <summary>
    /// Stores a record refreshed by a successful file operation. The operation itself already succeeded, so a failure to
    /// persist is logged (type name only) instead of failing it; the next status check re-derives the record.
    /// </summary>
    private void PersistRefreshed(string linkId, LinkRecord before, LinkRecord after)
    {
        if (after == before) return;
        try
        {
            lock (_linkGate)
            {
                // Skip if the link was removed or moved to another file while the operation ran.
                if (_links.TryGet(linkId, out var current) && string.Equals(current.Path, before.Path, StringComparison.Ordinal))
                    _links.Update(linkId, after);
            }
        }
        catch (StoreException ex)
        {
            _log($"links: persist failed {ex.GetType().Name}");
        }
    }

    private void RememberFolder(string fullPath)
    {
        var folder = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrEmpty(folder)) Volatile.Write(ref _lastFolder, folder);
    }

    private string InitialFolder()
    {
        var last = Volatile.Read(ref _lastFolder);
        return last is not null && Directory.Exists(last)
            ? last
            : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    }

    private string? AskForSavePath(LinkFormat format, string safeName)
    {
        if (_ui.IsDisposed || !_ui.IsHandleCreated) throw new StoreException(WindowClosedMessage);
        using var dialog = new SaveFileDialog
        {
            Filter = LinkFormats.DialogFilter(format),
            FileName = safeName,
            OverwritePrompt = true,
            InitialDirectory = InitialFolder(),
            DefaultExt = LinkFormats.Extension(format).TrimStart('.'),
            AddExtension = true,
            RestoreDirectory = true,
        };
        return dialog.ShowDialog(_ui) == DialogResult.OK && dialog.FileName.Length > 0 ? dialog.FileName : null;
    }

    private string? AskForOpenPath()
    {
        if (_ui.IsDisposed || !_ui.IsHandleCreated) throw new StoreException(WindowClosedMessage);
        using var dialog = new OpenFileDialog
        {
            Filter = LinkFormats.OpenFilter,
            InitialDirectory = InitialFolder(),
            CheckFileExists = true,
            Multiselect = false,
            RestoreDirectory = true,
        };
        return dialog.ShowDialog(_ui) == DialogResult.OK && dialog.FileName.Length > 0 ? dialog.FileName : null;
    }
}
