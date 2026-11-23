namespace CyberPad.Desktop.Tests;

public sealed class HostActionsTests
{
    private const string DataDir = @"C:\Users\u\AppData\Local\CyberPad";

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\notes.json")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\notes.json.bak")]
    [InlineData(@"c:\users\U\appdata\local\cyberpad\NOTES.JSON")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\WebView2\x.md")]
    [InlineData(@"C:\Users\u\AppData\Local\Temp\..\CyberPad\notes.json")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad\.\window.json")]
    public void IsInsideDataDir_TrueForPathsInTheDataFolder(string chosen)
    {
        Assert.True(HostActions.IsInsideDataDir(chosen, DataDir));
        Assert.True(HostActions.IsInsideDataDir(chosen, DataDir + @"\"));
    }

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad2\notes.json")]
    [InlineData(@"C:\Users\u\AppData\Local\CyberPad.md")]
    [InlineData(@"C:\Users\u\Documents\notes.json")]
    [InlineData(@"D:\CyberPad\notes.json")]
    public void IsInsideDataDir_FalseForPathsOutsideIt(string chosen)
    {
        Assert.False(HostActions.IsInsideDataDir(chosen, DataDir));
    }
}
