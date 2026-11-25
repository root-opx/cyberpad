using System.Runtime.InteropServices;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

[Collection(InstallTestCollection.Name)]
public sealed class CommandLineTests
{
    [Theory]
    [InlineData(@"C:\Apps\CyberPad\CyberPad.exe", "\"C:\\Apps\\CyberPad\\CyberPad.exe\"")]
    [InlineData(@"C:\Program Files Here\Cyber Pad\Uninstall.exe", "\"C:\\Program Files Here\\Cyber Pad\\Uninstall.exe\"")]
    [InlineData(@"C:\a\", "\"C:\\a\\\\\"")]
    [InlineData(@"C:\a\\", "\"C:\\a\\\\\\\\\"")]
    [InlineData("a\"b", "\"a\\\"b\"")]
    [InlineData("a\\\"b", "\"a\\\\\\\"b\"")]
    [InlineData("a\\\\b", "\"a\\\\b\"")]
    [InlineData("", "\"\"")]
    [InlineData(@"C:\50% off\x", "\"C:\\50% off\\x\"")]
    [InlineData(@"C:\a & b\x", "\"C:\\a & b\\x\"")]
    [InlineData(@"C:\a^b\x", "\"C:\\a^b\\x\"")]
    public void Quote_ProducesTheExpectedText(string arg, string expected) => Assert.Equal(expected, CommandLine.Quote(arg));

    [Theory]
    [InlineData(@"C:\Apps\Cyber Pad\CyberPad.exe")]
    [InlineData(@"C:\a\")]
    [InlineData(@"C:\a\\\")]
    [InlineData("a\"b")]
    [InlineData("a\\\"b")]
    [InlineData("\\\"")]
    [InlineData("\"\"")]
    [InlineData(@"C:\50% & ^ off\x")]
    [InlineData("tab\there")]
    [InlineData("")]
    public void Quote_RoundTripsThroughTheWindowsParser(string arg)
    {
        string commandLine = "prog.exe " + CommandLine.Quote(arg) + " next";
        Assert.Equal(new[] { "prog.exe", arg, "next" }, Parse(commandLine));
    }

    [Fact]
    public void Quote_RefusesNul() => Assert.Throws<ArgumentException>(() => CommandLine.Quote("a\0b"));

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\Programs\CyberPad", "\"C:\\Users\\u\\AppData\\Local\\Programs\\CyberPad\\Uninstall.exe\"")]
    [InlineData(@"C:\Tools\Cyber Pad", "\"C:\\Tools\\Cyber Pad\\Uninstall.exe\"")]
    [InlineData(@"C:\Tools\a & b ^c", "\"C:\\Tools\\a & b ^c\\Uninstall.exe\"")]
    public void UninstallCommand_QuotesTheUninstaller(string folder, string expected) =>
        Assert.Equal(expected, CommandLine.UninstallCommand(folder));

    [Theory]
    [InlineData(@"C:\Users\u\AppData\Local\Programs\CyberPad", "\"C:\\Users\\u\\AppData\\Local\\Programs\\CyberPad\\CyberPad.exe\" \"%1\"")]
    [InlineData(@"C:\Tools\Cyber Pad", "\"C:\\Tools\\Cyber Pad\\CyberPad.exe\" \"%1\"")]
    public void OpenCommand_QuotesTheAppAndTheFile(string folder, string expected) =>
        Assert.Equal(expected, CommandLine.OpenCommand(folder));

    [Theory]
    [InlineData("C:\\Tools\\Cyber\"Pad")]
    [InlineData("C:\\Tools\\CyberPad\" \"C:\\evil.exe")]
    [InlineData(@"C:\Tools\%1")]
    [InlineData(@"C:\Tools\%TEMP%")]
    [InlineData(@"C:\Tools\")]
    [InlineData(@"Tools\CyberPad")]
    [InlineData(@"\\server\share")]
    [InlineData("C:\\Tools\\a\nb")]
    public void CommandBuilders_RefuseFoldersThatCannotBeQuotedSafely(string folder)
    {
        Assert.Throws<ArgumentException>(() => CommandLine.UninstallCommand(folder));
        Assert.Throws<ArgumentException>(() => CommandLine.OpenCommand(folder));
    }

    private static string[] Parse(string commandLine)
    {
        IntPtr argv = CommandLineToArgvW(commandLine, out int count);
        Assert.NotEqual(IntPtr.Zero, argv);
        try
        {
            var args = new string[count];
            for (int i = 0; i < count; i++)
            {
                args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size))!;
            }

            return args;
        }
        finally
        {
            LocalFree(argv);
        }
    }

    // Parses a command line into arguments; it runs nothing.
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr CommandLineToArgvW(string lpCmdLine, out int pNumArgs);

    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr LocalFree(IntPtr hMem);
}
