using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace CyberPad.Desktop.Files;

/// <summary>
/// Client side of the "Open with" handoff: a second CyberPad process sends one full path to the running one over a
/// per-user named pipe. The pipe name only carries the id (the user SID in production, a random id in tests).
/// </summary>
public static class FileHandoff
{
    /// <summary>Longest accepted path in characters (the Windows extended path limit).</summary>
    public const int MaxChars = 32_767;

    /// <summary>Largest accepted message: 4 bytes per char covers any UTF-8 encoding of <see cref="MaxChars"/>.</summary>
    public const int MaxBytes = 131_072;

    public static string PipeName(string userSid) => "CyberPad-" + userSid;

    /// <summary>Sends <paramref name="fullPath"/> to the running instance. Never throws; false on timeout or failure.</summary>
    public static bool TrySend(string userSid, string fullPath, TimeSpan timeout)
    {
        try
        {
            if (string.IsNullOrEmpty(fullPath) || fullPath.Length > MaxChars) return false;
            var bytes = new UTF8Encoding(false, true).GetBytes(fullPath);
            var ms = (int)Math.Clamp(timeout.TotalMilliseconds, 1, int.MaxValue);

            // CurrentUserOnly makes the client refuse a pipe created by another user.
            using var client = new NamedPipeClientStream(".", PipeName(userSid), PipeDirection.Out,
                PipeOptions.CurrentUserOnly);
            client.Connect(ms);
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
            return true;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException
                                       or EncoderFallbackException or ObjectDisposedException
                                       or InvalidOperationException)
        {
            return false;
        }
    }
}

/// <summary>
/// Receives paths from <see cref="FileHandoff.TrySend"/>. One connection at a time; each message is validated with
/// <see cref="FilePathPolicy.TryNormalize"/> before <c>onPath</c> runs (on a pool thread). Rejections are logged
/// without content. The pipe ACL grants only the current Windows user (explicit ACL instead of CurrentUserOnly,
/// which cannot be combined with a custom security descriptor).
/// </summary>
public sealed class FileHandoffServer : IDisposable
{
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan RestartDelay = TimeSpan.FromMilliseconds(250);

    private readonly string _pipeName;
    private readonly Action<string> _onPath;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _loop;
    private int _disposed;

    public FileHandoffServer(string userSid, Action<string> onPath, Action<string>? log = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(userSid);
        ArgumentNullException.ThrowIfNull(onPath);
        _pipeName = FileHandoff.PipeName(userSid);
        _onPath = onPath;
        _log = log ?? (_ => { });

        // Create the first pipe instance synchronously so the pipe exists when the constructor returns.
        var first = CreatePipe();
        _loop = Task.Run(() => RunAsync(first, _cts.Token));
    }

    private NamedPipeServerStream CreatePipe()
    {
        var user = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("No current user SID.");
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(_pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 0, 0, security);
    }

    private async Task RunAsync(NamedPipeServerStream? pipe, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                pipe ??= CreatePipe();
                using var current = pipe;
                pipe = null;
                await current.WaitForConnectionAsync(token).ConfigureAwait(false);
                await HandleAsync(current, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ObjectDisposedException
                                           or InvalidOperationException)
            {
                // Connection-level or pipe-creation failure: log the type and serve again after a short pause.
                _log($"handoff: server {ex.GetType().Name}");
                if (!await PauseAsync(token).ConfigureAwait(false)) break;
            }
            catch (Exception ex)
            {
                // Unexpected: still never let the loop die silently.
                _log($"handoff: unexpected {ex.GetType().Name}");
                if (!await PauseAsync(token).ConfigureAwait(false)) break;
            }
        }
        pipe?.Dispose();
    }

    private static async Task<bool> PauseAsync(CancellationToken token)
    {
        try
        {
            await Task.Delay(RestartDelay, token).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private async Task HandleAsync(NamedPipeServerStream stream, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(ReadTimeout);

        var buffer = new byte[FileHandoff.MaxBytes + 1];
        var length = 0;
        try
        {
            while (length < buffer.Length)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(length), timeout.Token).ConfigureAwait(false);
                if (n == 0) break;
                length += n;
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            _log("handoff: rejected (read timeout)");
            return;
        }

        if (length == 0) { _log("handoff: rejected (empty)"); return; }
        if (length > FileHandoff.MaxBytes) { _log("handoff: rejected (too large)"); return; }

        string raw;
        try
        {
            raw = new UTF8Encoding(false, true).GetString(buffer, 0, length);
        }
        catch (DecoderFallbackException)
        {
            _log("handoff: rejected (not UTF-8)");
            return;
        }

        if (raw.Length > FileHandoff.MaxChars) { _log("handoff: rejected (too long)"); return; }
        if (raw.Contains('\0')) { _log("handoff: rejected (NUL)"); return; }
        if (!FilePathPolicy.TryNormalize(raw, out var fullPath, out _))
        {
            _log("handoff: rejected (path policy)");
            return;
        }

        try
        {
            _onPath(fullPath);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            _log($"handoff: callback {ex.GetType().Name}");
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try
        {
            _cts.Cancel();
            _loop.Wait(TimeSpan.FromSeconds(1));
        }
        catch (AggregateException ex)
        {
            _log($"handoff: dispose {ex.InnerException?.GetType().Name ?? "error"}");
        }
        finally
        {
            _cts.Dispose();
        }
    }
}
