using System.Text.Json;
using CyberPad.Desktop.Files;
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

    /// <summary>Text carried by the linked-file messages (the file cap on disk is 4 MB).</summary>
    public const int MaxFileTextChars = 4 * 1024 * 1024;

    public const int MaxLinkIds = 2000;

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
        ["saveAsFile"] = new[] { "type", "id", "format", "suggestedName", "text" },
        ["relinkFile"] = new[] { "type", "id", "linkId", "format", "suggestedName", "text" },
        ["theme"] = new[] { "type", "id", "theme" },
        ["openFile"] = new[] { "type", "id" },
        ["writeFile"] = new[] { "type", "id", "linkId", "text", "force" },
        ["readFile"] = new[] { "type", "id", "linkId" },
        ["matchesLastWrite"] = new[] { "type", "id", "linkId", "text" },
        ["checkFiles"] = new[] { "type", "id", "linkIds" },
        ["unlinkFile"] = new[] { "type", "id", "linkId" },
        ["revealFile"] = new[] { "type", "id", "linkId" },
        ["pruneLinks"] = new[] { "type", "id", "linkIds" },
        ["flushed"] = new[] { "type" },
        ["flushFailed"] = new[] { "type" },
    };

    private readonly IHostActions _actions;
    private readonly Action<string> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);

    // Linked-file I/O may hit a slow network drive, so it has its own gate and never delays notes.json saves.
    private readonly SemaphoreSlim _fileGate = new(1, 1);

    private const string GenericFileFailure = "The file operation failed.";

    public MessageDispatcher(IHostActions actions, Action<string> log)
    {
        _actions = actions;
        _log = log;
    }

    /// <summary>Returns the reply JSON, or null when there is nothing to send.</summary>
    /// <remarks>
    /// Store actions (load, save, quarantine), "flushed" and "flushFailed" run one at a time. An export runs outside that gate:
    /// it waits on the user's Save dialog, and autosaves must not queue behind it until they time out on the page. The same
    /// holds for saveAsFile, relinkFile and openFile. The other file messages run one at a time on a separate file gate.
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
            if (type is not ("flushed" or "flushFailed"))
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
                    return await RunFlushReplyAsync(type, _actions.Flushed).ConfigureAwait(false);

                case "flushFailed":
                    return await RunFlushReplyAsync(type, _actions.FlushFailed).ConfigureAwait(false);

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

                case "theme":
                {
                    var el = root.GetProperty("theme");
                    if (el.ValueKind != JsonValueKind.String || !HostThemes.TryParse(el.GetString(), out var theme))
                        return Reject(type, id, "invalid theme");
                    // Takes neither gate: a title bar colour must not wait behind a save or a file dialog.
                    return await RunAsync(type, id!, async () =>
                    {
                        await _actions.SetThemeAsync(theme).ConfigureAwait(false);
                        return Serialize(new { type = "themeApplied", id });
                    }, null).ConfigureAwait(false);
                }

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

                case "saveAsFile":
                case "relinkFile":
                {
                    string? relinkId = null;
                    if (type == "relinkFile")
                    {
                        if (!TryReadLinkId(root.GetProperty("linkId"), out relinkId)) return Reject(type, id, "invalid linkId");
                    }
                    var formatEl = root.GetProperty("format");
                    var nameEl = root.GetProperty("suggestedName");
                    var textEl = root.GetProperty("text");
                    if (formatEl.ValueKind != JsonValueKind.String
                        || nameEl.ValueKind != JsonValueKind.String
                        || textEl.ValueKind != JsonValueKind.String)
                        return Reject(type, id, "fields must be strings");
                    if (!LinkFormat.TryParse(formatEl.GetString(), out var format)) return Reject(type, id, "unknown format");
                    var suggested = nameEl.GetString()!;
                    if (suggested.Length > MaxNameChars) return Reject(type, id, "name too long");
                    var text = textEl.GetString()!;
                    if (text.Length > MaxFileTextChars) return Reject(type, id, "text too large");
                    var safeName = FileNameSanitizer.Sanitize(suggested, format.Extension);
                    return await RunFileAsync(type, id!, false, async () =>
                    {
                        var r = await _actions.SaveAsFileAsync(format, safeName, text, relinkId).ConfigureAwait(false);
                        return r is null
                            ? Serialize(new { type = "fileCancelled", id })
                            : Serialize(new { type = "fileLinked", id, linkId = r.LinkId, name = r.Name, format = r.Format.Wire });
                    }).ConfigureAwait(false);
                }

                case "openFile":
                    return await RunFileAsync(type, id!, false, async () =>
                    {
                        var r = await _actions.OpenFileAsync().ConfigureAwait(false);
                        return r is null
                            ? Serialize(new { type = "fileCancelled", id })
                            : Serialize(new
                            {
                                type = "fileOpened", id, linkId = r.LinkId, name = r.Name,
                                format = r.Format.Wire, text = r.Text, alreadyLinked = r.AlreadyLinked,
                            });
                    }).ConfigureAwait(false);

                case "writeFile":
                {
                    if (!TryReadLinkId(root.GetProperty("linkId"), out var linkId)) return Reject(type, id, "invalid linkId");
                    var textEl = root.GetProperty("text");
                    var forceEl = root.GetProperty("force");
                    if (textEl.ValueKind != JsonValueKind.String) return Reject(type, id, "text must be a string");
                    if (forceEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Reject(type, id, "force must be a boolean");
                    var text = textEl.GetString()!;
                    if (text.Length > MaxFileTextChars) return Reject(type, id, "text too large");
                    var force = forceEl.GetBoolean();
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        var outcome = await _actions.WriteFileAsync(linkId!, text, force).ConfigureAwait(false);
                        return outcome switch
                        {
                            WriteOutcome.Written => Serialize(new { type = "fileWritten", id }),
                            WriteOutcome.Conflict => Serialize(new { type = "fileConflict", id }),
                            WriteOutcome.Missing => Serialize(new { type = "fileMissing", id }),
                            _ => throw new InvalidOperationException("unknown write outcome"),
                        };
                    }).ConfigureAwait(false);
                }

                case "readFile":
                {
                    if (!TryReadLinkId(root.GetProperty("linkId"), out var linkId)) return Reject(type, id, "invalid linkId");
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        var text = await _actions.ReadFileAsync(linkId!).ConfigureAwait(false);
                        return text is null
                            ? Serialize(new { type = "fileMissing", id })
                            : Serialize(new { type = "fileRead", id, text });
                    }).ConfigureAwait(false);
                }

                case "matchesLastWrite":
                {
                    if (!TryReadLinkId(root.GetProperty("linkId"), out var linkId)) return Reject(type, id, "invalid linkId");
                    var textEl = root.GetProperty("text");
                    if (textEl.ValueKind != JsonValueKind.String) return Reject(type, id, "text must be a string");
                    var text = textEl.GetString()!;
                    if (text.Length > MaxFileTextChars) return Reject(type, id, "text too large");
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        var match = await _actions.MatchesLastWriteAsync(linkId!, text).ConfigureAwait(false);
                        return Serialize(new { type = "lastWriteMatch", id, match });
                    }).ConfigureAwait(false);
                }

                case "checkFiles":
                {
                    if (!TryReadLinkIds(root.GetProperty("linkIds"), out var linkIds)) return Reject(type, id, "invalid linkIds");
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        var result = await _actions.CheckFilesAsync(linkIds).ConfigureAwait(false);
                        var statuses = new Dictionary<string, string>(StringComparer.Ordinal);
                        foreach (var (key, status) in result) statuses[key] = StatusWire(status);
                        return Serialize(new { type = "fileStatus", id, statuses });
                    }).ConfigureAwait(false);
                }

                case "unlinkFile":
                {
                    if (!TryReadLinkId(root.GetProperty("linkId"), out var linkId)) return Reject(type, id, "invalid linkId");
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        await _actions.UnlinkFileAsync(linkId!).ConfigureAwait(false);
                        return Serialize(new { type = "fileUnlinked", id });
                    }).ConfigureAwait(false);
                }

                case "revealFile":
                {
                    if (!TryReadLinkId(root.GetProperty("linkId"), out var linkId)) return Reject(type, id, "invalid linkId");
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        await _actions.RevealFileAsync(linkId!).ConfigureAwait(false);
                        return Serialize(new { type = "fileRevealed", id });
                    }).ConfigureAwait(false);
                }

                case "pruneLinks":
                {
                    if (!TryReadLinkIds(root.GetProperty("linkIds"), out var keep)) return Reject(type, id, "invalid linkIds");
                    return await RunFileAsync(type, id!, true, async () =>
                    {
                        await _actions.PruneLinksAsync(keep).ConfigureAwait(false);
                        return Serialize(new { type = "linksPruned", id });
                    }).ConfigureAwait(false);
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

    /// <summary>
    /// Handles "flushed" or "flushFailed". Takes the store gate first, so the window never closes (or asks to close)
    /// while a store write is still running.
    /// </summary>
    private async Task<string?> RunFlushReplyAsync(string type, Action action)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            action();
        }
        catch (Exception ex)
        {
            _log($"{type}: unexpected {ex.GetType().Name}");
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

    /// <summary>
    /// Runs a linked-file action, optionally while holding the file gate. Failures never reach the page unfiltered: a
    /// StoreException carries a safe reason, an unknown link is a rejection, and any other exception is logged by type
    /// name only and answered with a generic reason (its message may contain a path).
    /// </summary>
    private async Task<string?> RunFileAsync(string type, string id, bool gated, Func<Task<string>> action)
    {
        var held = false;
        try
        {
            if (gated)
            {
                await _fileGate.WaitAsync().ConfigureAwait(false);
                held = true;
            }
            return await action().ConfigureAwait(false);
        }
        catch (UnknownLinkException)
        {
            return Reject(type, id, "unknown link");
        }
        catch (FileAlreadyLinkedException ex)
        {
            _log($"{type}: already linked");
            return Serialize(new { type = "fileFailed", id, reason = ex.Message, linkId = ex.LinkId });
        }
        catch (StoreException ex)
        {
            _log($"{type}: store failure");
            return Serialize(new { type = "fileFailed", id, reason = ex.Message });
        }
        catch (Exception ex)
        {
            _log($"{type}: unexpected {ex.GetType().Name}");
            return Serialize(new { type = "fileFailed", id, reason = GenericFileFailure });
        }
        finally
        {
            if (held) _fileGate.Release();
        }
    }

    private static string StatusWire(FileStatus status) => status switch
    {
        FileStatus.Ok => "ok",
        FileStatus.Changed => "changed",
        FileStatus.Missing => "missing",
        _ => "unknown",
    };

    /// <summary>A link id is a string of exactly 32 lowercase hex characters.</summary>
    private static bool TryReadLinkId(JsonElement el, out string? linkId)
    {
        linkId = null;
        if (el.ValueKind != JsonValueKind.String) return false;
        var v = el.GetString();
        if (!IsValidLinkId(v)) return false;
        linkId = v;
        return true;
    }

    private static bool IsValidLinkId(string? v)
    {
        if (v is null || v.Length != 32) return false;
        foreach (var c in v)
        {
            if (!(c is >= '0' and <= '9' || c is >= 'a' and <= 'f')) return false;
        }
        return true;
    }

    /// <summary>An array of at most <see cref="MaxLinkIds"/> unique valid link ids; may be empty.</summary>
    private static bool TryReadLinkIds(JsonElement el, out List<string> ids)
    {
        ids = new List<string>();
        if (el.ValueKind != JsonValueKind.Array) return false;
        if (el.GetArrayLength() > MaxLinkIds) return false;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in el.EnumerateArray())
        {
            if (!TryReadLinkId(item, out var v) || !seen.Add(v!)) return false;
            ids.Add(v!);
        }
        return true;
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
