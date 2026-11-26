namespace CyberPad.Desktop.Files;

/// <summary>
/// On-disk format of a file-linked note: one entry of <see cref="FileTypes"/>, held by its canonical wire name. It can
/// only be built for a listed type (the constructor checks), so a value other than <c>default</c> is always on the list.
/// <c>default(LinkFormat)</c> means "no format" and is refused wherever a format is used.
/// </summary>
public readonly record struct LinkFormat
{
    private readonly string? _wire;

    /// <exception cref="ArgumentException"><paramref name="wire"/> is not a listed canonical wire name.</exception>
    internal LinkFormat(string wire)
    {
        if (!FileTypes.IsListed(wire)) throw new ArgumentException("Not a listed file type.", nameof(wire));
        _wire = wire;
    }

    public static LinkFormat Txt { get; } = new("txt");
    public static LinkFormat Md { get; } = new("md");
    public static LinkFormat CpNote { get; } = new(FileTypes.EncryptedWire);

    /// <summary>False only for <c>default(LinkFormat)</c>.</summary>
    public bool IsDefined => _wire is not null;

    /// <summary>Canonical lower-case extension without the dot ("py", "cpnote").</summary>
    public string Wire => _wire ?? throw new InvalidOperationException("No file format.");

    public string Extension => "." + Wire;

    /// <summary>True for .cpnote, the only format an encrypted note is linked to.</summary>
    public bool IsEncrypted => string.Equals(_wire, FileTypes.EncryptedWire, StringComparison.Ordinal);

    /// <summary>Parses a wire name from the page or links.json. Exact lower-case only; anything else is rejected.</summary>
    public static bool TryParse(string? wire, out LinkFormat format)
    {
        if (FileTypes.TryGet(wire, out var type))
        {
            format = type.Format;
            return true;
        }
        format = default;
        return false;
    }

    public override string ToString() => _wire ?? "(none)";
}
