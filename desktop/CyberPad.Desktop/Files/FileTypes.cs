using System.Text;

namespace CyberPad.Desktop.Files;

/// <summary>One entry of the fixed file-type list: its canonical wire name (lower-case, no dot) and its group.</summary>
public sealed class FileType
{
    internal FileType(string wire, string group)
    {
        Wire = wire;
        Group = group;
    }

    /// <summary>Canonical lower-case extension without the dot, as sent on the bridge and stored in links.json.</summary>
    public string Wire { get; }

    public string Group { get; }

    public string Extension => "." + Wire;

    public LinkFormat Format => new(Wire);

    public override string ToString() => Wire;
}

/// <summary>
/// The only file types the host reads or writes. A fixed allow-list: lookups are exact and ordinal, and nothing outside
/// the table is ever accepted (there is no "any text" fallback). The page keeps the same list; tests pin both copies.
/// </summary>
public static class FileTypes
{
    /// <summary>The one encrypted format. Every other listed type is plain text.</summary>
    public const string EncryptedWire = "cpnote";

    public const string AllSupportedLabel = "All supported types";

    // Group, then its extensions, in the design's order. Lower-case ASCII letters and digits only.
    private static readonly (string Group, string[] Wires)[] Table =
    {
        ("Notes", new[] { "txt", "md", "markdown" }),
        ("Encrypted", new[] { "cpnote" }),
        ("Python", new[] { "py", "pyw" }),
        ("JavaScript", new[] { "js", "mjs", "cjs", "jsx" }),
        ("TypeScript", new[] { "ts", "tsx" }),
        ("Shell", new[] { "sh", "bash", "zsh" }),
        ("PowerShell", new[] { "ps1", "psm1", "psd1" }),
        ("Batch", new[] { "bat", "cmd" }),
        ("C", new[] { "c", "h" }),
        ("C++", new[] { "cpp", "cc", "cxx", "hpp" }),
        ("C#", new[] { "cs" }),
        ("Java", new[] { "java" }),
        ("Go", new[] { "go" }),
        ("Rust", new[] { "rs" }),
        ("Ruby", new[] { "rb" }),
        ("PHP", new[] { "php" }),
        ("Lua", new[] { "lua" }),
        ("Perl", new[] { "pl" }),
        ("SQL", new[] { "sql" }),
        ("HTML", new[] { "html", "htm" }),
        ("XML", new[] { "xml", "xsd", "xsl", "svg" }),
        ("CSS", new[] { "css", "scss" }),
        ("JSON", new[] { "json", "jsonl" }),
        ("YAML", new[] { "yaml", "yml" }),
        ("TOML and INI", new[] { "toml", "ini", "cfg", "conf", "properties", "env" }),
        ("Plain text", new[]
        {
            "log", "csv", "tsv", "diff", "patch", "nfo", "lst", "rules", "yar", "yara", "nse", "asm", "s", "tex", "rst",
            "gitignore",
        }),
    };

    private static readonly FileType[] Entries;
    private static readonly Dictionary<string, FileType> ByWire;
    private static readonly string[] GroupNames;

    static FileTypes()
    {
        var entries = new List<FileType>();
        var byWire = new Dictionary<string, FileType>(StringComparer.Ordinal);
        foreach (var (group, wires) in Table)
        {
            foreach (var wire in wires)
            {
                if (!IsCanonical(wire)) throw new InvalidOperationException("File type table entry is not canonical.");
                var type = new FileType(wire, group);
                byWire.Add(wire, type); // throws on a duplicate
                entries.Add(type);
            }
        }
        Entries = entries.ToArray();
        ByWire = byWire;
        GroupNames = Table.Select(t => t.Group).ToArray();
        MaxWireLength = Entries.Max(e => e.Wire.Length);
    }

    /// <summary>Every listed type, in table order.</summary>
    public static IReadOnlyList<FileType> All => Entries;

    /// <summary>Group names, in table order.</summary>
    public static IReadOnlyList<string> Groups => GroupNames;

