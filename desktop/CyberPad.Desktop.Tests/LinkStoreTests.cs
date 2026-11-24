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

    [Fact]
    public void Refresh_PersistFails_KeepsTheNewRecordInMemory_AndTheNextPersistWritesIt()
    {
        var dir = NewDir();
        var store = new LinkStore(dir);
        store.Load();
        var id = store.Add(Rec(@"C:\Notes\a.md"));
        var newer = Rec(@"C:\Notes\a.md", new string('b', 64));

        using (new FileStream(Path.Combine(dir, LinkStore.FileName), FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.Throws<CyberPad.Desktop.Storage.StoreException>(() => store.Refresh(id, newer));
        }
        Assert.True(store.TryGet(id, out var inMemory));
        Assert.Equal(newer, inMemory);

        store.Add(Rec(@"C:\Notes\b.md"));
        var again = new LinkStore(dir);
        again.Load();
        Assert.True(again.TryGet(id, out var onDisk));
        Assert.Equal(newer, onDisk);
    }

    [Fact]
    public void Refresh_UnknownId_Throws()
    {
        var store = new LinkStore(NewDir());
        store.Load();
        Assert.Throws<KeyNotFoundException>(() => store.Refresh(new string('c', 32), Rec(@"C:\Notes\a.md")));
    }

    [Fact]
    public void AtomicWrite_RetriesTheSwapOnSharingViolations()
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "x.json");
        File.WriteAllText(path, "old");
        var calls = 0;
        var sleeps = new List<int>();
        // A scanner holding the new temp file shows up as a sharing violation on the move.
        CyberPad.Desktop.Storage.AtomicFile.Write(path, "new", (from, to) =>
        {
            if (++calls < 3) throw new IOException("busy") { HResult = unchecked((int)0x80070020) };
            File.Move(from, to, overwrite: true);
        }, sleeps.Add);
        Assert.Equal(3, calls);
        Assert.Equal(2, sleeps.Count);
        Assert.Equal("new", File.ReadAllText(path));
        Assert.Single(Directory.GetFiles(dir));
    }

    [Fact]
    public void AtomicWrite_GivesUpAfterTheRetries_AndRemovesTheTemp()
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "x.json");
        File.WriteAllText(path, "old");
        var calls = 0;
        Assert.Throws<CyberPad.Desktop.Storage.StoreException>(() => CyberPad.Desktop.Storage.AtomicFile.Write(path, "new",
            (_, _) => { calls++; throw new IOException("busy") { HResult = unchecked((int)0x80070020) }; }, _ => { }));
        Assert.Equal(4, calls);
        Assert.Equal("old", File.ReadAllText(path));
        Assert.Single(Directory.GetFiles(dir));
    }
}
