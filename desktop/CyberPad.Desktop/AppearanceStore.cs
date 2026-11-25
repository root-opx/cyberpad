using System.Text.Json;
using CyberPad.Desktop.Bridge;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop;

/// <summary>
/// Remembers the theme last put on screen (<c>appearance.json</c>, <c>{"theme":"light"}</c>) so the next start can paint
/// the window, its title bar and the page background in those colours before the page loads. Nothing but one of the
/// five theme names is ever read or written; a missing, oversized or malformed file means Neon, silently.
/// </summary>
public sealed class AppearanceStore
{
    private const long MaxFileBytes = 4096;

    private static readonly JsonDocumentOptions ParseOptions = new() { MaxDepth = 4 };

    private readonly string _path;
    private readonly Action<string> _log;
    private HostTheme _last = HostTheme.Neon;

    public AppearanceStore(string path, Action<string> log)
    {
        _path = path;
        _log = log;
    }

    /// <summary>The remembered theme, or Neon for any problem. Never throws, never reports.</summary>
    public HostTheme Read()
    {
        _last = ReadFile();
        return _last;
    }

    /// <summary>
    /// Writes the theme when it differs from the last one read or written. A failure is logged by exception type
    /// name only and the call returns normally; the next change tries again.
    /// </summary>
    public void Save(HostTheme theme)
    {
        if (theme == _last) return;
        try
        {
            AtomicFile.Write(_path, "{\"theme\":\"" + NameOf(theme) + "\"}");
            _last = theme;
        }
        catch (Exception ex) when (ex is StoreException or ArgumentException or NotSupportedException)
        {
            // Never the path or the content: the type of the underlying failure is enough to tell what happened.
            _log("appearance: " + (ex.InnerException ?? ex).GetType().Name);
        }
    }

    private HostTheme ReadFile()
    {
        try
        {
            // One open, at most MaxFileBytes + 1 bytes read: the cap holds even if the file grows meanwhile.
            byte[] bytes;
            using (var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var buffer = new byte[MaxFileBytes + 1];
                var count = 0;
                int read;
                while (count < buffer.Length && (read = stream.Read(buffer, count, buffer.Length - count)) > 0) count += read;
                if (count > MaxFileBytes) return HostTheme.Neon;
                bytes = buffer.AsSpan(0, count).ToArray();
            }

            using var doc = JsonDocument.Parse(bytes, ParseOptions);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return HostTheme.Neon;
            if (!doc.RootElement.TryGetProperty("theme", out var value) || value.ValueKind != JsonValueKind.String)
                return HostTheme.Neon;
            return HostThemes.TryParse(value.GetString(), out var theme) ? theme : HostTheme.Neon;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException
            or InvalidOperationException or ArgumentException or NotSupportedException)
        {
            // Missing, locked, a directory, invalid UTF-8, malformed JSON, or an escaped lone surrogate (which makes
            // GetString/TryGetProperty throw InvalidOperationException): all mean Neon. This runs in the window's
            // constructor, so it must never throw.
            return HostTheme.Neon;
        }
    }

    private static string NameOf(HostTheme theme) => theme switch
    {
        HostTheme.Amber => "amber",
        HostTheme.Terminal => "terminal",
        HostTheme.Light => "light",
        HostTheme.Dark => "dark",
        _ => "neon",
    };
}
