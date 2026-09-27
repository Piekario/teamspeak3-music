import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type {
  AudioOutput,
  AudioOutputError,
  AudioPlaybackHandle,
  PlaybackEndReason,
  StartPlaybackOptions,
} from '../domain/ports.ts';

export interface PcmStreamAudioOutputOptions {
  readonly binary: string;
  /** Host and port of the gateway's PCM ingest listener. */
  readonly host: string;
  readonly port: number;
  /** Identifies which bot inside the gateway this audio belongs to. */
  readonly botId: string;
  readonly proxy?: string | undefined;
  readonly logger: {
    debug(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

const SIGKILL_DELAY_MS = 2_000;

/**
 * Sends audio to the TSLib gateway as raw PCM over TCP.
 *
 * The second implementation of `AudioOutput`, alongside the PulseAudio one. Both exist
 * because the port was declared in the domain: the playback service starts, stops and seeks
 * without knowing whether the bytes end up in a virtual sound card or a socket.
 *
 * This one is markedly simpler. There is no sound server, no sink to address, no `pactl`,
 * and no monitor device — ffmpeg writes s16le and the gateway encodes Opus. Volume is the
 * one thing that gets harder, since there is no sink to set it on; it belongs in the
 * gateway's encoder chain instead.
 */
export class PcmStreamAudioOutput implements AudioOutput {
  readonly #options: PcmStreamAudioOutputOptions;

  constructor(options: PcmStreamAudioOutputOptions) {
    this.#options = options;
  }

  async start(
    options: StartPlaybackOptions,
  ): Promise<Result<AudioPlaybackHandle, AudioOutputError>> {
    const socket = await this.#openIngest();
    if (!socket.ok) return socket;

    const args = this.#buildArguments(options);
    this.#options.logger.debug('spawning ffmpeg for gateway ingest', {
      startAtSec: options.startAtSec,
      headersKeys: options.httpHeaders ? Object.keys(options.httpHeaders) : undefined,
    });

    let child: ChildProcess;
    try {
      child = spawn(this.#options.binary, args, {
        env: {
          ...process.env,
          ...(this.#options.proxy === undefined
            ? {}
            : { http_proxy: this.#options.proxy, https_proxy: this.#options.proxy }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      socket.value.destroy();
      return err({ kind: 'audio/spawn-failed', detail: describeError(error) });
    }

    // ffmpeg's stdout is the PCM; piping it into the socket is the whole transport.
    child.stdout?.pipe(socket.value, { end: false });

    return ok(new PcmPlaybackHandle(child, socket.value, options, this.#options.logger));
  }

  async isHealthy(): Promise<boolean> {
    const socket = await this.#openIngest();
    if (!socket.ok) return false;
    socket.value.destroy();
    return true;
  }

  /**
   * Opens the ingest connection and announces which bot the stream belongs to. The gateway
   * expects a single newline-terminated bot id before any audio.
   */
  #openIngest(): Promise<Result<Socket, AudioOutputError>> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.#options.host, port: this.#options.port });
      socket.setNoDelay(true);

      const onError = (error: Error): void => {
        socket.destroy();
        resolve(err({ kind: 'audio/spawn-failed', detail: error.message }));
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        socket.write(`${this.#options.botId}\n`);
        resolve(ok(socket));
      });
    });
  }

  #buildArguments(options: StartPlaybackOptions): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];

    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
    );

    if (options.startAtSec > 0) {
      args.push('-ss', options.startAtSec.toFixed(3));
    }

    // Unlike the PulseAudio path there is no sound server providing a clock, so playback is
    // paced here. Without this ffmpeg would decode the whole track as fast as it can read it
    // and the gateway would receive minutes of audio in seconds.
    //
    // Before `-i`, where it belongs: `-re` is an input option, and ffmpeg 7 rejects it after
    // the input with "Error opening output files: Invalid argument" — which names the output
    // and says nothing about the option that is actually wrong.
    args.push('-re');

    if (options.httpHeaders !== undefined) {
      const userAgent =
        options.httpHeaders['User-Agent'] ?? options.httpHeaders['user-agent'];
      if (userAgent !== undefined) {
        args.push('-user_agent', userAgent);
      }

      const headerString = Object.entries(options.httpHeaders)
        .filter(([key]) => key.toLowerCase() !== 'user-agent')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') + '\r\n';
        
      if (headerString.trim().length > 0) {
        args.push('-headers', headerString);
      }
    }

    args.push('-i', options.streamUrl);

    // 48 kHz stereo s16le: what Opus wants and what the gateway's encoder expects.
    args.push('-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '2', '-ar', '48000');

    args.push('-f', 's16le', 'pipe:1');

    return args;
  }
}

class PcmPlaybackHandle implements AudioPlaybackHandle {
  readonly #child: ChildProcess;
  readonly #socket: Socket;
  readonly #logger: PcmStreamAudioOutputOptions['logger'];
  readonly #startedAtMs = Date.now();
  readonly #startAtSec: number;

  /** Set before any signal, so an intentional stop is never misread as a crash. */
  #stopping = false;
  #settled = false;
  #stderrTail = '';
  #killTimer: NodeJS.Timeout | undefined;

  constructor(
    child: ChildProcess,
    socket: Socket,
    options: StartPlaybackOptions,
    logger: PcmStreamAudioOutputOptions['logger'],
  ) {
    this.#child = child;
    this.#socket = socket;
    this.#logger = logger;
    this.#startAtSec = options.startAtSec;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-2_000);
    });

    child.once('error', (error) => {
      this.#settle(options.onEnded, {
        kind: 'failed',
        detail: describeError(error),
        playedSec: this.#playedSec(),
      });
    });

    child.once('exit', (code, signal) => {
      this.#clearKillTimer();
      this.#socket.end();

      if (this.#stopping) {
        this.#settle(options.onEnded, { kind: 'cancelled' });
        return;
      }
      if (code === 0) {
        this.#settle(options.onEnded, { kind: 'completed' });
        return;
      }

      const detail = summariseFailure(this.#stderrTail, code, signal);
      this.#logger.warn('ffmpeg exited unexpectedly', { code, signal, detail });
      this.#settle(options.onEnded, { kind: 'failed', detail, playedSec: this.#playedSec() });
    });

    // If the gateway goes away mid-track there is nowhere for the audio to go; stopping is
    // more honest than writing into a dead socket.
    socket.once('close', () => {
      if (!this.#settled && !this.#stopping) void this.stop();
    });
  }

  async stop(): Promise<void> {
    if (this.#stopping || this.#child.exitCode !== null) return;
    this.#stopping = true;

    this.#child.kill('SIGTERM');
    this.#killTimer = setTimeout(() => {
      if (this.#child.exitCode === null) this.#child.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
    this.#killTimer.unref?.();
  }

  #playedSec(): number {
    return this.#startAtSec + (Date.now() - this.#startedAtMs) / 1000;
  }

  #settle(onEnded: (reason: PlaybackEndReason) => void, reason: PlaybackEndReason): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearKillTimer();
    this.#socket.destroy();
    onEnded(reason);
  }

  #clearKillTimer(): void {
    if (this.#killTimer !== undefined) {
      clearTimeout(this.#killTimer);
      this.#killTimer = undefined;
    }
  }
}

function summariseFailure(stderr: string, code: number | null, signal: string | null): string {
  const lastMeaningfulLine = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

  if (lastMeaningfulLine !== undefined) return lastMeaningfulLine;
  if (signal !== null) return `ffmpeg terminated by ${signal}`;
  return `ffmpeg exited with code ${code ?? 'unknown'}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
