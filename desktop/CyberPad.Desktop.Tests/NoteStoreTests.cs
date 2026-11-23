using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public sealed class NoteStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));

    public NoteStoreTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string NewDir() => Path.Combine(_root, Guid.NewGuid().ToString("N"));

    [Fact]
    public void Save_FirstTime_CreatesMainWithoutBackup()
    {
        var store = new NoteStore(NewDir());
        store.Save("a");
        Assert.Equal(("a", (string?)null), store.Load());
    }

    [Fact]
    public void Save_Twice_KeepsPreviousAsBackup()
    {
        var store = new NoteStore(NewDir());
        store.Save("a");
        store.Save("b");
        Assert.Equal(("b", (string?)"a"), store.Load());
    }

    [Fact]
    public void Save_Load_RoundTripsUnicodeWithoutBom()
    {
        var dir = NewDir();
        var store = new NoteStore(dir);
        const string text = "✓ 漢字 🔐 مرحبا\r\nline2";
        store.Save(text);
        Assert.Equal(text, store.Load().Main);
        var bytes = File.ReadAllBytes(Path.Combine(dir, NoteStore.MainFile));
        Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
    }

    [Fact]
    public void Save_WhenTempWriteFails_LeavesMainUntouched()
    {
        var dir = NewDir();
        var store = new NoteStore(dir);
        store.Save("good");
        Directory.CreateDirectory(Path.Combine(dir, NoteStore.TempFile));
        Assert.Throws<StoreException>(() => store.Save("new"));
        Assert.Equal("good", store.Load().Main);
    }

    [Fact]
    public void Save_WhenDataDirIsUnusable_ThrowsStoreException()
    {
        var path = Path.Combine(_root, "afile");
        File.WriteAllText(path, "x");
        var store = new NoteStore(path);
        Assert.Throws<StoreException>(() => store.Save("data"));
    }

    [Fact]
    public void Load_WhenNothingSaved_ReturnsNulls()
    {
        var dir = NewDir();
        var store = new NoteStore(dir);
        Assert.Equal(((string?)null, (string?)null), store.Load());
        Assert.False(Directory.Exists(dir));
    }

    [Fact]
    public void Quarantine_RenamesInsteadOfDeleting()
    {
        var dir = NewDir();
        var store = new NoteStore(dir);
        store.Save("a");
        store.Save("b");
        var names = store.Quarantine(DateTimeOffset.Parse("2026-11-23T10:00:00Z"));
        Assert.Equal(2, names.Count);
        Assert.False(File.Exists(Path.Combine(dir, NoteStore.MainFile)));
        Assert.False(File.Exists(Path.Combine(dir, NoteStore.BackupFile)));
        Assert.Equal("b", File.ReadAllText(Path.Combine(dir, "notes.unreadable-20261123T100000Z.json")));
        Assert.Equal("a", File.ReadAllText(Path.Combine(dir, "notes.unreadable-20261123T100000Z.bak.json")));
    }

    [Fact]
    public void AtomicFile_Write_ReplacesExistingAndLeavesNoTemp()
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "f.txt");
        AtomicFile.Write(path, "one");
        AtomicFile.Write(path, "two");
        Assert.Equal("two", File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(dir, "*.tmp-*"));
    }
}
