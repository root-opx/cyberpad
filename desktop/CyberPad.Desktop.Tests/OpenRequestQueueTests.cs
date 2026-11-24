using CyberPad.Desktop.Files;

namespace CyberPad.Desktop.Tests;

public sealed class OpenRequestQueueTests
{
    [Fact]
    public void Queue_IsFifo_AndRefusesThe21st()
    {
        var q = new OpenRequestQueue();
        for (var i = 0; i < OpenRequestQueue.Capacity; i++) Assert.True(q.TryEnqueue($@"C:\n{i}.txt"));
        Assert.False(q.TryEnqueue(@"C:\extra.txt"));
        Assert.Equal(20, q.Count);
        for (var i = 0; i < OpenRequestQueue.Capacity; i++)
        {
            Assert.True(q.TryDequeue(out var p));
            Assert.Equal($@"C:\n{i}.txt", p);
        }
        Assert.False(q.TryDequeue(out _));
        Assert.Equal(0, q.Count);
    }

    [Fact]
    public void Queue_IsThreadSafe()
    {
        var q = new OpenRequestQueue();
        var accepted = 0;
        var threads = Enumerable.Range(0, 8).Select(t => new Thread(() =>
        {
            for (var i = 0; i < 10; i++)
            {
                if (q.TryEnqueue($@"C:\t{t}-{i}.txt")) Interlocked.Increment(ref accepted);
            }
        })).ToList();
        threads.ForEach(t => t.Start());
        threads.ForEach(t => t.Join());
        Assert.Equal(20, q.Count);
        Assert.Equal(20, accepted);
        Assert.Equal(60, 80 - accepted);
    }
}
