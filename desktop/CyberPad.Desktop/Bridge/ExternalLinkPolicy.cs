namespace CyberPad.Desktop.Bridge;

/// <summary>Decides which links from the page may be handed to the system. Reject, never rewrite.</summary>
public static class ExternalLinkPolicy
{
    public const int MaxLength = 2048;

    public static bool TryGetOpenableUri(string? raw, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrEmpty(raw) || raw.Length > MaxLength) return false;
        foreach (var c in raw)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c)) return false;
        }
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var parsed)) return false;

        var ok = parsed.Scheme switch
        {
            "http" or "https" => parsed.Host.Length > 0,
            "mailto" => true,
            _ => false,
        };
        if (!ok) return false;

        uri = parsed;
        return true;
    }
}
