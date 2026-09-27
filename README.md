# TeamSpeak 3 Music Bot

Plays YouTube audio into TeamSpeak 3 channels, driven by chat commands, with a web panel for
configuration and live control. Runs **several bots across several TeamSpeak servers** from
one backend.

## Why it is built this way

TeamSpeak's ServerQuery interface cannot transmit audio, so a music bot needs a *real*
TeamSpeak client identity. Rather than running the official GUI client in a container per bot
(amd64-only, needs a virtual display and a PulseAudio sink), every bot's connection is held by
one gateway process — a small .NET service built on [TSLib](vendor/TS3AudioBot), the library
behind TS3AudioBot. Control (join, move, chat, notifications) travels as JSON over a
WebSocket; PCM audio travels separately over a raw TCP socket, one per bot.

The practical upshot: creating a bot through the panel needs no second container, no VNC
bootstrap and no manual configuration step — the gateway just opens another connection. The
gateway image is also multi-arch, since nothing about it is architecture-bound the way the Qt
client was.

A ClientQuery-based transport (driving an actual GUI client, as above) still exists in the
backend as an alternate mode — set `TS3_TRANSPORT=clientquery` — for cases where running a
real client is preferable, but it is not the default and needs its own container image, which
this repository no longer builds for you.

## Requirements

- Docker.
- Node 22+ and pnpm, for development.
- If building the gateway image from source (rather than pulling from GHCR), the TSLib
  submodule must be checked out:
  ```bash
  git submodule update --init --recursive
  ```

## Quick start

```bash
git submodule update --init --recursive
cp .env.example .env && sed -i '' "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d
```

Open the panel (`http://localhost:8081` by default) and sign in with `ADMIN_TOKEN`. Create
your first bot from there — see **Panel access** below for the token model, and **Adding
another bot** for what a bot needs.

## Adding another bot

Bots are created and configured entirely through the panel: **Create bot**, fill in the
TeamSpeak server, port, nickname and an identifier, save. No container, no restart and no
manual key extraction — the gateway opens the new connection as soon as the bot is enabled.

Bots are fully independent — separate identity, queue and permissions — so two bots may point
at completely unrelated TeamSpeak servers. Set the bot's channel to the **Opus Music** codec
at quality 10 on the TeamSpeak server side; on a speech codec the bot sounds muddy no matter
what else is right.

Instances can also be seeded from a file instead of the panel — see `instances.example.json`
— which is mainly useful for scripted deployments or the `clientquery` transport.

## Publishing the panel through a Cloudflare tunnel

The panel is served by the `web` container, which also proxies `/api` and `/ws` to the bot —
so a tunnel needs exactly one target and the browser stays on a single origin.

`cloudflared` dials out to Cloudflare and traffic returns down that connection. Nothing
listens on the public internet here and the router needs no port forwarding, which is the
point: the machine stays as closed as it was before.

1. In the Cloudflare Zero Trust dashboard: **Networks → Tunnels → Create a tunnel →
   Cloudflared**. Name it, and copy the token from the install command it shows.
2. On the tunnel's **Public Hostname** tab, add the hostname you want (`bot.example.com`),
   service type **HTTP**, URL **`web:80`**. That name is the container's, resolved on the
   compose network — not a hostname of this machine.
3. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, then:

```
docker compose --profile tunnel up -d
```

The service sits behind a compose profile, so the stack runs unchanged when you are not
using it.

Consider putting Cloudflare Access in front as well. Panel access below is per person and
role-bound, which is the substantive control; Access adds an identity check *before* a
request ever reaches the panel, and gives you a record of who opened it. Zero Trust → Access
→ Applications, self-hosted, one email policy is enough, and it costs nothing at this scale.

## Panel access

`ADMIN_TOKEN` is the operator credential. It comes from the environment, it is always an
owner, it is never listed in the UI and it cannot be revoked from the panel — that is what
makes it the way back in when everything else has been revoked. It is not meant to be
handed to anybody else.

Everyone else gets their own token, issued from **Settings → Panel access**, with a role and
optionally a single bot:

| Role | May |
|---|---|
| `user` | queue tracks, load playlists, watch the queue |
| `dj` | all of the above, plus skip, pause, stop, seek, volume, shuffle, clear, and edit playlists |
| `owner` | all of the above, plus bot settings, creating and deleting bots, and issuing access |

They are the same four roles the chat commands use, applied to the same actions: `!skip` is a
DJ command, so the skip button is a DJ button. One permission model, not two that drift apart
the first time somebody is promoted in one and forgotten in the other.

Signing in exchanges the token for a session cookie the server sets. Nobody has to keep the
token anywhere or type it again on that browser, and because the cookie is `HttpOnly` a
script that manages to run on the panel cannot read it — which it could when the token lived
in `localStorage`. `SameSite=Strict` is what makes an automatically-attached cookie safe:
without it, any other site could issue commands as whoever is signed in. It also lets the
live socket stop carrying the credential in its query string, where it was landing in every
access log between the browser and the bot.

The bearer header still works, so scripts and `curl` need no session:

```
curl -H "Authorization: Bearer $TOKEN" https://bot.example.com/api/instances
```

Two details worth knowing:

- **A token is shown once.** Only its hash is stored, so nothing in the panel or the database
  can produce it again. Lost means reissued, not recovered.
