using System.Text.Json;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Files;
using CyberPad.Install;

namespace CyberPad.Desktop.Tests;

public sealed class FileTypesTests
{
    // The design's table (docs/superpowers/specs/2026-11-26-file-types-ide-selection-ctf-design.md, "1. File types"),
    // written out a second time on purpose: a change to the list must be made here and in FileTypes.
    private static readonly string[] Expected =
    {
        "txt", "md", "markdown",
        "cpnote",
        "py", "pyw",
        "js", "mjs", "cjs", "jsx",
        "ts", "tsx",
        "sh", "bash", "zsh",
        "ps1", "psm1", "psd1",
        "bat", "cmd",
        "c", "h",
        "cpp", "cc", "cxx", "hpp",
        "cs",
        "java",
        "go",
        "rs",
        "rb",
        "php",
        "lua",
        "pl",
        "sql",
        "html", "htm",
        "xml", "xsd", "xsl", "svg",
        "css", "scss",
        "json", "jsonl",
        "yaml", "yml",
        "toml", "ini", "cfg", "conf", "properties", "env",
        "log", "csv", "tsv", "diff", "patch", "nfo", "lst", "rules", "yar", "yara", "nse", "asm", "s", "tex", "rst", "gitignore",
    };

    private static readonly string[] ExpectedGroups =
    {
        "Notes", "Encrypted", "Python", "JavaScript", "TypeScript", "Shell", "PowerShell", "Batch", "C", "C++", "C#", "Java",
        "Go", "Rust", "Ruby", "PHP", "Lua", "Perl", "SQL", "HTML", "XML", "CSS", "JSON", "YAML", "TOML and INI", "Plain text",
    };

    public static IEnumerable<object[]> AllWires => Expected.Select(w => new object[] { w });

    [Fact]
    public void Table_IsExactlyTheDesignList_InOrder()
    {
        Assert.Equal(69, Expected.Length);
        Assert.Equal(Expected, FileTypes.All.Select(t => t.Wire));
        Assert.Equal(ExpectedGroups, FileTypes.Groups);
        Assert.Equal(ExpectedGroups, FileTypes.All.Select(t => t.Group).Distinct());
        Assert.Equal(new[] { "py", "pyw" }, FileTypes.All.Where(t => t.Group == "Python").Select(t => t.Wire));
        Assert.Equal(new[] { "cpnote" }, FileTypes.All.Where(t => t.Format.IsEncrypted).Select(t => t.Wire));
        Assert.Equal(10, FileTypes.MaxWireLength);
    }

    [Theory]
    [MemberData(nameof(AllWires))]
    public void EveryListedType_IsAcceptedEverywhere_WithItsCanonicalWire(string wire)
    {
        Assert.True(FileTypes.TryGet(wire, out var type));
        Assert.Equal(wire, type.Wire);
        Assert.Equal(wire == "cpnote", type.Format.IsEncrypted);

        Assert.True(FileTypes.TryGetByExtension("." + wire.ToUpperInvariant(), out var upper));
        Assert.Equal(wire, upper.Wire);

        Assert.True(LinkFormat.TryParse(wire, out var format));
        Assert.Equal(wire, format.Wire);

        var dir = Path.GetTempPath();
        foreach (var name in new[] { "n." + wire, "N." + wire.ToUpperInvariant() })
        {
            Assert.True(FilePathPolicy.TryNormalize(Path.Combine(dir, name), out var full, out var fromPath));
            Assert.Equal(wire, fromPath.Wire);
            Assert.Equal(Path.Combine(dir, name), full);
        }
    }

