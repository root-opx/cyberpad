namespace CyberPad.Desktop.Bridge;

/// <summary>The one origin the page is served from, and the check that a URI belongs to it.</summary>
public static class AppOrigin
{
    public const string Host = "cyberpad.example";
    public const string Origin = "https://cyberpad.example/";
    public static readonly Uri StartUri = new("https://cyberpad.example/index.html");

    /// <summary>True only for absolute https URIs on <see cref="Host"/> with the default port and no user-info. Any path is accepted.</summary>
    public static bool IsAppUri(string? uri)
    {
        if (string.IsNullOrEmpty(uri) || uri.Length > 8192) return false;
        foreach (var c in uri)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c)) return false;
        }
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
        return string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            && string.Equals(parsed.Host, Host, StringComparison.OrdinalIgnoreCase)
            && parsed.IsDefaultPort
            && parsed.UserInfo.Length == 0;
    }
}
