using System.Security.Cryptography;
using System.Text;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Files;

public enum FileStatus { Ok, Changed, Missing, Unknown }

public enum WriteOutcome { Written, Conflict, Missing }

/// <summary>
/// Reads and writes the files notes are linked to. Never overwrites a file that changed elsewhere unless told to
/// (Keep mine), never recreates a file that went missing, and never logs or reports file content or paths.
/// </summary>
public sealed class LinkedFiles
{
    public const long MaxFileBytes = 4L * 1024 * 1024;
    public const int MaxTextChars = 1_000_000;

    private const string TooLargeMessage = "The file is too large to open.";
    private const string ReadFailedMessage = "The file could not be read.";
    private const string WriteFailedMessage = "The file could not be written.";

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public (LinkRecord Record, string Text) ReadNew(string fullPath, LinkFormat format)
    {
        ArgumentException.ThrowIfNullOrEmpty(fullPath);
        var snap = ReadSnapshot(fullPath);
        var (text, enc, bom, le) = Decode(format, snap.Bytes);
        return (new LinkRecord(fullPath, format, enc, bom, le, snap.Bytes.Length, snap.MtimeUtc, snap.Sha256), text);
    }

    /// <summary>
    /// The file's current text; null if the file is gone. Reading never adopts new content: the record keeps meaning
    /// "what CyberPad last wrote or the user adopted". Only a timestamp-only change (same hash) refreshes it.
    /// </summary>
    public string? ReadCurrent(LinkRecord r, out LinkRecord refreshed)
    {
        ArgumentNullException.ThrowIfNull(r);
        refreshed = r;
        Snapshot snap;
        try
        {
            snap = ReadSnapshot(r.Path);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        var (text, _, _, _) = Decode(r.Format, snap.Bytes);
        if (string.Equals(snap.Sha256, r.Sha256, StringComparison.Ordinal))
            refreshed = r with { Size = snap.Bytes.Length, MtimeUtc = snap.MtimeUtc };
        return text;
    }

    /// <summary>
    /// Size and mtime equal means Ok; otherwise the hash decides. A read that does not finish within
    /// <paramref name="timeout"/> (or fails) is Unknown; the caller's thread is never held longer than that.
    /// </summary>
    public FileStatus Check(LinkRecord r, out LinkRecord refreshed, TimeSpan timeout)
    {
        ArgumentNullException.ThrowIfNull(r);
        refreshed = r;
        var work = Task.Run(() =>
        {
            try
            {
                var status = Inspect(r, out var fresh);
                return (status, fresh);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or StoreException)
            {
                return (FileStatus.Unknown, r);
            }
        });

        bool finished;
        try
        {
            finished = work.Wait(timeout);
        }
        catch (AggregateException)
        {
            return FileStatus.Unknown;
        }
        if (!finished) return FileStatus.Unknown;

        refreshed = work.Result.Item2;
        return work.Result.Item1;
    }

    public WriteOutcome Write(LinkRecord r, string text, bool force, out LinkRecord updated)
    {
        ArgumentNullException.ThrowIfNull(r);
        ArgumentNullException.ThrowIfNull(text);
        updated = r;

        var bytes = EncodeFor(r, text);

        if (!File.Exists(r.Path)) return WriteOutcome.Missing;

        // The temp file is fully written and flushed first; the check runs only then, right before the swap,
        // so a save by another program can only slip in during that one metadata check.
        var outcome = WriteOutcome.Written;
        LinkRecord? adopted = null;
        var swapped = WriteBytes(r.Path, bytes, replaceExisting: true, gate: () =>
        {
            FileStatus status;
            try
            {
                status = Inspect(r, out _);
                // Changed, but the file already holds exactly what this write would produce: adopt it, don't rewrite.
                if (status == FileStatus.Changed && !force && TryAdopt(r, text, out var current)) adopted = current;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new StoreException(ReadFailedMessage, ex);
            }
            if (status == FileStatus.Missing) outcome = WriteOutcome.Missing;
            else if (status == FileStatus.Changed && !force && adopted is null) outcome = WriteOutcome.Conflict;
            return outcome == WriteOutcome.Written && adopted is null;
        });
        if (adopted is not null)
        {
            updated = adopted;
            return WriteOutcome.Written;
        }
        if (!swapped) return outcome;
        updated = r with { Size = bytes.Length, MtimeUtc = File.GetLastWriteTimeUtc(r.Path), Sha256 = Hash(bytes) };
        return WriteOutcome.Written;
    }

    /// <summary>Writes a new linked file: UTF-8, no BOM, LF. Replaces an existing file (the dialog confirmed it).</summary>
    public LinkRecord WriteNew(string fullPath, LinkFormat format, string text)
    {
        ArgumentException.ThrowIfNullOrEmpty(fullPath);
        ArgumentNullException.ThrowIfNull(text);

        var seed = new LinkRecord(fullPath, format, TextEncodingKind.Utf8, false, LineEnding.Lf, 0, default, string.Empty);
        var bytes = EncodeFor(seed, text);
        WriteBytes(fullPath, bytes, replaceExisting: File.Exists(fullPath));
        return seed with { Size = bytes.Length, MtimeUtc = File.GetLastWriteTimeUtc(fullPath), Sha256 = Hash(bytes) };
    }

    private readonly record struct Snapshot(byte[] Bytes, DateTime MtimeUtc, string Sha256);

    private static Snapshot ReadSnapshot(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            // Checked on the open handle, so the size read is the size of the file being read.
            if (stream.Length > MaxFileBytes) throw new StoreException(TooLargeMessage);
            var bytes = new byte[(int)stream.Length];
            stream.ReadExactly(bytes);
            var mtime = File.GetLastWriteTimeUtc(stream.SafeFileHandle);
            return new Snapshot(bytes, mtime, Hash(bytes));
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException(ReadFailedMessage, ex);
        }
    }

