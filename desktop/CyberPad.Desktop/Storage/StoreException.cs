namespace CyberPad.Desktop.Storage;

/// <summary>Storage failure. The message is a short user-facing reason and never contains file content.</summary>
public sealed class StoreException : Exception
{
    public StoreException(string message) : base(message) { }

    public StoreException(string message, Exception inner) : base(message, inner) { }
}
