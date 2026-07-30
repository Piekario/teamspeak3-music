# The TeamSpeak 3 client ships for linux_amd64 only — there is no arm64 build — so this
# image is architecture-pinned and runs under emulation on Apple Silicon. It is deliberately
# the *only* emulated service: ffmpeg and the bot stay native and reach PulseAudio over TCP.
FROM --platform=linux/amd64 debian:bookworm-slim

ARG TS3_VERSION=3.6.2
ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PULSE_SINK_NAME=bot_sink \
    PULSE_SOURCE_NAME=bot_mic

# Qt5 needs a specific and unforgiving set of xcb libraries. A missing one surfaces only at
# runtime as `qt.qpa.plugin: Could not load the Qt platform plugin "xcb"`; if that appears,
# rerun the client with QT_DEBUG_PLUGINS=1 and read the dlopen errors.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bzip2 \
      xvfb x11vnc x11-utils \
      # openbox: Qt will not take keyboard focus without a window manager, which makes any
      # remaining GUI step — and VNC itself — unusable. sqlite3: used by the entrypoint to
      # seed the licence acceptance keys. xdotool: drives the rare dialog that still needs it.
      openbox sqlite3 xdotool \
      pulseaudio pulseaudio-utils libpulse0 \
      supervisor procps netcat-openbsd \
      libnss3 libxcursor1 libxcomposite1 libxi6 libxtst6 libxrandr2 \
      libasound2 libegl1 libgl1 libxkbcommon-x11-0 \
      libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
      libxcb-render-util0 libxcb-xinerama0 libxcb-xkb1 libxcb-shape0 \
      libfontconfig1 libdbus-1-3 libglib2.0-0 libxslt1.1 libsm6 libice6 \
      libxml2 libnspr4 \
      # Determined by running `ldd` against the extracted client rather than guessed:
      # libatomic is needed by nearly every bundled Qt library, and libevent/libpci by
      # Qt WebEngine, which the main binary links even though the bot never renders a page.
      # The client bundles its own libc++, libssl and libcrypto, so those are NOT needed.
      libatomic1 libevent-2.1-7 libpci3 \
 && rm -rf /var/lib/apt/lists/*

# The installer is a makeself self-extracting archive wrapping an interactive licence
# prompt. `--quiet --nox11` does NOT suppress that prompt: with no stdin the prompt's read
# returns immediately at EOF and the script re-asks forever, so the build appears to hang
# while quietly spooling gigabytes of "Please type y to accept" into the log.
#
# `yes` terminates the prompt on the first answer. The `test` afterwards is the real
# safeguard — it fails the build loudly if extraction produced nothing, rather than leaving
# a broken image to be discovered at runtime.
RUN curl -fSL -o /tmp/ts3.run \
      "https://files.teamspeak-services.com/releases/client/${TS3_VERSION}/TeamSpeak3-Client-linux_amd64-${TS3_VERSION}.run" \
 && chmod +x /tmp/ts3.run \
 && yes | /tmp/ts3.run --quiet --nox11 --target /opt/ts3client \
 && rm -f /tmp/ts3.run \
 && test -x /opt/ts3client/ts3client_runscript.sh \
 && test -x /opt/ts3client/ts3client_linux_amd64

RUN useradd -m -u 1000 -s /bin/bash ts3 \
 && usermod -aG audio,pulse,pulse-access ts3 \
 && chown -R ts3:ts3 /opt/ts3client

COPY pulse-daemon.conf /etc/pulse/daemon.conf
COPY pulse-default.pa /etc/pulse/system.pa
COPY supervisord.conf /etc/supervisor/conf.d/ts3.conf
COPY entrypoint.sh healthcheck.sh run-ts3client.sh run-x11vnc.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh \
             /usr/local/bin/run-ts3client.sh /usr/local/bin/run-x11vnc.sh

# 25639 ClientQuery, 4713 PulseAudio over TCP, 5900 VNC (bootstrap only).
EXPOSE 25639 4713 5900

# Qt startup under emulation is slow; a short start period would flap the container before
# it ever had a chance to come up.
HEALTHCHECK --interval=20s --timeout=10s --start-period=120s --retries=5 \
  CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
