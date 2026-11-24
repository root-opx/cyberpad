namespace CyberPad.Desktop.Storage;

/// <summary>Retries a file swap while another process briefly holds the file (sharing or lock violation).</summary>
internal static class SharingRetry
{
    private const int Retries = 3;
    private const int DelayMs = 100;
    private const int ErrorSharingViolation = unchecked((int)0x80070020);
    private const int ErrorLockViolation = unchecked((int)0x80070021);

    /// <summary>
    /// Runs <paramref name="swap"/>, retrying at most <see cref="Retries"/> times, <see cref="DelayMs"/> ms apart,
    /// only on a sharing or lock violation (as an antivirus scanner or a sync client causes). Any other failure,
    /// or the last one, propagates unchanged.
    /// </summary>
    internal static void Run(Action swap, Action<int>? sleep = null)
    {
        ArgumentNullException.ThrowIfNull(swap);
        var wait = sleep ?? Thread.Sleep;
        for (var retry = 0; ; retry++)
        {
            try
            {
                swap();
                return;
            }
            catch (IOException ex) when (retry < Retries && ex.HResult is ErrorSharingViolation or ErrorLockViolation)
            {
                wait(DelayMs);
            }
        }
    }
}
