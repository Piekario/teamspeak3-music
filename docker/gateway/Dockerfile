# The TSLib gateway: every bot in one process, no TeamSpeak GUI client and no emulation.
# Multi-arch — nothing here is architecture-bound, which is the main practical gain over
# driving the official client.
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build

WORKDIR /src
COPY vendor/TS3AudioBot/TSLib vendor/TS3AudioBot/TSLib
COPY services/ts3-gateway services/ts3-gateway

RUN dotnet publish services/ts3-gateway/TsMusic.Gateway.csproj \
      -c Release -o /app --nologo

FROM mcr.microsoft.com/dotnet/aspnet:9.0

# TSLib encodes Opus through the native libopus, and without it a bot connects perfectly and
# then throws DllNotFoundException the moment it tries to build an encoder — joining the
# server but staying silent, which is a confusing way to fail.
# libopus-dev, not libopus0. The runtime package ships only the versioned libopus.so.0,
# while TSLib's P/Invoke asks the loader for the unversioned "libopus" — and the unversioned
# symlink lives in the -dev package. With only libopus0 the bot connects perfectly and then
# throws DllNotFoundException when it builds an encoder: present on the server, permanently
# silent.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libopus-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app ./

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    AUDIO_PORT=8477

# 8080 control (WebSocket), 8477 raw PCM ingest.
EXPOSE 8080 8477

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -qO- http://127.0.0.1:8080/health || exit 1"]

ENTRYPOINT ["dotnet", "TsMusic.Gateway.dll"]
