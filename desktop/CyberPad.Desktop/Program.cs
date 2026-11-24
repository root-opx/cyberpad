using System.Security.Principal;
using CyberPad.Desktop.Diagnostics;
using Microsoft.Web.WebView2.Core;

namespace CyberPad.Desktop;

internal static class Program
{
    private const string Title = "CyberPad";

    private const string RuntimeMissingMessage =
        "CyberPad needs the Microsoft Edge WebView2 Runtime. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start CyberPad again.";

    /// <summary>%LOCALAPPDATA%\CyberPad\cyberpad.log (Trace only if local app data is unavailable). Fixed path, never from input.</summary>
    private static readonly FileLog s_log = new(LogPath());

    [STAThread]
    private static int Main()
    {
        ApplicationConfiguration.Initialize();

        var sid = WindowsIdentity.GetCurrent().User?.Value;
        if (sid is null)
        {
            ShowError("CyberPad could not identify the current Windows user.");
            return 1;
        }

        // Disposed at the end of Main, on this thread, which owns the mutex.
        using var instance = SingleInstance.TryAcquire(sid);
        if (instance is null)
        {
            SingleInstance.SignalExisting(sid);
            return 0;
        }

        if (!IsWebViewRuntimeInstalled())
        {
            ShowError(RuntimeMissingMessage);
            return 1;
        }

        var dataDir = DataDirectory();
        if (dataDir is null)
        {
            ShowError("CyberPad could not create its data folder in your local application data.");
            return 1;
        }

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (!File.Exists(Path.Combine(wwwroot, "index.html")))
        {
            ShowError("CyberPad's page files are missing. Reinstall CyberPad.");
            return 1;
        }

        var version = typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        Application.Run(new MainForm(dataDir, wwwroot, version, instance, Log));
        return 0;
    }

    private static bool IsWebViewRuntimeInstalled()
    {
        try
        {
            return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            return false;
        }
    }

    /// <summary>%LOCALAPPDATA%\CyberPad, created if needed. Never derived from user input. Null if unavailable.</summary>
    private static string? DataDirectory()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(localAppData)) return null;
        var dir = Path.Combine(localAppData, "CyberPad");
        try
        {
            Directory.CreateDirectory(dir);
            return dir;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log($"startup: data folder {ex.GetType().Name}");
            return null;
        }
    }

    private static void ShowError(string message) =>
        MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);

    private static string? LogPath()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return string.IsNullOrEmpty(localAppData) ? null : Path.Combine(localAppData, "CyberPad", FileLog.FileName);
    }

    /// <summary>Content-free diagnostics only (message type, reason, exception type name). Never throws.</summary>
    private static void Log(string line) => s_log.Write(line);
}
