using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public sealed class HostFileActionsTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));
    private readonly string _data;
    private readonly string _docs;
    private readonly Control _control;
    private readonly LinkStore _links;
    private readonly OpenRequestQueue _queue = new();
    private readonly HostActions _host;

    public HostFileActionsTests()
    {
        // A Control installs a WinForms sync context on this thread; with no message loop, awaits would never resume.
        var previous = SynchronizationContext.Current;
        _control = new Control();
        SynchronizationContext.SetSynchronizationContext(previous);
        _data = Path.Combine(_root, "data");
        _docs = Path.Combine(_root, "docs");
        Directory.CreateDirectory(_data);
        Directory.CreateDirectory(_docs);
        _links = new LinkStore(_data);
        _links.Load();
        _host = new HostActions(new NoteStore(_data), _links, new LinkedFiles(), _queue, "1.0.0", _control, () => { }, () => { });
    }

    public void Dispose()
    {
        _control.Dispose();
        try
        {
            foreach (var f in Directory.GetFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(f, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string Doc(string name) => Path.Combine(_docs, name);

    private async Task<FileLinkResult> SaveAs(string path, LinkFormat format = LinkFormat.Txt, string text = "hello", string? relink = null)
    {
        _host.AskSavePath = (_, _) => path;
        var r = await _host.SaveAsFileAsync(format, Path.GetFileName(path), text, relink);
        Assert.NotNull(r);
        return r!;
    }

    [Fact]
    public async Task SaveAs_WritesFile_LinksIt_AndReturnsOnlyTheName()
    {
        var path = Doc("a.txt");
        string? suggested = null;
        _host.AskSavePath = (f, name) => { suggested = name; Assert.Equal(LinkFormat.Txt, f); return path; };
        var r = await _host.SaveAsFileAsync(LinkFormat.Txt, "suggested.txt", "hi", null);
        Assert.Equal("suggested.txt", suggested);
        Assert.Equal("a.txt", r!.Name);
        Assert.Matches("^[0-9a-f]{32}$", r.LinkId);
        Assert.Equal("hi", File.ReadAllText(path));
        Assert.True(_links.TryGet(r.LinkId, out var rec));
        Assert.Equal(path, rec.Path);
    }

    [Fact]
    public async Task SaveAs_Cancelled_ReturnsNull()
    {
        _host.AskSavePath = (_, _) => null;
        Assert.Null(await _host.SaveAsFileAsync(LinkFormat.Txt, "a.txt", "x", null));
        Assert.Equal(0, _links.Count);
    }

    [Fact]
    public async Task SaveAs_RefusesPathLinkedToAnotherNote()
    {
        var path = Doc("a.txt");
        var first = await SaveAs(path);
        _host.AskSavePath = (_, _) => path;
        var ex = await Assert.ThrowsAsync<FileAlreadyLinkedException>(() => _host.SaveAsFileAsync(LinkFormat.Txt, "a.txt", "other", null));
        Assert.Equal(first.LinkId, ex.LinkId);
        Assert.Equal("That file is already linked to another note.", ex.Message);
        Assert.Equal("hello", File.ReadAllText(path)); // not overwritten
    }

    [Fact]
    public async Task SaveAs_RefusesDataFolder()
    {
        var path = Path.Combine(_data, "x.txt");
        _host.AskSavePath = (_, _) => path;
        var ex = await Assert.ThrowsAsync<StoreException>(() => _host.SaveAsFileAsync(LinkFormat.Txt, "x.txt", "t", null));
        Assert.Equal("Choose a folder outside the CyberPad data folder.", ex.Message);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task SaveAs_RefusesExtensionThatDoesNotMatchTheFormat()
    {
        _host.AskSavePath = (_, _) => Doc("a.md");
        await Assert.ThrowsAsync<StoreException>(() => _host.SaveAsFileAsync(LinkFormat.Txt, "a.txt", "t", null));
        _host.AskSavePath = (_, _) => Doc("a.exe");
        await Assert.ThrowsAsync<StoreException>(() => _host.SaveAsFileAsync(LinkFormat.Txt, "a.txt", "t", null));
        Assert.False(File.Exists(Doc("a.md")));
        Assert.Equal(0, _links.Count);
    }

    [Fact]
    public async Task SaveAs_Relink_UpdatesExistingLinkId_AndAllowsItsOwnPath()
    {
        var first = await SaveAs(Doc("a.txt"));
        var moved = await SaveAs(Doc("b.txt"), relink: first.LinkId);
        Assert.Equal(first.LinkId, moved.LinkId);
        Assert.Equal(1, _links.Count);
        Assert.True(_links.TryGet(first.LinkId, out var rec));
        Assert.Equal(Doc("b.txt"), rec.Path);

        var again = await SaveAs(Doc("b.txt"), text: "same file", relink: first.LinkId);
        Assert.Equal(first.LinkId, again.LinkId);
        Assert.Equal("same file", File.ReadAllText(Doc("b.txt")));
    }

    [Fact]
    public async Task SaveAs_Relink_UnknownId_Throws()
    {
        _host.AskSavePath = (_, _) => Doc("a.txt");
        await Assert.ThrowsAsync<UnknownLinkException>(() =>
            _host.SaveAsFileAsync(LinkFormat.Txt, "a.txt", "t", new string('a', 32)));
    }

    [Fact]
    public async Task PruneLinks_RemovesOthersAndPersists()
    {
        File.WriteAllText(Doc("old1.txt"), "1");
        File.WriteAllText(Doc("old2.txt"), "2");
        var lf = new LinkedFiles();
        var keepId = _links.Add(lf.ReadNew(Doc("old1.txt"), LinkFormat.Txt).Record);
        var dropId = _links.Add(lf.ReadNew(Doc("old2.txt"), LinkFormat.Txt).Record);

        await _host.PruneLinksAsync(new[] { keepId });

        Assert.True(_links.TryGet(keepId, out _));
        Assert.False(_links.TryGet(dropId, out _));
        var reloaded = new LinkStore(_data);
        reloaded.Load();
        Assert.Equal(1, reloaded.Count);
    }

    [Fact]
    public async Task PruneLinks_NeverRemovesALinkAddedThisSession()
    {
        var created = await SaveAs(Doc("new.txt"));
        File.WriteAllText(Doc("o.txt"), "o");
        _host.AskOpenPath = () => Doc("o.txt");
        var opened = await _host.OpenFileAsync();

        await _host.PruneLinksAsync(Array.Empty<string>());

        Assert.True(_links.TryGet(created.LinkId, out _));
        Assert.True(_links.TryGet(opened!.LinkId, out _));
    }

    [Fact]
    public async Task Open_UsesQueuedPathBeforeDialog()
    {
        File.WriteAllText(Doc("q.md"), "queued");
        _queue.TryEnqueue(Doc("q.md"));
        var asked = false;
        _host.AskOpenPath = () => { asked = true; return null; };
        var r = await _host.OpenFileAsync();
        Assert.False(asked);
        Assert.Equal("queued", r!.Text);
        Assert.Equal("q.md", r.Name);
        Assert.Equal(LinkFormat.Md, r.Format);
        Assert.False(r.AlreadyLinked);
        Assert.Equal(0, _queue.Count);
    }

    [Fact]
    public async Task Open_Cancelled_ReturnsNull()
    {
        _host.AskOpenPath = () => null;
        Assert.Null(await _host.OpenFileAsync());
    }

    [Fact]
    public async Task Open_AlreadyLinked_ReturnsSameLinkId_AndCurrentText()
    {
        var first = await SaveAs(Doc("a.txt"), text: "v1");
        File.WriteAllText(Doc("a.txt"), "v2 edited elsewhere");
        _host.AskOpenPath = () => Doc("a.txt");
        var r = await _host.OpenFileAsync();
        Assert.Equal(first.LinkId, r!.LinkId);
        Assert.True(r.AlreadyLinked);
        Assert.Equal("v2 edited elsewhere", r.Text);
        Assert.Equal(1, _links.Count);
    }

    [Fact]
    public async Task Open_AlreadyLinked_DoesNotAdoptChangedContent()
    {
        var first = await SaveAs(Doc("a.txt"), text: "v1");
        File.WriteAllText(Doc("a.txt"), "v2 edited elsewhere");
        _host.AskOpenPath = () => Doc("a.txt");
        var r = await _host.OpenFileAsync();
        Assert.True(r!.AlreadyLinked);
        Assert.Equal(FileStatus.Changed, (await _host.CheckFilesAsync(new[] { first.LinkId }))[first.LinkId]);
        Assert.Equal(WriteOutcome.Conflict, await _host.WriteFileAsync(first.LinkId, "v1 mine", false));
        Assert.Equal("v2 edited elsewhere", File.ReadAllText(Doc("a.txt")));
    }

    [Fact]
    public async Task ReadFile_DoesNotAdoptChangedContent()
    {
        var link = await SaveAs(Doc("a.txt"), text: "one");
        File.WriteAllText(Doc("a.txt"), "edited elsewhere");
        Assert.Equal("edited elsewhere", await _host.ReadFileAsync(link.LinkId));
        Assert.Equal(FileStatus.Changed, (await _host.CheckFilesAsync(new[] { link.LinkId }))[link.LinkId]);
        Assert.Equal(WriteOutcome.Conflict, await _host.WriteFileAsync(link.LinkId, "mine", false));
        Assert.Equal("edited elsewhere", File.ReadAllText(Doc("a.txt")));

        // Adopting the file's text explicitly (a non-forced write of exactly that text) confirms it.
        Assert.Equal(WriteOutcome.Written, await _host.WriteFileAsync(link.LinkId, "edited elsewhere", false));
        Assert.Equal(FileStatus.Ok, (await _host.CheckFilesAsync(new[] { link.LinkId }))[link.LinkId]);
        Assert.Equal(WriteOutcome.Written, await _host.WriteFileAsync(link.LinkId, "mine", false));
        Assert.Equal("mine", File.ReadAllText(Doc("a.txt")));
    }

    [Fact]
    public async Task ReadFile_TimestampOnlyChange_RefreshesRecord()
    {
        var link = await SaveAs(Doc("a.txt"), text: "one");
        File.SetLastWriteTimeUtc(Doc("a.txt"), DateTime.UtcNow.AddHours(1));
        Assert.Equal("one", await _host.ReadFileAsync(link.LinkId));
        Assert.True(_links.TryGet(link.LinkId, out var rec));
        Assert.Equal(File.GetLastWriteTimeUtc(Doc("a.txt")), rec!.MtimeUtc);
        Assert.Equal(FileStatus.Ok, (await _host.CheckFilesAsync(new[] { link.LinkId }))[link.LinkId]);
    }

    [Fact]
    public async Task Open_RejectsPolicyFailures()
    {
        _queue.TryEnqueue(@"C:\x.exe");
        var q = await Assert.ThrowsAsync<StoreException>(() => _host.OpenFileAsync());
        Assert.Equal(FilePathPolicy.UnsupportedMessage, q.Message);

        _host.AskOpenPath = () => Doc("evil.exe");
        var d = await Assert.ThrowsAsync<StoreException>(() => _host.OpenFileAsync());
        Assert.Equal(FilePathPolicy.UnsupportedMessage, d.Message);
        Assert.Equal(0, _links.Count);
    }

    [Fact]
    public async Task Open_MissingFile_MapsToNotFound()
    {
        _host.AskOpenPath = () => Doc("nope.txt");
        var ex = await Assert.ThrowsAsync<StoreException>(() => _host.OpenFileAsync());
        Assert.Equal("The file could not be found.", ex.Message);

        _host.AskOpenPath = () => Path.Combine(_docs, "no-dir", "nope.txt");
        ex = await Assert.ThrowsAsync<StoreException>(() => _host.OpenFileAsync());
        Assert.Equal("The file could not be found.", ex.Message);
    }

    [Fact]
    public async Task Open_AlreadyLinkedButFileGone_IsNotFound()
    {
        await SaveAs(Doc("a.txt"));
        File.Delete(Doc("a.txt"));
        _host.AskOpenPath = () => Doc("a.txt");
        var ex = await Assert.ThrowsAsync<StoreException>(() => _host.OpenFileAsync());
        Assert.Equal("The file could not be found.", ex.Message);
    }

    [Fact]
    public async Task OpenCompleted_IsRaisedEvenWhenOpenFails()
    {
        var raised = 0;
        _host.OpenCompleted += () => raised++;
        _host.AskOpenPath = () => Doc("evil.exe");
        await Assert.ThrowsAsync<StoreException>(() => _host.OpenFileAsync());
        _host.AskOpenPath = () => null;
        await _host.OpenFileAsync();
        Assert.Equal(2, raised);
    }

    [Fact]
    public async Task WriteAndRead_RoundTrip_AndPersistRefreshedRecord()
    {
        var link = await SaveAs(Doc("a.txt"), text: "one");
        Assert.Equal(WriteOutcome.Written, await _host.WriteFileAsync(link.LinkId, "two", false));
        Assert.Equal("two", File.ReadAllText(Doc("a.txt")));
        Assert.Equal("two", await _host.ReadFileAsync(link.LinkId));
        var status = await _host.CheckFilesAsync(new[] { link.LinkId });
        Assert.Equal(FileStatus.Ok, status[link.LinkId]);

        File.WriteAllText(Doc("a.txt"), "changed elsewhere");
        Assert.Equal(WriteOutcome.Conflict, await _host.WriteFileAsync(link.LinkId, "three", false));
        status = await _host.CheckFilesAsync(new[] { link.LinkId });
        Assert.Equal(FileStatus.Changed, status[link.LinkId]);
        File.Delete(Doc("a.txt"));
        Assert.Null(await _host.ReadFileAsync(link.LinkId));
        Assert.Equal(WriteOutcome.Missing, await _host.WriteFileAsync(link.LinkId, "x", true));
        status = await _host.CheckFilesAsync(new[] { link.LinkId });
        Assert.Equal(FileStatus.Missing, status[link.LinkId]);
    }

    [Fact]
    public async Task Unlink_RemovesRecord_AndLeavesFile()
    {
        var link = await SaveAs(Doc("a.txt"));
        await _host.UnlinkFileAsync(link.LinkId);
        Assert.Equal(0, _links.Count);
        Assert.True(File.Exists(Doc("a.txt")));
    }

    [Fact]
    public async Task Reveal_MissingFile_IsNotFound()
    {
        var link = await SaveAs(Doc("a.txt"));
        File.Delete(Doc("a.txt"));
        var ex = await Assert.ThrowsAsync<StoreException>(() => _host.RevealFileAsync(link.LinkId));
        Assert.Equal("The file could not be found.", ex.Message);
    }

    [Fact]
    public async Task UnknownLinkId_ThrowsUnknownLink()
    {
        var id = new string('f', 32);
        await Assert.ThrowsAsync<UnknownLinkException>(() => _host.WriteFileAsync(id, "t", false));
        await Assert.ThrowsAsync<UnknownLinkException>(() => _host.ReadFileAsync(id));
        await Assert.ThrowsAsync<UnknownLinkException>(() => _host.CheckFilesAsync(new[] { id }));
        await Assert.ThrowsAsync<UnknownLinkException>(() => _host.UnlinkFileAsync(id));
        await Assert.ThrowsAsync<UnknownLinkException>(() => _host.RevealFileAsync(id));
    }

    [Fact]
    public void RevealStartInfo_UsesExplorerFromTheWindowsFolder_AndArgumentList()
    {
        var info = HostActions.RevealStartInfo(@"C:\docs b.txt");
        Assert.True(Path.IsPathFullyQualified(info.FileName));
        Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), info.FileName);
        Assert.False(info.UseShellExecute);
        Assert.Equal(new[] { "/select,", @"C:\docs b.txt" }, info.ArgumentList.ToArray());
    }
}
