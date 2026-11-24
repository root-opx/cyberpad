using System.Text.RegularExpressions;
using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Tests;

public sealed class LinkStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));

    public LinkStoreTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string NewDir() => Path.Combine(_root, Guid.NewGuid().ToString("N"));

    private static readonly string GoodSha = new('a', 64);

    private static LinkRecord Rec(string path, string sha = "") => new(
        path, LinkFormat.Md, TextEncodingKind.Utf8, false, LineEnding.Lf, 12, new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
        sha.Length == 0 ? GoodSha : sha);

    [Fact]
    public void Add_Persists_And_Load_RestoresRecord()
    {
        var dir = NewDir();
        var rec = Rec(@"C:\Notes\a.md") with { Bom = true, LineEnding = LineEnding.CrLf, Encoding = TextEncodingKind.Utf16LE };
        var store = new LinkStore(dir);
        store.Load();
        var id = store.Add(rec);
        Assert.Matches(new Regex("^[0-9a-f]{32}$"), id);

        var again = new LinkStore(dir);
        again.Load();
        Assert.Equal(1, again.Count);
        Assert.True(again.TryGet(id, out var got));
        Assert.Equal(rec, got);
    }

    [Fact]
    public void Update_And_Remove_Persist()
    {
        var dir = NewDir();
        var store = new LinkStore(dir);
        store.Load();
        var id = store.Add(Rec(@"C:\Notes\a.md"));
        var changed = Rec(@"C:\Notes\a.md", new string('b', 64)) with { Size = 99 };
        store.Update(id, changed);

        var again = new LinkStore(dir);
        again.Load();
        Assert.True(again.TryGet(id, out var got));
        Assert.Equal(changed, got);

        Assert.True(again.Remove(id));
        Assert.False(again.Remove(id));
        var third = new LinkStore(dir);
        third.Load();
        Assert.Equal(0, third.Count);
    }

    [Fact]
    public void Load_Garbage_QuarantinesAndStartsEmpty()
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, LinkStore.FileName), "{");
        var store = new LinkStore(dir);
        store.Load();
        Assert.Equal(0, store.Count);
        Assert.Single(Directory.GetFiles(dir, "links.unreadable-*.json"));
        Assert.False(File.Exists(Path.Combine(dir, LinkStore.FileName)));
    }

    [Fact]
    public void Load_OversizedFile_Quarantines()
    {
        var dir = NewDir();
        var store = new LinkStore(dir);
        store.Load();
        store.Add(Rec(@"C:\Notes\a.md"));

        var small = new LinkStore(dir, maxFileBytes: 10);
        small.Load();
        Assert.Equal(0, small.Count);
        Assert.Single(Directory.GetFiles(dir, "links.unreadable-*.json"));
    }

    [Fact]
    public void Load_DropsInvalidRecords()
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        string Entry(string path, string sha, string format = "md", long size = 1) =>
            $"{{\"path\":{System.Text.Json.JsonSerializer.Serialize(path)},\"format\":\"{format}\",\"encoding\":\"utf8\",\"bom\":false,\"lineEnding\":\"lf\",\"size\":{size},\"mtimeUtc\":\"2026-01-02T03:04:05.0000000Z\",\"sha256\":\"{sha}\"}}";
        var good = new string('0', 32);
        var json = "{\"v\":1,\"links\":{"
            + $"\"{good}\":{Entry(@"C:\Notes\a.md", GoodSha)},"
            + $"\"{new string('1', 32)}\":{Entry(@"rel\a.md", GoodSha)},"
            + $"\"{new string('2', 32)}\":{Entry(@"C:\Notes\b.md", "XYZ")},"
            + $"\"{new string('3', 32)}\":{Entry(@"C:\Notes\c.md", new string('A', 64))},"
            + $"\"{new string('4', 32)}\":{Entry(@"C:\Notes\d.md", GoodSha, "txt")},"
            + $"\"{new string('5', 32)}\":{Entry(@"C:\Notes\e.md", GoodSha, "md", -1)},"
            + $"\"BADID\":{Entry(@"C:\Notes\f.md", GoodSha)},"
            + $"\"{new string('6', 32)}\":{Entry(@"C:\Notes\A.md", GoodSha)}"
            + "}}";
        File.WriteAllText(Path.Combine(dir, LinkStore.FileName), json);

        var store = new LinkStore(dir);
        store.Load();
        Assert.Equal(1, store.Count);
        Assert.True(store.TryGet(good, out var rec));
        Assert.Equal(@"C:\Notes\a.md", rec.Path);
        Assert.Empty(Directory.GetFiles(dir, "links.unreadable-*.json"));
    }

    [Fact]
    public void FindByPath_IsCaseInsensitive()
    {
        var store = new LinkStore(NewDir());
        store.Load();
        var id = store.Add(Rec(@"C:\Notes\Mixed.md"));
        Assert.Equal(id, store.FindByPath(@"c:\notes\MIXED.md"));
        Assert.Null(store.FindByPath(@"C:\Notes\other.md"));
    }

    [Fact]
    public void Prune_RemovesUnreferencedLinks()
    {
        var dir = NewDir();
        var store = new LinkStore(dir);
        store.Load();
        var keep = store.Add(Rec(@"C:\Notes\a.md"));
        var drop = store.Add(Rec(@"C:\Notes\b.md"));
        store.Prune(new HashSet<string> { keep });
        Assert.True(store.TryGet(keep, out _));
        Assert.False(store.TryGet(drop, out _));

        var again = new LinkStore(dir);
        again.Load();
        Assert.Equal(1, again.Count);
    }
}
