using System.Security.Cryptography;
using System.Text;

namespace CyberPad.Desktop.Storage;

/// <summary>Crash-safe whole-file writes: write a temp sibling, flush to disk, then swap into place.</summary>
public static class AtomicFile
{
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public static void Write(string path, string text)
    {
        var tmp = path + ".tmp-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
        try
        {
            WriteDurably(tmp, text);
            File.Move(tmp, path, overwrite: true);
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
