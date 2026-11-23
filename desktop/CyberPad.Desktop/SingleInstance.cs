using System.Runtime.InteropServices;

namespace CyberPad.Desktop;

/// <summary>
/// One CyberPad per user session. The first instance owns a named mutex and listens on a named event; a later launch
/// signals that event (so the first window comes to the front) and exits.
/// </summary>
public sealed class SingleInstance : IDisposable
{
    private const int MaxSidLength = 184;
    private const int AsfwAny = -1;

    private readonly Mutex _mutex;
    private readonly EventWaitHandle _activate;
    private readonly ManualResetEvent _stop = new(false);
    private readonly Thread _listener;
    private bool _disposed;

    private SingleInstance(Mutex mutex, EventWaitHandle activate)
    {
        _mutex = mutex;
        _activate = activate;
        _listener = new Thread(Listen) { IsBackground = true, Name = "CyberPad activation listener" };
        _listener.Start();
    }

    /// <summary>Raised on a background thread when another launch asks this instance to come to the front.</summary>
    public event Action? ActivationRequested;

    /// <summary>Returns the instance that owns the session lock, or null when another CyberPad already holds it.</summary>
    /// <remarks>Dispose on the thread that called this: that thread owns the mutex.</remarks>
    public static SingleInstance? TryAcquire(string userSid)
    {
        ValidateSid(userSid);
        var mutex = new Mutex(initiallyOwned: true, MutexName(userSid), out var createdNew);
        if (!createdNew)
        {
            mutex.Dispose();
            return null;
        }
        // Create-or-open: a launch that races our startup may have created (and set) the event already.
        var activate = new EventWaitHandle(false, EventResetMode.AutoReset, EventName(userSid));
        return new SingleInstance(mutex, activate);
    }

    /// <summary>Asks the running instance to activate its window.</summary>
    public static void SignalExisting(string userSid)
    {
        ValidateSid(userSid);
        // This process was just launched by the user and may take the foreground; let the running instance take it.
        AllowSetForegroundWindow(AsfwAny);
        using var activate = new EventWaitHandle(false, EventResetMode.AutoReset, EventName(userSid));
        activate.Set();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _stop.Set();
        _listener.Join(TimeSpan.FromSeconds(2));
        _mutex.ReleaseMutex();
        _mutex.Dispose();
        _activate.Dispose();
        _stop.Dispose();
    }

    private void Listen()
    {
        var handles = new WaitHandle[] { _stop, _activate };
        // Ends when Dispose sets _stop (index 0); each activation signal raises the event once.
        while (WaitHandle.WaitAny(handles) == 1)
        {
            ActivationRequested?.Invoke();
        }
    }

    private static string MutexName(string sid) => $@"Local\CyberPad-{sid}";

    private static string EventName(string sid) => $@"Local\CyberPad-{sid}-activate";

    /// <summary>A SID string is "S-" followed by digits and dashes; anything else would make an unexpected kernel object name.</summary>
    private static void ValidateSid(string userSid)
    {
        ArgumentNullException.ThrowIfNull(userSid);
        if (userSid.Length is < 3 or > MaxSidLength || !userSid.StartsWith("S-", StringComparison.Ordinal))
            throw new ArgumentException("Not a SID string.", nameof(userSid));
        for (var i = 2; i < userSid.Length; i++)
        {
            var c = userSid[i];
            if (c is not (>= '0' and <= '9') and not '-')
                throw new ArgumentException("Not a SID string.", nameof(userSid));
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(int dwProcessId);
}
