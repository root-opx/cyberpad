using CyberPad.Desktop.Bridge;

namespace CyberPad.Desktop.Tests;

public sealed class FileNameSanitizerTests
{
    [Theory]
    [InlineData(@"..\..\x", ExportKind.Note, "x.md")]
    [InlineData("CON", ExportKind.Backup, "_CON.json")]
    [InlineData("con.txt", ExportKind.Note, "_con.txt.md")]
    [InlineData("a/b:c", ExportKind.IocCsv, "a-b-c.csv")]
    [InlineData("notes.txt", ExportKind.Note, "notes.txt.md")]
    [InlineData("Notes.MD", ExportKind.Note, "Notes.MD")]
    [InlineData("", ExportKind.Note, "cyberpad-export.md")]
    [InlineData(null, ExportKind.EncryptedBackup, "cyberpad-export.json")]
    [InlineData("cyberpad-backup-2026-11-23.encrypted.json", ExportKind.EncryptedBackup, "cyberpad-backup-2026-11-23.encrypted.json")]
    public void Sanitize_ProducesSafeNames(string? input, ExportKind kind, string expected)
    {
        Assert.Equal(expected, FileNameSanitizer.Sanitize(input, kind));
    }

    [Theory]
    [InlineData(@"..\x", ".md", "x.md")]
    [InlineData("Notes.MD", ".md", "Notes.MD")]
    [InlineData("n", ".cpnote", "n.cpnote")]
    [InlineData("con", ".txt", "_con.txt")]
    [InlineData(null, ".txt", "cyberpad-export.txt")]
    public void Sanitize_WithExtension_AppliesSameRules(string? input, string ext, string expected)
    {
        Assert.Equal(expected, FileNameSanitizer.Sanitize(input, ext));
    }

    [Fact]
    public void Sanitize_TruncatesTo120WithExtension()
    {
        var result = FileNameSanitizer.Sanitize(new string('a', 200), ExportKind.Note);
        Assert.Equal(120, result.Length);
        Assert.EndsWith(".md", result);
    }

    [Fact]
    public void ExportKinds_TryParse_RejectsUnknownAndWrongCase()
    {
        Assert.False(ExportKinds.TryParse("Note", out _));
        Assert.False(ExportKinds.TryParse("exe", out _));
        Assert.False(ExportKinds.TryParse("", out _));
        Assert.True(ExportKinds.TryParse("iocMd", out var kind));
        Assert.Equal(ExportKind.IocMd, kind);
    }
}
