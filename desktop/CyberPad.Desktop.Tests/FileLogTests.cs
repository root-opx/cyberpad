using System.Text;
using CyberPad.Desktop.Diagnostics;

namespace CyberPad.Desktop.Tests;

public sealed class FileLogTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 11, 24, 9, 30, 5, TimeSpan.FromHours(1));
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-log-tests-" + Guid.NewGuid().ToString("N"));

    public FileLogTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string LogPath => Path.Combine(_root, FileLog.FileName);

    private FileLog NewLog(long maxBytes = FileLog.DefaultMaxBytes) => new(LogPath, maxBytes, () => Now);

    [Fact]
    public void Defaults_MatchTheSpec()
    {
        Assert.Equal("cyberpad.log", FileLog.FileName);
        Assert.Equal(256 * 1024, FileLog.DefaultMaxBytes);
        Assert.Equal(500, FileLog.MaxLineChars);
    }

    [Fact]
    public void Write_AppendsUtcTimestampedLines_Utf8WithoutBom()
    {
        var log = NewLog();
        log.Write("save: store failure");
        log.Write("load: unexpected IOException");
        var bytes = File.ReadAllBytes(LogPath);
        Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
        Assert.Equal(
            new[] { "2026-11-24T08:30:05Z save: store failure", "2026-11-24T08:30:05Z load: unexpected IOException" },
            File.ReadAllLines(LogPath, Encoding.UTF8));
    }

    [Fact]
    public void Write_StripsCarriageReturnsAndLineFeeds()
    {
        var log = NewLog();
        log.Write("a\r\nforged 2026-01-01T00:00:00Z entry\rb\nc");
        Assert.Equal(new[] { "2026-11-24T08:30:05Z aforged 2026-01-01T00:00:00Z entrybc" }, File.ReadAllLines(LogPath));
    }

    [Fact]
    public void Write_CapsTheLineAt500Characters()
    {
        var log = NewLog();
        log.Write(new string('x', 2000));
        var line = Assert.Single(File.ReadAllLines(LogPath));
        Assert.Equal("2026-11-24T08:30:05Z " + new string('x', 500), line);
    }

    [Fact]
    public void Write_NullLine_IsLoggedEmpty()
    {
        NewLog().Write(null!);
        Assert.Equal(new[] { "2026-11-24T08:30:05Z " }, File.ReadAllLines(LogPath));
    }

    [Fact]
    public void Write_RotatesOnceTheFileReachesTheThreshold()
    {
        File.WriteAllText(LogPath, new string('o', 100));
        File.WriteAllText(LogPath + ".1", "older");
        var log = NewLog(maxBytes: 100);
        log.Write("first after rotation");
        Assert.Equal(new string('o', 100), File.ReadAllText(LogPath + ".1")); // overwritten
        Assert.Equal(new[] { "2026-11-24T08:30:05Z first after rotation" }, File.ReadAllLines(LogPath));
    }

    [Fact]
    public void Write_BelowTheThreshold_KeepsAppending()
    {
        File.WriteAllText(LogPath, new string('o', 99));
        var log = NewLog(maxBytes: 100);
        log.Write("x");
        Assert.False(File.Exists(LogPath + ".1"));
        Assert.StartsWith(new string('o', 99) + "2026-11-24T08:30:05Z x", File.ReadAllText(LogPath));
    }

    [Fact]
    public void Write_KeepsTheFileBounded()
    {
        var log = NewLog(maxBytes: 300);
        for (var i = 0; i < 200; i++) log.Write("event " + i);
        Assert.True(new FileInfo(LogPath).Length < 300 + 100);
        Assert.True(new FileInfo(LogPath + ".1").Length < 300 + 100);
        Assert.Equal(2, Directory.GetFiles(_root).Length);
    }

    [Fact]
    public void Write_ToAnUnwritablePath_DoesNotThrow()
    {
        var blocker = Path.Combine(_root, "afile");
        File.WriteAllText(blocker, "x");
        new FileLog(Path.Combine(blocker, FileLog.FileName), FileLog.DefaultMaxBytes, () => Now).Write("a"); // parent is a file

        Directory.CreateDirectory(LogPath); // the log path itself is a folder
        NewLog().Write("b");
        Assert.True(Directory.Exists(LogPath));
    }

    [Fact]
    public void Write_WithNoPath_DoesNotThrow()
    {
        new FileLog(null, FileLog.DefaultMaxBytes, () => Now).Write("trace only");
        Assert.Empty(Directory.GetFileSystemEntries(_root));
    }

    [Fact]
    public async Task Write_FromManyThreads_KeepsEveryLineWhole()
    {
        var log = NewLog();
        await Task.WhenAll(Enumerable.Range(0, 8).Select(t => Task.Run(() =>
        {
            for (var i = 0; i < 50; i++) log.Write($"thread {t} event {i}");
        })));
        var lines = File.ReadAllLines(LogPath);
        Assert.Equal(400, lines.Length);
        Assert.All(lines, l => Assert.Matches(@"^2026-11-24T08:30:05Z thread \d event \d+$", l));
    }
}
