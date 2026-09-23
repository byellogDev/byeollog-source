using System.Net;
using System.Net.Sockets;
using System.Text;
namespace HurogiCollector;
internal static partial class Program
{
    private static async Task HttpSecurityBoundaryTestsAsync(string root)
    {
        using (var reader = new StringReader("GET /overlay HTTP/1.1\r\nHost: localhost\r\n\r\n"))
        {
            Equal("GET /overlay HTTP/1.1", await ByeollogOverlayService.ReadBoundedHttpLineAsync(reader, 2048, CancellationToken.None), "bounded parser keeps standard request line");
            Equal("Host: localhost", await ByeollogOverlayService.ReadBoundedHttpLineAsync(reader, 16384, CancellationToken.None), "bounded parser keeps standard headers");
            Equal("", await ByeollogOverlayService.ReadBoundedHttpLineAsync(reader, 0, CancellationToken.None), "empty header terminator consumes no budget");
        }
        foreach (var value in new[] { new string('x', 2048) + "\r\n", new string('x', 2048) + "\n" })
            Equal(2048, (await ByeollogOverlayService.ReadBoundedHttpLineAsync(new StringReader(value), 2048, CancellationToken.None))!.Length, "exact request line limit remains accepted");
        var infinite = new InfiniteHttpLine();
        var rejected = false;
        try { await ByeollogOverlayService.ReadBoundedHttpLineAsync(infinite, 2048, CancellationToken.None); }
        catch (InvalidDataException) { rejected = true; }
        True(rejected && infinite.CharactersRead == 2049, "unterminated attacker line stops before unbounded allocation");
        var storage = new CollectorStorage(Path.Combine(root, "security-loopback"));
        using var wallpaper = new WallpaperOverlayState(storage.RootPath, _ => { });
        using var service = new ByeollogOverlayService(storage, new OverlayAssetCache(storage.RootPath), wallpaper, AvailableLoopbackPort());
        True(service.TryStart(), "isolated loopback server starts");
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false, MaxConnectionsPerServer = 8 });
        var normal = await Task.WhenAll(Enumerable.Range(0, 160).Select(async _ => { using var r = await http.GetAsync(service.OverlayUrl + "/health"); return r.StatusCode; }));
        True(normal.All(status => status == HttpStatusCode.OK), "160 ordinary OBS-style polls survive the admission limit");
        var stalled = new List<TcpClient>();
        try
        {
            for (var i = 0; i < 144; i++)
            {
                var client = new TcpClient(); await client.ConnectAsync(IPAddress.Loopback, service.Port); stalled.Add(client);
                await client.GetStream().WriteAsync(Encoding.ASCII.GetBytes("GET /overlay HTTP/1.1\r\nX-Stall: "));
            }
            await Task.Delay(150);
            True(service.ActiveHttpClients <= ByeollogOverlayService.MaximumConcurrentClients, "slow clients cannot create unbounded handlers");
        }
        finally { foreach (var client in stalled) client.Dispose(); }
        for (var i = 0; i < 100 && service.ActiveHttpClients != 0; i++) await Task.Delay(20);
        Equal(0, service.ActiveHttpClients, "disconnected clients release every admission slot");
        using var healthy = await http.GetAsync(service.OverlayUrl + "/health");
        Equal(HttpStatusCode.OK, healthy.StatusCode, "normal OBS polling recovers after synthetic stalled clients");
    }
    private sealed class InfiniteHttpLine : TextReader
    {
        internal int CharactersRead;
        public override ValueTask<int> ReadAsync(Memory<char> buffer, CancellationToken cancellationToken = default)
        { cancellationToken.ThrowIfCancellationRequested(); buffer.Span[0] = 'x'; CharactersRead++; return ValueTask.FromResult(1); }
    }
}