    [Theory]
    [MemberData(nameof(AllWires))]
    public async Task EveryListedType_IsAcceptedByTheDispatcher(string wire)
    {
        var f = new FakeHostActions();
        Assert.True(LinkFormat.TryParse(wire, out var format));
        f.SaveAsResult = new FileLinkResult("0123456789abcdef0123456789abcdef", "n." + wire, format);
        var d = new MessageDispatcher(f, _ => { });
        var reply = await d.HandleAsync("https://cyberpad.example/",
            $$"""{"type":"saveAsFile","id":"a","format":"{{wire}}","suggestedName":"note","text":"t"}""");
        var r = JsonDocument.Parse(reply!).RootElement;
        Assert.Equal("fileLinked", r.GetProperty("type").GetString());
        Assert.Equal(wire, r.GetProperty("format").GetString());
        Assert.Equal(wire, f.SavedAs!.Value.Format.Wire);
        Assert.Equal("note." + wire, f.SavedAs!.Value.Name);
    }

    [Theory]
    [InlineData("PY")]
    [InlineData("Py")]
    [InlineData(" py")]
    [InlineData("py ")]
    [InlineData(".py")]
    [InlineData("py\u0000")]
    [InlineData("рy")]
    [InlineData("")]
    [InlineData("exe")]
    [InlineData("dll")]
    [InlineData("com")]
    [InlineData("scr")]
    [InlineData("msi")]
    [InlineData("lnk")]
    [InlineData("url")]
    [InlineData("hta")]
    [InlineData("vbs")]
    [InlineData("js.exe")]
    [InlineData("abcdefghijklm")]
    [InlineData("txt;exe")]
    [InlineData("*")]
    public async Task UnlistedOrNonCanonicalWire_IsRejected(string wire)
    {
        Assert.False(FileTypes.TryGet(wire, out _));
        Assert.False(LinkFormat.TryParse(wire, out _));

        var f = new FakeHostActions();
        var log = new List<string>();
        var d = new MessageDispatcher(f, log.Add);
        var payload = JsonSerializer.Serialize(new { type = "saveAsFile", id = "a", format = wire, suggestedName = "x", text = "t" });
        var r = JsonDocument.Parse((await d.HandleAsync("https://cyberpad.example/", payload))!).RootElement;
        Assert.Equal("rejected", r.GetProperty("type").GetString());
        Assert.Equal("unknown format", r.GetProperty("reason").GetString());
        Assert.Equal(0, f.FileCalls);
        Assert.Equal(new[] { "saveAsFile: unknown format" }, log);
    }

    [Fact]
    public void TryGet_Null_IsRejected()
    {
        Assert.False(FileTypes.TryGet(null, out _));
        Assert.False(FileTypes.TryGetByExtension(null, out _));
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("py")]
    [InlineData(". py")]
    [InlineData(".py ")]
    [InlineData(".py.")]
    [InlineData("..py")]
    [InlineData(".exe")]
    [InlineData(".abcdefghijklm")]
    [InlineData(".рy")]
    [InlineData(".ſh")]
    [InlineData(".Ksh")]
    [InlineData(".ını")]   // dotless i: "INI" under ToUpperInvariant
    [InlineData(".İNİ")]   // dotted capital I: "ini" under ToLowerInvariant
    public void TryGetByExtension_RefusesAnythingButAListedAsciiExtension(string ext)
    {
        Assert.False(FileTypes.TryGetByExtension(ext, out _));
    }

    [Fact]
    public void LinkFormat_CannotBeBuiltForAnUnlistedType()
    {
        Assert.Throws<ArgumentException>(() => new LinkFormat("exe"));
        Assert.Throws<ArgumentException>(() => new LinkFormat("PY"));
    }

