using System.Drawing;
using static CyberPad.Desktop.WindowPlacement;

namespace CyberPad.Desktop.Tests;

public sealed class WindowPlacementTests : IDisposable
{
    private static readonly Size Min = new(900, 600);
    private static readonly IReadOnlyList<Rectangle> OneScreen = new[] { new Rectangle(0, 0, 1920, 1040) };

    private readonly string _root = Path.Combine(Path.GetTempPath(), "cyberpad-tests-" + Guid.NewGuid().ToString("N"));

    public WindowPlacementTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private string PathFor(string name) => Path.Combine(_root, name);

    [Fact]
    public void Read_ReturnsNullForMissingOrCorruptFile()
    {
        Assert.Null(Read(PathFor("missing.json")));

        var corrupt = PathFor("corrupt.json");
        File.WriteAllText(corrupt, "{ not json");
        Assert.Null(Read(corrupt));

        var wrongShape = PathFor("array.json");
        File.WriteAllText(wrongShape, "[1, 2, 3]");
        Assert.Null(Read(wrongShape));

        var literalNull = PathFor("null.json");
        File.WriteAllText(literalNull, "null");
        Assert.Null(Read(literalNull));
    }

    [Theory]
    [InlineData("{\"X\":0,\"Y\":0,\"Width\":0,\"Height\":600,\"Maximized\":false}")]
    [InlineData("{\"X\":0,\"Y\":0,\"Width\":900,\"Height\":-1,\"Maximized\":false}")]
    [InlineData("{\"X\":2147483647,\"Y\":0,\"Width\":2147483647,\"Height\":600,\"Maximized\":false}")]
    [InlineData("{\"X\":-2000000,\"Y\":0,\"Width\":900,\"Height\":600,\"Maximized\":false}")]
    [InlineData("{\"X\":\"10\",\"Y\":0,\"Width\":900,\"Height\":600,\"Maximized\":false}")]
    public void Read_ReturnsNullForOutOfRangeOrMistypedValues(string json)
    {
        var path = PathFor("bad.json");
        File.WriteAllText(path, json);
        Assert.Null(Read(path));
    }

    [Fact]
    public void Write_Read_RoundTrips()
    {
        var path = PathFor("window.json");
        var p = new Placement(-1200, 40, 1280, 800, true);
        Write(path, p);
        Assert.Equal(p, Read(path));

        var q = new Placement(10, 20, 900, 600, false);
        Write(path, q);
        Assert.Equal(q, Read(path));
    }

    [Fact]
    public void Fit_KeepsVisiblePlacement()
    {
        var p = new Placement(100, 100, 1000, 700, false);
        Assert.Equal(p, Fit(p, OneScreen, Min));

        // Visible on a second monitor to the left of the primary one.
        var screens = new[] { new Rectangle(0, 0, 1920, 1040), new Rectangle(-1920, 0, 1920, 1040) };
        var left = new Placement(-1800, 50, 1200, 800, true);
        Assert.Equal(left, Fit(left, screens, Min));
    }

    [Fact]
    public void Fit_RecentresWhenOffAllScreens()
    {
        var p = new Placement(-5000, 100, 1000, 700, true);
        Assert.Equal(new Placement(460, 170, 1000, 700, true), Fit(p, OneScreen, Min));
    }

    [Fact]
    public void Fit_RecentresWhenOverlapIsLessThan100By100()
    {
        // Only 50 px of the window's width reaches into the working area.
        var p = new Placement(1870, 100, 1000, 700, false);
        Assert.Equal(new Placement(460, 170, 1000, 700, false), Fit(p, OneScreen, Min));

        // Exactly 100 × 100 px visible is enough.
        var edge = new Placement(1820, 940, 1000, 700, false);
        Assert.Equal(edge, Fit(edge, OneScreen, Min));
    }

    [Fact]
    public void Fit_EnforcesMinimumSize()
    {
        var p = new Placement(100, 100, 10, 10, false);
        Assert.Equal(new Placement(100, 100, 900, 600, false), Fit(p, OneScreen, Min));
    }

    [Fact]
    public void Fit_ShrinksARecentredWindowToTheScreenButNotBelowMinimum()
    {
        var small = new[] { new Rectangle(0, 0, 1366, 728) };
        var p = new Placement(-5000, 0, 3000, 2000, false);
        Assert.Equal(new Placement(0, 0, 1366, 728, false), Fit(p, small, Min));

        // Larger than the screen even at minimum size: keep the title bar reachable at the top-left corner.
        var tiny = new[] { new Rectangle(100, 50, 800, 500) };
        Assert.Equal(new Placement(100, 50, 900, 600, false), Fit(p, tiny, Min));
    }
}
