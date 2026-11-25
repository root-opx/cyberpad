using CyberPad.Desktop;
using CyberPad.Desktop.Bridge;

namespace CyberPad.Desktop.Tests;

public sealed class AppearanceStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));
    private readonly List<string> _log = new();

    public AppearanceStoreTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string PathFor(string name) => Path.Combine(_root, name);

    private AppearanceStore StoreAt(string path) => new(path, _log.Add);

    [Theory]
    [InlineData(HostTheme.Amber)] [InlineData(HostTheme.Terminal)] [InlineData(HostTheme.Light)] [InlineData(HostTheme.Dark)]
    public void SaveThenRead_RoundTrips(HostTheme theme)
    {
        var path = PathFor("appearance.json");
        StoreAt(path).Save(theme);
        Assert.Equal(theme, StoreAt(path).Read());
        Assert.Empty(_log);
    }

    [Fact]
    public void Save_WritesTheDocumentedShape()
    {
        var path = PathFor("appearance.json");
        StoreAt(path).Save(HostTheme.Light);
        Assert.Equal("{\"theme\":\"light\"}", File.ReadAllText(path));
        Assert.Equal(new[] { "appearance.json" }, Directory.GetFiles(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void Read_MissingFile_IsNeon_WithoutALogLine()
    {
        Assert.Equal(HostTheme.Neon, StoreAt(PathFor("nope.json")).Read());
        Assert.Empty(_log);
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("[\"light\"]")]
    [InlineData("\"light\"")]
    [InlineData("{}")]
    [InlineData("{\"theme\":null}")]
    [InlineData("{\"theme\":1}")]
    [InlineData("{\"theme\":true}")]
    [InlineData("{\"theme\":[\"light\"]}")]
    [InlineData("{\"theme\":{\"light\":1}}")]
    [InlineData("{\"theme\":\"system\"}")]
    [InlineData("{\"theme\":\"Light\"}")]
    [InlineData("{\"theme\":\" light\"}")]
    [InlineData("{\"theme\":\"\"}")]
    [InlineData("{\"Theme\":\"light\"}")]
    [InlineData("{\"theme\":\"__proto__\"}")]
    [InlineData("{\"theme\":\"\\ud800\"}")]
    [InlineData("{\"theme\":\"light\",\"\\ud800\":1}")]
    [InlineData("{\"theme\":\"\\ud800light\"}")]
    [InlineData("{\"theme\":\"\\udc00\"}")]
    public void Read_GarbageOrRejectedNames_AreNeon(string content)
    {
        var path = PathFor("appearance.json");
        File.WriteAllText(path, content);
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
        Assert.Empty(_log);
    }

    [Fact]
    public void Read_AMegabyteString_IsNeon()
    {
        var path = PathFor("appearance.json");
        File.WriteAllText(path, "{\"theme\":\"" + new string('a', 1_000_000) + "\"}");
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
    }

    [Fact]
    public void Read_FileOverFourKilobytes_IsNotRead_EvenWhenItHoldsAValidTheme()
    {
        var path = PathFor("appearance.json");
        File.WriteAllText(path, "{\"theme\":\"light\"," + new string(' ', 5000) + "}");
        Assert.True(new FileInfo(path).Length > 4096);
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
    }

    [Fact]
    public void Read_FileJustOverTheCap_IsNotRead()
    {
        var path = PathFor("appearance.json");
        var json = "{\"theme\":\"light\"}";
        File.WriteAllText(path, json + new string(' ', 4097 - json.Length));
        Assert.Equal(4097, new FileInfo(path).Length);
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());

        File.WriteAllText(path, json + new string(' ', 4096 - json.Length)); // exactly at the cap: read
        Assert.Equal(4096, new FileInfo(path).Length);
        Assert.Equal(HostTheme.Light, StoreAt(path).Read());
    }

    [Fact]
    public void Read_InvalidUtf8Bytes_AreNeon()
    {
        var path = PathFor("appearance.json");
        File.WriteAllBytes(path, new byte[] { 0x7B, 0x22, 0x74, 0x68, 0x65, 0x6D, 0x65, 0x22, 0x3A, 0x22, 0xFF, 0xFE, 0x22, 0x7D });
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
        File.WriteAllBytes(path, new byte[] { 0xEF, 0xBB, 0xBF, 0x7B, 0x7D }); // BOM then {}
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
    }

    [Fact]
    public void Read_AFileLockedByAnotherProcess_IsNeon()
    {
        var path = PathFor("appearance.json");
        File.WriteAllText(path, "{\"theme\":\"light\"}");
        using var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
    }

    [Fact]
    public void Read_DeeplyNestedJson_IsNeon()
    {
        var path = PathFor("appearance.json");
        File.WriteAllText(path, new string('[', 2000) + new string(']', 2000));
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
    }

    [Fact]
    public void Read_APathThatIsADirectory_IsNeon()
    {
        var path = PathFor("appearance.json");
        Directory.CreateDirectory(path);
        Assert.Equal(HostTheme.Neon, StoreAt(path).Read());
    }

    [Fact]
    public void Save_OnlyWritesWhenTheThemeDiffersFromTheLastRead()
    {
        var path = PathFor("appearance.json");
        File.WriteAllText(path, "{\"theme\":\"dark\"}");
        var store = StoreAt(path);
        Assert.Equal(HostTheme.Dark, store.Read());

        File.Delete(path);
        store.Save(HostTheme.Dark); // unchanged: no write
        Assert.False(File.Exists(path));

        store.Save(HostTheme.Light);
        Assert.True(File.Exists(path));

        File.Delete(path);
        store.Save(HostTheme.Light); // unchanged since the last write
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void Save_WithoutARead_TreatsNeonAsTheStartingTheme()
    {
        var path = PathFor("appearance.json");
        var store = StoreAt(path);
        store.Save(HostTheme.Neon);
        Assert.False(File.Exists(path));
        store.Save(HostTheme.Amber);
        Assert.True(File.Exists(path));
    }

    [Fact]
    public void Save_ToAnUnwritableLocation_LogsTheTypeNameOnly_AndCarriesOn()
    {
        var path = Path.Combine(_root, "secret-folder-name", "appearance.json");
        var store = StoreAt(path);
        store.Save(HostTheme.Light); // the folder does not exist: must not throw
        var line = Assert.Single(_log);
        Assert.StartsWith("appearance: ", line);
        Assert.DoesNotContain("secret-folder-name", line);
        Assert.DoesNotContain("light", line);
        Assert.DoesNotContain(Path.DirectorySeparatorChar, line);

        // A failed write is retried on the next change, not remembered as done.
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        store.Save(HostTheme.Light);
        Assert.Equal("{\"theme\":\"light\"}", File.ReadAllText(path));
    }
}
