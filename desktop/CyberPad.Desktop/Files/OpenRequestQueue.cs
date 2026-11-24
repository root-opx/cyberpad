namespace CyberPad.Desktop.Files;

/// <summary>
/// FIFO of full paths waiting to be opened (command line, pipe). Checks capacity only: the path policy is applied
/// when the file is opened. Thread-safe.
/// </summary>
public sealed class OpenRequestQueue
{
    public const int Capacity = 20;

    private readonly object _gate = new();
    private readonly Queue<string> _paths = new();

    public int Count
    {
        get { lock (_gate) return _paths.Count; }
    }

    /// <returns>False when the queue is full (the path is dropped).</returns>
    public bool TryEnqueue(string fullPath)
    {
        ArgumentException.ThrowIfNullOrEmpty(fullPath);
        lock (_gate)
        {
            if (_paths.Count >= Capacity) return false;
            _paths.Enqueue(fullPath);
            return true;
        }
    }

    public bool TryDequeue(out string fullPath)
    {
        lock (_gate)
        {
            if (_paths.Count > 0)
            {
                fullPath = _paths.Dequeue();
                return true;
            }
        }
        fullPath = string.Empty;
        return false;
    }
}