    [Fact]
    public void OpenFilter_AllSupportedFirst_ThenEachGroup_NoWildcard()
    {
        var filter = FileTypes.OpenDialogFilter();
        var parts = filter.Split('|');
        Assert.Equal(0, parts.Length % 2);
        Assert.Equal((1 + ExpectedGroups.Length) * 2, parts.Length);

        Assert.Equal("All supported types", parts[0]);
        Assert.Equal(Expected.Select(w => "*." + w), parts[1].Split(';'));

        for (var g = 0; g < ExpectedGroups.Length; g++)
        {
            var wires = FileTypes.All.Where(t => t.Group == ExpectedGroups[g]).Select(t => "*." + t.Wire);
            var patterns = string.Join(";", wires);
            Assert.Equal($"{ExpectedGroups[g]} ({patterns})", parts[2 + g * 2]);
            Assert.Equal(patterns, parts[3 + g * 2]);
        }

        Assert.DoesNotContain("*.*", filter);
        Assert.DoesNotContain("*;", filter);
        Assert.True(filter.Length < 4096, $"open filter is {filter.Length} characters");
        Assert.True(parts.Max(p => p.Length) < 512);
    }

    [Theory]
    [InlineData("py", "Python")]
    [InlineData("pyw", "Python")]
    [InlineData("md", "Notes")]
    [InlineData("txt", "Notes")]
    [InlineData("gitignore", "Plain text")]
    public void SaveFilter_PlainNote_OwnGroupFirst_ThenAllPlainTypes_RequestedExtensionFirst(string wire, string group)
    {
        Assert.True(LinkFormat.TryParse(wire, out var format));
        var filter = FileTypes.SaveDialogFilter(format);
        var parts = filter.Split('|');
        Assert.Equal(4, parts.Length);

        var groupPatterns = parts[1].Split(';');
        Assert.StartsWith(group + " (*." + wire, parts[0]);
        Assert.Equal("*." + wire, groupPatterns[0]);
        Assert.Equal(
            FileTypes.All.Where(t => t.Group == group).Select(t => "*." + t.Wire).OrderBy(x => x, StringComparer.Ordinal),
            groupPatterns.OrderBy(x => x, StringComparer.Ordinal));

        Assert.Equal("All supported types", parts[2]);
        var all = parts[3].Split(';');
        Assert.Equal("*." + wire, all[0]);
        Assert.Equal(68, all.Length);
        Assert.Equal(all.Length, all.Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(
            Expected.Where(w => w != "cpnote").Select(w => "*." + w).OrderBy(x => x, StringComparer.Ordinal),
            all.OrderBy(x => x, StringComparer.Ordinal));
        Assert.DoesNotContain("cpnote", filter);
        Assert.DoesNotContain("*.*", filter);
        Assert.True(filter.Length < 4096, $"save filter is {filter.Length} characters");
    }

    [Fact]
    public void SaveFilter_EncryptedNote_OffersOnlyCpNote()
    {
        Assert.Equal("Encrypted (*.cpnote)|*.cpnote", FileTypes.SaveDialogFilter(LinkFormat.CpNote));
    }

    /// <summary>The WinForms setter validates a filter (it throws on a malformed one). The dialogs are never shown.</summary>
    [Fact]
    public void Filters_AreAcceptedByTheWinFormsDialogs()
    {
        using (var open = new OpenFileDialog())
        {
            open.Filter = FileTypes.OpenDialogFilter();
            Assert.Equal(FileTypes.OpenDialogFilter(), open.Filter);
        }
        foreach (var type in FileTypes.All)
        {
            using var save = new SaveFileDialog();
            save.Filter = FileTypes.SaveDialogFilter(type.Format);
            save.DefaultExt = type.Wire;
            Assert.Equal(type.Wire, save.DefaultExt);
        }
    }

    [Fact]
    public void SaveFilter_NoFormat_Throws()
    {
        Assert.Throws<InvalidOperationException>(() => FileTypes.SaveDialogFilter(default));
    }

    /// <summary>The wider list is for CyberPad's own dialogs only; the installer's "Open with" registration does not change.</summary>
    [Fact]
    public void InstallerOpenWithTypes_AreStillOnlyMdTxtCpNote()
    {
        Assert.Equal(new[] { ".md", ".txt", ".cpnote" }, InstallLayout.OpenWithTypes);
    }
}
