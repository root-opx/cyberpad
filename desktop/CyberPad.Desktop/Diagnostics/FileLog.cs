using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace CyberPad.Desktop.Diagnostics;

/// <summary>
/// Content-free diagnostics log: one line per event, "yyyy-MM-ddTHH:mm:ssZ line" in UTC, UTF-8 without BOM, appended to
/// a size-bounded file with one rotated generation (<c>.1</c>). Callers pass only message types, rejection reasons and
/// exception type names, never note content. Every line is also written to <see cref="Trace"/>. Never throws.
/// </summary>
public sealed class FileLog
{
    public const string FileName = "cyberpad.log";
    public const long DefaultMaxBytes = 256 * 1024;
    public const int MaxLineChars = 500;

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    private readonly string? _path;
    private readonly long _maxBytes;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _lock = new();

    /// <param name="path">The log file, or null to write to <see cref="Trace"/> only. Never derived from user input.</param>
    /// <param name="maxBytes">Once the file is at least this large, the next line first moves it to <c>path.1</c>.</param>
    /// <param name="clock">The time source; defaults to the system clock.</param>
    public FileLog(string? path, long maxBytes = DefaultMaxBytes, Func<DateTimeOffset>? clock = null)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxBytes, 1);
        _path = string.IsNullOrEmpty(path) ? null : path;
        _maxBytes = maxBytes;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public void Write(string line)
    {
        var entry = Format(_clock(), line);
        lock (_lock)
        {
            Trace.WriteLine("CyberPad: " + entry);
            if (_path is null) return;
            try
            {
                var info = new FileInfo(_path);
                if (info.Exists && info.Length >= _maxBytes) File.Move(_path, _path + ".1", overwrite: true);
                File.AppendAllText(_path, entry + Environment.NewLine, Utf8NoBom);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Logging must never fail its caller: fall back to Trace, which already has the line.
                Trace.WriteLine("CyberPad: log file unavailable " + ex.GetType().Name);
            }
        }
    }

    /// <summary>Strips CR and LF (no forged lines), caps the text at <see cref="MaxLineChars"/> and prefixes the UTC time.</summary>
    internal static string Format(DateTimeOffset now, string? line)
    {
        var text = (line ?? string.Empty).Replace("\r", string.Empty, StringComparison.Ordinal).Replace("\n", string.Empty, StringComparison.Ordinal);
        if (text.Length > MaxLineChars) text = text[..MaxLineChars];
        return now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture) + " " + text;
    }
}
