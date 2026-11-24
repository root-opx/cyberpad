using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Files;

/// <summary>What the host remembers about a linked file: where it is and what was last confirmed on disk.</summary>
public sealed record LinkRecord(
    string Path,
    LinkFormat Format,
    TextEncodingKind Encoding,
    bool Bom,
    LineEnding LineEnding,
    long Size,
    DateTime MtimeUtc,
    string Sha256);

/// <summary>
/// The host-private map from opaque link IDs to linked files (links.json). The page only ever sees IDs.
/// Every field is validated on load; invalid records are dropped and an unreadable file is set aside.
/// </summary>
public sealed class LinkStore
{
    public const string FileName = "links.json";

    /// <summary>Largest links.json Load reads; anything bigger was not written by CyberPad.</summary>
    public const long MaxFileBytes = 8L * 1024 * 1024;

    private const int SchemaVersion = 1;
    private const int MaxRecords = 100_000;

    private readonly object _gate = new();
    private readonly long _maxFileBytes;
    private Dictionary<string, LinkRecord> _links = new(StringComparer.Ordinal);

    public LinkStore(string dataDir) : this(dataDir, MaxFileBytes) { }

    internal LinkStore(string dataDir, long maxFileBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDir);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxFileBytes, 1);
        DataDir = dataDir;
        _maxFileBytes = maxFileBytes;
    }

    public string DataDir { get; }

    private string FilePath => System.IO.Path.Combine(DataDir, FileName);

    public int Count
    {
        get { lock (_gate) return _links.Count; }
    }

    public void Load()
    {
        lock (_gate)
        {
            _links = new Dictionary<string, LinkRecord>(StringComparer.Ordinal);
            if (!File.Exists(FilePath)) return;

            byte[]? bytes;
            try
            {
                using var stream = new FileStream(FilePath, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (stream.Length > _maxFileBytes)
                {
                    bytes = null;
                }
                else
                {
                    bytes = new byte[(int)stream.Length];
                    stream.ReadExactly(bytes);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new StoreException("The links file could not be read.", ex);
            }

            var parsed = bytes is null ? null : TryParse(bytes);
            if (parsed is null)
            {
                Quarantine();
                return;
            }
            _links = parsed;
        }
    }

    public bool TryGet(string linkId, out LinkRecord record)
    {
        lock (_gate)
        {
            if (linkId is not null && _links.TryGetValue(linkId, out var found))
            {
                record = found;
                return true;
            }
        }
        record = null!;
        return false;
    }

    public string Add(LinkRecord r)
    {
        ArgumentNullException.ThrowIfNull(r);
        lock (_gate)
        {
            string id;
            do
            {
                id = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            }
            while (_links.ContainsKey(id));

            var next = new Dictionary<string, LinkRecord>(_links, StringComparer.Ordinal) { [id] = r };
            Persist(next);
            _links = next;
            return id;
        }
    }

    public void Update(string linkId, LinkRecord r)
    {
        ArgumentNullException.ThrowIfNull(linkId);
        ArgumentNullException.ThrowIfNull(r);
        lock (_gate)
        {
            if (!_links.ContainsKey(linkId)) throw new KeyNotFoundException("Unknown link.");
            var next = new Dictionary<string, LinkRecord>(_links, StringComparer.Ordinal) { [linkId] = r };
            Persist(next);
            _links = next;
        }
    }

    /// <summary>
    /// Replaces a record after a file operation that already happened (a write, or a timestamp-only refresh). Memory
    /// takes the new record first, so it keeps describing the file even if persisting links.json then fails (the
    /// StoreException is still thrown); the next successful persist writes it.
    /// </summary>
    public void Refresh(string linkId, LinkRecord r)
    {
        ArgumentNullException.ThrowIfNull(linkId);
        ArgumentNullException.ThrowIfNull(r);
        lock (_gate)
        {
            if (!_links.ContainsKey(linkId)) throw new KeyNotFoundException("Unknown link.");
            var next = new Dictionary<string, LinkRecord>(_links, StringComparer.Ordinal) { [linkId] = r };
            _links = next;
            Persist(next);
        }
    }

    public bool Remove(string linkId)
    {
        lock (_gate)
        {
            if (linkId is null || !_links.ContainsKey(linkId)) return false;
            var next = new Dictionary<string, LinkRecord>(_links, StringComparer.Ordinal);
            next.Remove(linkId);
            Persist(next);
            _links = next;
            return true;
        }
    }

    public string? FindByPath(string fullPath)
    {
        lock (_gate)
        {
            foreach (var (id, rec) in _links)
            {
                if (string.Equals(rec.Path, fullPath, StringComparison.OrdinalIgnoreCase)) return id;
            }
        }
        return null;
    }

    /// <summary>Drops every link whose ID is not in <paramref name="keep"/>.</summary>
    public void Prune(IReadOnlySet<string> keep)
    {
        ArgumentNullException.ThrowIfNull(keep);
        lock (_gate)
        {
            var next = new Dictionary<string, LinkRecord>(StringComparer.Ordinal);
            foreach (var (id, rec) in _links)
            {
                if (keep.Contains(id)) next[id] = rec;
            }
            if (next.Count == _links.Count) return;
            Persist(next);
            _links = next;
        }
    }

    private void Persist(Dictionary<string, LinkRecord> links)
    {
        try
        {
            Directory.CreateDirectory(DataDir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException("The links file could not be written.", ex);
        }
        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteNumber("v", SchemaVersion);
            w.WriteStartObject("links");
            foreach (var (id, r) in links)
            {
                w.WriteStartObject(id);
                w.WriteString("path", r.Path);
                w.WriteString("format", LinkFormats.Wire(r.Format));
                w.WriteString("encoding", EncodingWire(r.Encoding));
                w.WriteBoolean("bom", r.Bom);
                w.WriteString("lineEnding", r.LineEnding == LineEnding.CrLf ? "crlf" : "lf");
                w.WriteNumber("size", r.Size);
                w.WriteString("mtimeUtc", r.MtimeUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
                w.WriteString("sha256", r.Sha256);
                w.WriteEndObject();
            }
            w.WriteEndObject();
            w.WriteEndObject();
        }
        AtomicFile.Write(FilePath, System.Text.Encoding.UTF8.GetString(buffer.ToArray()));
    }

    private void Quarantine()
    {
        var stamp = DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        try
        {
            File.Move(FilePath, System.IO.Path.Combine(DataDir, $"links.unreadable-{stamp}.json"), overwrite: false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException("The unreadable links file could not be set aside.", ex);
        }
    }

    /// <summary>Returns the valid records, or null when the file as a whole is not a links file.</summary>
    private static Dictionary<string, LinkRecord>? TryParse(byte[] bytes)
    {
        try
        {
            using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number
                || !v.TryGetInt32(out var version) || version != SchemaVersion) return null;
            if (!root.TryGetProperty("links", out var links) || links.ValueKind != JsonValueKind.Object) return null;

            var result = new Dictionary<string, LinkRecord>(StringComparer.Ordinal);
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var seen = 0;
            foreach (var entry in links.EnumerateObject())
            {
                if (++seen > MaxRecords) break;
                if (!IsLinkId(entry.Name) || result.ContainsKey(entry.Name)) continue;
                if (!TryParseRecord(entry.Value, out var rec)) continue;
                if (!paths.Add(rec.Path)) continue; // one file, one link
                result[entry.Name] = rec;
            }
            return result;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool TryParseRecord(JsonElement e, out LinkRecord record)
    {
        record = null!;
        if (e.ValueKind != JsonValueKind.Object) return false;

        if (!TryString(e, "path", out var rawPath)
            || !FilePathPolicy.TryNormalize(rawPath, out var fullPath, out var pathFormat)
            || !string.Equals(fullPath, rawPath, StringComparison.Ordinal)) return false;

        if (!TryString(e, "format", out var formatWire) || !LinkFormats.TryParse(formatWire, out var format)
            || format != pathFormat) return false;

        if (!TryString(e, "encoding", out var encWire) || !TryEncoding(encWire, out var enc)) return false;

        if (!e.TryGetProperty("bom", out var bomEl) || bomEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
        var bom = bomEl.GetBoolean();

        if (!TryString(e, "lineEnding", out var leWire)) return false;
        LineEnding le;
        if (leWire == "lf") le = LineEnding.Lf;
        else if (leWire == "crlf") le = LineEnding.CrLf;
        else return false;

        if (format == LinkFormat.CpNote && (enc != TextEncodingKind.Utf8 || bom || le != LineEnding.Lf)) return false;

        if (!e.TryGetProperty("size", out var sizeEl) || sizeEl.ValueKind != JsonValueKind.Number
            || !sizeEl.TryGetInt64(out var size) || size < 0) return false;

        if (!TryString(e, "mtimeUtc", out var mtimeText)
            || !DateTime.TryParseExact(mtimeText, "O", CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out var mtime) || mtime.Kind != DateTimeKind.Utc) return false;

        if (!TryString(e, "sha256", out var sha) || !IsSha256(sha)) return false;

        record = new LinkRecord(fullPath, format, enc, bom, le, size, mtime, sha);
        return true;
    }

    private static bool TryString(JsonElement e, string name, out string value)
    {
        value = string.Empty;
        if (!e.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String) return false;
        value = p.GetString() ?? string.Empty;
        return true;
    }

    private static bool TryEncoding(string wire, out TextEncodingKind kind)
    {
        switch (wire)
        {
            case "utf8": kind = TextEncodingKind.Utf8; return true;
            case "utf16le": kind = TextEncodingKind.Utf16LE; return true;
            case "utf16be": kind = TextEncodingKind.Utf16BE; return true;
            default: kind = default; return false;
        }
    }

    private static string EncodingWire(TextEncodingKind kind) => kind switch
    {
        TextEncodingKind.Utf8 => "utf8",
        TextEncodingKind.Utf16LE => "utf16le",
        TextEncodingKind.Utf16BE => "utf16be",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    private static bool IsLowerHex(string s, int length)
    {
        if (s.Length != length) return false;
        foreach (var c in s)
        {
            if (!(c is >= '0' and <= '9' || c is >= 'a' and <= 'f')) return false;
        }
        return true;
    }

    private static bool IsLinkId(string s) => IsLowerHex(s, 32);

    private static bool IsSha256(string s) => IsLowerHex(s, 64);
}
