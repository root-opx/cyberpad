using CyberPad.Desktop.Bridge;

namespace CyberPad.Desktop.Tests;

public class HostThemeTests
{
    [Theory]
    [InlineData("neon", HostTheme.Neon)]
    [InlineData("amber", HostTheme.Amber)]
    [InlineData("terminal", HostTheme.Terminal)]
    [InlineData("light", HostTheme.Light)]
    [InlineData("dark", HostTheme.Dark)]
    public void TryParse_AcceptsTheFiveNames(string name, HostTheme expected)
    {
        Assert.True(HostThemes.TryParse(name, out var t));
        Assert.Equal(expected, t);
    }

    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("Neon")] [InlineData("NEON")] [InlineData(" neon")]
    [InlineData("neon ")] [InlineData("solarized")] [InlineData("system")]
    [InlineData("Light")] [InlineData("DARK")] [InlineData(" light")] [InlineData("light ")] [InlineData("0")] [InlineData("#191338")] [InlineData("neon\0")]
    public void TryParse_RejectsEverythingElse(string? name) => Assert.False(HostThemes.TryParse(name, out _));

    [Theory]
    [InlineData(HostTheme.Neon, 0x381319, 0xFFE6EC, 0x722A36)]
    [InlineData(HostTheme.Amber, 0x08151F, 0x75CCFF, 0x15364F)]
    [InlineData(HostTheme.Terminal, 0x031203, 0x66FF33, 0x103D0D)]
    [InlineData(HostTheme.Light, 0xEAF0F0, 0x1F1B1B, 0xB4BFBF)]
    [InlineData(HostTheme.Dark, 0x261F1C, 0xECE6E3, 0x4C403A)]
    public void ColorsFor_MatchTheCssTokens_AsColorRefs(HostTheme theme, int caption, int text, int border)
    {
        var c = HostThemes.ColorsFor(theme);
        Assert.Equal(caption, HostThemes.ToColorRef(c.Caption));
        Assert.Equal(text, HostThemes.ToColorRef(c.Text));
        Assert.Equal(border, HostThemes.ToColorRef(c.Border));
    }

    [Theory]
    [InlineData(HostTheme.Neon, 0x2E0F14)]
    [InlineData(HostTheme.Amber, 0x06111A)]
    [InlineData(HostTheme.Terminal, 0x010801)]
    [InlineData(HostTheme.Light, 0xF7FAFA)]
    [InlineData(HostTheme.Dark, 0x1D1816)]
    public void BackgroundFor_MatchesTheCssVoidToken_AsColorRefs(HostTheme theme, int expected) =>
        Assert.Equal(expected, HostThemes.ToColorRef(HostThemes.BackgroundFor(theme)));

    [Theory]
    [InlineData(HostTheme.Neon, true)]
    [InlineData(HostTheme.Amber, true)]
    [InlineData(HostTheme.Terminal, true)]
    [InlineData(HostTheme.Light, false)]
    [InlineData(HostTheme.Dark, true)]
    public void UsesDarkCaption_IsOffOnlyForLight(HostTheme theme, bool expected) =>
        Assert.Equal(expected, HostThemes.UsesDarkCaption(theme));

    [Fact]
    public void Apply_WithAnInvalidWindowHandle_DoesNotThrow()
    {
        var log = new List<string>();
        TitleBar.Apply(IntPtr.Zero, HostTheme.Amber, log.Add);
        Assert.DoesNotContain(log, l => l.Contains('#') || l.Contains('\\'));
    }
}
