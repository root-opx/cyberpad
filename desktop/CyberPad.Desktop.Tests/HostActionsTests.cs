using System.ComponentModel;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public sealed class HostActionsTests
{
    private const string DataDir = @"C:\Users\u\AppData\Local\CyberPad";

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
        var host = new HostActions(new NoteStore(Path.Combine(Path.GetTempPath(), "cyberpad-unused")), "1.0.0", control, () => { });

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
        var host = new HostActions(new NoteStore(Path.Combine(Path.GetTempPath(), "cyberpad-unused")), "1.0.0", control, () => { });
        host.CancelPendingDialog();
    }
}
