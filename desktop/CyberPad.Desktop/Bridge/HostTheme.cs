using System.Drawing;

namespace CyberPad.Desktop.Bridge;

/// <summary>The page themes the host knows how to paint the Windows title bar for.</summary>
public enum HostTheme { Neon, Amber, Terminal }

/// <summary>
/// Name parsing and the fixed title bar colours. The colours live here, never in a page message: the page can only pick
/// one of three names. Keep in step with --panel, --ink and --line in css/style.css.
/// </summary>
public static class HostThemes
{
    public readonly record struct TitleBarColors(Color Caption, Color Text, Color Border);

    /// <summary>Exact, ordinal match on the three theme names; everything else is refused.</summary>
    public static bool TryParse(string? name, out HostTheme theme)
    {
        switch (name)
        {
            case "neon": theme = HostTheme.Neon; return true;
            case "amber": theme = HostTheme.Amber; return true;
            case "terminal": theme = HostTheme.Terminal; return true;
            default: theme = default; return false;
        }
    }

    public static TitleBarColors ColorsFor(HostTheme theme) => theme switch
    {
        HostTheme.Amber => new TitleBarColors(Rgb(0x1f1508), Rgb(0xffcc75), Rgb(0x4f3615)),
        HostTheme.Terminal => new TitleBarColors(Rgb(0x031203), Rgb(0x33ff66), Rgb(0x0d3d10)),
        _ => new TitleBarColors(Rgb(0x191338), Rgb(0xece6ff), Rgb(0x362a72)),
    };

    /// <summary>Windows COLORREF: 0x00BBGGRR.</summary>
    public static int ToColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

    private static Color Rgb(int rgb) => Color.FromArgb((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
}
