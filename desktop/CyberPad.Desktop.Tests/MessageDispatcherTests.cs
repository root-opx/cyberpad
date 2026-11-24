using System.Text.Json;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public class MessageDispatcherTests
{
    private const string Src = "https://cyberpad.example/";

    private static (MessageDispatcher d, FakeHostActions f, List<string> log) Make()
    {
        var f = new FakeHostActions();
        var log = new List<string>();
        return (new MessageDispatcher(f, log.Add), f, log);
    }

    private static JsonElement Parse(string? json) => JsonDocument.Parse(json!).RootElement;

    [Fact]
    public async Task Load_RepliesWithFilesVersionAndDataDir()
    {
        var (d, _, _) = Make();
        var r = Parse(await d.HandleAsync(Src, """{"type":"load","id":"r1"}"""));
        Assert.Equal("loaded", r.GetProperty("type").GetString());
        Assert.Equal("r1", r.GetProperty("id").GetString());
        Assert.Equal("m", r.GetProperty("main").GetString());
        Assert.Equal("b", r.GetProperty("backup").GetString());
        Assert.Equal("1.0.0", r.GetProperty("version").GetString());
        Assert.Equal(@"C:\data", r.GetProperty("dataDir").GetString());
    }

    [Fact]
    public async Task Load_NoFiles_RepliesWithNulls()
    {
        var (d, f, _) = Make();
        f.LoadResult = (null, null);
        var r = Parse(await d.HandleAsync(Src, """{"type":"load","id":"r1"}"""));
        Assert.Equal(JsonValueKind.Null, r.GetProperty("main").ValueKind);
        Assert.Equal(JsonValueKind.Null, r.GetProperty("backup").ValueKind);
    }

    [Fact]
    public async Task Save_CallsStoreAndRepliesSaved()
    {
        var (d, f, _) = Make();
        var reply = await d.HandleAsync(Src, """{"type":"save","id":"r1","data":"x"}""");
        Assert.Equal("x", f.Saved);
        Assert.Equal("""{"type":"saved","id":"r1"}""", reply);
    }

    [Fact]
    public async Task Save_StoreFailure_RepliesSaveFailedWithoutContent()
    {
        var (d, f, log) = Make();
        f.SaveThrows = new StoreException("Disk is full.");
        var r = Parse(await d.HandleAsync(Src, """{"type":"save","id":"r1","data":"SECRET-DATA"}"""));
        Assert.Equal("saveFailed", r.GetProperty("type").GetString());
        Assert.Equal("Disk is full.", r.GetProperty("reason").GetString());
        Assert.DoesNotContain(log, l => l.Contains("SECRET-DATA"));
    }

    [Fact]
    public async Task Save_UnexpectedException_LogsTypeOnlyAndRepliesGenericFailure()
    {
        var (d, f, log) = Make();
        f.SaveThrows = new InvalidOperationException("SECRET-DATA in message");
        var reply = await d.HandleAsync(Src, """{"type":"save","id":"r1","data":"SECRET-DATA"}""");
        var r = Parse(reply);
        Assert.Equal("saveFailed", r.GetProperty("type").GetString());
        Assert.DoesNotContain("SECRET-DATA", reply);
        Assert.Equal(new[] { "save: unexpected InvalidOperationException" }, log);
    }

    [Fact]
    public async Task Load_UnexpectedException_RepliesRejected()
    {
        var (d, f, log) = Make();
        f.LoadThrows = new IOException("boom");
        var r = Parse(await d.HandleAsync(Src, """{"type":"load","id":"r1"}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal(new[] { "load: unexpected IOException" }, log);
    }

    [Fact]
    public async Task Quarantine_CallsActionAndReplies()
    {
        var (d, f, _) = Make();
        var reply = await d.HandleAsync(Src, """{"type":"quarantine","id":"q1"}""");
        Assert.Equal(1, f.QuarantineCalls);
        Assert.Equal("""{"type":"quarantined","id":"q1"}""", reply);
    }

    [Fact]
    public async Task ExportFile_SanitizesNameAndForwardsKind()
    {
        var (d, f, _) = Make();
        var reply = await d.HandleAsync(Src, """{"type":"exportFile","id":"e1","kind":"iocCsv","suggestedName":"..\\..\\x","text":"t"}""");
        Assert.Equal((ExportKind.IocCsv, "x.csv", "t"), f.Exported);
        Assert.Equal("""{"type":"exported","id":"e1","name":"x.csv"}""", reply);
    }

    [Fact]
    public async Task ExportFile_Cancelled_RepliesExportCancelled()
    {
        var (d, f, _) = Make();
        f.ExportResult = null;
        var reply = await d.HandleAsync(Src, """{"type":"exportFile","id":"e1","kind":"note","suggestedName":"n","text":"t"}""");
        Assert.Equal("""{"type":"exportCancelled","id":"e1"}""", reply);
    }

    [Fact]
    public async Task ExportFile_StoreFailure_RepliesExportFailed()
    {
        var (d, f, _) = Make();
        f.ExportThrows = new StoreException("Access denied.");
        var r = Parse(await d.HandleAsync(Src, """{"type":"exportFile","id":"e1","kind":"note","suggestedName":"n","text":"t"}"""));
        Assert.Equal("exportFailed", r.GetProperty("type").GetString());
        Assert.Equal("Access denied.", r.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task ExportFile_OverlongName_IsRejected()
    {
        var (d, f, _) = Make();
        var json = $$"""{"type":"exportFile","id":"e1","kind":"note","suggestedName":"{{new string('a', 121)}}","text":"t"}""";
        var r = Parse(await d.HandleAsync(Src, json));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Null(f.Exported);
    }

    [Fact]
    public async Task Flushed_CallsActionAndRepliesNothing()
    {
        var (d, f, _) = Make();
        Assert.Null(await d.HandleAsync(Src, """{"type":"flushed"}"""));
        Assert.Equal(1, f.FlushedCalls);
    }

    [Fact]
    public async Task Flushed_WithExtraField_IsRejected()
    {
        var (d, f, _) = Make();
        Assert.Null(await d.HandleAsync(Src, """{"type":"flushed","id":"a"}"""));
        Assert.Equal(0, f.Calls);
    }

    [Fact]
    public async Task FlushFailed_CallsActionAndRepliesNothing()
    {
        var (d, f, _) = Make();
        Assert.Null(await d.HandleAsync(Src, """{"type":"flushFailed"}"""));
        Assert.Equal(1, f.FlushFailedCalls);
        Assert.Equal(0, f.FlushedCalls);
    }

    [Theory]
    [InlineData("""{"type":"flushFailed","id":"a"}""")]
    [InlineData("""{"type":"flushFailed","reason":"x"}""")]
    [InlineData("""{"type":"flushFailed","type":"flushFailed"}""")]
    public async Task FlushFailed_WithExtraOrDuplicateField_IsRejected(string json)
    {
        var (d, f, log) = Make();
        Assert.Null(await d.HandleAsync(Src, json));
        Assert.Equal(0, f.Calls);
        Assert.Single(log);
    }

    [Fact]
    public async Task FlushFailed_WaitsForARunningSave()
    {
        var (d, f, _) = Make();
        f.DelayMs = 150;
        var save = d.HandleAsync(Src, """{"type":"save","id":"s1","data":"x"}""");
        var flush = d.HandleAsync(Src, """{"type":"flushFailed"}""");
        await Task.WhenAll(save, flush);
        Assert.Equal("x", f.Saved);
        Assert.Equal(1, f.FlushFailedCalls);
        Assert.Equal(1, f.MaxConcurrency);
    }

    [Fact]
    public async Task DocumentUriSource_IsAccepted()
    {
        var (d, _, _) = Make();
        var r = Parse(await d.HandleAsync("https://cyberpad.example/index.html", """{"type":"load","id":"r1"}"""));
        Assert.Equal("loaded", r.GetProperty("type").GetString());
    }

    [Theory]
    [InlineData("https://evil.example/")]
    [InlineData("https://cyberpad.example.evil.com/")]
    [InlineData("")]
    public async Task WrongOrigin_IsRejectedWithoutCallingActions(string source)
    {
        var (d, f, _) = Make();
        Assert.Null(await d.HandleAsync(source, """{"type":"save","id":"a","data":"x"}"""));
        Assert.Equal(0, f.Calls);
    }

    [Theory]
    [InlineData("""{"type":"delete","id":"a"}""")]
    [InlineData("""{"type":"save","id":"a","data":5}""")]
    [InlineData("""{"type":"save","id":"a","data":"x","path":"C:\\x"}""")]
    [InlineData("""{"type":"save","id":"a"}""")]
    [InlineData("""{"type":"save","id":"a","data":"x","data":"y"}""")]
    [InlineData("""{"type":"load"}""")]
    [InlineData("""{"type":"load","id":"../../x"}""")]
    [InlineData("""{"type":"load","id":"a\n"}""")]
    [InlineData("""{"type":"exportFile","id":"a","kind":"exe","suggestedName":"x","text":"t"}""")]
    [InlineData("""{"type":"exportFile","id":"a","kind":"note","suggestedName":7,"text":"t"}""")]
    [InlineData("""[1,2]""")]
    [InlineData("""not json""")]
    [InlineData("""{"type":{"a":{"b":{"c":{"d":1}}}}}""")]
    public async Task InvalidMessages_AreRejectedAndNoActionRuns(string json)
    {
        var (d, f, log) = Make();
        var reply = await d.HandleAsync(Src, json);
        Assert.Equal(0, f.Calls);
        Assert.Single(log);
        if (reply is not null) Assert.Equal("rejected", Parse(reply).GetProperty("type").GetString());
    }

    [Fact]
    public async Task Rejection_WithValidId_EchoesIdAndLogsNoContent()
    {
        var (d, _, log) = Make();
        var r = Parse(await d.HandleAsync(Src, """{"type":"save","id":"a1","data":"SECRET-DATA","extra":1}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal("a1", r.GetProperty("id").GetString());
        Assert.Equal(new[] { "save: unexpected field" }, log);
    }

    [Fact]
    public async Task OversizeData_IsRejected()
    {
        var (d, f, _) = Make();
        var json = $$"""{"type":"save","id":"a","data":"{{new string('a', MessageDispatcher.MaxTextChars + 1)}}"}""";
        var r = Parse(await d.HandleAsync(Src, json));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Null(f.Saved);
    }

    [Fact]
    public async Task OversizeRawMessage_IsRejectedBeforeParsing()
    {
        var (d, f, log) = Make();
        var json = new string(' ', checked((int)(6L * MessageDispatcher.MaxTextChars + 65537)));
        Assert.Null(await d.HandleAsync(Src, json));
        Assert.Equal(0, f.Calls);
        Assert.Equal(new[] { "?: message too large" }, log);
    }

    [Fact]
    public async Task EscapedLoneSurrogateInData_IsRejectedWithIdAndNoThrow()
    {
        var (d, f, log) = Make();
        var r = Parse(await d.HandleAsync(Src, """{"type":"save","id":"a1","data":"\ud800"}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal("a1", r.GetProperty("id").GetString());
        Assert.Null(f.Saved);
        Assert.Equal(new[] { "save: invalid string" }, log);
    }

    [Fact]
    public async Task EscapedLoneSurrogateInPropertyName_IsRejectedWithoutThrowing()
    {
        var (d, f, log) = Make();
        // The name comparison for "type" already throws, so nothing is known about the message: null reply, content-free log.
        Assert.Null(await d.HandleAsync(Src, """{"type":"save","id":"a1","data":"x","\ud800":1}"""));
        Assert.Equal(0, f.Calls);
        Assert.Equal(new[] { "?: invalid string" }, log);
    }

    [Fact]
    public async Task UnescapedLoneSurrogateInRawText_IsRejectedWithoutThrowing()
    {
        var (d, f, log) = Make();
        var json = "{\"type\":\"save\",\"id\":\"a1\",\"data\":\"" + '\ud800' + "\"}";
        Assert.Null(await d.HandleAsync(Src, json));
        Assert.Equal(0, f.Calls);
        Assert.Equal(new[] { "?: invalid string" }, log);
    }

    [Fact]
    public async Task Messages_AreHandledOneAtATime()
    {
        var (d, f, _) = Make();
        f.DelayMs = 50;
        await Task.WhenAll(
            d.HandleAsync(Src, """{"type":"save","id":"a","data":"1"}"""),
            d.HandleAsync(Src, """{"type":"save","id":"b","data":"2"}"""));
        Assert.Equal(1, f.MaxConcurrency);
        Assert.Equal(2, f.Calls);
    }

    [Fact]
    public async Task Save_CompletesWhileAnExportDialogIsOpen()
    {
        var (d, f, _) = Make();
        f.ExportBlocker = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);

        var export = d.HandleAsync(Src, """{"type":"exportFile","id":"e1","kind":"note","suggestedName":"n","text":"t"}""");
        await f.ExportEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var save = d.HandleAsync(Src, """{"type":"save","id":"s1","data":"x"}""");
        var saved = Parse(await save.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal("saved", saved.GetProperty("type").GetString());
        Assert.Equal("s1", saved.GetProperty("id").GetString());
        Assert.Equal("x", f.Saved);
        Assert.False(export.IsCompleted);

        f.ExportBlocker.SetResult("n.md");
        var exported = Parse(await export.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal("exported", exported.GetProperty("type").GetString());
        Assert.Equal("e1", exported.GetProperty("id").GetString());
    }

    [Fact]
    public async Task Export_IsStillValidatedBeforeTheActionRuns()
    {
        var (d, f, log) = Make();
        f.ExportBlocker = new TaskCompletionSource<string?>();
        var r = Parse(await d.HandleAsync(Src, """{"type":"exportFile","id":"e1","kind":"exe","suggestedName":"n","text":"t"}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal(0, f.Calls);
        Assert.Equal(new[] { "exportFile: unknown kind" }, log);
    }
}
