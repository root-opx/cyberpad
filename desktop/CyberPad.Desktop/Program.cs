using System.Security.Principal;
using CyberPad.Desktop.Diagnostics;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;
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
    private static int Main(string[] args)
    {
        // "Open with" can start us with the opened file's folder as the working directory. Nothing here should
        // resolve a relative name against it, so move to the install folder first.
        try
        {
            Directory.SetCurrentDirectory(AppContext.BaseDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            Log($"startup: cwd {ex.GetType().Name}");
        }

        ApplicationConfiguration.Initialize();

        // Exactly one argument is a path to open; anything else that is present is invalid. An invalid request
        // is reported once, then CyberPad carries on as if it had been started without it.
        string? requestedPath = null;
        if (args.Length > 0)
        {
            if (args.Length == 1 && FilePathPolicy.TryNormalize(args[0], out var normalized, out _))
            {
                requestedPath = normalized;
            }
            else
            {
                MessageBox.Show(FilePathPolicy.UnsupportedMessage, Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

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
            if (requestedPath is not null)
            {
                if (!FileHandoff.TrySend(sid, requestedPath, TimeSpan.FromSeconds(3)))
                {
                    ShowError("CyberPad is already running but not responding.");
                    return 1;
                }
            }
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

        var links = new LinkStore(dataDir);
        try
        {
            links.Load();
        }
        catch (StoreException ex)
        {
            Log($"startup: links {ex.GetType().Name}");
            ShowError("CyberPad could not read its list of linked files. Check that the CyberPad data folder is accessible and start CyberPad again.");
            return 1;
        }

        // Created here so a command-line path can be queued before the window exists.
        var openRequests = new OpenRequestQueue();
        if (requestedPath is not null && !openRequests.TryEnqueue(requestedPath)) Log("startup: open queue full");

        var version = typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        using var form = new MainForm(dataDir, wwwroot, version, instance, Log, links, openRequests);

        // Paths from later "Open with" launches arrive on a pipe thread: queue, then let the window pick them up.
        using var handoff = StartHandoffServer(sid, openRequests, form);
        Application.Run(form);
        return 0;
    }

    private static FileHandoffServer? StartHandoffServer(string sid, OpenRequestQueue queue, MainForm form)
    {
        try
        {
            return new FileHandoffServer(sid, path =>
            {
                if (!queue.TryEnqueue(path))
                {
                    Log("handoff: open queue full, path dropped");
                    return;
                }
                form.NotifyPathQueued();
            }, Log);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // CyberPad still works; only "Open with" while it is running is unavailable.
            Log($"startup: handoff server {ex.GetType().Name}");
            return null;
        }
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
