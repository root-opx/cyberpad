using System.Security.Cryptography;
using System.Text;

namespace CyberPad.Desktop.Storage;

/// <summary>Crash-safe whole-file writes: write a temp sibling, flush to disk, then swap into place.</summary>
public static class AtomicFile
{
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public static void Write(string path, string text) => Write(path, text, null, null);

    /// <param name="move">Test seam: the final swap (File.Move with overwrite).</param>
    /// <param name="sleep">Test seam: waits between swap retries.</param>
    internal static void Write(string path, string text, Action<string, string>? move, Action<int>? sleep)
    {
        var swap = move ?? ((from, to) => File.Move(from, to, overwrite: true));
        var tmp = path + ".tmp-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
        try
        {
            WriteDurably(tmp, text);
            // A scanner or sync client briefly holding the new file is retried, as NoteStore.Save does.
            SharingRetry.Run(() => swap(tmp, path), sleep);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            DeleteQuietly(tmp);
            throw new StoreException("The file could not be written.", ex);
        }
    }

    /// <summary>Writes UTF-8 (no BOM) to <paramref name="path"/> and forces it to physical disk.</summary>
    internal static void WriteDurably(string path, string text)
    {
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None,
            bufferSize: 4096, FileOptions.WriteThrough);
        var bytes = Utf8NoBom.GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(flushToDisk: true);
    }

    internal static void DeleteQuietly(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best effort: a leftover temp file is harmless and the original error is reported.
        }
    }
}