    private static FileStatus Inspect(LinkRecord r, out LinkRecord refreshed)
    {
        refreshed = r;
        try
        {
            var info = new FileInfo(r.Path);
            if (!info.Exists) return FileStatus.Missing;
            if (info.Length == r.Size && info.LastWriteTimeUtc.Ticks == r.MtimeUtc.Ticks) return FileStatus.Ok;
            if (info.Length > MaxFileBytes) return FileStatus.Changed;

            var snap = ReadSnapshot(r.Path);
            if (!string.Equals(snap.Sha256, r.Sha256, StringComparison.Ordinal)) return FileStatus.Changed;

            refreshed = r with { Size = snap.Bytes.Length, MtimeUtc = snap.MtimeUtc };
            return FileStatus.Ok;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return FileStatus.Missing;
        }
    }

    /// <summary>
    /// True when the file decodes to exactly <paramref name="text"/> and encoding that text in the file's own encoding,
    /// BOM and line endings gives back its exact bytes; <paramref name="adopted"/> is then the record of the file as it is.
    /// A file that isn't valid text, is over the size cap, or doesn't round-trip byte for byte is never adopted.
    /// </summary>
    private static bool TryAdopt(LinkRecord r, string text, out LinkRecord adopted)
    {
        adopted = r;
        Snapshot snap;
        try
        {
            if (new FileInfo(r.Path).Length > MaxFileBytes) return false;
            snap = ReadSnapshot(r.Path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return false;
        }

        LinkRecord candidate;
        byte[] mine;
        try
        {
            var (decoded, enc, bom, le) = Decode(r.Format, snap.Bytes);
            if (!string.Equals(decoded, text, StringComparison.Ordinal)) return false;
            candidate = r with { Encoding = enc, Bom = bom, LineEnding = le };
            mine = EncodeFor(candidate, text);
        }
        catch (StoreException)
        {
            return false; // not text in a supported form: it can only be a conflict
        }
        if (!mine.AsSpan().SequenceEqual(snap.Bytes)) return false;
        adopted = candidate with { Size = snap.Bytes.Length, MtimeUtc = snap.MtimeUtc, Sha256 = snap.Sha256 };
        return true;
    }

    private static (string Text, TextEncodingKind Enc, bool Bom, LineEnding Le) Decode(LinkFormat format, byte[] bytes)
    {
        if (format == LinkFormat.CpNote)
        {
            var skip = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
            string raw;
            try
            {
                raw = StrictUtf8.GetString(bytes, skip, bytes.Length - skip);
            }
            catch (DecoderFallbackException ex)
            {
                throw new StoreException(TextCodec.NotTextMessage, ex);
            }
            if (raw.Contains('\0')) throw new StoreException(TextCodec.NotTextMessage);
            return (raw, TextEncodingKind.Utf8, false, LineEnding.Lf);
        }

        var decoded = TextCodec.Decode(bytes);
        if (decoded.Text.Length > MaxTextChars) throw new StoreException(TooLargeMessage);
        return (decoded.Text, decoded.Encoding, decoded.Bom, decoded.LineEnding);
    }

    private static byte[] EncodeFor(LinkRecord r, string text)
    {
        byte[] bytes;
        try
        {
            bytes = r.Format == LinkFormat.CpNote
                ? StrictUtf8.GetBytes(text)
                : TextCodec.Encode(text, r.Encoding, r.Bom, r.LineEnding);
        }
        catch (EncoderFallbackException ex)
        {
            throw new StoreException(TextCodec.NotTextMessage, ex);
        }
        if (bytes.Length > MaxFileBytes) throw new StoreException("The note is too large to save to a file.");
        return bytes;
    }

    /// <summary>
    /// Writes a hidden temp sibling, flushes it to disk, runs the optional gate (false means do not swap), then swaps it in (retrying only on sharing or lock
    /// violations). The temp file is removed on any failure.
    /// </summary>
    private static bool WriteBytes(string path, byte[] bytes, bool replaceExisting, Func<bool>? gate = null)
    {
        var dir = Path.GetDirectoryName(path) ?? throw new StoreException(WriteFailedMessage);
        var tmp = Path.Combine(dir, "." + Path.GetFileName(path) + ".cyberpad-tmp-"
            + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant());
        var swapped = false;
        try
        {
            if (replaceExisting && (File.GetAttributes(path) & FileAttributes.ReadOnly) != 0)
                throw new StoreException("The file is read-only.");

            using (var stream = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(flushToDisk: true);
            }
            File.SetAttributes(tmp, FileAttributes.Hidden);

            if (gate is not null && !gate()) return false;

            if (replaceExisting)
                SharingRetry.Run(() => File.Replace(tmp, path, null));
            else
            {
                SharingRetry.Run(() => File.Move(tmp, path, overwrite: false));
                swapped = true;
                File.SetAttributes(path, FileAttributes.Normal); // the temp name was hidden, the file is not
            }
            swapped = true;
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException(WriteFailedMessage, ex);
        }
        finally
        {
            if (!swapped) AtomicFile.DeleteQuietly(tmp);
        }
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
