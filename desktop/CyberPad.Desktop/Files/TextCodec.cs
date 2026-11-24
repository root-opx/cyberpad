using System.Text;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Files;

public enum TextEncodingKind { Utf8, Utf16LE, Utf16BE }

public enum LineEnding { Lf, CrLf }

/// <summary>Decoded file text (always LF-normalised) plus what is needed to write it back unchanged.</summary>
public sealed record DecodedText(string Text, TextEncodingKind Encoding, bool Bom, LineEnding LineEnding);

public static class TextCodec
{
    public const string NotTextMessage = "This file isn't UTF-8 or UTF-16 text.";

    /// <summary>
    /// Strict decode: UTF-8 (with or without BOM) or UTF-16 LE/BE with BOM. Anything else,
    /// and any text containing U+0000, throws <see cref="StoreException"/>.
    /// </summary>
    public static DecodedText Decode(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);

        TextEncodingKind kind;
        int skip;
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            kind = TextEncodingKind.Utf8; skip = 3;
        }
        else if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        {
            kind = TextEncodingKind.Utf16LE; skip = 2;
        }
        else if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
        {
            kind = TextEncodingKind.Utf16BE; skip = 2;
        }
        else
        {
            kind = TextEncodingKind.Utf8; skip = 0;
        }

        string raw;
        try
        {
            raw = GetEncoding(kind).GetString(bytes, skip, bytes.Length - skip);
        }
        catch (DecoderFallbackException ex)
        {
            throw new StoreException(NotTextMessage, ex);
        }
        catch (ArgumentException ex)
        {
            throw new StoreException(NotTextMessage, ex);
        }

        if (raw.Contains('\0')) throw new StoreException(NotTextMessage);

        int crlf = 0, loneLf = 0;
        for (int i = 0; i < raw.Length; i++)
        {
            if (raw[i] != '\n') continue;
            if (i > 0 && raw[i - 1] == '\r') crlf++; else loneLf++;
        }

        var ending = crlf > loneLf ? LineEnding.CrLf : LineEnding.Lf;
        return new DecodedText(raw.Replace("\r\n", "\n"), kind, skip > 0, ending);
    }

    public static byte[] Encode(string text, TextEncodingKind enc, bool bom, LineEnding le)
    {
        ArgumentNullException.ThrowIfNull(text);

        var body = le == LineEnding.CrLf ? text.Replace("\n", "\r\n") : text;
        var encoding = GetEncoding(enc);
        var payload = encoding.GetBytes(body);
        if (!bom) return payload;

        var preamble = enc switch
        {
            TextEncodingKind.Utf8 => new byte[] { 0xEF, 0xBB, 0xBF },
            TextEncodingKind.Utf16LE => new byte[] { 0xFF, 0xFE },
            _ => new byte[] { 0xFE, 0xFF },
        };
        var result = new byte[preamble.Length + payload.Length];
        preamble.CopyTo(result, 0);
        payload.CopyTo(result, preamble.Length);
        return result;
    }

    private static Encoding GetEncoding(TextEncodingKind kind) => kind switch
    {
        TextEncodingKind.Utf8 => new UTF8Encoding(false, throwOnInvalidBytes: true),
        TextEncodingKind.Utf16LE => new UnicodeEncoding(false, false, true),
        TextEncodingKind.Utf16BE => new UnicodeEncoding(true, false, true),
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };
}
