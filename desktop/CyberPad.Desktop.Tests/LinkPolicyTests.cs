using CyberPad.Desktop.Bridge;

namespace CyberPad.Desktop.Tests;

public sealed class LinkPolicyTests
{
    [Theory]
    [InlineData("https://nvd.nist.gov/vuln/detail/CVE-2024-3094", true)]
    [InlineData("https://attack.mitre.org/techniques/T1059/001/", true)]
    [InlineData("mailto:soc@example.com", true)]
    [InlineData("file:///C:/Windows/system32/calc.exe", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("ms-settings:privacy", false)]
    [InlineData(@"\\server\share\x", false)]
    [InlineData("https://exa mple.com", false)]
    [InlineData("/relative/path", false)]
    [InlineData("http://", false)]
    public void TryGetOpenableUri_AllowsOnlyWebAndMail(string raw, bool ok)
    {
        Assert.Equal(ok, ExternalLinkPolicy.TryGetOpenableUri(raw, out var uri));
        Assert.Equal(ok, uri is not null);
    }

    [Fact]
    public void TryGetOpenableUri_RejectsOverlong()
    {
        Assert.False(ExternalLinkPolicy.TryGetOpenableUri("https://x.example/" + new string('a', 2100), out _));
    }

    [Fact]
    public void TryGetOpenableUri_RejectsNullAndControlCharacters()
    {
        Assert.False(ExternalLinkPolicy.TryGetOpenableUri(null, out _));
        Assert.False(ExternalLinkPolicy.TryGetOpenableUri("https://x.example/\u0000", out _));
        Assert.False(ExternalLinkPolicy.TryGetOpenableUri("https://x.example/\r\nHost: y", out _));
    }

    [Theory]
    [InlineData("https://cyberpad.example/index.html", true)]
    [InlineData("https://cyberpad.example/", true)]
    [InlineData("HTTPS://CyberPad.Example/x", true)]
    [InlineData("https://cyberpad.example.evil.com/", false)]
    [InlineData("http://cyberpad.example/", false)]
    [InlineData("https://cyberpad.example:8443/", false)]
    [InlineData("https://x@cyberpad.example/", false)]
    [InlineData("about:blank", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsAppUri_MatchesOnlyTheAppOrigin(string? uri, bool ok)
    {
        Assert.Equal(ok, AppOrigin.IsAppUri(uri));
    }
}
