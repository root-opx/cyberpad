using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CyberPad.Desktop;

/// <summary>
/// The CyberPad window: hosts the page in a locked-down WebView2, recovers from browser crashes, and asks the page to
/// seal and save its notes before the window closes.
/// </summary>
internal sealed class MainForm : Form
{
    private static readonly Size MinWindowSize = new(900, 600);
    private static readonly Size DefaultWindowSize = new(1280, 820);
    private static readonly Color PageBackground = Color.FromArgb(0x14, 0x0f, 0x2e);
    private static readonly string[] AllowedMenuItems = { "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "undo", "redo" };

    private const string OpenRequestedMessage = "{\"type\":\"openRequested\"}";
    private const string FlushMessage = "{\"type\":\"flush\"}";
    private const int FlushTimeoutMs = 5000;
    private const int MaxCrashesPerWindow = 3;
    private const long CrashWindowMs = 60_000;

    /// <summary>The page's "flushFailed" carries no detail, so one text covers notes.json and linked files.</summary>
    internal const string FlushFailedPrompt = "CyberPad could not save your latest changes (to its notes or to a linked file). Close anyway?";
    internal const string StillSavingPrompt = "CyberPad is still saving to a linked file. Close anyway?";

    internal enum FlushTimeoutAction { Close, AskFirst }

    /// <summary>
    /// What the 5 s close timeout does: close as before, or ask first while a linked-file operation is still running
    /// (closing then could cut off a slow write, for example to a network share).
    /// </summary>
    internal static FlushTimeoutAction OnFlushTimeout(bool fileOperationInFlight) =>
        fileOperationInFlight ? FlushTimeoutAction.AskFirst : FlushTimeoutAction.Close;

    private readonly string _dataDir;
    private readonly string _wwwroot;
    private readonly string _placementPath;
    private readonly Action<string> _log;
    private readonly SingleInstance _instance;
    private readonly HostActions _hostActions;
    private readonly OpenRequestQueue _openRequests;
    private readonly MessageDispatcher _dispatcher;
    private readonly System.Windows.Forms.Timer _closeTimer = new() { Interval = FlushTimeoutMs };
    private readonly Queue<long> _recentCrashes = new();

    private WebView2? _webView;
    private bool _pageReady;
    private bool _openRequestPosted; // the page has been asked and has not yet answered with openFile
    private ulong _appNavigationId;
    private bool _recoveryStopped;
    private HostTheme _theme = HostTheme.Neon;
    private bool _closeRequested;
    private bool _closeConfirmed;
    private FormWindowState _lastShownState = FormWindowState.Normal;

    public MainForm(string dataDir, string wwwroot, string version, SingleInstance instance, Action<string> log,
        LinkStore links, OpenRequestQueue openRequests)
    {
        _dataDir = dataDir;
        _wwwroot = wwwroot;
        _placementPath = Path.Combine(dataDir, "window.json");
        _log = log;
        _instance = instance;
        _openRequests = openRequests;
        _hostActions = new HostActions(new NoteStore(dataDir), links, new LinkedFiles(log), openRequests, version, this,
            ConfirmClose, FlushFailed, ApplyTheme, log);
        _hostActions.DialogClosed += OnFileActivityChanged;
        _hostActions.OpenCompleted += OnOpenCompleted;
        _dispatcher = new MessageDispatcher(_hostActions, log);

        Text = "CyberPad";
        MinimumSize = MinWindowSize;
        BackColor = PageBackground;
        Icon = LoadAppIcon();
        ApplyPlacement();

        _closeTimer.Tick += OnCloseTimerTick;
        _instance.ActivationRequested += OnActivationRequested;
    }

    // Always called on the UI thread (HostActions.SetThemeAsync posts it there).
    private void ApplyTheme(HostTheme theme)
    {
        _theme = theme;
        if (IsHandleCreated) TitleBar.Apply(Handle, theme, _log);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Dark before the page loads, and again after any handle re-creation.
        TitleBar.Apply(Handle, _theme, _log);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _instance.ActivationRequested -= OnActivationRequested;
            _hostActions.DialogClosed -= OnFileActivityChanged;
            _hostActions.OpenCompleted -= OnOpenCompleted;
            _closeTimer.Dispose();
        }
        base.Dispose(disposing);
    }

    // ---------------------------------------------------------------- window placement

