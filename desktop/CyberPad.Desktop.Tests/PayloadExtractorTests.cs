using System.IO.Compression;
using System.Text;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

[Collection(InstallTestCollection.Name)]
public sealed class PayloadExtractorTests : IDisposable
{
    private readonly InstallTempDir _temp = new();
    private readonly string _installDir;
    private readonly string _victim;

    public PayloadExtractorTests()
    {
        _installDir = _temp.Path_("app", "CyberPad");
        _victim = _temp.Path_("victim.txt");
        File.WriteAllText(_victim, "keep me");
    }

    public void Dispose() => _temp.Dispose();

    private void AssertNothingWrittenAndVictimKept(string before)
    {
        Assert.False(Directory.Exists(_installDir));
        Assert.Equal("keep me", File.ReadAllText(_victim));
        Assert.Equal(before, _temp.Dump());
    }

    [Fact]
    public void NormalPayload_RoundTrips()
    {
        using MemoryStream zip = TestZips.Build(
            ("CyberPad.exe", "exe"),
            ("wwwroot/", ""),
            ("wwwroot/index.html", "<html>"),
            ("wwwroot\\js\\app.js", "js"),
            ("runtimes/win-x64/native/a.dll", "dll"));
        var progress = new ListProgress();

        IReadOnlyList<string> files = new PayloadExtractor().Extract(zip, _installDir, progress);

        Assert.Equal(new[] { "CyberPad.exe", @"wwwroot\index.html", @"wwwroot\js\app.js", @"runtimes\win-x64\native\a.dll" }, files);
        Assert.Equal("exe", File.ReadAllText(Path.Combine(_installDir, "CyberPad.exe")));
        Assert.Equal("<html>", File.ReadAllText(Path.Combine(_installDir, "wwwroot", "index.html")));
        Assert.Equal("js", File.ReadAllText(Path.Combine(_installDir, "wwwroot", "js", "app.js")));
        Assert.Equal(100, progress.Values.Last());
        Assert.Equal("keep me", File.ReadAllText(_victim));
    }

    [Theory]
    [InlineData("../x")]
    [InlineData("..\\x")]
    [InlineData("../../victim.txt")]
    [InlineData("..\\..\\victim.txt")]
    [InlineData("/abs")]
    [InlineData("\\abs")]
    [InlineData("C:/x")]
    [InlineData("C:\\x")]
    [InlineData("C:x")]
    [InlineData("a/../../x")]
    [InlineData("a/../b")]
    [InlineData("a/./b")]
    [InlineData("./a")]
    [InlineData("a//b")]
    [InlineData("//server/share/x")]
    [InlineData("\\\\?\\C:\\x")]
    [InlineData("CON")]
    [InlineData("con.txt")]
    [InlineData("a/NUL/b")]
    [InlineData("COM1.dll")]
    [InlineData("LPT3")]
    [InlineData("a:b")]
    [InlineData("a.txt:stream")]
    [InlineData("x.")]
    [InlineData("x ")]
    [InlineData("dir./x")]
    [InlineData("a\u0001b")]
    [InlineData("a\nb")]
    [InlineData("a?b")]
    [InlineData("a*b")]
    [InlineData("a<b>")]
    [InlineData("a|b")]
    [InlineData("a\"b")]
    [InlineData("PROGRA~1/x")]
    [InlineData("install.manifest")]
    [InlineData("Uninstall.exe")]
    [InlineData("UNINSTALL.EXE")]
    [InlineData("install.manifest/x")]
    [InlineData("Uninstall.exe/x")]
    [InlineData("uninstall.exe/")]
    [InlineData("../")]
    [InlineData("/")]
    public void HostileEntryName_StopsTheExtraction_AndWritesNothing(string name)
    {
        string before = _temp.Dump();
        using MemoryStream zip = TestZips.Build(("CyberPad.exe", "exe"), (name, "evil"));

        var ex = Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(zip, _installDir, null));

