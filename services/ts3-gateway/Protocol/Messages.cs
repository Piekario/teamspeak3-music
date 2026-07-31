using System.Text.Json.Serialization;

namespace TsMusic.Gateway.Protocol;

/// <summary>
/// The wire contract between the TypeScript backend and this gateway.
///
/// It is deliberately a near-copy of the backend's <c>BotClient</c> port rather than an
/// exposure of TSLib: the backend already speaks in terms of "send a channel message" and
/// "move to channel", and keeping that vocabulary means swapping the transport was a change
/// of adapter, not a change of domain.
///
/// Control travels as JSON over a WebSocket. Audio does not — raw PCM goes over a separate
/// TCP stream, because base64 in JSON would triple the bandwidth of the one thing that is
/// continuous and latency-sensitive.
/// </summary>
public sealed record Request(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("command")] string Command,
    [property: JsonPropertyName("botId")] string? BotId,
    [property: JsonPropertyName("payload")] System.Text.Json.JsonElement? Payload);

public sealed record Response(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("result")] object? Result = null,
    [property: JsonPropertyName("error")] string? Error = null);

public sealed record Event(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("botId")] string BotId,
    [property: JsonPropertyName("payload")] object Payload);

// ─── command payloads ───────────────────────────────────────────────────────

public sealed record CreateBotPayload(
    [property: JsonPropertyName("host")] string Host,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("nickname")] string Nickname,
    [property: JsonPropertyName("serverPassword")] string? ServerPassword,
    [property: JsonPropertyName("channel")] string? Channel,
    [property: JsonPropertyName("channelPassword")] string? ChannelPassword,
    /// <summary>
    /// A previously generated identity, so a bot keeps the same unique id across restarts.
    /// Permissions and server groups are bound to it, so losing it means the bot returns as
    /// a stranger. Omit only on first creation; the gateway then generates one and reports
    /// it back for the caller to persist.
    /// </summary>
    [property: JsonPropertyName("identity")] string? Identity,
    [property: JsonPropertyName("identityOffset")] ulong IdentityOffset);

public sealed record TextPayload(
    [property: JsonPropertyName("text")] string Text);

public sealed record PrivateTextPayload(
    [property: JsonPropertyName("clientId")] ushort ClientId,
    [property: JsonPropertyName("text")] string Text);

public sealed record MoveChannelPayload(
    [property: JsonPropertyName("channelId")] ulong ChannelId,
    [property: JsonPropertyName("password")] string? Password);

public sealed record NicknamePayload(
    [property: JsonPropertyName("nickname")] string Nickname);

/// <summary>Percent, where 100 is unity gain; above that amplifies a quiet source.</summary>
public sealed record VolumePayload(
    [property: JsonPropertyName("volume")] int Volume);

// ─── results and events ─────────────────────────────────────────────────────

public sealed record BotCreatedResult(
    [property: JsonPropertyName("identity")] string Identity,
    [property: JsonPropertyName("identityOffset")] ulong IdentityOffset,
    [property: JsonPropertyName("uid")] string Uid);

public sealed record WhoAmIResult(
    [property: JsonPropertyName("clientId")] ushort ClientId,
    [property: JsonPropertyName("channelId")] ulong ChannelId,
    [property: JsonPropertyName("uid")] string Uid,
    [property: JsonPropertyName("nickname")] string Nickname);

public sealed record ChannelRef(
    [property: JsonPropertyName("id")] ulong Id,
    [property: JsonPropertyName("name")] string Name);

public sealed record ChannelClient(
    [property: JsonPropertyName("clid")] ushort Clid,
    [property: JsonPropertyName("uid")] string Uid,
    [property: JsonPropertyName("nickname")] string Nickname,
    [property: JsonPropertyName("serverGroupIds")] ulong[] ServerGroupIds);

public sealed record IncomingMessageEvent(
    /// <summary>channel | private | poke — mirrors the backend's MessageTarget.</summary>
    [property: JsonPropertyName("target")] string Target,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("senderClientId")] ushort SenderClientId,
    [property: JsonPropertyName("senderUid")] string SenderUid,
    [property: JsonPropertyName("senderNickname")] string SenderNickname);

public sealed record StatusEvent(
    /// <summary>disconnected | connecting | connected | error</summary>
    [property: JsonPropertyName("connection")] string Connection,
    [property: JsonPropertyName("error")] string? Error);
