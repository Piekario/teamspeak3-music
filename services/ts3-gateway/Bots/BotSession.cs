using System.Text.Json;
using TSLib;
using TSLib.Audio;
using TSLib.Full;
using TSLib.Helper;
using TsMusic.Gateway.Protocol;

namespace TsMusic.Gateway.Bots;

/// <summary>
/// One bot: a TeamSpeak connection plus the audio pipeline that feeds it.
///
/// This is the piece that removes the container-per-bot cost. Driving the GUI client meant
/// one operating-system-level audio chain per bot — a null sink, a virtual microphone, an X
/// server and an emulated Qt process. Here a bot is an object, its identity is generated in
/// code rather than clicked through a first-run wizard, and its audio is a stream of PCM
/// bytes. Several fit comfortably in one process.
/// </summary>
public sealed class BotSession : IAsyncDisposable
{
    private readonly TsFullClient _client = new();
    private readonly Action<Event> _publish;
    private readonly ILogger _logger;

    /// <summary>
    /// The audio path is push-based, which matches how the data actually arrives: ffmpeg
    /// hands us PCM whenever it has some. Writing it into the encoder makes the encoder push
    /// finished Opus frames to <see cref="VoiceSink"/>, which forwards them to the server.
    /// No polling loop and no buffering of our own.
    /// </summary>
    private EncoderPipe? _encoder;

    public string BotId { get; }
    public IdentityData Identity { get; private set; }
    public string Connection { get; private set; } = "disconnected";

    public BotSession(string botId, IdentityData identity, Action<Event> publish, ILogger logger)
    {
        BotId = botId;
        Identity = identity;
        _publish = publish;
        _logger = logger;

        _client.OnTextMessage += OnTextMessage;
        _client.OnClientPoke += OnClientPoke;
        _client.OnDisconnected += OnDisconnected;
        _client.OnErrorEvent += (_, error) =>
            _logger.LogWarning("bot {BotId}: {Error}", BotId, error.ErrorFormat());
    }

    public async Task<E<string>> ConnectAsync(CreateBotPayload payload)
    {
        SetConnection("connecting", null);

        // Everything on ConnectionDataFull is read-only, so it is built in one shot rather
        // than assembled field by field.
        var connectionData = new ConnectionDataFull(
            address: $"{payload.Host}:{payload.Port}",
            identity: Identity,
            versionSign: TsVersionSigned.VER_LIN_3_X_X,
            username: payload.Nickname,
            serverPassword: Password.FromPlain(payload.ServerPassword ?? string.Empty),
            defaultChannel: payload.Channel ?? string.Empty,
            defaultChannelPassword: Password.FromPlain(payload.ChannelPassword ?? string.Empty));

        var result = await _client.Connect(connectionData);
        if (!result.Ok)
        {
            var message = result.Error.ErrorFormat();
            SetConnection("error", message);
            return message;
        }

        SetConnection("connected", null);
        StartAudio();
        return E<string>.OkR;
    }

    /// <summary>
    /// Opus Music rather than Opus Voice: the voice codecs are mono and tuned for speech,
    /// which is plainly audible on anything with a stereo image.
    /// </summary>
    private void StartAudio()
    {
        _encoder?.Dispose();
        _encoder = new EncoderPipe(Codec.OpusMusic)
        {
            OutStream = new VoiceSink(_client, Codec.OpusMusic),
        };
    }

    /// <summary>Accepts raw 48 kHz stereo s16le PCM, exactly as ffmpeg produces it.</summary>
    public void WriteAudio(Span<byte> pcm)
    {
        // Silently ignoring audio for a bot that is not connected is deliberate: ffmpeg may
        // still be draining a buffer while the bot drops, and that is not an error worth
        // logging on every frame.
        _encoder?.Write(pcm, null);
    }

    /// <summary>
    /// Terminates the encoder chain: hands finished Opus frames to the TeamSpeak connection.
    /// </summary>
    private sealed class VoiceSink(TsFullClient client, Codec codec) : IAudioPassiveConsumer
    {
        public bool Active => client.Connected;

        public void Write(Span<byte> data, Meta? meta)
        {
            if (!client.Connected) return;
            client.SendAudio(data, codec);
        }
    }

    public Task<E<string>> SendChannelMessageAsync(string text) =>
        DescribeAsync(_client.SendMessage(text, TextMessageTargetMode.Channel, 0));

    public Task<E<string>> SendPrivateMessageAsync(ushort clientId, string text) =>
        DescribeAsync(_client.SendMessage(text, TextMessageTargetMode.Private, clientId));

    public Task<E<string>> MoveToChannelAsync(ulong channelId, string? password) =>
        DescribeAsync(_client.ClientMove(_client.ClientId, (ChannelId)channelId, password));

    public Task<E<string>> SetNicknameAsync(string nickname) =>
        DescribeAsync(_client.ChangeName(nickname));

    /// <summary>
    /// Collapses TSLib's command result into a plain error string for the wire. Every command
    /// is asynchronous — TSLib's `CmdR` is an alias for Task&lt;E&lt;CommandError&gt;&gt;.
    /// </summary>
    private static async Task<E<string>> DescribeAsync(Task<E<TSLib.Messages.CommandError>> pending)
    {
        var result = await pending;
        return result.Ok ? E<string>.OkR : result.Error.ErrorFormat();
    }

    // ─── events out ─────────────────────────────────────────────────────────

    private void OnTextMessage(object? sender, IEnumerable<TSLib.Messages.TextMessage> messages)
    {
        foreach (var message in messages)
        {
            // The bot hears its own messages; answering them would loop.
            if (message.InvokerId == _client.ClientId) continue;

            _publish(new Event("message", BotId, new IncomingMessageEvent(
                Target: message.Target == TextMessageTargetMode.Private ? "private" : "channel",
                Text: message.Message ?? string.Empty,
                SenderClientId: message.InvokerId.Value,
                SenderUid: message.InvokerUid?.Value ?? string.Empty,
                SenderNickname: message.InvokerName ?? string.Empty)));
        }
    }

    private void OnClientPoke(object? sender, IEnumerable<TSLib.Messages.ClientPoke> pokes)
    {
        foreach (var poke in pokes)
        {
            _publish(new Event("message", BotId, new IncomingMessageEvent(
                Target: "poke",
                Text: poke.Message ?? string.Empty,
                SenderClientId: poke.InvokerId.Value,
                SenderUid: poke.InvokerUid?.Value ?? string.Empty,
                SenderNickname: poke.InvokerName ?? string.Empty)));
        }
    }

    private void OnDisconnected(object? sender, DisconnectEventArgs args)
        => SetConnection("disconnected", args.Error?.ErrorFormat());

    private void SetConnection(string state, string? error)
    {
        Connection = state;
        _publish(new Event("status", BotId, new StatusEvent(state, error)));
    }

    public async ValueTask DisposeAsync()
    {
        _encoder?.Dispose();
        await _client.Disconnect();
        _client.Dispose();
    }
}