    private void ApplyPlacement()
    {
        var screens = Screen.AllScreens.OrderByDescending(s => s.Primary).Select(s => s.WorkingArea).ToList();
        var saved = WindowPlacement.Read(_placementPath);
        var fit = WindowPlacement.Fit(saved ?? DefaultPlacement(screens), screens, MinWindowSize);
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(fit.X, fit.Y, fit.Width, fit.Height);
        if (fit.Maximized)
        {
            WindowState = FormWindowState.Maximized;
            _lastShownState = FormWindowState.Maximized;
        }
    }

    private static WindowPlacement.Placement DefaultPlacement(IReadOnlyList<Rectangle> screens)
    {
        var area = screens.Count > 0 ? screens[0] : new Rectangle(Point.Empty, DefaultWindowSize);
        var width = Math.Min(DefaultWindowSize.Width, area.Width);
        var height = Math.Min(DefaultWindowSize.Height, area.Height);
        return new WindowPlacement.Placement(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height, false);
    }

    private void SavePlacement()
    {
        var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        var maximized = WindowState == FormWindowState.Maximized
            || (WindowState == FormWindowState.Minimized && _lastShownState == FormWindowState.Maximized);
        try
        {
            WindowPlacement.Write(_placementPath, new WindowPlacement.Placement(bounds.X, bounds.Y, bounds.Width, bounds.Height, maximized));
        }
        catch (StoreException)
        {
            _log("placement: not saved");
        }
    }

    private static Icon? LoadAppIcon()
    {
        using var stream = typeof(MainForm).Assembly.GetManifestResourceStream("CyberPad.Desktop.app.ico");
        return stream is null ? null : new Icon(stream);
    }

