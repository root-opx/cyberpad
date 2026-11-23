using System.Text.Json;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Bridge;

/// <summary>
/// Trust boundary between the page and the host. Validates every message (origin, size, shape, field
/// allow-list) before any action runs. Rejects, never cleans up. Logs only "type: reason".
/// </summary>
public sealed class MessageDispatcher
{
    public const int MaxTextChars = 64 * 1024 * 1024;
    public const int MaxNameChars = 120;

    // JSON escaping can make the raw message several times longer than the data it carries.
    private const long MaxRawChars = 6L * MaxTextChars + 65536;

    private static readonly JsonDocumentOptions ParseOptions = new() { MaxDepth = 4 };
    private static readonly JsonSerializerOptions ReplyOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static readonly Dictionary<string, string[]> Fields = new(StringComparer.Ordinal)
    {
        ["load"] = new[] { "type", "id" },
        ["save"] = new[] { "type", "id", "data" },
        ["quarantine"] = new[] { "type", "id" },
        ["exportFile"] = new[] { "type", "id", "kind", "suggestedName", "text" },
        ["flushed"] = new[] { "type" },
    };

    private readonly IHostActions _actions;
    private readonly Action<string> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public MessageDispatcher(IHostActions actions, Action<string> log)
    {
        _actions = actions;
        _log = log;
    }

    /// <summary>Returns the reply JSON, or null when there is nothing to send.</summary>
    /// <remarks>
    /// Store actions (load, save, quarantine) and "flushed" run one at a time. An export runs outside that gate:
    /// it waits on the user's Save dialog, and autosaves must not queue behind it until they time out on the page.
    /// </remarks>
    public async Task<string?> HandleAsync(string source, string json)
    {
        // Hoisted so a string-decoding failure can still be logged with its type and answered with its id.
        string? type = null;
        string? id = null;
        try
        {
            return await DispatchCoreAsync(source, json, t => type = t, i => id = i).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // Lone UTF-16 surrogates pass JsonDocument.Parse but throw when a string is read (or when parsing raw text).
            return Reject(type, id, "invalid string");
        }
    }

