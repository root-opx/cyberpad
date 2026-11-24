using System.Diagnostics;
using System.IO.Pipes;
using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Tests;

public sealed class FileHandoffTests
{
    private static string NewId() => "test-" + Guid.NewGuid().ToString("N");

    private static bool WaitFor(Func<bool> condition, int ms = 5000)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            if (condition()) return true;
            Thread.Sleep(10);
        }
        return condition();
    }

    [Fact]
    public void PipeName_IsPrefixedWithTheId() => Assert.Equal("CyberPad-S-1-5-21", FileHandoff.PipeName("S-1-5-21"));

    [Fact]
    public void Handoff_DeliversOneValidPath()
    {
        var id = NewId();
        var got = new List<string>();
        using var server = new FileHandoffServer(id, p => { lock (got) got.Add(p); });

        Assert.True(FileHandoff.TrySend(id, @"C:\n\a.md", TimeSpan.FromSeconds(3)));
        Assert.True(WaitFor(() => { lock (got) return got.Count == 1; }));
        lock (got) Assert.Equal(@"C:\n\a.md", got[0]);
    }

    [Fact]
    public void Handoff_RejectsInvalidPath_AndKeepsServing()
    {
        var id = NewId();
        var got = new List<string>();
        using var server = new FileHandoffServer(id, p => { lock (got) got.Add(p); });

        Assert.True(FileHandoff.TrySend(id, @"C:\x.exe", TimeSpan.FromSeconds(3)));
        Assert.True(FileHandoff.TrySend(id, @"C:\n\ok.txt", TimeSpan.FromSeconds(3)));
        Assert.True(WaitFor(() => { lock (got) return got.Count >= 1; }));
        Thread.Sleep(100);
        lock (got) Assert.Equal(new[] { @"C:\n\ok.txt" }, got);
    }

    [Fact]
    public void Handoff_DropsOversizedMessage_AndKeepsServing()
    {
        var id = NewId();
        var got = new List<string>();
        using var server = new FileHandoffServer(id, p => { lock (got) got.Add(p); });

        using (var raw = new NamedPipeClientStream(".", FileHandoff.PipeName(id), PipeDirection.Out))
        {
            raw.Connect(3000);
            try
            {
                var big = new byte[200_000];
                Array.Fill(big, (byte)'a');
                raw.Write(big, 0, big.Length);
                raw.Flush();
            }
            catch (IOException)
            {
                // The server may drop the connection mid-write; that is the expected outcome.
            }
        }

        Assert.True(FileHandoff.TrySend(id, @"C:\n\next.md", TimeSpan.FromSeconds(3)));
        Assert.True(WaitFor(() => { lock (got) return got.Count >= 1; }));
        lock (got) Assert.Equal(new[] { @"C:\n\next.md" }, got);
    }

    [Fact]
    public void Handoff_DropsInvalidUtf8AndNul_AndKeepsServing()
    {
        var id = NewId();
        var got = new List<string>();
        using var server = new FileHandoffServer(id, p => { lock (got) got.Add(p); });

        foreach (var bytes in new[] { new byte[] { 0xFF, 0xFE, 0xFD }, "C:\n\a\0.txt"u8.ToArray() })
        {
            using var raw = new NamedPipeClientStream(".", FileHandoff.PipeName(id), PipeDirection.Out);
            raw.Connect(3000);
            raw.Write(bytes, 0, bytes.Length);
        }

        Assert.True(FileHandoff.TrySend(id, @"C:\n\good.txt", TimeSpan.FromSeconds(3)));
        Assert.True(WaitFor(() => { lock (got) return got.Count >= 1; }));
        lock (got) Assert.Equal(new[] { @"C:\n\good.txt" }, got);
    }

    [Fact]
    public void TrySend_NoServer_ReturnsFalseWithinTimeout()
    {
        var sw = Stopwatch.StartNew();
        Assert.False(FileHandoff.TrySend(NewId(), @"C:\n\a.md", TimeSpan.FromSeconds(3)));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3.5), $"took {sw.Elapsed}");
    }

    [Fact]
    public void Dispose_ReturnsPromptly_AndIsIdempotent()
    {
        var server = new FileHandoffServer(NewId(), _ => { });
        var sw = Stopwatch.StartNew();
        server.Dispose();
        server.Dispose();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"took {sw.Elapsed}");
    }

    [Fact]
    public void Dispose_WhileAClientIsStalled_ReturnsPromptly()
    {
        var id = NewId();
        var server = new FileHandoffServer(id, _ => { });
        using var raw = new NamedPipeClientStream(".", FileHandoff.PipeName(id), PipeDirection.Out);
        raw.Connect(3000); // connected, sends nothing
        Thread.Sleep(100);
        var sw = Stopwatch.StartNew();
        server.Dispose();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"took {sw.Elapsed}");
    }
}