    // ---------------------------------------------------------------- WebView2 setup

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await StartWebViewAsync().ConfigureAwait(true);
    }

    /// <summary>Creates the WebView2 and loads the page. Never throws: a failure is reported and closes the window.</summary>
    private async Task StartWebViewAsync()
    {
        try
        {
            await CreateWebViewAsync().ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            // Broad on purpose: this runs under async void callers, where an escaping exception ends the process
            // unreported. WebView2 creation fails with COMException, WebView2RuntimeNotFoundException,
            // InvalidOperationException, UnauthorizedAccessException and others; every one is logged by type and
            // fails closed (message, then the window closes).
            ReportStartFailure(ex);
        }
    }

    private async Task CreateWebViewAsync()
    {
        var webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = PageBackground,
            Visible = WindowState != FormWindowState.Minimized,
        };
        _webView = webView;
        Controls.Add(webView);

        var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataDir, "WebView2")).ConfigureAwait(true);
        await webView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
        if (!ReferenceEquals(_webView, webView) || webView.IsDisposed) return; // replaced or closed meanwhile

        var core = webView.CoreWebView2;
        ApplySettings(core.Settings);
        core.SetVirtualHostNameToFolderMapping(AppOrigin.Host, _wwwroot, CoreWebView2HostResourceAccessKind.Deny);
        AttachPolicyHandlers(core);
        core.Navigate(AppOrigin.StartUri.AbsoluteUri);
    }

    private static void ApplySettings(CoreWebView2Settings settings)
    {
#if DEBUG
        settings.AreDevToolsEnabled = true;
#else
        settings.AreDevToolsEnabled = false;
#endif
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPinchZoomEnabled = false;
        settings.AreHostObjectsAllowed = false;
        settings.IsReputationCheckingRequired = false; // a local page: no SmartScreen lookups
    }

    private void AttachPolicyHandlers(CoreWebView2 core)
    {
        core.ContextMenuRequested += OnContextMenuRequested;
        core.NavigationStarting += OnNavigationStarting;
        core.FrameNavigationStarting += OnFrameNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += OnNewWindowRequested;
        core.DownloadStarting += OnDownloadStarting;
        core.PermissionRequested += OnPermissionRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        core.ProcessFailed += OnProcessFailed;
    }

    private void ReportStartFailure(Exception ex)
    {
        _log($"webview: start failed {ex.GetType().Name}");
        _pageReady = false;
        if (IsDisposed) return;
        MessageBox.Show(this,
            $"CyberPad could not start its page view.\n\nYour notes are stored in:\n{_dataDir}\n\nRestart CyberPad to try again.",
            "CyberPad", MessageBoxButtons.OK, MessageBoxIcon.Error);
        _closeConfirmed = true; // nothing to flush: the page never ran or is gone
        Close();
    }

    // ---------------------------------------------------------------- page policy

    private void OnContextMenuRequested(object? sender, CoreWebView2ContextMenuRequestedEventArgs e)
    {
        var items = e.MenuItems;
        for (var i = items.Count - 1; i >= 0; i--)
        {
            var item = items[i];
            if (item.Kind != CoreWebView2ContextMenuItemKind.Separator && !IsAllowedMenuItem(item.Name)) items.RemoveAt(i);
        }

        // Drop leading, trailing and doubled separators left behind by the filter.
        for (var i = items.Count - 1; i >= 0; i--)
        {
            var isSeparator = items[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
            var redundant = i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator;
            if (isSeparator && redundant) items.RemoveAt(i);
        }

        if (items.Count == 0) e.Handled = true; // show nothing rather than an empty menu
    }

    private static bool IsAllowedMenuItem(string? name) =>
        name is not null
        && (Array.IndexOf(AllowedMenuItems, name) >= 0 || name.StartsWith("spellCheck", StringComparison.Ordinal));

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (AppOrigin.IsAppUri(e.Uri))
        {
            // The page is being (re)loaded; it is ready again when this navigation completes.
            _appNavigationId = e.NavigationId;
            _pageReady = false;
            _openRequestPosted = false;
            return;
        }
        e.Cancel = true;
        _log("navigation: blocked");
        if (e.IsUserInitiated) OpenExternally(e.Uri);
    }

    private void OnFrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (AppOrigin.IsAppUri(e.Uri)) return;
        e.Cancel = true;
        _log("frame navigation: blocked");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // Navigations we cancelled (external links) complete too, with IsSuccess false; the loaded page is unaffected.
        if (e.NavigationId != _appNavigationId) return;
        _pageReady = e.IsSuccess && sender is CoreWebView2 core && IsCurrent(core) && AppOrigin.IsAppUri(core.Source);
        if (!e.IsSuccess) _log($"navigation: failed {e.WebErrorStatus}");
        else RequestOpenCheck(); // paths queued before the page was ready
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true; // never open a second WebView window
        if (e.IsUserInitiated) OpenExternally(e.Uri);
        else _log("new window: blocked");
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        e.Cancel = true;
        e.Handled = true;
        _log("download: blocked");
    }

    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        e.State = CoreWebView2PermissionState.Deny;
        e.Handled = true;
        _log($"permission: denied {e.PermissionKind}");
    }

    /// <summary>Hands a link to the default browser or mail client, only if the link policy allows it.</summary>
    private void OpenExternally(string? raw)
    {
        if (!ExternalLinkPolicy.TryGetOpenableUri(raw, out var uri) || uri is null)
        {
            _log("link: rejected");
            return;
        }
        try
        {
            using var process = Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or PlatformNotSupportedException)
        {
            _log($"link: open failed {ex.GetType().Name}");
        }
    }

    // ---------------------------------------------------------------- page bridge

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            // Event args are only valid during the event: read them before the first await.
            var source = e.Source;
            var json = e.WebMessageAsJson;
            var reply = await _dispatcher.HandleAsync(source, json).ConfigureAwait(true);
            if (reply is null) return;
            if (sender is CoreWebView2 core && IsCurrent(core)) core.PostWebMessageAsJson(reply);
            else _log("reply: dropped, page gone");
        }
        catch (Exception ex)
        {
            // async void: an escaping exception would crash the app. Type name only, never content.
            _log($"web message: unexpected {ex.GetType().Name}");
        }
    }

    private bool IsCurrent(CoreWebView2 core) =>
        _webView is { IsDisposed: false } webView && ReferenceEquals(webView.CoreWebView2, core);

    private bool TryPostToPage(string json)
    {
        if (!_pageReady || _webView is not { IsDisposed: false } webView || webView.CoreWebView2 is not { } core) return false;
        try
        {
            core.PostWebMessageAsJson(json);
            return true;
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException)
        {
            _log($"post: failed {ex.GetType().Name}");
            return false;
        }
    }

    // ---------------------------------------------------------------- queued open requests

    /// <summary>
    /// Asks the page to call openFile when paths are queued, the page is ready and no dialog is open. At most one
    /// request is outstanding: another would make the page's openFile fall through to the Open dialog.
    /// </summary>
    private void PostOpenRequestedIfDue()
    {
        if (IsDisposed || _closeRequested || _openRequestPosted) return;
        if (_openRequests.Count == 0 || _hostActions.IsDialogOpen) return;
        if (TryPostToPage(OpenRequestedMessage)) _openRequestPosted = true;
    }

    /// <summary>Any thread: re-evaluates <see cref="PostOpenRequestedIfDue"/> on the UI thread. Task 8 calls it after enqueuing a path.</summary>
    internal void RequestOpenCheck()
    {
        try
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke(new Action(PostOpenRequestedIfDue));
        }
        catch (InvalidOperationException ex)
        {
            _log($"open request: window gone {ex.GetType().Name}");
        }
    }

    /// <summary>Any thread: a path was queued by a later launch. Brings the window forward and re-checks the queue.</summary>
    internal void NotifyPathQueued()
    {
        try
        {
            if (IsHandleCreated && !IsDisposed)
            {
                BeginInvoke(new Action(() =>
                {
                    BringToUser();
                    PostOpenRequestedIfDue();
                }));
            }
        }
        catch (InvalidOperationException ex)
        {
            _log($"open request: window gone {ex.GetType().Name}");
        }
    }

    private void OnFileActivityChanged() => RequestOpenCheck();

    private void OnOpenCompleted()
    {
        try
        {
            if (IsHandleCreated && !IsDisposed)
            {
                BeginInvoke(new Action(() =>
                {
                    _openRequestPosted = false;
                    PostOpenRequestedIfDue();
                }));
            }
        }
        catch (InvalidOperationException ex)
        {
            _log($"open request: window gone {ex.GetType().Name}");
        }
    }

    // ---------------------------------------------------------------- crash recovery

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        var kind = e.ProcessFailedKind;
        _log($"process failed: {kind}");

        switch (kind)
        {
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                // Logged above, nothing else: a busy page may recover, and a reload would lose its unsaved work.
                // It does not count toward the crash limit. During a close, the flush timeout still applies.
                break;

            case CoreWebView2ProcessFailedKind.RenderProcessExited:
                _pageReady = false;
                if (_closeRequested)
                {
                    ConfirmClose(); // the page cannot answer the flush any more
                }
                else if (sender is CoreWebView2 core && AllowRecovery())
                {
                    Reload(core);
                }
                break;

            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                _pageReady = false;
                if (_closeRequested) ConfirmClose();
                else if (AllowRecovery()) BeginInvoke(new Action(RecreateWebView));
                break;
        }
    }

    /// <summary>Counts a failure. False (and a one-time message) once 3 failures fall within 60 s.</summary>
    private bool AllowRecovery()
    {
        if (_recoveryStopped) return false;

        var now = Environment.TickCount64;
        while (_recentCrashes.Count > 0 && now - _recentCrashes.Peek() > CrashWindowMs) _recentCrashes.Dequeue();
        _recentCrashes.Enqueue(now);
        if (_recentCrashes.Count < MaxCrashesPerWindow) return true;

        _recoveryStopped = true;
        _recentCrashes.Clear();
        _log("recovery: stopped");
        // Deferred: a modal dialog must not run inside a WebView2 event handler.
        BeginInvoke(new Action(ShowRecoveryStopped));
        return false;
    }

    private void Reload(CoreWebView2 core)
    {
        try
        {
            core.Reload();
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException)
        {
            _log($"reload: failed {ex.GetType().Name}");
        }
    }

    private async void RecreateWebView()
    {
        if (IsDisposed || _closeRequested) return;
        var old = _webView;
        _webView = null;
        if (old is not null)
        {
            Controls.Remove(old);
            try
            {
                old.Dispose();
            }
            catch (Exception ex) when (ex is COMException or InvalidOperationException)
            {
                // The browser behind it is already gone; the replacement below does not depend on this control.
                _log($"webview: dispose failed {ex.GetType().Name}");
            }
        }
        await StartWebViewAsync().ConfigureAwait(true);
    }

    private void ShowRecoveryStopped()
    {
        if (IsDisposed) return;
        MessageBox.Show(this,
            "CyberPad's page stopped working three times within a minute, so it will not be reloaded again.\n\n"
            + $"Your saved notes are in:\n{_dataDir}\n\nClose and restart CyberPad to continue.",
            "CyberPad", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    // ---------------------------------------------------------------- closing handshake

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_closeConfirmed && WaitForFlush())
        {
            e.Cancel = true;
            base.OnFormClosing(e);
            return;
        }
        _closeConfirmed = true;
        _closeTimer.Stop();
        SavePlacement();
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        // An export whose Save dialog was posted but never shown must not leave the page's request hanging.
        _hostActions.CancelPendingDialog();
        base.OnFormClosed(e);
    }

    /// <summary>True while the close must wait for the page: the flush was posted now or earlier.</summary>
    private bool WaitForFlush()
    {
        if (_closeRequested) return true; // already waiting for "flushed", "flushFailed" or the timer
        _closeRequested = true;
        if (!TryPostToPage(FlushMessage)) return false; // no live page: nothing to flush
        _closeTimer.Start();
        return true;
    }

    private void OnCloseTimerTick(object? sender, EventArgs e)
    {
        _closeTimer.Stop();
        _log("close: flush timed out");
        if (OnFlushTimeout(_hostActions.IsFileOperationInFlight) == FlushTimeoutAction.Close)
        {
            ConfirmClose();
            return;
        }
        try
        {
            // Posted, like the other close prompts.
            BeginInvoke(new Action(AskToCloseWhileSaving));
        }
        catch (InvalidOperationException ex)
        {
            _log($"close: window gone {ex.GetType().Name}");
        }
    }

    private void AskToCloseWhileSaving()
    {
        if (!_closeRequested || _closeConfirmed || IsDisposed) return;
        _closeRequested = false; // a later close starts the handshake again; a late "flushed" is ignored meanwhile
        _log("close: linked file still saving");
        var answer = MessageBox.Show(this, StillSavingPrompt,
            "CyberPad", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes || IsDisposed || _closeConfirmed) return;
        _closeConfirmed = true;
        Close();
    }

    /// <summary>Called from any thread by the page's "flushed", the timeout, or a page crash during close.</summary>
    private void ConfirmClose()
    {
        try
        {
            BeginInvoke(new Action(FinishClose));
        }
        catch (InvalidOperationException ex)
        {
            _log($"close: window gone {ex.GetType().Name}");
        }
    }

    private void FinishClose()
    {
        // A "flushed" the host never asked for is ignored, so the page cannot close the window by itself.
        if (!_closeRequested || _closeConfirmed || IsDisposed) return;
        _closeConfirmed = true;
        _closeTimer.Stop();
        Close();
    }

    /// <summary>Called from any thread by the page's "flushFailed": its latest changes could not be saved.</summary>
    private void FlushFailed()
    {
        try
        {
            // Posted: the dialog must not run inside the WebView2 message handler.
            BeginInvoke(new Action(AskToCloseUnsaved));
        }
        catch (InvalidOperationException ex)
        {
            _log($"close: window gone {ex.GetType().Name}");
        }
    }

    private void AskToCloseUnsaved()
    {
        // Like "flushed", a "flushFailed" the host never asked for is ignored.
        if (!_closeRequested || _closeConfirmed || IsDisposed) return;
        _closeTimer.Stop();
        _closeRequested = false; // a later close starts the handshake again
        _log("close: final save failed");
        var answer = MessageBox.Show(this, FlushFailedPrompt,
            "CyberPad", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes || IsDisposed || _closeConfirmed) return;
        _closeConfirmed = true;
        Close();
    }

    // ---------------------------------------------------------------- minimize and second launch

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState != FormWindowState.Minimized) _lastShownState = WindowState;
        if (_webView is not { IsDisposed: false } webView) return;

        // Hiding the control fires "visibilitychange" in the page, which locks encrypted notes.
        var visible = WindowState != FormWindowState.Minimized;
        if (webView.Visible != visible) webView.Visible = visible;
    }

    /// <summary>Raised on the single-instance listener thread; must not throw.</summary>
    private void OnActivationRequested()
    {
        try
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke(new Action(BringToUser));
        }
        catch (InvalidOperationException ex)
        {
            _log($"activate: window gone {ex.GetType().Name}");
        }
    }

    private void BringToUser()
    {
        if (IsDisposed) return;
        if (WindowState == FormWindowState.Minimized) WindowState = _lastShownState;
        Activate();
    }
}
