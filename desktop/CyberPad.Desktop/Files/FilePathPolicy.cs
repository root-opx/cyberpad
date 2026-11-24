using System.Security;

namespace CyberPad.Desktop.Files;

public static class FilePathPolicy
{
    public const string UnsupportedMessage = "CyberPad can only open .txt, .md and .cpnote files.";

    private const int MaxPathChars = 32767;

    /// <summary>
    /// Accepts only fully qualified paths (drive or UNC) with a known extension. Rejects device and
    /// extended-length prefixes, control characters and overlong input; never "cleans up" a bad path.
    /// </summary>
    public static bool TryNormalize(string? raw, out string fullPath, out LinkFormat format)
    {
        fullPath = string.Empty;
        format = default;

        if (string.IsNullOrEmpty(raw) || raw.Length > MaxPathChars) return false;
        foreach (var c in raw)
        {
            if (char.IsControl(c)) return false;
        }
        if (HasDevicePrefix(raw)) return false;
        if (!Path.IsPathFullyQualified(raw)) return false;

        string full;
        try
        {
            full = Path.GetFullPath(raw);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or SecurityException)
        {
            return false;
        }

        if (full.Length > MaxPathChars || HasDevicePrefix(full)) return false;
        if (HasStrayColon(full)) return false;

        var ext = Path.GetExtension(full);
        LinkFormat parsed;
        if (ext.Equals(".txt", StringComparison.OrdinalIgnoreCase)) parsed = LinkFormat.Txt;
        else if (ext.Equals(".md", StringComparison.OrdinalIgnoreCase)) parsed = LinkFormat.Md;
        else if (ext.Equals(".cpnote", StringComparison.OrdinalIgnoreCase)) parsed = LinkFormat.CpNote;
        else return false;

        fullPath = full;
        format = parsed;
        return true;
    }

    /// <summary>A colon is only legal in a drive root ("C:"); anywhere else it names an alternate data stream.</summary>
    private static bool HasStrayColon(string full)
    {
        var start = full.Length >= 2 && full[1] == ':' && char.IsAsciiLetter(full[0]) ? 2 : 0;
        return full.IndexOf(':', start) >= 0;
    }

    private static bool IsSep(char c) => c == '\\' || c == '/';

    private static bool HasDevicePrefix(string p) =>
        p.Length >= 4 && IsSep(p[0]) && IsSep(p[1]) && (p[2] == '.' || p[2] == '?') && IsSep(p[3]);
}
