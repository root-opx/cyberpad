using System.ComponentModel;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public sealed class HostActionsTests
{
    private const string DataDir = @"C:\Users\u\AppData\Local\CyberPad";
    private static readonly string Unused = Path.Combine(Path.GetTempPath(), "cyberpad-unused");

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\notes.json")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\notes.json.bak")]
    [InlineData(@"c:\users\U\appdata\local\cyberpad\NOTES.JSON")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\WebView2\x.md")]
    [InlineData(@"C:\Users\u\AppData\Local\Temp\..\CyberPad\notes.json")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\.\window.json")]
    public void IsInsideDataDir_TrueForPathsInTheDataFolder(string chosen)
    {
        Assert.True(HostActions.IsInsideDataDir(chosen, DataDir));
        Assert.True(HostActions.IsInsideDataDir(chosen, DataDir + @"\"));
    }

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad2\notes.json")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad.md")]
    [InlineData(@"C:\Users\u\Documents\notes.json")]
    [InlineData(@"D:\CyberPad\notes.json")]
    public void IsInsideDataDir_FalseForPathsOutsideIt(string chosen)
    {
        Assert.False(HostActions.IsInsideDataDir(chosen, DataDir));
    }

    /// <summary>A UI thread stand-in: BeginInvoke only queues; nothing runs until <see cref="RunQueued"/>.</summary>
    private sealed class QueueingInvoker : ISynchronizeInvoke
    {
        public readonly Queue<Delegate> Queued = new();
        public Exception? BeginInvokeThrows;

        public bool InvokeRequired => false; // as if the caller were already on the UI thread

        public IAsyncResult BeginInvoke(Delegate method, object?[]? args)
        {
            if (BeginInvokeThrows is not null) throw BeginInvokeThrows;
            Queued.Enqueue(method);
            return Task.CompletedTask;
        }

        public void RunQueued()
        {
            while (Queued.Count > 0) Queued.Dequeue().DynamicInvoke();
        }

        public object? EndInvoke(IAsyncResult result) => null;

        public object? Invoke(Delegate method, object?[]? args) => throw new NotSupportedException();
    }

    private static TaskCompletionSource<string?> NewTcs() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    [Fact]
    public async Task PostToUiAsync_NeverRunsTheCallbackInline_EvenOnTheUiThread()
    {
        var ui = new QueueingInvoker();
        var ran = false;
        var task = HostActions.PostToUiAsync(ui, () => { ran = true; return "path"; }, NewTcs());

        Assert.False(ran);
        Assert.False(task.IsCompleted);
        Assert.Single(ui.Queued);

        ui.RunQueued();
        Assert.True(ran);
        Assert.Equal("path", await task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task PostToUiAsync_FaultsWithTheCallbacksException()
    {
        var ui = new QueueingInvoker();
        var boom = new StoreException("boom");
        var task = HostActions.PostToUiAsync<string?>(ui, () => throw boom, NewTcs());
        ui.RunQueued();
        Assert.Same(boom, await Assert.ThrowsAsync<StoreException>(() => task.WaitAsync(TimeSpan.FromSeconds(5))));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PostToUiAsync_FaultsWithStoreExceptionWhenTheWindowIsGone(bool disposed)
    {
        var ui = new QueueingInvoker
        {
            BeginInvokeThrows = disposed ? new ObjectDisposedException("MainForm") : new InvalidOperationException("no handle"),
        };
        var ran = false;
        var task = HostActions.PostToUiAsync(ui, () => { ran = true; return "path"; }, NewTcs());
        var ex = await Assert.ThrowsAsync<StoreException>(() => task.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(HostActions.WindowClosedMessage, ex.Message);
        Assert.False(ran);
    }

    [Fact]
    public async Task PostToUiAsync_SkipsTheCallbackWhenCancelledBeforeItRuns()
    {
        var ui = new QueueingInvoker();
        var tcs = NewTcs();
        var ran = false;
        var task = HostActions.PostToUiAsync(ui, () => { ran = true; return "path"; }, tcs);
        tcs.TrySetException(new StoreException(HostActions.WindowClosedMessage)); // what CancelPendingDialog does
        ui.RunQueued();
        Assert.False(ran);
        await Assert.ThrowsAsync<StoreException>(() => task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task ExportAsync_FailsCleanlyWithoutAWindowHandle_AndCanBeRetried()
    {
        using var control = new Control(); // never shown: no handle, so BeginInvoke has nowhere to post
        var host = new HostActions(new NoteStore(Unused), new LinkStore(Unused), new LinkedFiles(), new OpenRequestQueue(), "1.0.0", control, () => { }, () => { }, _ => { });

        for (var attempt = 0; attempt < 2; attempt++)
        {
            var ex = await Assert.ThrowsAsync<StoreException>(
                () => host.ExportAsync(ExportKind.Note, "n.md", "t").WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(HostActions.WindowClosedMessage, ex.Message); // not "Another export is already open."
        }
    }

    [Fact]
    public void CancelPendingDialog_WithNothingPending_DoesNothing()
    {
        using var control = new Control();
        var host = new HostActions(new NoteStore(Unused), new LinkStore(Unused), new LinkedFiles(), new OpenRequestQueue(), "1.0.0", control, () => { }, () => { }, _ => { });
        host.CancelPendingDialog();
    }

    [Fact]
    public void FlushedAndFlushFailed_CallTheirOwnCallbacks()
    {
        using var control = new Control();
        int flushed = 0, failed = 0;
        var host = new HostActions(new NoteStore(Unused), new LinkStore(Unused), new LinkedFiles(), new OpenRequestQueue(), "1.0.0", control,
            () => flushed++, () => failed++, _ => { });
        host.FlushFailed();
        Assert.Equal((0, 1), (flushed, failed));
        host.Flushed();
        Assert.Equal((1, 1), (flushed, failed));
    }

    [Fact]
    public void FlushTimeout_AsksFirstOnlyWhileALinkedFileOperationRuns()
    {
        Assert.Equal(MainForm.FlushTimeoutAction.AskFirst, MainForm.OnFlushTimeout(fileOperationInFlight: true));
        Assert.Equal(MainForm.FlushTimeoutAction.Close, MainForm.OnFlushTimeout(fileOperationInFlight: false));
    }

    [Fact]
    public void ClosePrompts_UseTheAgreedTexts()
    {
        Assert.Equal("CyberPad could not save your latest changes (to its notes or to a linked file). Close anyway?",
            MainForm.FlushFailedPrompt);
        Assert.Equal("CyberPad is still saving to a linked file. Close anyway?", MainForm.StillSavingPrompt);
    }

    /// <summary>Runs the posted delegate at once on the calling thread: no window, no message loop.</summary>
    private sealed class InlineInvoker : ISynchronizeInvoke
    {
        public bool InvokeRequired => false;
        public IAsyncResult BeginInvoke(Delegate method, object?[]? args) { method.DynamicInvoke(args); return null!; }
        public object? EndInvoke(IAsyncResult result) => null;
        public object? Invoke(Delegate method, object?[]? args) => method.DynamicInvoke(args);
    }

    /// <summary>Simulates a window that is gone: posting throws, as a handle-less control does.</summary>
    private sealed class ClosedInvoker : ISynchronizeInvoke
    {
        public bool InvokeRequired => false;
        public IAsyncResult BeginInvoke(Delegate method, object?[]? args) => throw new InvalidOperationException();
        public object? EndInvoke(IAsyncResult result) => null;
        public object? Invoke(Delegate method, object?[]? args) => throw new InvalidOperationException();
    }

    [Fact]
    public async Task SetTheme_WithNoWindowHandle_CompletesAndNeverCallsTheCallback()
    {
        using var control = new Control();
        var calls = 0;
        var host = new HostActions(new NoteStore(Unused), new LinkStore(Unused), new LinkedFiles(), new OpenRequestQueue(), "1.0.0", control,
            () => { }, () => { }, _ => calls++);
        await host.SetThemeAsync(HostTheme.Amber).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task ApplyThemeOnUi_CallsTheCallbackOnceWithTheTheme()
    {
        var seen = new List<HostTheme>();
        await HostActions.ApplyThemeOnUiAsync(new InlineInvoker(), seen.Add, HostTheme.Terminal, _ => { });
        Assert.Equal(new[] { HostTheme.Terminal }, seen);
    }

    [Fact]
    public async Task ApplyThemeOnUi_CallbackException_ReachesTheCaller()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            HostActions.ApplyThemeOnUiAsync(new InlineInvoker(), _ => throw new InvalidOperationException("boom"), HostTheme.Neon, _ => { }));
    }

    [Fact]
    public async Task ApplyThemeOnUi_WindowClosed_IsAbsorbedAndLogged()
    {
        var log = new List<string>();
        await HostActions.ApplyThemeOnUiAsync(new ClosedInvoker(), _ => { }, HostTheme.Neon, log.Add);
        Assert.Equal(new[] { "theme: window closed" }, log);
    }
}
