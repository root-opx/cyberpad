using System.Text;
using CyberPad.Desktop.Files;
using CyberPad.Desktop.Storage;

namespace CyberPad.Desktop.Tests;

public sealed class TextCodecTests
{
    private static readonly UTF8Encoding Utf8 = new(false);

    [Fact]
    public void Decode_Utf8NoBom_NormalisesLf()
    {
        var d = TextCodec.Decode(Utf8.GetBytes("a\r\nb\r\nc"));
        Assert.Equal("a\nb\nc", d.Text);
        Assert.Equal(TextEncodingKind.Utf8, d.Encoding);
        Assert.False(d.Bom);
        Assert.Equal(LineEnding.CrLf, d.LineEnding);
    }

    [Fact]
    public void Decode_Utf8Bom_StripsAndRemembers()
    {
        var bytes = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Utf8.GetBytes("x")).ToArray();
        var d = TextCodec.Decode(bytes);
        Assert.Equal("x", d.Text);
        Assert.True(d.Bom);
        Assert.Equal(TextEncodingKind.Utf8, d.Encoding);
    }

    [Fact]
    public void Decode_Utf16LeAndBeWithBom()
    {
        var le = new byte[] { 0xFF, 0xFE }.Concat(Encoding.Unicode.GetBytes("✓漢")).ToArray();
        var be = new byte[] { 0xFE, 0xFF }.Concat(Encoding.BigEndianUnicode.GetBytes("✓漢")).ToArray();
        var dl = TextCodec.Decode(le);
        var db = TextCodec.Decode(be);
        Assert.Equal("✓漢", dl.Text);
        Assert.Equal(TextEncodingKind.Utf16LE, dl.Encoding);
        Assert.True(dl.Bom);
        Assert.Equal("✓漢", db.Text);
        Assert.Equal(TextEncodingKind.Utf16BE, db.Encoding);
        Assert.True(db.Bom);
    }

    [Fact]
    public void Decode_RejectsInvalidUtf8AndNul()
    {
        var e1 = Assert.Throws<StoreException>(() => TextCodec.Decode(new byte[] { 0xC3, 0x28 }));
        var e2 = Assert.Throws<StoreException>(() => TextCodec.Decode(Utf8.GetBytes("a\0b")));
        Assert.Equal(TextCodec.NotTextMessage, e1.Message);
        Assert.Equal(TextCodec.NotTextMessage, e2.Message);
    }

    [Fact]
    public void Decode_RejectsUtf16WithoutBom()
    {
        var e = Assert.Throws<StoreException>(() => TextCodec.Decode(Encoding.Unicode.GetBytes("ab")));
        Assert.Equal(TextCodec.NotTextMessage, e.Message);
    }

    [Fact]
    public void Decode_LoneLfMajority_IsLf()
    {
        Assert.Equal(LineEnding.Lf, TextCodec.Decode(Utf8.GetBytes("a\nb\nc\r\nd")).LineEnding);
    }

    [Fact]
    public void Decode_LoneCr_IsKept()
    {
        Assert.Equal("a\rb\nc", TextCodec.Decode(Utf8.GetBytes("a\rb\r\nc")).Text);
    }

    [Theory]
    [InlineData(TextEncodingKind.Utf8, false, LineEnding.Lf)]
    [InlineData(TextEncodingKind.Utf8, false, LineEnding.CrLf)]
    [InlineData(TextEncodingKind.Utf8, true, LineEnding.Lf)]
    [InlineData(TextEncodingKind.Utf8, true, LineEnding.CrLf)]
    [InlineData(TextEncodingKind.Utf16LE, true, LineEnding.Lf)]
    [InlineData(TextEncodingKind.Utf16LE, true, LineEnding.CrLf)]
    [InlineData(TextEncodingKind.Utf16BE, true, LineEnding.Lf)]
    [InlineData(TextEncodingKind.Utf16BE, true, LineEnding.CrLf)]
    public void Decode_Encode_RoundTripsCrLfAndBom(TextEncodingKind enc, bool bom, LineEnding le)
    {
        var bytes = TextCodec.Encode("✓ 漢字 🔐\nline2\n", enc, bom, le);
        var d = TextCodec.Decode(bytes);
        Assert.Equal("✓ 漢字 🔐\nline2\n", d.Text);
        Assert.Equal(enc, d.Encoding);
        Assert.Equal(bom, d.Bom);
        Assert.Equal(le, d.LineEnding);
        Assert.Equal(bytes, TextCodec.Encode(d.Text, d.Encoding, d.Bom, d.LineEnding));
    }

    [Fact]
    public void Encode_NewFileDefaults()
    {
        Assert.Equal(Utf8.GetBytes("a\nb"), TextCodec.Encode("a\nb", TextEncodingKind.Utf8, false, LineEnding.Lf));
    }
}