    private async Task<string?> DispatchCoreAsync(string source, string json, Action<string> setType, Action<string?> setId)
    {
        if (!AppOrigin.IsAppUri(source)) return Reject(null, null, "wrong origin");
        if (json is null || json.Length > MaxRawChars) return Reject(null, null, "message too large");

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json, ParseOptions);
        }
        catch (JsonException)
        {
            return Reject(null, null, "invalid json");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Reject(null, null, "not an object");
            if (!root.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String)
                return Reject(null, null, "missing type");
            var type = typeEl.GetString()!;
            setType(type);
            if (!Fields.TryGetValue(type, out var allowed)) return Reject(null, null, "unknown type");

            // The id is read first so that every later rejection of this message can echo it back.
            string? id = null;
            if (type != "flushed")
            {
                if (!root.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String)
                    return Reject(type, null, "missing id");
                id = idEl.GetString();
                if (!IsValidId(id)) return Reject(type, null, "invalid id");
                setId(id);
            }

            // Exact field set: no extras, no duplicates, none missing.
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in root.EnumerateObject())
            {
                if (Array.IndexOf(allowed, p.Name) < 0) return Reject(type, id, "unexpected field");
                if (!seen.Add(p.Name)) return Reject(type, id, "duplicate field");
            }
            if (seen.Count != allowed.Length) return Reject(type, id, "missing field");

            switch (type)
            {
                case "flushed":
                    return await RunFlushedAsync().ConfigureAwait(false);

                case "load":
                    return await RunAsync(type, id!, Serialized(async () =>
                    {
                        var (main, backup) = await _actions.LoadAsync().ConfigureAwait(false);
                        return Serialize(new { type = "loaded", id, main, backup, version = _actions.Version, dataDir = _actions.DataDir });
                    }), null).ConfigureAwait(false);

                case "quarantine":
                    return await RunAsync(type, id!, Serialized(async () =>
                    {
                        await _actions.QuarantineAsync().ConfigureAwait(false);
                        return Serialize(new { type = "quarantined", id });
                    }), null).ConfigureAwait(false);

                case "save":
                {
                    var el = root.GetProperty("data");
                    if (el.ValueKind != JsonValueKind.String) return Reject(type, id, "data must be a string");
                    var data = el.GetString()!;
                    if (data.Length > MaxTextChars) return Reject(type, id, "data too large");
                    return await RunAsync(type, id!, Serialized(async () =>
                    {
                        await _actions.SaveAsync(data).ConfigureAwait(false);
                        return Serialize(new { type = "saved", id });
                    }), reason => Serialize(new { type = "saveFailed", id, reason })).ConfigureAwait(false);
                }

                case "exportFile":
                {
                    var kindEl = root.GetProperty("kind");
                    var nameEl = root.GetProperty("suggestedName");
                    var textEl = root.GetProperty("text");
                    if (kindEl.ValueKind != JsonValueKind.String
                        || nameEl.ValueKind != JsonValueKind.String
                        || textEl.ValueKind != JsonValueKind.String)
                        return Reject(type, id, "fields must be strings");
                    if (!ExportKinds.TryParse(kindEl.GetString(), out var kind)) return Reject(type, id, "unknown kind");
                    var suggested = nameEl.GetString()!;
                    if (suggested.Length > MaxNameChars) return Reject(type, id, "name too long");
                    var text = textEl.GetString()!;
                    if (text.Length > MaxTextChars) return Reject(type, id, "text too large");
                    var safeName = FileNameSanitizer.Sanitize(suggested, kind);
                    return await RunAsync(type, id!, async () =>
                    {
                        var name = await _actions.ExportAsync(kind, safeName, text).ConfigureAwait(false);
                        return name is null
                            ? Serialize(new { type = "exportCancelled", id })
                            : Serialize(new { type = "exported", id, name });
                    }, reason => Serialize(new { type = "exportFailed", id, reason })).ConfigureAwait(false);
                }

                default:
                    return Reject(type, id, "unknown type");
            }
        }
    }

    /// <summary>Wraps a store action so that it runs only while holding the store gate.</summary>
    private Func<Task<string>> Serialized(Func<Task<string>> action) => async () =>
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            return await action().ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    };

    /// <summary>Takes the store gate first, as before, so the window never closes while a store write is still running.</summary>
    private async Task<string?> RunFlushedAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            _actions.Flushed();
        }
        catch (Exception ex)
        {
            _log($"flushed: unexpected {ex.GetType().Name}");
        }
        finally
        {
            _gate.Release();
        }
        return null;
    }

    /// <summary>
    /// Runs an action. A StoreException carries a safe reason and is relayed through <paramref name="failure"/> (or as a
    /// rejection when the type has no failure reply). Any other exception is logged by type name only and answered with a
    /// generic failure: nothing is swallowed silently and no exception message ever reaches the log or the page.
    /// </summary>
    private async Task<string?> RunAsync(string type, string id, Func<Task<string>> action, Func<string, string>? failure)
    {
        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (StoreException ex)
        {
            _log($"{type}: store failure");
            return failure is not null ? failure(ex.Message) : RejectedReply(id, ex.Message);
        }
        catch (Exception ex)
        {
            _log($"{type}: unexpected {ex.GetType().Name}");
            const string generic = "Unexpected error.";
            return failure is not null ? failure(generic) : RejectedReply(id, generic);
        }
    }

    private string? Reject(string? type, string? id, string reason)
    {
        _log($"{type ?? "?"}: {reason}");
        return id is null ? null : RejectedReply(id, reason);
    }

    private static string RejectedReply(string id, string reason) => Serialize(new { type = "rejected", id, reason });

    private static bool IsValidId(string? id)
    {
        if (string.IsNullOrEmpty(id) || id.Length > 64) return false;
        foreach (var c in id)
        {
            var ok = c is >= 'A' and <= 'Z' || c is >= 'a' and <= 'z' || c is >= '0' and <= '9' || c == '_' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    private static string Serialize<T>(T value) => JsonSerializer.Serialize(value, ReplyOptions);
}
