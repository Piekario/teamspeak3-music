using System.Text.Json;
using TSLib;
using TSLib.Audio;
using TSLib.Full;
using TSLib.Helper;
using TSLib.Scheduler;
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
    /// <summary>
    /// TSLib is not thread-agnostic: every connection and command must run on the client's
    /// own scheduler thread, and calling from anywhere else throws
    /// <c>TaskSchedulerException: Cannot call from an outside thread</c> rather than working
    /// by accident. Each bot therefore owns a scheduler and marshals its calls onto it.
    ///
    /// <see cref="TsFullClient.SendAudio"/> is the deliberate exception — it does not verify
    /// the thread, because audio arrives from a separate pipeline by design.
    /// </summary>
    private readonly DedicatedTaskScheduler _scheduler;
    private readonly TsFullClient _client;
    private readonly Action<Event> _publish;
    private readonly ILogger _logger;

    /// <summary>
    /// The audio path is push-based, which matches how the data actually arrives: ffmpeg
    /// hands us PCM whenever it has some. Writing it into the encoder makes the encoder push
    /// finished Opus frames to <see cref="VoiceSink"/>, which forwards them to the server.
    /// No polling loop and no buffering of our own.
    /// </summary>
    private EncoderPipe? _encoder;

    /// <summary>
    /// Applied to raw samples before encoding.
    ///
    /// On the PulseAudio transport volume was a sink setting, which made it instant and free.
    /// Here it has to live in the pipeline, so it is placed ahead of the encoder: scaling
    /// PCM is cheap and correct, whereas re-encoding to change level would not be.
    /// </summary>
    private VolumePipe? _volume;

    public string BotId { get; }
    public IdentityData Identity { get; private set; }
    public string Connection { get; private set; } = "disconnected";

    public BotSession(string botId, IdentityData identity, Action<Event> publish, ILogger logger)
    {
        BotId = botId;
        Identity = identity;
        _publish = publish;
        _logger = logger;

        _scheduler = new DedicatedTaskScheduler(Id.Null);
        _client = new TsFullClient(_scheduler);

        _client.OnTextMessage += OnTextMessage;
        _client.OnClientPoke += OnClientPoke;
        _client.OnDisconnected += OnDisconnected;
        _client.OnErrorEvent += (_, error) =>
            _logger.LogWarning("bot {BotId}: {Error}", BotId, error.ErrorFormat());
    }

    /// <summary>The port a TeamSpeak server uses unless it says otherwise.</summary>
    private const int DefaultVoicePort = 9987;

    public async Task<E<string>> ConnectAsync(CreateBotPayload payload)
    {
        SetConnection("connecting", null);

        // The default port is left off the address rather than spelled out. TSLib resolves a
        // hostname through SRV and TSDNS — which is how hosted servers publish the port they
        // really run on — but an explicit port in the address overrides whatever that lookup
        // returns. Sending ":9987" therefore silently talked to the wrong port on every
        // server that is not on the default one, and the connect simply never completed.
        var address = payload.Port == DefaultVoicePort
            ? payload.Host
            : $"{payload.Host}:{payload.Port}";

        // Everything on ConnectionDataFull is read-only, so it is built in one shot rather
        // than assembled field by field.
        var connectionData = new ConnectionDataFull(
            address: address,
            identity: Identity,
            versionSign: TsVersionSigned.VER_LIN_3_X_X,
            username: payload.Nickname,
            serverPassword: Password.FromPlain(payload.ServerPassword ?? string.Empty),
            defaultChannel: payload.Channel ?? string.Empty,
            defaultChannelPassword: Password.FromPlain(payload.ChannelPassword ?? string.Empty));

        var result = await _scheduler.InvokeAsync(() => _client.Connect(connectionData));
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

        // PCM in → volume → Opus encoder → server.
        _encoder = new EncoderPipe(Codec.OpusMusic)
        {
            OutStream = new VoiceSink(_client, Codec.OpusMusic),
        };
        _volume = new VolumePipe { OutStream = _encoder, Volume = _requestedVolume };
    }

    /// <summary>Accepts raw 48 kHz stereo s16le PCM, exactly as ffmpeg produces it.</summary>
    public void WriteAudio(Span<byte> pcm)
    {
        // Silently ignoring audio for a bot that is not connected is deliberate: ffmpeg may
        // still be draining a buffer while the bot drops, and that is not an error worth
        // logging on every frame.
        _volume?.Write(pcm, null);
    }

    private float _requestedVolume = 0.4f;

    /// <summary>
    /// Sets playback level. The domain speaks in percent, where 100 is unity gain and values
    /// above it amplify — quiet sources genuinely need that headroom.
    /// </summary>
    public void SetVolume(int percent)
    {
        _requestedVolume = Math.Clamp(percent, 0, 150) / 100f;
        if (_volume is not null) _volume.Volume = _requestedVolume;
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
        DescribeAsync(() => _client.SendMessage(text, TextMessageTargetMode.Channel, 0));

    public Task<E<string>> SendPrivateMessageAsync(ushort clientId, string text) =>
        DescribeAsync(() => _client.SendMessage(text, TextMessageTargetMode.Private, clientId));

    public Task<E<string>> MoveToChannelAsync(ulong channelId, string? password) =>
        DescribeAsync(() => _client.ClientMove(_client.ClientId, (ChannelId)channelId, password));

    public Task<E<string>> SetNicknameAsync(string nickname) =>
        DescribeAsync(() => _client.ChangeName(nickname));

    /// <summary>
    /// Collapses TSLib's command result into a plain error string for the wire. Every command
    /// is asynchronous — TSLib's `CmdR` is an alias for Task&lt;E&lt;CommandError&gt;&gt;.
    /// </summary>
    private async Task<E<string>> DescribeAsync(Func<Task<E<TSLib.Messages.CommandError>>> command)
    {
        // Marshalled onto the scheduler: sending a command ultimately reaches code that
        // verifies the calling thread.
        var result = await _scheduler.InvokeAsync(command);
        return result.Ok ? E<string>.OkR : result.Error.ErrorFormat();
    }

    /// <summary>
    /// Reads the connection book on its owning thread. The book is mutated as notifications
    /// arrive, so reading it from a request thread would be a race even where TSLib does not
    /// explicitly reject it.
    /// </summary>
    private Task<T> ReadAsync<T>(Func<T> read) => _scheduler.Invoke(read);

    // ─── reads ──────────────────────────────────────────────────────────────
    //
    // These come from TSLib's book — a live mirror of the server the client maintains from
    // the notifications it receives. No round-trip is needed, which is a real improvement on
    // the ClientQuery transport, where every `clientlist` was a request over a socket that
    // could be in flight while a command was waiting.

    public Task<WhoAmIResult> WhoAmIAsync() => ReadAsync(() =>
    {
        var self = _client.Book.Self();
        return new WhoAmIResult(
            ClientId: _client.ClientId.Value,
            ChannelId: self?.Channel.Value ?? 0,
            Uid: Identity.ClientUid.Value,
            Nickname: self?.Name ?? string.Empty);
    });

    public Task<ChannelRef?> CurrentChannelAsync() => ReadAsync(() =>
    {
        var channel = _client.Book.CurrentChannel();
        return channel is null ? null : new ChannelRef(channel.Id.Value, channel.Name);
    });

    public Task<ChannelRef[]> ListChannelsAsync() => ReadAsync(() =>
        _client.Book.Channels.Values
            .Select(channel => new ChannelRef(channel.Id.Value, channel.Name))
            .ToArray());

    /// <summary>
    /// Clients in the bot's own channel, with their server groups — the input the permission
    /// resolver needs to map a person to a role.
    /// </summary>
    public Task<ChannelClient[]> ListChannelClientsAsync() => ReadAsync(() =>
    {
        var ownChannel = _client.Book.Self()?.Channel;
        if (ownChannel is null) return [];

        return _client.Book.Clients.Values
            .Where(client => client.Channel == ownChannel)
            .Select(client => new ChannelClient(
                Clid: client.Id.Value,
                Uid: client.Uid?.Value ?? string.Empty,
                Nickname: client.Name,
                ServerGroupIds: client.ServerGroups.Select(group => group.Value).ToArray()))
            .ToArray();
    });

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

        // Disconnect also verifies the calling thread, so it goes through the scheduler like
        // everything else. Tearing the scheduler down first would leave the connection open.
        try
        {
            await _scheduler.InvokeAsync(() => _client.Disconnect());
        }
        catch (Exception error)
        {
            _logger.LogDebug(error, "bot {BotId}: disconnect failed during teardown", BotId);
        }

        _client.Dispose();
        _scheduler.Dispose();
    }
}
