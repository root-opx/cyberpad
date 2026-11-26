using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

/// <summary>Shared fake host for the dispatcher tests. Configurable results; blockers for concurrency tests.</summary>
internal sealed class FakeHostActions : IHostActions
{
    public string Version => "1.0.0";
    public string DataDir => @"C:\data";
    public (string?, string?) LoadResult = ("m", "b");
    public string? Saved;
    public Exception? SaveThrows;
    public Exception? LoadThrows;
    public (ExportKind Kind, string Name, string Text)? Exported;
    public string? ExportResult = "x.csv";
    public Exception? ExportThrows;
    public int FlushedCalls, FlushFailedCalls, QuarantineCalls, Calls, DelayMs;
    private int _running, _max;
    public int MaxConcurrency => _max;

    public Task<(string? Main, string? Backup)> LoadAsync()
    {
        Calls++;
        if (LoadThrows is not null) throw LoadThrows;
        return Task.FromResult(LoadResult);
    }

    public async Task SaveAsync(string data)
    {
        Calls++;
        var now = Interlocked.Increment(ref _running);
        lock (this) _max = Math.Max(_max, now);
        try
        {
            if (DelayMs > 0) await Task.Delay(DelayMs);
            if (SaveThrows is not null) throw SaveThrows;
            Saved = data;
        }
        finally { Interlocked.Decrement(ref _running); }
    }

    public HostTheme? ThemeSet;
    public int ThemeCalls;
    public Exception? ThemeThrows;

    public Task SetThemeAsync(HostTheme theme)
    {
        ThemeCalls++;
        if (ThemeThrows is not null) throw ThemeThrows;
        ThemeSet = theme;
        return Task.CompletedTask;
    }

    public Task QuarantineAsync() { Calls++; QuarantineCalls++; return Task.CompletedTask; }

    /// <summary>When set, ExportAsync waits on this (like a Save dialog the user has left open).</summary>
    public TaskCompletionSource<string?>? ExportBlocker;
    public readonly TaskCompletionSource ExportEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task<string?> ExportAsync(ExportKind kind, string safeName, string text)
    {
        Calls++;
        if (ExportThrows is not null) throw ExportThrows;
        Exported = (kind, safeName, text);
        ExportEntered.TrySetResult();
        return ExportBlocker?.Task ?? Task.FromResult(ExportResult);
    }

    // ---- linked files ----
    public (LinkFormat Format, string Name, string Text, string? RelinkId)? SavedAs;
    public FileLinkResult? SaveAsResult = new("0123456789abcdef0123456789abcdef", "n.md", LinkFormat.Md);
    public Exception? FileThrows;
    public FileOpenResult? OpenResult = new("0123456789abcdef0123456789abcdef", "o.md", LinkFormat.Md, "hello", false);
    public (string LinkId, string Text, bool Force)? Written;
    public WriteOutcome WriteResult = WriteOutcome.Written;
    public string? ReadResult = "file text";
    public bool MatchResult = true;
    public (string LinkId, string Text)? Matched;
    public IReadOnlyList<string>? Checked;
    public Dictionary<string, FileStatus> CheckResult = new();
    public string? Unlinked, Revealed;
    public IReadOnlyList<string>? Pruned;
    public int FileCalls;

    /// <summary>When set, WriteFileAsync waits on this (a slow network drive).</summary>
    public TaskCompletionSource? WriteBlocker;
    public readonly TaskCompletionSource WriteEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _fileRunning, _fileMax;
    public int MaxFileConcurrency => _fileMax;

    public Task<FileLinkResult?> SaveAsFileAsync(LinkFormat format, string safeName, string text, string? relinkId)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        SavedAs = (format, safeName, text, relinkId);
        return Task.FromResult(SaveAsResult);
    }

    public Task<FileOpenResult?> OpenFileAsync()
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        return Task.FromResult(OpenResult);
    }

    public async Task<WriteOutcome> WriteFileAsync(string linkId, string text, bool force)
    {
        FileCalls++;
        var now = Interlocked.Increment(ref _fileRunning);
        lock (this) _fileMax = Math.Max(_fileMax, now);
        try
        {
            WriteEntered.TrySetResult();
            if (WriteBlocker is not null) await WriteBlocker.Task;
            if (FileThrows is not null) throw FileThrows;
            Written = (linkId, text, force);
            return WriteResult;
        }
        finally { Interlocked.Decrement(ref _fileRunning); }
    }

    public Task<string?> ReadFileAsync(string linkId)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        return Task.FromResult(ReadResult);
    }

    public Task<bool> MatchesLastWriteAsync(string linkId, string text)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        Matched = (linkId, text);
        return Task.FromResult(MatchResult);
    }

    public Task<IReadOnlyDictionary<string, FileStatus>> CheckFilesAsync(IReadOnlyList<string> linkIds)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        Checked = linkIds;
        return Task.FromResult<IReadOnlyDictionary<string, FileStatus>>(CheckResult);
    }

    public Task UnlinkFileAsync(string linkId)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        Unlinked = linkId;
        return Task.CompletedTask;
    }

    public Task RevealFileAsync(string linkId)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        Revealed = linkId;
        return Task.CompletedTask;
    }

    public Task PruneLinksAsync(IReadOnlyList<string> keep)
    {
        FileCalls++;
        if (FileThrows is not null) throw FileThrows;
        Pruned = keep;
        return Task.CompletedTask;
    }

    public void Flushed() { Calls++; FlushedCalls++; }

    public void FlushFailed() { Calls++; FlushFailedCalls++; }
}
