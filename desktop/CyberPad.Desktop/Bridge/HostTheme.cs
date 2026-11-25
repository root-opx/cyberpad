using System.Drawing;

namespace CyberPad.Desktop.Bridge;

/// <summary>The page themes the host knows how to paint the Windows title bar for.</summary>
public enum HostTheme { Neon, Amber, Terminal, Light, Dark }

/// <summary>
/// Name parsing and the fixed title bar colours. The colours live here, never in a page message: the page can only pick
/// one of five names. For all five themes, keep in step with --panel, --ink and --line in css/style.css.
/// </summary>
public static class HostThemes
{
    public readonly record struct TitleBarColors(Color Caption, Color Text, Color Border);

    /// <summary>Exact, ordinal match on the five theme names; everything else is refused.</summary>
    public static bool TryParse(string? name, out HostTheme theme)
    {
        switch (name)
        {
            case "neon": theme = HostTheme.Neon; return true;
            case "amber": theme = HostTheme.Amber; return true;
            case "terminal": theme = HostTheme.Terminal; return true;
            case "light": theme = HostTheme.Light; return true;
            case "dark": theme = HostTheme.Dark; return true;
            default: theme = default; return false;
        }
    }

    public static TitleBarColors ColorsFor(HostTheme theme) => theme switch
    {
        HostTheme.Amber => new TitleBarColors(Rgb(0x1f1508), Rgb(0xffcc75), Rgb(0x4f3615)),
        HostTheme.Terminal => new TitleBarColors(Rgb(0x031203), Rgb(0x33ff66), Rgb(0x0d3d10)),
        HostTheme.Light => new TitleBarColors(Rgb(0xf0f0ea), Rgb(0x1b1b1f), Rgb(0xbfbfb4)),
        HostTheme.Dark => new TitleBarColors(Rgb(0x1c1f26), Rgb(0xe3e6ec), Rgb(0x3a404c)),
        _ => new TitleBarColors(Rgb(0x191338), Rgb(0xece6ff), Rgb(0x362a72)),
    };

    /// <summary>
    /// The page background (--void in css/style.css) of each theme: the window and WebView2 colour shown before the
    /// page has painted, so a start-up never flashes another theme's colour.
    /// </summary>
    public static Color BackgroundFor(HostTheme theme) => theme switch
    {
        HostTheme.Amber => Rgb(0x1a1106),
        HostTheme.Terminal => Rgb(0x010801),
        HostTheme.Light => Rgb(0xfafaf7),
        HostTheme.Dark => Rgb(0x16181d),
        _ => Rgb(0x140f2e),
    };

    /// <summary>The Windows immersive dark mode flag: off for Light, on for every other theme.</summary>
    public static bool UsesDarkCaption(HostTheme theme) => theme != HostTheme.Light;

    /// <summary>Windows COLORREF: 0x00BBGGRR.</summary>
    public static int ToColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

    private static Color Rgb(int rgb) => Color.FromArgb((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
}
