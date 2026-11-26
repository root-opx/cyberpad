using System.Text;

namespace CyberPad.Desktop.Bridge;

/// <summary>Turns a page-suggested name into a safe file name (never a path). Pure; no I/O.</summary>
public static class FileNameSanitizer
{
    public const int MaxLength = 120;
    private const string Fallback = "cyberpad-export";

    private static readonly HashSet<string> Reserved = BuildReserved();

    public static string Sanitize(string? suggested, ExportKind kind) => Sanitize(suggested, ExportKinds.Extension(kind));

    /// <summary>Same rules for an arbitrary extension (with its leading dot), for example ".md".</summary>
    public static string Sanitize(string? suggested, string extension)
    {
        ArgumentException.ThrowIfNullOrEmpty(extension);
        var ext = extension;
        var invalid = Path.GetInvalidFileNameChars();

        // 1 + 2: replace invalid characters with '-', collapse runs of '-'.
        var sb = new StringBuilder();
        foreach (var c in suggested ?? string.Empty)
        {
            var ch = Array.IndexOf(invalid, c) >= 0 ? '-' : c;
            if (ch == '-' && sb.Length > 0 && sb[^1] == '-') continue;
            sb.Append(ch);
        }

        // 3 + 4: trim, fall back when empty.
        var cleaned = sb.ToString();
        var name = cleaned.Trim('.', ' ', '-');
        if (name.Length == 0) name = Fallback;
        // A dot-file title (".env", ".gitignore") whose name is the requested extension stays itself, not "env.env".
        else if (cleaned.StartsWith('.') && ext.Length > 1 && ext[0] == '.'
                 && string.Equals(name, ext[1..], StringComparison.OrdinalIgnoreCase))
            name = "." + name;

        // 5: ensure the kind's extension.
        if (!name.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) name += ext;

        // 6: reserved device names (checked on the part before the first '.').
        if (IsReserved(name)) name = "_" + name;

        // 7: truncate the stem so the whole name fits, keeping the extension.
        if (name.Length > MaxLength)
        {
            var stem = name[..(name.Length - ext.Length)];
            stem = stem[..(MaxLength - ext.Length)].TrimEnd('.', ' ', '-');
            if (stem.Length == 0) stem = Fallback;
            name = stem + ext;
            if (IsReserved(name)) name = "_" + name;
        }

        return name;
    }

    private static bool IsReserved(string name)
    {
        var dot = name.IndexOf('.');
        var head = (dot < 0 ? name : name[..dot]).TrimEnd(' ');
        return Reserved.Contains(head);
    }

    private static HashSet<string> BuildReserved()
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "CON", "PRN", "AUX", "NUL" };
        for (var i = 1; i <= 9; i++)
        {
            set.Add("COM" + i);
            set.Add("LPT" + i);
        }
        return set;
    }
}
