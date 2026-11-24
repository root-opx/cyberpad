using System.Text.Json;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public class FileMessageTests
{
    private const string Src = "https://cyberpad.example/";
    private const string L1 = "0123456789abcdef0123456789abcdef";
    private const string L2 = "fedcba9876543210fedcba9876543210";

    private static (MessageDispatcher d, FakeHostActions f, List<string> log) Make()
    {
        var f = new FakeHostActions();
        var log = new List<string>();
        return (new MessageDispatcher(f, log.Add), f, log);
    }

    private static JsonElement Parse(string? json) => JsonDocument.Parse(json!).RootElement;

    [Fact]
    public async Task SaveAsFile_ForwardsSanitizedNameAndReplies()
    {
        var (d, f, _) = Make();
        var r = Parse(await d.HandleAsync(Src, """{"type":"saveAsFile","id":"a","format":"md","suggestedName":"..\\x","text":"body"}"""));
        Assert.Equal((LinkFormat.Md, "x.md", "body", (string?)null), f.SavedAs);
        Assert.Equal("fileLinked", r.GetProperty("type").GetString());
        Assert.Equal("a", r.GetProperty("id").GetString());
        Assert.Equal(L1, r.GetProperty("linkId").GetString());
        Assert.Equal("n.md", r.GetProperty("name").GetString());
        Assert.Equal("md", r.GetProperty("format").GetString());
    }

    [Fact]
    public async Task SaveAsFile_Cancelled_RepliesFileCancelled()
    {
        var (d, f, _) = Make();
        f.SaveAsResult = null;
        Assert.Equal("""{"type":"fileCancelled","id":"a"}""",
            await d.HandleAsync(Src, """{"type":"saveAsFile","id":"a","format":"txt","suggestedName":"x","text":"t"}"""));
    }

    [Fact]
    public async Task RelinkFile_PassesLinkId()
    {
        var (d, f, _) = Make();
        f.SaveAsResult = new FileLinkResult(L1, "n.cpnote");
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"relinkFile","id":"a","linkId":"{{L1}}","format":"cpnote","suggestedName":"n","text":"t"}"""));
        Assert.Equal((LinkFormat.CpNote, "n.cpnote", "t", (string?)L1), f.SavedAs);
        Assert.Equal("fileLinked", r.GetProperty("type").GetString());
        Assert.Equal("cpnote", r.GetProperty("format").GetString());
    }

    [Fact]
    public async Task OpenFile_RepliesWithTextAndAlreadyLinked()
    {
        var (d, f, _) = Make();
        f.OpenResult = new FileOpenResult(L1, "o.md", LinkFormat.Md, "hello", true);
        var r = Parse(await d.HandleAsync(Src, """{"type":"openFile","id":"a"}"""));
        Assert.Equal("fileOpened", r.GetProperty("type").GetString());
        Assert.Equal(L1, r.GetProperty("linkId").GetString());
        Assert.Equal("o.md", r.GetProperty("name").GetString());
        Assert.Equal("md", r.GetProperty("format").GetString());
        Assert.Equal("hello", r.GetProperty("text").GetString());
        Assert.True(r.GetProperty("alreadyLinked").GetBoolean());
    }

    [Fact]
    public async Task OpenFile_Cancelled_RepliesFileCancelled()
    {
        var (d, f, _) = Make();
        f.OpenResult = null;
        Assert.Equal("""{"type":"fileCancelled","id":"a"}""", await d.HandleAsync(Src, """{"type":"openFile","id":"a"}"""));
    }

    [Theory]
    [InlineData(WriteOutcome.Written, "fileWritten")]
    [InlineData(WriteOutcome.Conflict, "fileConflict")]
    [InlineData(WriteOutcome.Missing, "fileMissing")]
    public async Task WriteFile_MapsOutcomes(WriteOutcome o, string type)
    {
        var (d, f, _) = Make();
        f.WriteResult = o;
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"writeFile","id":"a","linkId":"{{L1}}","text":"t","force":true}"""));
        Assert.Equal(type, r.GetProperty("type").GetString());
        Assert.Equal("a", r.GetProperty("id").GetString());
        Assert.Equal((L1, "t", true), f.Written);
    }

    [Fact]
    public async Task WriteFile_StoreFailure_RepliesFileFailedWithReason()
    {
        var (d, f, _) = Make();
        f.FileThrows = new StoreException("Disk is full.");
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"writeFile","id":"a","linkId":"{{L1}}","text":"t","force":false}"""));
        Assert.Equal("fileFailed", r.GetProperty("type").GetString());
        Assert.Equal("Disk is full.", r.GetProperty("reason").GetString());
        Assert.False(r.TryGetProperty("linkId", out _));
    }

    [Fact]
    public async Task UnexpectedException_LogsTypeOnlyAndRepliesGenericFileFailed()
    {
        var (d, f, log) = Make();
        f.FileThrows = new IOException(@"C:\secret\path.txt");
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"readFile","id":"a","linkId":"{{L1}}"}"""));
        Assert.Equal("fileFailed", r.GetProperty("type").GetString());
        Assert.Equal("The file operation failed.", r.GetProperty("reason").GetString());
        Assert.Contains(log, l => l.Contains("IOException"));
        Assert.DoesNotContain(log, l => l.Contains("secret"));
    }

    [Fact]
    public async Task ReadFile_RepliesText()
    {
        var (d, _, _) = Make();
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"readFile","id":"a","linkId":"{{L1}}"}"""));
        Assert.Equal("fileRead", r.GetProperty("type").GetString());
        Assert.Equal("file text", r.GetProperty("text").GetString());
    }

    [Fact]
    public async Task ReadFile_Missing_RepliesFileMissing()
    {
        var (d, f, _) = Make();
        f.ReadResult = null;
        Assert.Equal("""{"type":"fileMissing","id":"a"}""",
            await d.HandleAsync(Src, $$"""{"type":"readFile","id":"a","linkId":"{{L1}}"}"""));
    }

    [Fact]
    public async Task CheckFiles_RepliesStatusesLowercase()
    {
        var (d, f, _) = Make();
        f.CheckResult = new() { [L1] = FileStatus.Ok, [L2] = FileStatus.Changed, ["x"] = FileStatus.Missing, ["y"] = FileStatus.Unknown };
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"checkFiles","id":"a","linkIds":["{{L1}}","{{L2}}"]}"""));
        Assert.Equal("fileStatus", r.GetProperty("type").GetString());
        var s = r.GetProperty("statuses");
        Assert.Equal("ok", s.GetProperty(L1).GetString());
        Assert.Equal("changed", s.GetProperty(L2).GetString());
        Assert.Equal("missing", s.GetProperty("x").GetString());
        Assert.Equal("unknown", s.GetProperty("y").GetString());
        Assert.Equal(new[] { L1, L2 }, f.Checked);
    }

    [Fact]
    public async Task UnlinkAndReveal_Reply()
    {
        var (d, f, _) = Make();
        Assert.Equal("""{"type":"fileUnlinked","id":"a"}""", await d.HandleAsync(Src, $$"""{"type":"unlinkFile","id":"a","linkId":"{{L1}}"}"""));
        Assert.Equal("""{"type":"fileRevealed","id":"b"}""", await d.HandleAsync(Src, $$"""{"type":"revealFile","id":"b","linkId":"{{L2}}"}"""));
        Assert.Equal(L1, f.Unlinked);
        Assert.Equal(L2, f.Revealed);
    }

    [Fact]
    public async Task UnknownLink_IsRejectedWithReason()
    {
        var (d, f, _) = Make();
        f.FileThrows = new UnknownLinkException();
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"unlinkFile","id":"a","linkId":"{{L1}}"}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal("unknown link", r.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task AlreadyLinked_RepliesFileFailedWithOtherLinkId()
    {
        var (d, f, _) = Make();
        f.FileThrows = new FileAlreadyLinkedException(L2);
        var r = Parse(await d.HandleAsync(Src, """{"type":"saveAsFile","id":"a","format":"txt","suggestedName":"x","text":"t"}"""));
        Assert.Equal("fileFailed", r.GetProperty("type").GetString());
        Assert.Equal("That file is already linked to another note.", r.GetProperty("reason").GetString());
        Assert.Equal(L2, r.GetProperty("linkId").GetString());
    }

    [Fact]
    public async Task PruneLinks_ForwardsKeepList()
    {
        var (d, f, _) = Make();
        Assert.Equal("""{"type":"linksPruned","id":"a"}""",
            await d.HandleAsync(Src, $$"""{"type":"pruneLinks","id":"a","linkIds":["{{L1}}"]}"""));
        Assert.Equal(new[] { L1 }, f.Pruned);
        await d.HandleAsync(Src, """{"type":"pruneLinks","id":"b","linkIds":[]}""");
        Assert.Empty(f.Pruned!);
    }

    [Theory]
    [InlineData("""{"type":"writeFile","id":"a","linkId":"ABC","text":"t","force":false}""")]
    [InlineData("""{"type":"writeFile","id":"a","linkId":"0123456789abcdef0123456789abcdef","text":"t","force":"no"}""")]
    [InlineData("""{"type":"writeFile","id":"a","linkId":"0123456789ABCDEF0123456789abcdef","text":"t","force":false}""")]
    [InlineData("""{"type":"writeFile","id":"a","linkId":"0123456789abcdef0123456789abcdef","text":5,"force":false}""")]
    [InlineData("""{"type":"saveAsFile","id":"a","format":"html","suggestedName":"x","text":"t"}""")]
    [InlineData("""{"type":"saveAsFile","id":"a","format":"TXT","suggestedName":"x","text":"t"}""")]
    [InlineData("""{"type":"saveAsFile","id":"a","format":"txt","suggestedName":"x","text":"t","path":"C:\\x"}""")]
    [InlineData("""{"type":"checkFiles","id":"a","linkIds":["0123456789abcdef0123456789abcdef","0123456789abcdef0123456789abcdef"]}""")]
    [InlineData("""{"type":"checkFiles","id":"a","linkIds":"x"}""")]
    [InlineData("""{"type":"checkFiles","id":"a","linkIds":[5]}""")]
    [InlineData("""{"type":"pruneLinks","id":"a","linkIds":["nope"]}""")]
    [InlineData("""{"type":"relinkFile","id":"a","linkId":"zz","format":"txt","suggestedName":"x","text":"t"}""")]
    [InlineData("""{"type":"openFile","id":"a","extra":1}""")]
    public async Task InvalidFileMessages_AreRejected(string json)
    {
        var (d, f, _) = Make();
        var r = Parse(await d.HandleAsync(Src, json));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal(0, f.FileCalls);
    }

    [Fact]
    public async Task CheckFiles_Over2000_IsRejected()
    {
        var (d, f, _) = Make();
        var ids = string.Join(",", Enumerable.Range(0, 2001).Select(i => $"\"{i:x32}\""));
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"checkFiles","id":"a","linkIds":[{{ids}}]}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal(0, f.FileCalls);
    }

    [Fact]
    public async Task CheckFiles_Exactly2000_IsAccepted()
    {
        var (d, f, _) = Make();
        var ids = string.Join(",", Enumerable.Range(0, 2000).Select(i => $"\"{i:x32}\""));
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"checkFiles","id":"a","linkIds":[{{ids}}]}"""));
        Assert.Equal("fileStatus", r.GetProperty("type").GetString());
        Assert.Equal(2000, f.Checked!.Count);
    }

    [Fact]
    public async Task WriteFile_TextOverLimit_IsRejected()
    {
        var (d, f, _) = Make();
        var text = new string('a', 4 * 1024 * 1024 + 1);
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"writeFile","id":"a","linkId":"{{L1}}","text":"{{text}}","force":false}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal(0, f.FileCalls);
    }

    [Fact]
    public async Task SaveAsFile_NameOverLimit_IsRejected()
    {
        var (d, f, _) = Make();
        var name = new string('a', 121);
        var r = Parse(await d.HandleAsync(Src, $$"""{"type":"saveAsFile","id":"a","format":"txt","suggestedName":"{{name}}","text":"t"}"""));
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal(0, f.FileCalls);
    }

    [Fact]
    public async Task FileWrites_DoNotBlockNoteSaves()
    {
        var (d, f, _) = Make();
        f.WriteBlocker = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var write = d.HandleAsync(Src, $$"""{"type":"writeFile","id":"w","linkId":"{{L1}}","text":"t","force":false}""");
        await f.WriteEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var saved = await d.HandleAsync(Src, """{"type":"save","id":"s","data":"x"}""").WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("""{"type":"saved","id":"s"}""", saved);
        Assert.False(write.IsCompleted);
        f.WriteBlocker.SetResult();
        Assert.Equal("""{"type":"fileWritten","id":"w"}""", await write.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task FileWrites_AreSerialized()
    {
        var (d, f, _) = Make();
        f.WriteBlocker = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = d.HandleAsync(Src, $$"""{"type":"writeFile","id":"a","linkId":"{{L1}}","text":"t","force":false}""");
        var b = d.HandleAsync(Src, $$"""{"type":"writeFile","id":"b","linkId":"{{L2}}","text":"t","force":false}""");
        await f.WriteEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(100);
        f.WriteBlocker.SetResult();
        await Task.WhenAll(a, b).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, f.MaxFileConcurrency);
        Assert.Equal(2, f.FileCalls);
    }
}
