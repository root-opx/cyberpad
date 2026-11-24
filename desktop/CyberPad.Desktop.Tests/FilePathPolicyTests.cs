using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Tests;

public sealed class FilePathPolicyTests
{
    [Theory]
    [InlineData(@"C:\Notes\case.txt", true, LinkFormat.Txt)]
    [InlineData(@"C:\Notes\Case.MD", true, LinkFormat.Md)]
    [InlineData(@"D:\x\secret.cpnote", true, LinkFormat.CpNote)]
    [InlineData(@"\\server\share\n.md", true, LinkFormat.Md)]
    [InlineData(@"C:\Notes\run.exe", false, default(LinkFormat))]
    [InlineData(@"C:\Notes\n.txt.exe", false, default(LinkFormat))]
    [InlineData(@"\\.\COM1", false, default(LinkFormat))]
    [InlineData(@"\\?\C:\x.txt", false, default(LinkFormat))]
    [InlineData(@"relative\n.txt", false, default(LinkFormat))]
    [InlineData("C:\a\nb.txt", false, default(LinkFormat))]
    [InlineData("", false, default(LinkFormat))]
    public void TryNormalize_AllowsOnlyRootedPathsWithKnownExtensions(string raw, bool ok, LinkFormat f)
    {
        Assert.Equal(ok, FilePathPolicy.TryNormalize(raw, out var full, out var format));
        if (ok)
        {
            Assert.Equal(f, format);
            Assert.Equal(Path.GetFullPath(raw), full);
        }
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
    public void LinkFormats_TryParse_ExactCase()
    {
        Assert.False(LinkFormats.TryParse("TXT", out _));
        Assert.False(LinkFormats.TryParse("html", out _));
        Assert.False(LinkFormats.TryParse("", out _));
        Assert.False(LinkFormats.TryParse(null, out _));
        Assert.True(LinkFormats.TryParse("cpnote", out var f));
        Assert.Equal(LinkFormat.CpNote, f);
    }

    [Fact]
    public void LinkFormats_MapsWireExtensionAndFilter()
    {
        Assert.Equal("md", LinkFormats.Wire(LinkFormat.Md));
        Assert.Equal(".cpnote", LinkFormats.Extension(LinkFormat.CpNote));
        Assert.Equal("Text (*.txt)|*.txt", LinkFormats.DialogFilter(LinkFormat.Txt));
    }
}
