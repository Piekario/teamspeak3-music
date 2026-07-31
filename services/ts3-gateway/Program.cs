using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using TsMusic.Gateway.Bots;
using TsMusic.Gateway.Protocol;

// The gateway holds every bot in one process. Control arrives as JSON over a WebSocket;
// audio arrives as raw PCM on a separate TCP port, one connection per bot, because putting a
// continuous 1.5 Mbit/s stereo stream through base64-in-JSON would be wasteful and jittery.

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<BotRegistry>();
builder.Logging.AddSimpleConsole(options => options.SingleLine = true);

var app = builder.Build();
app.UseWebSockets();

var registry = app.Services.GetRequiredService<BotRegistry>();
var logger = app.Services.GetRequiredService<ILogger<Program>>();
var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

app.MapGet("/health", () => Results.Ok(new { status = "ok", bots = registry.BotIds.Count }));

app.Map("/control", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var sendLock = new SemaphoreSlim(1, 1);

    async void Publish(Event botEvent)
    {
        // Events originate on TSLib's threads, so sends are serialised. A failure here means
        // the backend went away; the bots keep running and it will resubscribe.
        try
        {
            await sendLock.WaitAsync();
            try
            {
                if (socket.State != WebSocketState.Open) return;
                var json = JsonSerializer.SerializeToUtf8Bytes(botEvent, jsonOptions);
                await socket.SendAsync(json, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            finally { sendLock.Release(); }
        }
        catch (Exception error)
        {
            logger.LogDebug(error, "dropping event for a closed control socket");
        }
    }

    async Task SendAsync(object payload)
    {
        await sendLock.WaitAsync();
        try
        {
            if (socket.State != WebSocketState.Open) return;
            await socket.SendAsync(
                JsonSerializer.SerializeToUtf8Bytes(payload, jsonOptions),
                WebSocketMessageType.Text, true, CancellationToken.None);
        }
        finally { sendLock.Release(); }
    }

    var buffer = new byte[32 * 1024];
    while (socket.State == WebSocketState.Open)
    {
        var received = await socket.ReceiveAsync(buffer, CancellationToken.None);
        if (received.MessageType == WebSocketMessageType.Close) break;

        var raw = Encoding.UTF8.GetString(buffer, 0, received.Count);

        // Handled off the read loop, deliberately. Connecting a bot to a TeamSpeak server
        // takes seconds, and awaiting it here made every other bot's request queue behind it:
        // with two bots the second one's create waited out the first one's connect, timed
        // out, retried, and the backlog only ever grew. Responses carry the request id, so
        // they need no ordering — only the socket writes do, and the lock already serialises
        // those.
        _ = Task.Run(async () =>
        {
            Response response;
            try
            {
                var request = JsonSerializer.Deserialize<Request>(raw, jsonOptions)
                              ?? throw new InvalidOperationException("empty request");
                response = await HandleAsync(request, registry, Publish, jsonOptions);
            }
            catch (Exception error)
            {
                logger.LogWarning(error, "control request failed");
                response = new Response("unknown", false, Error: error.Message);
            }

            try
            {
                await SendAsync(response);
            }
            catch (Exception error)
            {
                logger.LogDebug(error, "dropping a response for a closed control socket");
            }
        });
    }
});

// ─── PCM ingest ─────────────────────────────────────────────────────────────
// One TCP connection per bot. The first line is the bot id; everything after it is raw
// 48 kHz stereo s16le PCM, exactly what `ffmpeg -f s16le` writes.
var audioPort = int.TryParse(Environment.GetEnvironmentVariable("AUDIO_PORT"), out var port)
    ? port
    : 8477;

var audioListener = new TcpListener(IPAddress.Any, audioPort);
audioListener.Start();
logger.LogInformation("PCM ingest listening on {Port}", audioPort);

_ = Task.Run(async () =>
{
    while (true)
    {
        var client = await audioListener.AcceptTcpClientAsync();
        _ = Task.Run(() => ReceiveAudioAsync(client, registry, logger));
    }
});

app.Run();

// ─── handlers ───────────────────────────────────────────────────────────────

static async Task<Response> HandleAsync(
    Request request,
    BotRegistry registry,
    Action<Event> publish,
    JsonSerializerOptions options)
{
    T Payload<T>() => request.Payload is { } element
        ? element.Deserialize<T>(options) ?? throw new InvalidOperationException("bad payload")
        : throw new InvalidOperationException($"{request.Command} needs a payload");

    BotSession Session() => registry.Find(request.BotId ?? string.Empty)
        ?? throw new InvalidOperationException($"no bot '{request.BotId}'");

    switch (request.Command)
    {
        case "bot.create":
        {
            var result = await registry.CreateAsync(
                request.BotId ?? throw new InvalidOperationException("botId required"),
                Payload<CreateBotPayload>(),
                publish);
            return new Response(request.Id, true, result);
        }

        case "bot.destroy":
            await registry.RemoveAsync(request.BotId ?? string.Empty);
            return new Response(request.Id, true);

        case "bot.sendChannelMessage":
        {
            var sent = await Session().SendChannelMessageAsync(Payload<TextPayload>().Text);
            return Reply(request.Id, sent);
        }

        case "bot.sendPrivateMessage":
        {
            var payload = Payload<PrivateTextPayload>();
            var sent = await Session().SendPrivateMessageAsync(payload.ClientId, payload.Text);
            return Reply(request.Id, sent);
        }

        case "bot.moveToChannel":
        {
            var payload = Payload<MoveChannelPayload>();
            var moved = await Session().MoveToChannelAsync(payload.ChannelId, payload.Password);
            return Reply(request.Id, moved);
        }

        case "bot.setNickname":
        {
            var renamed = await Session().SetNicknameAsync(Payload<NicknamePayload>().Nickname);
            return Reply(request.Id, renamed);
        }

        // Reads come from TSLib's local book, so they cost nothing on the wire — but they are
        // still marshalled onto the bot's scheduler, since the book is mutated there.
        case "bot.whoami":
            return new Response(request.Id, true, await Session().WhoAmIAsync());

        case "bot.currentChannel":
            return new Response(request.Id, true, await Session().CurrentChannelAsync());

        case "bot.listChannels":
            return new Response(request.Id, true, await Session().ListChannelsAsync());

        case "bot.listChannelClients":
            return new Response(request.Id, true, await Session().ListChannelClientsAsync());

        case "bot.status":
            return new Response(request.Id, true, new StatusEvent(Session().Connection, null));

        case "bot.setVolume":
            Session().SetVolume(Payload<VolumePayload>().Volume);
            return new Response(request.Id, true);

        default:
            return new Response(request.Id, false, Error: $"unknown command '{request.Command}'");
    }
}

static Response Reply(string id, E<string> outcome) =>
    outcome.Ok ? new Response(id, true) : new Response(id, false, Error: outcome.Error);

static async Task ReceiveAudioAsync(TcpClient client, BotRegistry registry, ILogger logger)
{
    using (client)
    {
        await using var stream = client.GetStream();

        // The bot id arrives as the first newline-terminated line.
        var header = new List<byte>(64);
        var single = new byte[1];
        while (await stream.ReadAsync(single) == 1 && single[0] != (byte)'\n')
        {
            header.Add(single[0]);
            if (header.Count > 128) return;
        }

        var botId = Encoding.UTF8.GetString(header.ToArray()).Trim();
        var session = registry.Find(botId);
        if (session is null)
        {
            logger.LogWarning("audio stream for unknown bot '{BotId}'", botId);
            return;
        }

        logger.LogInformation("audio stream attached to bot {BotId}", botId);
        var buffer = new byte[3840]; // 20 ms of 48 kHz stereo s16le
        try
        {
            int read;
            while ((read = await stream.ReadAsync(buffer)) > 0)
            {
                session.WriteAudio(buffer.AsSpan(0, read));
            }
        }
        catch (IOException)
        {
            // ffmpeg exited or was killed for a skip — an ordinary end, not a fault.
        }
        finally
        {
            logger.LogInformation("audio stream for bot {BotId} ended", botId);
        }
    }
}
