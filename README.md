# TeamSpeak 3 Music Bot

Plays YouTube audio into TeamSpeak 3 channels, driven by chat commands, with a web panel for
configuration and live control. Runs **several bots across several TeamSpeak servers** from
one backend.

## Why it is built this way

TeamSpeak's ServerQuery interface cannot transmit audio, so a music bot needs a *real*
TeamSpeak client. This project therefore runs the official headless client in a container,
feeds it a PulseAudio virtual microphone, and pushes audio into that microphone with ffmpeg.

Two consequences shape everything else:

- **The TeamSpeak client is amd64-only.** No arm64 build exists, so on Apple Silicon that one
  container runs emulated. It is deliberately the *only* emulated service — the bot, and
  therefore ffmpeg, stays native and reaches PulseAudio over TCP.
- **Everything goes through ClientQuery, not ServerQuery.** ServerQuery needs a server admin
  login you will not get on someone else's server, cannot see channel chat without moving its
  own client, and bans you for exceeding 10 commands per 3 seconds. ClientQuery has none of
  those problems and speaks as the bot's own identity.

## Requirements

- Docker with **Rosetta** enabled (Docker Desktop → Settings → General → *Use Rosetta for
  x86/amd64 emulation*). Verify with:
  ```bash
  docker run --rm --platform=linux/amd64 debian:bookworm-slim uname -m
  ```
  It must print `x86_64` and return in seconds. Tens of seconds means you are on QEMU.
- Node 22+ and pnpm, for development.

Docker Desktop keeps its CLI inside the app bundle. If `docker` is not on your PATH:
```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

## Quick start

```bash
cp .env.example .env && sed -i '' "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
cp instances.example.json instances.json
```

Edit `instances.json` — one entry per bot. Leave `clientQuery.apiKey` as a placeholder for
now; you will fill it in after the first start.

```bash
pnpm instances:generate
docker compose -f docker-compose.yml -f docker-compose.instances.yml up -d
```

## One-time client bootstrap

Each bot needs a TeamSpeak identity, and the identity lives in the client's own config. That
config volume is the **only state in this project that cannot be rebuilt** — back it up.

Good news, verified against 3.6.2: **the ClientQuery plugin is enabled by default and
generates its own API key on first start.** No GUI clicking is needed to obtain it.

```bash
scripts/read-apikey.sh party
```

Put that value into `instances.json` as `clientQuery.apiKey`, then restart the bot service.

### When you do need the GUI

Some client settings genuinely cannot be reached headlessly, and they matter for audio
quality. Set `enableVnc: true` for the instance, regenerate, restart, then connect a VNC
viewer to `127.0.0.1:5900` (macOS: `open vnc://localhost:5900`).

In the client, set:

| Setting | Value | Why |
|---|---|---|
| Capture device | **BotMic** | The virtual microphone fed by ffmpeg |
| Capture mode | **Continuous transmission** | Voice activation gates out quiet intros |
| Echo cancellation | **off** | Mangles music |
| Echo reduction / denoise | **off** | Same |
| **Automatic voice gain (AGC)** | **off** | Applies its own dynamic gain on top of yours, which makes the volume control feel broken and non-linear |

Also set the bot's channel to the **Opus Music** codec at quality 10 — on a speech codec the
bot will sound muddy no matter what else is right. That is a server-admin action on the
channel, not a client setting.

Then back the volume up and turn VNC off again:

```bash
docker run --rm -v ts3-config-party:/c -v "$PWD":/b alpine tar czf /b/ts3-config-party.tgz -C /c .
```

Keep that archive somewhere safe and out of git. Restoring it is what makes deploying to a
new host a one-minute job instead of repeating this section.

## Adding another bot

Add an entry to `instances.json` with a new `id`, then:

```bash
pnpm instances:generate
docker compose -f docker-compose.yml -f docker-compose.instances.yml up -d
scripts/read-apikey.sh <new-id>
```

Bots are fully independent — separate identity, sink, queue and ClientQuery socket — so two
entries may point at completely unrelated TeamSpeak servers. Budget roughly 300–500 MB of RAM
per bot: each one is a full emulated Qt application.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test          # domain and protocol tests: no Docker, no TeamSpeak required
pnpm typecheck
```

Tests run on Node's native type stripping, so most of the codebase is verifiable without any
infrastructure at all. Two consequences for contributors: source files import each other with
`.ts` extensions (`tsc` rewrites them to `.js` on emit), and **constructor parameter
properties are not usable** — Node's strip-only mode rejects them, so declare fields
explicitly.

## Architecture

Domain-driven, with a one-way dependency rule: the domain knows nothing about Fastify,
SQLite, ffmpeg or TeamSpeak. Everything external enters through a port declared in the domain
and an adapter implemented in infrastructure.

```
packages/backend/src/
├─ contexts/
│  ├─ instances/   Instance config, ClientQuery client, per-bot runtime
│  ├─ playback/    Queue, playback state machine, ffmpeg/yt-dlp/pactl adapters
│  ├─ access/      Roles, permission resolution
│  ├─ catalog/     Playlists, play history
│  └─ chat/        Command parsing, dispatch pipeline, the command set
├─ shared-kernel/  Result, Entity, ValueObject, AggregateRoot, Clock, EventBus
└─ infrastructure/ SQLite schema and repositories
```

A few decisions worth knowing before changing things:

- **Expected failures are `Result` values, not exceptions.** An unhandled throw is therefore
  always a bug, which is what makes the dispatcher's catch-all safe rather than lazy.
- **Playback position is computed, never stored.** Storing it would need a ticker, and a
  ticker drifts. The UI interpolates from a position plus its timestamp.
- **Pause and seek are the same mechanism**: stop ffmpeg, restart it with `-ss`. One code path
  and seek comes free.
- **Identity is the client UID, never the nickname.** Nicknames are changeable; keying
  permissions on them invites impersonation.
- **Playlists are global; identities, permissions and history are per instance.** Two bots on
  two servers share no users, but content is worth sharing.

## Troubleshooting

**The client container is healthy but the bot never appears on the server.** The identity or
the connect settings live in the config volume. Check `docker logs tsmusic-client-<id>`.

**Volume changes feel non-linear or have no effect.** Automatic voice gain is still on in the
client. See the bootstrap table above.

**`yt-dlp` suddenly fails on everything.** YouTube changed extraction. In order of effort:
update yt-dlp (it lives in a volume, no rebuild needed), then supply `YTDLP_COOKIES_FILE`
from a logged-in browser, then try `YTDLP_EXTRACTOR_ARGS`. The bot reports yt-dlp's own error
text in chat precisely so you can tell which of these applies.

**A build of the client image appears to hang for many minutes.** The installer asks for
licence acceptance on stdin and will loop forever without it. The Dockerfile pipes `yes` into
it; if you edit that line, keep the pipe.
