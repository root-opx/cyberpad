using System.Runtime.InteropServices;
using CyberPad.Desktop.Bridge;

namespace CyberPad.Desktop;

/// <summary>Paints the Windows title bar with the theme's fixed colours (DWM). Best effort: it never throws.</summary>
public static class TitleBar
{
    private const int UseImmersiveDarkMode = 20;
    private const int BorderColor = 34;
    private const int CaptionColor = 35;
    private const int TextColor = 36;

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /// <summary>
    /// Windows 10 and older builds do not know attributes 34 to 36 and answer with an error code; that is ignored, the
    /// default bar stays. Only a missing DWM library is logged, by exception type name alone.
    /// </summary>
    public static void Apply(IntPtr hwnd, HostTheme theme, Action<string> log)
    {
        try
        {
            var colors = HostThemes.ColorsFor(theme);
            Set(hwnd, UseImmersiveDarkMode, HostThemes.UsesDarkCaption(theme) ? 1 : 0);
            Set(hwnd, CaptionColor, HostThemes.ToColorRef(colors.Caption));
            Set(hwnd, TextColor, HostThemes.ToColorRef(colors.Text));
            Set(hwnd, BorderColor, HostThemes.ToColorRef(colors.Border));
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            log("titlebar: " + ex.GetType().Name);
        }
    }

    private static void Set(IntPtr hwnd, int attribute, int value) =>
        _ = DwmSetWindowAttribute(hwnd, attribute, ref value, sizeof(int));
}
