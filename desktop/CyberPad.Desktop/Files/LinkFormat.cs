namespace CyberPad.Desktop.Files;

/// <summary>On-disk format of a file-linked note.</summary>
public enum LinkFormat { Txt, Md, CpNote }

public static class LinkFormats
{
    public const string OpenFilter = "CyberPad files (*.txt;*.md;*.cpnote)|*.txt;*.md;*.cpnote";

    /// <summary>Parses a wire name. Exact case only; anything else is rejected.</summary>
    public static bool TryParse(string? wire, out LinkFormat format)
    {
        switch (wire)
        {
            case "txt": format = LinkFormat.Txt; return true;
            case "md": format = LinkFormat.Md; return true;
            case "cpnote": format = LinkFormat.CpNote; return true;
            default: format = default; return false;
        }
    }

    public static string Wire(LinkFormat format) => format switch
    {
        LinkFormat.Txt => "txt",
        LinkFormat.Md => "md",
        LinkFormat.CpNote => "cpnote",
        _ => throw new ArgumentOutOfRangeException(nameof(format)),
    };

    public static string Extension(LinkFormat format) => "." + Wire(format);

    public static string DialogFilter(LinkFormat format) => format switch
    {
        LinkFormat.Txt => "Text (*.txt)|*.txt",
        LinkFormat.Md => "Markdown (*.md)|*.md",
        LinkFormat.CpNote => "Encrypted CyberPad note (*.cpnote)|*.cpnote",
        _ => throw new ArgumentOutOfRangeException(nameof(format)),
    };
}