- **A token scoped to one bot is told the others do not exist.** It sees one bot in the list,
  and a request aimed at another gets a 404 rather than a 403 — a 403 would confirm which ids
  are real.

Routes that nobody has written a policy rule for require `owner`. That is deliberate: a new
endpoint is unreachable until somebody decides who may reach it, which is annoying for
whoever adds it and much better than an endpoint that is quietly open to everyone.

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

Running the backend directly with `pnpm dev:backend` (rather than through `docker compose`,
which sets it explicitly) gets `TS3_TRANSPORT=clientquery`, not `gateway` — that variable's
own code-level default is `clientquery`; only `docker-compose.yml` overrides it to `gateway`.
Set it yourself if you're testing the gateway path outside compose.

## Architecture

Domain-driven, with a one-way dependency rule: the domain knows nothing about Fastify,
SQLite, ffmpeg or TeamSpeak. Everything external enters through a port declared in the domain
and an adapter implemented in infrastructure.

```
packages/backend/src/
├─ contexts/
│  ├─ instances/   Instance config, gateway/ClientQuery transports, per-bot runtime
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
- **Playlists, identities, permissions and history are all per instance.** A preset is tied to
  a room's taste and to the server groups allowed to load it; a bot offering another
  community's playlists would be noise rather than a feature.

## Troubleshooting

**A bot never appears on the server.** Check `docker logs tsmusic-gateway` — it holds every
bot's connection, so a bad host, a wrong server password or a rejected identity shows up
there rather than in the bot service's own log.

**The bot is connected and the queue is playing, but nobody hears anything (`clientquery`
transport only).** Check that the bot's output is not muted — TeamSpeak mutes the microphone
along with the speakers, so an output-muted bot transmits nothing while looking perfectly
healthy. The client plays into `bot_void`, a sink whose monitor feeds nothing, so the bot
cannot relay other people's voices even unmuted. Note that `client_flag_talking` is not a
reliable check here — it was observed reading `0` while audio was genuinely being
transmitted; trust your ears, or `pactl list sink-inputs`. This whole class of problem does
not exist on the `gateway` transport: muting is a no-op there, correctly, since a TSLib bot
has no speakers to mute in the first place.

**"That one is 18+".** YouTube serves age-restricted videos only to a signed-in account that
has been age-verified, and there is no way around that from an anonymous client — not a
proxy, not a PO token, not an extractor argument. The bot needs cookies from such an account:

```
YTDLP_COOKIES_FILE=./cookies.txt
```

pointing at a Netscape-format export, which compose mounts read-only into the container. The
easiest way to produce one:

```
yt-dlp --cookies-from-browser firefox --cookies cookies.txt --skip-download https://youtu.be/dQw4w9WgXcQ
```

Use an account you are willing to lose — this pattern gets accounts rate-limited — and expect
to re-export when the cookies expire. The bot names this case specifically in chat rather than
reporting a generic refusal, because the remedy is different from every other block.

**`yt-dlp` suddenly fails on everything.** YouTube changed extraction. In order of effort:
update yt-dlp (it lives in a volume, no rebuild needed), then supply `YTDLP_COOKIES_FILE`
from a logged-in browser, then try `YTDLP_EXTRACTOR_ARGS`. The bot reports yt-dlp's own error
text in chat precisely so you can tell which of these applies.

## Running on a datacenter IP

A home connection generally passes. A VPS — Hetzner, OVH, DigitalOcean — very often does not:
YouTube answers "Sign in to confirm you're not a bot" on a large share of datacenter ranges.
Plan for this before deploying rather than after.

**The constraint that shapes every workaround:** a `googlevideo` media URL is bound to the IP
that requested it. Resolving from a clean address and streaming from the server does not
work — the stream returns 403 on a URL that looks perfectly fresh. Whatever you do must apply
to *both* the metadata call and the media fetch, which is why `YTDLP_PROXY` configures them
together rather than exposing two settings that could disagree.

Three levers, strongest first:

| Lever | Setting | Trade-off |
|---|---|---|
| Egress proxy | `YTDLP_PROXY=socks5://host:1080` | Most effective, no account involved. Needs a proxy whose IP YouTube trusts — a residential/mobile proxy, or a tunnel back to a connection that already works. All audio traffic flows through it, so bandwidth and latency are real considerations. |
| Cookies | `YTDLP_COOKIES_FILE=/data/cookies.txt` | Very effective. Ties a Google account to the bot, and that account can be rate-limited or banned for this pattern — use one you are willing to lose, never your main. Cookies expire and need re-exporting. |
| PO tokens | `YTDLP_POT_PROVIDER_URL` | Helps, guarantees nothing. No provider is bundled — point this at one you run yourself. Its own README describes a PO token as something that "may help your traffic seem more legitimate" — a supplement to the two levers above, not a substitute. |

A WireGuard tunnel from the server back to a connection that already works is the usual way
to get a trusted egress without paying for a proxy service. Point `YTDLP_PROXY` at a local
SOCKS proxy on the far side of that tunnel.

None of these is permanent. Treat a working setup as something to monitor, not something to
finish — which is why yt-dlp lives in a volume and every lever is an environment variable
rather than a rebuild.

The three issues above (client image build hangs, a modal dialog blocking the client, a stale
X lock after restart) were specific to the removed `docker/ts3-client` GUI-client image used
by the `clientquery` transport's per-bot containers. That image is no longer built by this
repository; running `clientquery` today means supplying your own client container.