        Assert.Equal(InstallMessages.PayloadDamaged, ex.Message);
        AssertNothingWrittenAndVictimKept(before);
        Assert.False(File.Exists(_temp.Path_("x")));
        Assert.False(File.Exists(_temp.Path_("app", "x")));
        Assert.False(File.Exists(@"C:\x"));
    }

    [Fact]
    public void NameOf201Characters_IsRefused_And200IsAllowed()
    {
        string at200 = "d/" + new string('n', 198);
        using (MemoryStream ok = TestZips.Build((at200, "x")))
        {
            Assert.Single(new PayloadExtractor().Extract(ok, _installDir, null));
        }

        string before = _temp.Dump();
        using MemoryStream bad = TestZips.Build((at200 + "n", "x"));
        Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(bad, _temp.Path_("other"), null));
        Assert.Equal(before, _temp.Dump());
    }

    [Theory]
    [InlineData("a.txt", "A.TXT")]
    [InlineData("dir/a.txt", "DIR\\a.txt")]
    [InlineData("a", "a/b")]
    [InlineData("x/y", "x/y/z")]
    public void DuplicateOrConflictingNames_AreRefused(string first, string second)
    {
        string before = _temp.Dump();
        using MemoryStream zip = TestZips.Build((first, "1"), (second, "2"));
        Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(zip, _installDir, null));
        AssertNothingWrittenAndVictimKept(before);
    }

    [Fact]
    public void MoreThan2000Entries_AreRefused()
    {
        string before = _temp.Dump();
        var entries = Enumerable.Range(0, 2001).Select(i => ($"f{i}.txt", "x")).ToArray();
        using MemoryStream zip = TestZips.Build(entries);
        Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(zip, _installDir, null));
        AssertNothingWrittenAndVictimKept(before);
    }

    [Fact]
    public void EntryCap_AllowsExactlyTheCap()
    {
        using MemoryStream five = TestZips.Build(Enumerable.Range(0, 5).Select(i => ($"f{i}", "x")).ToArray());
        Assert.Equal(5, new PayloadExtractor(5, 1000).Extract(five, _installDir, null).Count);

        using MemoryStream six = TestZips.Build(Enumerable.Range(0, 6).Select(i => ($"f{i}", "x")).ToArray());
        Assert.Throws<InstallException>(() => new PayloadExtractor(5, 1000).Extract(six, _temp.Path_("other"), null));
    }

    [Fact]
    public void TotalSizeOverTheCap_StopsHalfWay_AndRemovesEverythingWritten()
    {
        string before = _temp.Dump();
        var data = new byte[400];
        using MemoryStream zip = TestZips.BuildBytes(("a.bin", data), ("b.bin", data), ("c.bin", data));
        var ex = Assert.Throws<InstallException>(() => new PayloadExtractor(10, 1000).Extract(zip, _installDir, null));
        Assert.Equal(InstallMessages.PayloadDamaged, ex.Message);
        AssertNothingWrittenAndVictimKept(before);
    }

    [Fact]
    public void EntryWhoseDataExceedsTheCapWhileItsHeaderClaimsLess_IsStopped_WithNoPartialFile()
    {
        // The .NET Framework zip reader (used by the real setup) does not stop at the declared size, so
        // the extractor counts real bytes. Simulate that reader: the header says 10 bytes, the data never ends.
        string before = _temp.Dump();
        var endless = new EndlessStream();
        using MemoryStream zip = TestZips.Build(("first.txt", "ok"), ("big.bin", "0123456789"));
        var extractor = new PayloadExtractor(10, 1000);
        extractor.OpenEntry = e => e.FullName == "big.bin" ? endless : e.Open();

        var ex = Assert.Throws<InstallException>(() => extractor.Extract(zip, _installDir, null));

        Assert.Equal(InstallMessages.PayloadDamaged, ex.Message);
        Assert.True(endless.BytesRead <= 1000 + 81920, "reading stopped at the cap");
        AssertNothingWrittenAndVictimKept(before);
    }

    [Fact]
    public void EntryShorterThanItsHeaderClaims_IsRefused()
    {
        string before = _temp.Dump();
        using MemoryStream zip = TestZips.Build(("CyberPad.exe", "0123456789"));
        var extractor = new PayloadExtractor { OpenEntry = _ => new MemoryStream(new byte[3]) };

        Assert.Throws<InstallException>(() => extractor.Extract(zip, _installDir, null));

        AssertNothingWrittenAndVictimKept(before);
    }

    [Fact]
    public void RealZipWhoseHeaderUnderstatesItsSize_NeverWritesMoreThanDeclared()
    {
        // On .NET 8 the zip reader itself stops at the declared size; whatever the reader does, no file may
        // grow past the declared size and the total cap.
        var big = new byte[5000];
        new Random(1).NextBytes(big);
        byte[] zipBytes = TestZips.BuildBytes(("big.bin", big)).ToArray();
        PatchUncompressedSize(zipBytes, 10);

        using var zip = new MemoryStream(zipBytes);
        try
        {
            new PayloadExtractor(10, 1000).Extract(zip, _installDir, null);
            Assert.True(new FileInfo(Path.Combine(_installDir, "big.bin")).Length <= 10);
        }
        catch (InstallException)
        {
            Assert.False(Directory.Exists(_installDir));
        }
    }

    private sealed class EndlessStream : Stream
    {
        public long BytesRead { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => BytesRead; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count)
        {
            Array.Fill(buffer, (byte)'z', offset, count);
            BytesRead += count;
            return count;
        }
    }

    [Fact]
    public void NotAZip_IsReportedAsDamaged()
    {
        using var zip = new MemoryStream(Encoding.ASCII.GetBytes("this is not a zip file"));
        var ex = Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(zip, _installDir, null));
        Assert.Equal(InstallMessages.PayloadDamaged, ex.Message);
        Assert.False(Directory.Exists(_installDir));
    }

    [Fact]
    public void ExistingFileInTheTarget_IsNeverOverwritten()
    {
        Directory.CreateDirectory(_installDir);
        File.WriteAllText(Path.Combine(_installDir, "CyberPad.exe"), "user's");
        using MemoryStream zip = TestZips.Build(("other.txt", "x"), ("CyberPad.exe", "new"));

        var ex = Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(zip, _installDir, null));

        Assert.Equal(InstallMessages.FilesInTheWay, ex.Message);
        Assert.Equal("user's", File.ReadAllText(Path.Combine(_installDir, "CyberPad.exe")));
        Assert.False(File.Exists(Path.Combine(_installDir, "other.txt")));
    }

    [Fact]
    public void FolderInThePayloadThatIsAJunctionOnDisk_IsNotWrittenThrough()
    {
        string outside = _temp.Path_("outside");
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(_installDir);
        _temp.CreateJunction(Path.Combine(_installDir, "wwwroot"), outside);
        using MemoryStream zip = TestZips.Build(("wwwroot/index.html", "x"));

        Assert.Throws<InstallException>(() => new PayloadExtractor().Extract(zip, _installDir, null));

        Assert.Empty(Directory.GetFileSystemEntries(outside));
        Assert.Equal("keep me", File.ReadAllText(_victim));
    }

    /// <summary>Rewrites the uncompressed-size field of the (only) entry in the local and central headers.</summary>
    private static void PatchUncompressedSize(byte[] zip, uint size)
    {
        int patched = 0;
        for (int i = 0; i + 4 <= zip.Length; i++)
        {
            uint signature = BitConverter.ToUInt32(zip, i);
            if (signature == 0x04034b50)
            {
                BitConverter.GetBytes(size).CopyTo(zip, i + 22);
                patched++;
            }
            else if (signature == 0x02014b50)
            {
                BitConverter.GetBytes(size).CopyTo(zip, i + 24);
                patched++;
            }
        }

        Assert.Equal(2, patched);
        using var check = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        Assert.Equal(size, (uint)check.Entries[0].Length);
    }
}
