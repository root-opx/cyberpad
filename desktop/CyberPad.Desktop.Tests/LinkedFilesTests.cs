using System.Security.Cryptography;
using System.Text;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public sealed class LinkedFilesTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));
    private readonly LinkedFiles _files = new();

    public LinkedFilesTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try
        {
            foreach (var f in Directory.GetFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(f, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string P(string name) => Path.Combine(_root, name);

    private static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

    private static byte[] WithBom(string s) => new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes(s)).ToArray();

    [Fact]
    public void WriteNew_Then_Write_RoundTrips()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a\nb");
        Assert.Equal("a\nb", File.ReadAllText(path));
        Assert.Equal(Sha(File.ReadAllBytes(path)), rec.Sha256);
        Assert.Equal(LinkFormat.Md, rec.Format);

        Assert.Equal(WriteOutcome.Written, _files.Write(rec, "c", false, out var updated));
        Assert.Equal("c", File.ReadAllText(path));
        Assert.Equal(1, updated.Size);
        Assert.Equal(Sha(File.ReadAllBytes(path)), updated.Sha256);
        Assert.Equal(WriteOutcome.Written, _files.Write(updated, "d", false, out _));
    }

    [Fact]
    public void WriteNew_ReplacesExistingFile()
    {
        var path = P("n.txt");
        File.WriteAllText(path, "old old old");
        _files.WriteNew(path, LinkFormat.Txt, "new");
        Assert.Equal("new", File.ReadAllText(path));
    }

    [Fact]
    public void Write_ChangedElsewhere_ReturnsConflictAndLeavesFile()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a\nb");
        File.WriteAllText(path, "theirs");
        Assert.Equal(WriteOutcome.Conflict, _files.Write(rec, "mine", false, out _));
        Assert.Equal("theirs", File.ReadAllText(path));
    }

    [Fact]
    public void Write_Force_OverwritesChangedFile()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a");
        File.WriteAllText(path, "theirs");
        Assert.Equal(WriteOutcome.Written, _files.Write(rec, "mine", true, out var updated));
        Assert.Equal("mine", File.ReadAllText(path));
        Assert.Equal(Sha(File.ReadAllBytes(path)), updated.Sha256);
    }

    [Fact]
    public void Write_MissingFile_ReturnsMissingAndCreatesNothing()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a");
        File.Delete(path);
        Assert.Equal(WriteOutcome.Missing, _files.Write(rec, "x", false, out _));
        Assert.Equal(WriteOutcome.Missing, _files.Write(rec, "x", true, out _));
        Assert.False(File.Exists(path));
        Assert.Empty(Directory.GetFileSystemEntries(_root));
    }

    [Fact]
    public void ReadNew_TextOverMaxChars_Throws()
    {
        var path = P("big.txt");
        File.WriteAllText(path, new string('a', LinkedFiles.MaxTextChars + 1));
        var ex = Assert.Throws<StoreException>(() => _files.ReadNew(path, LinkFormat.Txt));
        Assert.Equal("The file is too large to open.", ex.Message);
    }

    [Fact]
    public void ReadNew_OverSizeCap_Throws()
    {
        var path = P("huge.txt");
        File.WriteAllBytes(path, new byte[LinkedFiles.MaxFileBytes + 1]);
        var ex = Assert.Throws<StoreException>(() => _files.ReadNew(path, LinkFormat.Txt));
        Assert.Equal("The file is too large to open.", ex.Message);
    }

    [Fact]
    public void ReadNew_AtSizeCap_CpNoteIsAllowed()
    {
        var path = P("cap.cpnote");
        File.WriteAllBytes(path, Enumerable.Repeat((byte)'a', (int)LinkedFiles.MaxFileBytes).ToArray());
        var (rec, text) = _files.ReadNew(path, LinkFormat.CpNote);
        Assert.Equal(LinkedFiles.MaxFileBytes, text.Length);
        Assert.Equal(LinkedFiles.MaxFileBytes, rec.Size);
    }

    [Fact]
    public void ReadNew_RefusesNonText()
    {
        File.WriteAllBytes(P("bin.txt"), new byte[] { 0xFF, 0xFF, 0xFF });
        var ex = Assert.Throws<StoreException>(() => _files.ReadNew(P("bin.txt"), LinkFormat.Txt));
        Assert.Equal(TextCodec.NotTextMessage, ex.Message);
        File.WriteAllBytes(P("nul.cpnote"), Encoding.UTF8.GetBytes("a\0b"));
        Assert.Throws<StoreException>(() => _files.ReadNew(P("nul.cpnote"), LinkFormat.CpNote));
        File.WriteAllBytes(P("u16.cpnote"), new byte[] { 0xFF, 0xFE, 0x61, 0x00 });
        Assert.Throws<StoreException>(() => _files.ReadNew(P("u16.cpnote"), LinkFormat.CpNote));
    }

    [Fact]
    public void ReadNew_CpNote_IsStrictUtf8WithoutNewlineConversion()
    {
        var path = P("c.cpnote");
        File.WriteAllBytes(path, WithBom("a\r\nb"));
        var (rec, text) = _files.ReadNew(path, LinkFormat.CpNote);
        Assert.Equal("a\r\nb", text);
        Assert.Equal(TextEncodingKind.Utf8, rec.Encoding);
        Assert.False(rec.Bom);
        Assert.Equal(LineEnding.Lf, rec.LineEnding);

        Assert.Equal(WriteOutcome.Written, _files.Write(rec, "x\r\ny", false, out _));
        Assert.Equal(Encoding.UTF8.GetBytes("x\r\ny"), File.ReadAllBytes(path));
    }

    [Fact]
    public void Check_TimestampOnlyChange_IsOk()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a");
        var later = rec.MtimeUtc.AddHours(1);
        File.SetLastWriteTimeUtc(path, later);
        Assert.Equal(FileStatus.Ok, _files.Check(rec, out var refreshed, TimeSpan.FromSeconds(2)));
        Assert.Equal(later, refreshed.MtimeUtc);
        Assert.Equal(rec.Sha256, refreshed.Sha256);
    }

    [Fact]
    public void Check_UnchangedChangedMissing()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a");
        Assert.Equal(FileStatus.Ok, _files.Check(rec, out _, TimeSpan.FromSeconds(2)));
        File.WriteAllText(path, "b");
        Assert.Equal(FileStatus.Changed, _files.Check(rec, out _, TimeSpan.FromSeconds(2)));
        File.Delete(path);
        Assert.Equal(FileStatus.Missing, _files.Check(rec, out _, TimeSpan.FromSeconds(2)));
    }

    [Fact]
    public void ReadCurrent_ReturnsTextAndRefreshedRecord_OrNullWhenMissing()
    {
        var path = P("n.txt");
        var rec = _files.WriteNew(path, LinkFormat.Txt, "a");
        File.WriteAllBytes(path, WithBom("x\r\ny\r\n"));
        var text = _files.ReadCurrent(rec, out var refreshed);
        Assert.Equal("x\ny\n", text);
        Assert.True(refreshed.Bom);
        Assert.Equal(LineEnding.CrLf, refreshed.LineEnding);
        Assert.Equal(Sha(File.ReadAllBytes(path)), refreshed.Sha256);
        Assert.Equal(WriteOutcome.Written, _files.Write(refreshed, "q", false, out _));

        File.Delete(path);
        Assert.Null(_files.ReadCurrent(rec, out _));
    }

    [Fact]
    public void Write_PreservesCrLfAndBom()
    {
        var path = P("n.txt");
        File.WriteAllBytes(path, WithBom("a\r\nb\r\n"));
        var (rec, text) = _files.ReadNew(path, LinkFormat.Txt);
        Assert.Equal("a\nb\n", text);
        Assert.Equal(WriteOutcome.Written, _files.Write(rec, "x\ny", false, out _));
        Assert.Equal(WithBom("x\r\ny"), File.ReadAllBytes(path));
    }

    [Fact]
    public void Write_LeavesNoTempFiles()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a");
        Assert.Equal(WriteOutcome.Written, _files.Write(rec, "b", false, out var updated));
        Assert.Empty(Directory.GetFiles(_root, ".*.cyberpad-tmp-*"));
        Assert.False(File.GetAttributes(path).HasFlag(FileAttributes.Hidden));

        File.SetAttributes(path, FileAttributes.ReadOnly);
        Assert.Throws<StoreException>(() => _files.Write(updated, "c", true, out _));
        Assert.Empty(Directory.GetFiles(_root, ".*.cyberpad-tmp-*"));
        Assert.Single(Directory.GetFiles(_root));
    }

    [Fact]
    public void Write_ReadOnlyFile_ThrowsStoreException()
    {
        var path = P("n.md");
        var rec = _files.WriteNew(path, LinkFormat.Md, "a");
        File.SetAttributes(path, FileAttributes.ReadOnly);
        Assert.Throws<StoreException>(() => _files.Write(rec, "b", false, out _));
        Assert.Equal("a", File.ReadAllText(path));
    }

    [Fact]
    public void Write_LoneSurrogate_ThrowsStoreExceptionAndLeavesFile()
    {
        var path = P("n.txt");
        var rec = _files.WriteNew(path, LinkFormat.Txt, "a");
        var ex = Assert.Throws<StoreException>(() => _files.Write(rec, "x\uD800y", false, out _));
        Assert.Equal(TextCodec.NotTextMessage, ex.Message);
        Assert.Equal("a", File.ReadAllText(path));
        Assert.Throws<StoreException>(() => _files.WriteNew(P("m.txt"), LinkFormat.Txt, "\uD800"));
        Assert.False(File.Exists(P("m.txt")));
        Assert.Empty(Directory.GetFiles(_root, ".*.cyberpad-tmp-*"));
    }

    [Fact]
    public void SharingRetry_RetriesOnlySharingViolations()
    {
        var calls = 0;
        var sleeps = new List<int>();
        SharingRetry.Run(() =>
        {
            if (++calls < 3) throw new IOException("busy") { HResult = unchecked((int)0x80070020) };
        }, sleeps.Add);
        Assert.Equal(3, calls);
        Assert.Equal(2, sleeps.Count);

        Assert.Throws<IOException>(() => SharingRetry.Run(() => throw new IOException("other"), sleeps.Add));
    }
}
