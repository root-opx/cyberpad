using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Tests;

public sealed class CommandLinePathTests
{
    [Fact]
    public void Relative_IsResolvedAgainstTheGivenBase()
    {
        Assert.True(CommandLinePath.TryResolve("notes.md", @"C:\work", out var p, out var f));
        Assert.Equal(@"C:\work\notes.md", p);
        Assert.Equal(LinkFormat.Md, f);
        Assert.True(CommandLinePath.TryResolve(@"..\a.txt", @"C:\work\sub", out p, out _));
        Assert.Equal(@"C:\work\a.txt", p);
    }

    [Fact]
    public void Absolute_IsUnchanged()
    {
        Assert.True(CommandLinePath.TryResolve(@"D:\x\y.txt", @"C:\work", out var p, out _));
        Assert.Equal(@"D:\x\y.txt", p);
    }

    [Theory]
    [InlineData(@"C:\x\a.exe")]
    [InlineData("a.exe")]
    [InlineData(@"\\.\pipe\x.txt")]
    [InlineData(@"\\?\C:\x\a.txt")]
    [InlineData(@"C:\x\a.txt:stream")]
    [InlineData("a.txt:stream")]
    [InlineData("")]
    [InlineData("a\0.txt")]
    public void Unsupported_IsRejected(string arg)
    {
        Assert.False(CommandLinePath.TryResolve(arg, @"C:\work", out _, out _));
    }

    [Fact]
    public void BadBase_IsRejected() =>
        Assert.False(CommandLinePath.TryResolve("a.md", "relative", out _, out _));
}
