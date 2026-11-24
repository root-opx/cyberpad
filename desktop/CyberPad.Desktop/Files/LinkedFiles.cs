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

    /// <summary>The file's current text, with the record refreshed to what is now on disk; null if the file is gone.</summary>
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
        var (text, enc, bom, le) = Decode(r.Format, snap.Bytes);
        refreshed = r with { Encoding = enc, Bom = bom, LineEnding = le, Size = snap.Bytes.Length, MtimeUtc = snap.MtimeUtc, Sha256 = snap.Sha256 };
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

        FileStatus status;
        try
        {
            status = Inspect(r, out _);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StoreException(ReadFailedMessage, ex);
        }

        if (status == FileStatus.Missing) return WriteOutcome.Missing;
        if (status == FileStatus.Changed && !force) return WriteOutcome.Conflict;

        WriteBytes(r.Path, bytes, replaceExisting: true);
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
    /// Writes a hidden temp sibling, flushes it to disk, then swaps it in (retrying only on sharing or lock
    /// violations). The temp file is removed on any failure.
    /// </summary>
    private static void WriteBytes(string path, byte[] bytes, bool replaceExisting)
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

            if (replaceExisting)
                SharingRetry.Run(() => File.Replace(tmp, path, null));
            else
            {
                SharingRetry.Run(() => File.Move(tmp, path, overwrite: false));
                swapped = true;
                File.SetAttributes(path, FileAttributes.Normal); // the temp name was hidden, the file is not
            }
            swapped = true;
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
