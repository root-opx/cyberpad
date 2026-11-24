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
    public void MaxFileBytes_IsThreeTimesTheMessageLimitPlusOneMegabyte()
    {
        Assert.Equal(3L * 64 * 1024 * 1024 + 1024 * 1024, NoteStore.MaxFileBytes);
    }

    [Theory]
    [InlineData(NoteStore.MainFile)]
    [InlineData(NoteStore.BackupFile)]
    public void Load_RefusesAFileOverTheLimit(string name)
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, name), new string('x', 101));
        var store = new NoteStore(dir, maxFileBytes: 100);
        var ex = Assert.Throws<StoreException>(() => store.Load());
        Assert.Equal("The notes file is too large to open.", ex.Message);
    }

    [Fact]
    public void Load_AcceptsAFileExactlyAtTheLimit()
    {
        var dir = NewDir();
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, NoteStore.MainFile), new string('x', 100));
        var store = new NoteStore(dir, maxFileBytes: 100);
        Assert.Equal(new string('x', 100), store.Load().Main);
    }

    [Fact]
    public async Task Save_RetriesWhileNotesFileIsBrieflyLocked()
    {
        var dir = NewDir();
        var store = new NoteStore(dir);
        store.Save("a");
        var main = Path.Combine(dir, NoteStore.MainFile);
        var held = new FileStream(main, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        var release = Task.Run(async () => { await Task.Delay(150); held.Dispose(); });
        try
        {
            store.Save("b"); // blocks this thread; the first attempt hits the lock, a retry succeeds
        }
        finally
        {
            await release.WaitAsync(TimeSpan.FromSeconds(5));
            held.Dispose();
        }
        Assert.Equal(("b", (string?)"a"), store.Load());
        Assert.False(File.Exists(Path.Combine(dir, NoteStore.TempFile)));
    }

    [Fact]
    public void Save_GivesUpWhenNotesFileStaysLocked()
    {
        var dir = NewDir();
        var sleeps = new List<int>();
        var store = new NoteStore(dir, sleep: sleeps.Add);
        store.Save("a");
        using (new FileStream(Path.Combine(dir, NoteStore.MainFile), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var ex = Assert.Throws<StoreException>(() => store.Save("b"));
            Assert.Equal("The notes could not be saved to disk.", ex.Message);
        }
        Assert.Equal(new[] { 100, 100, 100 }, sleeps);
        Assert.Equal(("a", (string?)null), store.Load());
        Assert.False(File.Exists(Path.Combine(dir, NoteStore.TempFile)));
    }

    [Fact]
    public void Save_DoesNotRetryOtherFailures()
    {
        var dir = NewDir();
        var sleeps = new List<int>();
        var store = new NoteStore(dir, sleep: sleeps.Add);
        store.Save("a");
        store.Save("b");
        // A held backup fails File.Replace with ERROR_UNABLE_TO_REMOVE_REPLACED, not a sharing violation.
        using (new FileStream(Path.Combine(dir, NoteStore.BackupFile), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.Throws<StoreException>(() => store.Save("c"));
        }
        Assert.Empty(sleeps);
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
