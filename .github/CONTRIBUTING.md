# Contributing

Thanks for considering a contribution to the TeamSpeak 3 Music Bot.

## Getting set up

```bash
git clone --recurse-submodules https://github.com/Piekario/teamspeak3-music.git
cd teamspeak3-music
pnpm install
```

If you already cloned without `--recurse-submodules`, run:

```bash
git submodule update --init --recursive
```

That pulls in `vendor/TS3AudioBot`, which `services/ts3-gateway` compiles against. You only
need it if you're touching the gateway; the Node packages build and test without it.

## Working on the Node packages (`packages/backend`, `packages/frontend`, `packages/shared`)

```bash
pnpm -r build
pnpm -r test          # domain and protocol tests: no Docker, no TeamSpeak required
pnpm typecheck
```

A few conventions to know before changing backend code — see the **Architecture** and
**Development** sections of the [README](../README.md) for the full picture:

- Source files import each other with explicit `.ts` extensions (`tsc` rewrites them to `.js`
  on emit); tests run on Node's native type stripping, which also means **constructor
  parameter properties don't work** — declare fields explicitly instead.
- The domain layer knows nothing about Fastify, SQLite, ffmpeg or TeamSpeak. External
  concerns enter through a port declared in the domain and an adapter in infrastructure.
- Expected failures are `Result` values, not exceptions. An unhandled throw is a bug.

## Working on the gateway (`services/ts3-gateway`)

Requires the .NET SDK and the `vendor/TS3AudioBot` submodule checked out.

```bash
dotnet build services/ts3-gateway/TsMusic.Gateway.csproj
```

This component is licensed under OSL-3.0 rather than MIT because it compiles directly against
TSLib — see the note at the bottom of [LICENSE](../LICENSE) before contributing here.

## Running the full stack

```bash
cp .env.example .env && sed -i '' "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d
```

See the README's **Quick start** and **Troubleshooting** sections for the common gotchas
(codec settings, yt-dlp/YouTube issues, datacenter IPs).

## Making a change

1. Open an issue first for anything beyond a small fix — it saves everyone rework if the
   approach needs discussion.
2. Keep PRs focused on one change. `pnpm -r test`, `pnpm typecheck` and `pnpm -r build` should
   all pass before you open it; CI runs the same checks (plus the gateway build) on every PR.
3. Match the existing style in the file you're editing rather than introducing a new one.
4. Describe *why*, not just *what*, in the PR description — the reviewer can read the diff.

## Reporting bugs and requesting features

Use the issue templates — they ask for the information that's actually needed to act on a
report (logs, transport mode, environment). See [SECURITY.md](SECURITY.md) instead if what
you found is a vulnerability rather than a bug.
