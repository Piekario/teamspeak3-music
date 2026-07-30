# The bot stays on the host's native architecture. Only the TeamSpeak client is emulated,
# which matters because ffmpeg is the CPU-hungry part of this system and reaches PulseAudio
# over TCP rather than needing to live beside it.
FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

# The lockfile is what makes `--frozen-lockfile` meaningful: without it the build would
# either fail outright or silently resolve different dependency versions than the ones
# tested here.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
RUN pnpm install --frozen-lockfile --filter @tsmusic/shared --filter @tsmusic/backend

COPY packages/shared packages/shared
COPY packages/backend packages/backend
# No `pnpm prune --prod` here: it prompts interactively ("modules will be removed and
# reinstalled from scratch"), which has no place in a build, and it reinstalls the whole
# tree to save space that a self-hosted bot does not need.
RUN pnpm --filter @tsmusic/shared build && pnpm --filter @tsmusic/backend build \
 && test -d packages/shared/dist && test -d packages/backend/dist

FROM node:22-bookworm-slim

# ffmpeg produces the audio; pactl sets sink volume; python3 is what yt-dlp runs on.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg pulseaudio-utils python3 python3-pip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp is installed into a volume rather than into the image. YouTube breaks extraction
# without warning and yt-dlp ships fixes weekly; baking it in would mean an image rebuild at
# exactly the moment the bot has stopped working.
ENV PYTHONPATH=/opt/ytdlp \
    PATH=/opt/ytdlp/bin:$PATH \
    NODE_ENV=production
RUN mkdir -p /opt/ytdlp \
 && pip3 install --break-system-packages --target /opt/ytdlp yt-dlp

WORKDIR /app

# The whole tree is copied in one piece rather than cherry-picking dist and package.json.
# pnpm's layout is a web of symlinks — each package has its own node_modules pointing into
# the root .pnpm store — and reproducing that path by path produced an image that resolved
# its own package.json but not its dependencies. Copying wholesale keeps every link intact;
# the extra weight is the TypeScript sources, which is not a price worth optimising here.
COPY --from=build /app ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "packages/backend/dist/main.js"]
