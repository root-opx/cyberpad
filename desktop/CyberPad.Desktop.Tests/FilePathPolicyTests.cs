using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Tests;

public sealed class FilePathPolicyTests
{
    [Theory]
    [InlineData(@"C:\Notes\case.txt", "txt")]
    [InlineData(@"C:\Notes\Case.MD", "md")]
    [InlineData(@"D:\x\secret.cpnote", "cpnote")]
    [InlineData(@"\\server\share\n.md", "md")]
    [InlineData(@"C:\Notes\script.py", "py")]
    [InlineData(@"C:\Notes\script.PY", "py")]
    [InlineData(@"C:\Notes\Script.Ps1", "ps1")]
    [InlineData(@"C:\Notes\.gitignore", "gitignore")]
    [InlineData(@"C:\Notes\.env", "env")]
    [InlineData(@"C:\Notes\.ENV", "env")]
    [InlineData(@"C:\Notes\app.properties", "properties")]
    [InlineData(@"C:\Notes\boot.s", "s")]
    public void TryNormalize_AcceptsListedTypes_AndReportsTheCanonicalWire(string raw, string wire)
    {
        Assert.True(FilePathPolicy.TryNormalize(raw, out var full, out var format));
        Assert.Equal(wire, format.Wire);
        Assert.Equal(Path.GetFullPath(raw), full);
    }

    [Theory]
    [InlineData(@"C:\Notes\run.exe")]
    [InlineData(@"C:\Notes\n.txt.exe")]
    [InlineData(@"C:\Notes\name.py.exe")]
    [InlineData(@"C:\Notes\n.js.exe")]
    [InlineData(@"C:\Notes\Makefile")]
    [InlineData(@"C:\Notes\n.")]
    [InlineData(@"C:\Notes\n.abcdefghijklm")]
    [InlineData("C:\\Notes\\n.\u0440y")]          // Cyrillic er, looks like "py"
    [InlineData("C:\\Notes\\n.\u0440Y")]          // the same, upper-case Latin Y
    [InlineData("C:\\Notes\\n.\u017Fh")]          // long s: Unicode upper-cases it to "S"
    [InlineData("C:\\Notes\\n.\uFF50\uFF59")]     // full-width "py"
    [InlineData("C:\\Notes\\n.\u212Ash")]         // Kelvin sign
    [InlineData(@"C:\Notes\n.py:stream")]
    [InlineData(@"C:\Notes\n.py::$DATA")]
    [InlineData(@"\\.\COM1")]
    [InlineData(@"\\?\C:\x.txt")]
    [InlineData(@"\\?\C:\x.py ")]
    [InlineData(@"relative\n.txt")]
    [InlineData("C:\\a\nb.txt")]
    [InlineData(@"C:\Notes\n.md:x.txt")]
    [InlineData(@"\\server\share\n.md:x.txt")]
    [InlineData(@"\\server:1\share\n.md")]
    [InlineData("")]
    public void TryNormalize_RefusesEverythingElse(string raw)
    {
        Assert.False(FilePathPolicy.TryNormalize(raw, out var full, out var format));
        Assert.Equal(string.Empty, full);
        Assert.False(format.IsDefined);
    }

    [Theory]
    [InlineData("exe")]
    [InlineData("dll")]
    [InlineData("com")]
    [InlineData("scr")]
    [InlineData("msi")]
    [InlineData("lnk")]
    [InlineData("url")]
    [InlineData("hta")]
    [InlineData("vbs")]
    public void TryNormalize_RefusesExecutableAndShortcutTypes(string ext)
    {
        Assert.False(FilePathPolicy.TryNormalize(@"C:\Notes\n." + ext, out _, out _));
        Assert.False(FilePathPolicy.TryNormalize(@"C:\Notes\n." + ext.ToUpperInvariant(), out _, out _));
    }

    /// <summary>
    /// Windows drops trailing dots and spaces from the last path segment when it opens a file. GetFullPath does the same,
    /// so the policy judges, and returns, the name the file system will really open.
    /// </summary>
    [Theory]
    [InlineData("name.py ", "name.py", "py")]
    [InlineData("name.py.", "name.py", "py")]
    [InlineData("name.py. . ", "name.py", "py")]
    [InlineData("name.PY  ", "name.PY", "py")]
    public void TryNormalize_TrailingDotOrSpace_JudgesTheNameWindowsOpens(string typed, string opened, string wire)
    {
        var dir = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, opened), "x");
            var raw = dir + "\\" + typed;
            Assert.True(FilePathPolicy.TryNormalize(raw, out var full, out var format));
            Assert.Equal(Path.Combine(dir, opened), full);
            Assert.Equal(wire, format.Wire);
            Assert.Equal("x", File.ReadAllText(raw)); // the file system opens the same file under the typed name
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Theory]
    [InlineData("name.exe ")]
    [InlineData("name.exe.")]
    [InlineData("name.py .exe")]
    [InlineData("name.py.exe. ")]
    public void TryNormalize_TrailingDotOrSpace_NeverHidesAnUnlistedType(string typed)
    {
        Assert.False(FilePathPolicy.TryNormalize(@"C:\Notes\" + typed, out _, out _));
    }

    [Fact]
    public void TryNormalize_RejectsNull()
    {
        Assert.False(FilePathPolicy.TryNormalize(null, out _, out _));
    }

    [Fact]
    public void TryNormalize_RejectsOverlong()
    {
        Assert.False(FilePathPolicy.TryNormalize("C:\\" + new string('a', 32800) + ".txt", out _, out _));
    }

    [Fact]
    public void UnsupportedMessage_IsTheNewSentence()
    {
        Assert.Equal("CyberPad cannot open that file type.", FilePathPolicy.UnsupportedMessage);
    }

    [Fact]
    public void LinkFormat_TryParse_ExactCase()
    {
        Assert.False(LinkFormat.TryParse("TXT", out _));
        Assert.False(LinkFormat.TryParse("exe", out _));
        Assert.False(LinkFormat.TryParse("", out _));
        Assert.False(LinkFormat.TryParse(null, out _));
        Assert.True(LinkFormat.TryParse("cpnote", out var f));
        Assert.Equal(LinkFormat.CpNote, f);
        Assert.True(f.IsEncrypted);
        Assert.True(LinkFormat.TryParse("html", out var h));
        Assert.False(h.IsEncrypted);
    }

    [Fact]
    public void LinkFormat_MapsWireAndExtension_AndDefaultIsNoFormat()
    {
        Assert.Equal("md", LinkFormat.Md.Wire);
        Assert.Equal(".cpnote", LinkFormat.CpNote.Extension);
        Assert.False(default(LinkFormat).IsDefined);
        Assert.False(default(LinkFormat).IsEncrypted);
        Assert.Throws<InvalidOperationException>(() => default(LinkFormat).Wire);
        Assert.NotEqual(default, LinkFormat.Txt);
    }
}
