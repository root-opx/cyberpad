using System.Drawing;
using System.Text.Json;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop;

/// <summary>Remembers the window rectangle between runs and keeps a restored window reachable on screen.</summary>
public static class WindowPlacement
{
    public sealed record Placement(int X, int Y, int Width, int Height, bool Maximized);

    /// <summary>Coordinates and sizes outside these bounds are treated as a corrupt file.</summary>
    private const int MaxCoordinate = 1_000_000;
    private const int MaxSize = 100_000;
    private const int MinVisible = 100;
    private const long MaxFileBytes = 4096;

    private static readonly JsonSerializerOptions JsonOptions = new() { MaxDepth = 2 };

    /// <summary>Returns null when the file is missing, unreadable, not valid JSON, or holds out-of-range values.</summary>
    public static Placement? Read(string path)
    {
        string json;
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > MaxFileBytes) return null;
            json = File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        Placement? p;
        try
        {
            p = JsonSerializer.Deserialize<Placement>(json, JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }

        return p is not null && IsPlausible(p) ? p : null;
    }

    /// <exception cref="StoreException">The file could not be written.</exception>
    public static void Write(string path, Placement p)
    {
        ArgumentNullException.ThrowIfNull(p);
        AtomicFile.Write(path, JsonSerializer.Serialize(p, JsonOptions));
    }

    /// <summary>
    /// Clamps the size to at least <paramref name="min"/>. If the window would not show at least 100×100 px of any
    /// working area, it is centred on the first screen (shrunk to that screen, never below <paramref name="min"/>, and
    /// kept inside its top-left corner when even the minimum size does not fit).
    /// </summary>
    public static Placement Fit(Placement p, IReadOnlyList<Rectangle> screens, Size min)
    {
        ArgumentNullException.ThrowIfNull(p);
        ArgumentNullException.ThrowIfNull(screens);

        var width = Math.Clamp(p.Width, min.Width, Math.Max(min.Width, MaxSize));
        var height = Math.Clamp(p.Height, min.Height, Math.Max(min.Height, MaxSize));
        var x = Math.Clamp(p.X, -MaxCoordinate, MaxCoordinate);
        var y = Math.Clamp(p.Y, -MaxCoordinate, MaxCoordinate);
        var window = new Rectangle(x, y, width, height);

        if (screens.Count == 0) return p with { X = x, Y = y, Width = width, Height = height };

        foreach (var screen in screens)
        {
            var overlap = Rectangle.Intersect(window, screen);
            if (overlap.Width >= MinVisible && overlap.Height >= MinVisible)
                return p with { X = x, Y = y, Width = width, Height = height };
        }

        var first = screens[0];
        width = Math.Max(min.Width, Math.Min(width, first.Width));
        height = Math.Max(min.Height, Math.Min(height, first.Height));
        return p with
        {
            X = first.X + Math.Max(0, (first.Width - width) / 2),
            Y = first.Y + Math.Max(0, (first.Height - height) / 2),
            Width = width,
            Height = height,
        };
    }

    private static bool IsPlausible(Placement p) =>
        p.Width is > 0 and <= MaxSize
        && p.Height is > 0 and <= MaxSize
        && p.X is >= -MaxCoordinate and <= MaxCoordinate
        && p.Y is >= -MaxCoordinate and <= MaxCoordinate;
}
