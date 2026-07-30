using System.Collections.Concurrent;
using TSLib.Full;
using TsMusic.Gateway.Protocol;

namespace TsMusic.Gateway.Bots;

/// <summary>
/// Every bot in the process, addressed by the id the backend gave it.
///
/// This is the whole of the "no container per bot" claim: adding a bot allocates an object,
/// not an operating system.
/// </summary>
public sealed class BotRegistry(ILogger<BotRegistry> logger)
{
    private readonly ConcurrentDictionary<string, BotSession> _sessions = new();

    public IReadOnlyCollection<string> BotIds => _sessions.Keys.ToArray();

    public BotSession? Find(string botId) => _sessions.GetValueOrDefault(botId);

    /// <summary>
    /// Creates a bot, reusing a stored identity when one is supplied.
    ///
    /// The identity is the bot's permanent name on a TeamSpeak server — server groups and
    /// permissions hang off it — so the caller is handed it back to persist. Generating a
    /// fresh one on every start would make the bot a stranger after each restart, losing
    /// every permission an admin had granted it.
    /// </summary>
    public async Task<BotCreatedResult> CreateAsync(
        string botId,
        CreateBotPayload payload,
        Action<Event> publish)
    {
        await RemoveAsync(botId);

        var identity = ResolveIdentity(payload);
        var session = new BotSession(botId, identity, publish, logger);
        _sessions[botId] = session;

        var connected = await session.ConnectAsync(payload);
        if (!connected.Ok)
        {
            logger.LogWarning("bot {BotId} failed to connect: {Error}", botId, connected.Error);
        }

        return new BotCreatedResult(
            Identity: identity.PublicAndPrivateKeyString,
            IdentityOffset: identity.ValidKeyOffset,
            Uid: identity.ClientUid.Value);
    }

    private static IdentityData ResolveIdentity(CreateBotPayload payload)
    {
        if (!string.IsNullOrWhiteSpace(payload.Identity))
        {
            var loaded = TsCrypt.LoadIdentityDynamic(payload.Identity, payload.IdentityOffset);
            if (loaded.Ok) return loaded.Value;
        }

        // securityLevel 8 is what the official client uses by default. Higher levels take
        // exponentially longer to compute and only matter on servers that demand them.
        return TsCrypt.GenerateNewIdentity(8);
    }

    public async Task<bool> RemoveAsync(string botId)
    {
        if (!_sessions.TryRemove(botId, out var session)) return false;
        await session.DisposeAsync();
        return true;
    }

    public async Task DisposeAllAsync()
    {
        foreach (var botId in BotIds) await RemoveAsync(botId);
    }
}