    /// <summary>Length of the longest listed extension (without the dot).</summary>
    public static int MaxWireLength { get; }

    /// <summary>A wire value from the page or from links.json: exact, lower-case, ordinal. "PY", " py" and "py " fail.</summary>
    public static bool TryGet(string? wire, out FileType type)
    {
        if (wire is not null && ByWire.TryGetValue(wire, out var found))
        {
            type = found;
            return true;
        }
        type = null!;
        return false;
    }

    /// <summary>
    /// A path's extension as <see cref="Path.GetExtension(string?)"/> returns it (with the dot). ASCII letters compare
    /// without regard to case (".PY" is Python) and the canonical lower-case entry is reported. Any character outside
    /// ASCII letters and digits fails, so Unicode look-alikes (a Cyrillic "р", a long "ſ") never fold onto a listed type.
    /// </summary>
    public static bool TryGetByExtension(string? extension, out FileType type)
    {
        type = null!;
        if (extension is null || extension.Length < 2 || extension[0] != '.') return false;
        if (extension.Length - 1 > MaxWireLength) return false;

        var sb = new StringBuilder(extension.Length - 1);
        for (var i = 1; i < extension.Length; i++)
        {
            var c = extension[i];
            if (c is >= 'A' and <= 'Z') sb.Append((char)(c + ('a' - 'A')));
            else if (c is >= 'a' and <= 'z' or >= '0' and <= '9') sb.Append(c);
            else return false;
        }
        return TryGet(sb.ToString(), out type);
    }

    internal static bool IsListed(string? wire) => wire is not null && ByWire.ContainsKey(wire);

    /// <summary>
    /// The Open dialog's filter: "All supported types" (every extension once), then one entry per group. No "*.*".
    /// </summary>
    public static string OpenDialogFilter()
    {
        var parts = new List<string> { AllSupportedLabel, Patterns(Entries) };
        foreach (var group in GroupNames) AddGroup(parts, group, InGroup(group));
        return string.Join("|", parts);
    }

    /// <summary>
    /// The Save dialog's filter for a note asking for <paramref name="requested"/>. An encrypted note gets only .cpnote.
    /// Otherwise the requested type's group comes first, then "All supported types" (every plain type, never .cpnote). In
    /// both entries the requested extension is listed first, so the dialog adds it when the user types a name without one.
    /// </summary>
    public static string SaveDialogFilter(LinkFormat requested)
    {
        var wire = requested.Wire;
        var own = ByWire[wire];
        if (requested.IsEncrypted)
        {
            var parts = new List<string>();
            AddGroup(parts, own.Group, new[] { own });
            return string.Join("|", parts);
        }

        var result = new List<string>();
        AddGroup(result, own.Group, RequestedFirst(own, InGroup(own.Group)));
        result.Add(AllSupportedLabel);
        result.Add(Patterns(RequestedFirst(own, Entries.Where(e => !e.Format.IsEncrypted))));
        return string.Join("|", result);
    }

    private static IEnumerable<FileType> InGroup(string group) => Entries.Where(e => string.Equals(e.Group, group, StringComparison.Ordinal));

    private static IEnumerable<FileType> RequestedFirst(FileType own, IEnumerable<FileType> types) =>
        new[] { own }.Concat(types.Where(t => !ReferenceEquals(t, own)));

    private static void AddGroup(List<string> parts, string group, IEnumerable<FileType> types)
    {
        var patterns = Patterns(types);
        parts.Add($"{group} ({patterns})");
        parts.Add(patterns);
    }

    private static string Patterns(IEnumerable<FileType> types) => string.Join(";", types.Select(t => "*." + t.Wire));

    private static bool IsCanonical(string wire)
    {
        if (wire.Length == 0) return false;
        foreach (var c in wire)
        {
            if (!(c is >= 'a' and <= 'z' || c is >= '0' and <= '9')) return false;
        }
        return true;
    }
}
