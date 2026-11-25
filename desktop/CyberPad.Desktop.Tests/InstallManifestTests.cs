using System.Text;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

[Collection(InstallTestCollection.Name)]
public sealed class InstallManifestTests
{
    private static InstallManifest? Parse(string text) => InstallManifest.TryRead(new MemoryStream(Encoding.UTF8.GetBytes(text)));

    private static InstallManifest? Parse(byte[] bytes) => InstallManifest.TryRead(new MemoryStream(bytes));

    [Fact]
    public void WriteThenRead_RoundTrips()
    {
        var manifest = new InstallManifest("1.2.30", new[] { "CyberPad.exe", "wwwroot/index.html", @"wwwroot\js\app.js" });
        var stream = new MemoryStream();
        manifest.Write(stream);
        byte[] bytes = stream.ToArray();

        Assert.Equal("CyberPad-Install 1\nversion=1.2.30\nCyberPad.exe\nwwwroot\\index.html\nwwwroot\\js\\app.js\n", Encoding.UTF8.GetString(bytes));
        Assert.NotEqual(0xEF, bytes[0]); // no BOM
        Assert.DoesNotContain((byte)'\r', bytes);

        InstallManifest? read = Parse(bytes);
        Assert.NotNull(read);
        Assert.Equal("1.2.30", read!.Version);
        Assert.Equal(new[] { "CyberPad.exe", @"wwwroot\index.html", @"wwwroot\js\app.js" }, read.Files);
    }

    [Fact]
    public void EmptyFileList_IsValid() => Assert.Empty(Parse("CyberPad-Install 1\nversion=1\n")!.Files);

    [Fact]
    public void Exactly2000Paths_AreValid()
    {
        string text = "CyberPad-Install 1\nversion=1.0.0\n" + string.Concat(Enumerable.Range(0, 2000).Select(i => $"f{i}\n"));
        Assert.Equal(2000, Parse(text)!.Files.Count);
    }

    [Theory]
    [InlineData("")]
    [InlineData("\n")]
    [InlineData("CyberPad-Install 1\n")]
    [InlineData("CyberPad-Install 2\nversion=1.0.0\nCyberPad.exe\n")]
    [InlineData("cyberpad-install 1\nversion=1.0.0\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1 \nversion=1.0.0\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\r\nversion=1.0.0\r\nCyberPad.exe\r\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nCyberPad.exe")]
    [InlineData("\uFEFFCyberPad-Install 1\nversion=1.0.0\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=v1\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1..2\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=.1\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1.\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0-beta\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0.0.0.0.0.0.0.0.1\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nVersion=1.0.0\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion = 1.0.0\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n..\\..\\victim.txt\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n../../victim.txt\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\na\\..\\..\\x\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n..\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n.\\a\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nC:\\Windows\\win.ini\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nC:x\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n\\Windows\\win.ini\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n/etc/passwd\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n\\\\server\\share\\x\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\na:b\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nCON\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nwwwroot\\aux.js\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nx.\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nx \n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\na\\\\b\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\na\\\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nCyberPad.exe\n\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\n\nCyberPad.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nCyberPad.exe\ncyberpad.EXE\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\na/b\na\\B\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\ninstall.manifest\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nUninstall.exe\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\ninstall.manifest\\x\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nUninstall.exe/x\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\na\u0007b\n")]
    [InlineData("CyberPad-Install 1\nversion=1.0.0\nPROGRA~1\\x\n")]
    [InlineData("version=1.0.0\nCyberPad-Install 1\nCyberPad.exe\n")]
    public void InvalidManifest_ReadsAsNull(string text) => Assert.Null(Parse(text));

    [Fact]
    public void MoreThan2000Paths_ReadsAsNull()
    {
        string text = "CyberPad-Install 1\nversion=1.0.0\n" + string.Concat(Enumerable.Range(0, 2001).Select(i => $"f{i}\n"));
        Assert.Null(Parse(text));
    }

    [Fact]
    public void PathOf201Characters_ReadsAsNull()
    {
        Assert.NotNull(Parse("CyberPad-Install 1\nversion=1\n" + new string('a', 200) + "\n"));
        Assert.Null(Parse("CyberPad-Install 1\nversion=1\n" + new string('a', 201) + "\n"));
    }

    [Fact]
    public void FileOver256KB_ReadsAsNull_WithoutReadingTheRest()
    {
        // 1,500 lines of 190 characters: under the line cap, about 285 KB.
        string text = "CyberPad-Install 1\nversion=1.0.0\n" +
                      string.Concat(Enumerable.Range(0, 1500).Select(i => i.ToString("D4") + new string('p', 186) + "\n"));
        Assert.True(Encoding.UTF8.GetByteCount(text) > InstallManifest.MaxBytes);
        Assert.Null(Parse(text));

        var endless = new EndlessStream();
        Assert.Null(InstallManifest.TryRead(endless));
        Assert.True(endless.BytesRead <= InstallManifest.MaxBytes + 1);
    }

    [Fact]
    public void NulByte_ReadsAsNull()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("CyberPad-Install 1\nversion=1.0.0\nCyber\0Pad.exe\n");
        Assert.Null(Parse(bytes));
    }

    [Fact]
    public void InvalidUtf8_ReadsAsNull()
    {
        byte[] head = Encoding.UTF8.GetBytes("CyberPad-Install 1\nversion=1.0.0\n");
        byte[] bytes = head.Concat(new byte[] { 0x61, 0xC3, 0x28, 0x0A }).ToArray();
        Assert.Null(Parse(bytes));

        byte[] overlong = head.Concat(new byte[] { 0xC0, 0xAE, 0xC0, 0xAE, 0x5C, 0x78, 0x0A }).ToArray(); // overlong "..\x"
        Assert.Null(Parse(overlong));
    }

    [Fact]
    public void ManifestFileThatIsALink_ReadsAsNull()
    {
        const string dir = @"C:\Apps\CyberPad";
        var probe = new FakeProbe().Install(dir);
        Assert.NotNull(InstallManifest.TryReadFrom(dir, probe));

        probe.ReparsePoints.Add(dir + @"\install.manifest");
        Assert.Null(InstallManifest.TryReadFrom(dir, probe));
    }

    [Fact]
    public void MissingManifest_ReadsAsNull() => Assert.Null(InstallManifest.TryReadFrom(@"C:\Apps\CyberPad", new FakeProbe()));

    [Theory]
    [InlineData("1.0.0", true)]
    [InlineData("10", true)]
    [InlineData("1.2.3.4", true)]
    [InlineData("12345678901234567890", true)]
    [InlineData("123456789012345678901", false)]
    [InlineData("1.0.0 ", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void VersionRule(string? version, bool valid) => Assert.Equal(valid, InstallManifest.IsValidVersion(version));

    [Fact]
    public void Constructor_RefusesInvalidValues()
    {
        Assert.Throws<ArgumentException>(() => new InstallManifest("1.x", new[] { "a" }));
        Assert.Throws<ArgumentException>(() => new InstallManifest("1", new[] { "..\\a" }));
        Assert.Throws<ArgumentException>(() => new InstallManifest("1", new[] { "a", "A" }));
        Assert.Throws<ArgumentException>(() => new InstallManifest("1", new[] { "Uninstall.exe" }));
        Assert.Throws<ArgumentException>(() => new InstallManifest("1", Enumerable.Range(0, 2001).Select(i => $"f{i}")));
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
            Array.Fill(buffer, (byte)'a', offset, count);
            BytesRead += count;
            return count;
        }
    }
}
