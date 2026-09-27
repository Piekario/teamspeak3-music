import { spawn, type ChildProcess } from 'node:child_process';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type {
  AudioOutput,
  AudioOutputError,
  AudioPlaybackHandle,
  PlaybackEndReason,
  StartPlaybackOptions,
} from '../domain/ports.ts';

export interface FfmpegAudioOutputOptions {
  readonly binary: string;
  /** PulseAudio address, e.g. `tcp:ts3-client-party:4713`. Never assumed to be local. */
  readonly pulseServer: string;
  readonly sinkName: string;
  /**
   * Identifies this instance's stream in `pactl list sink-inputs`. Not cosmetic: it is how
   * the volume controller finds the right stream when several bots share a host.
   */
  readonly applicationName: string;
  /**
   * Must be the same proxy the resolver used. A googlevideo URL is bound to the IP that
   * requested it, so fetching the media from a different exit address returns 403 even
   * though the URL is perfectly fresh.
   */
  readonly proxy?: string | undefined;
  readonly logger: {
    debug(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

/** Grace period before a terminating process is killed outright. */
const SIGKILL_DELAY_MS = 2_000;

/**
 * Drives ffmpeg, one process at a time.
 *
 * The subtle part is telling an intentional stop apart from a crash. Skipping a track kills
 * ffmpeg, and ffmpeg then exits non-zero — indistinguishable from a genuine failure unless
 * the intent is recorded first. Getting this wrong produces the classic "it skipped two
 * tracks" bug, where the skip kills the process and the exit handler treats the death as a
 * failure and skips again. Hence `#stopping`, set before any signal is sent.
 */
export class FfmpegAudioOutput implements AudioOutput {
  readonly #options: FfmpegAudioOutputOptions;

  constructor(options: FfmpegAudioOutputOptions) {
    this.#options = options;
  }

  async start(
    options: StartPlaybackOptions,
  ): Promise<Result<AudioPlaybackHandle, AudioOutputError>> {
    const args = this.#buildArguments(options);
    this.#options.logger.debug('spawning ffmpeg', {
      startAtSec: options.startAtSec,
      headersKeys: options.httpHeaders ? Object.keys(options.httpHeaders) : undefined,
      sink: this.#options.sinkName,
    });

    let child: ChildProcess;
    try {
      child = spawn(this.#options.binary, args, {
        env: {
          ...process.env,
          PULSE_SERVER: this.#options.pulseServer,
          // ffmpeg reads proxy settings from the environment for http/https inputs.
          ...(this.#options.proxy === undefined
            ? {}
            : { http_proxy: this.#options.proxy, https_proxy: this.#options.proxy }),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      return err({ kind: 'audio/spawn-failed', detail: describeError(error) });
    }

    return ok(new FfmpegPlaybackHandle(child, options, this.#options.logger));
  }

  async isHealthy(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = spawn(this.#options.binary, ['-hide_banner', '-version'], {
        stdio: 'ignore',
      });
      probe.once('error', () => resolve(false));
      probe.once('exit', (code) => resolve(code === 0));
    });
  }

  #buildArguments(options: StartPlaybackOptions): string[] {
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];

    // A media URL over HTTPS drops out; reconnecting is cheaper than skipping the track.
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
    );

    // Input-side seek: placed before -i so ffmpeg jumps rather than decoding and discarding.
    if (options.startAtSec > 0) {
      args.push('-ss', options.startAtSec.toFixed(3));
    }

    if (options.httpHeaders !== undefined) {
      const userAgent =
        options.httpHeaders['User-Agent'] ?? options.httpHeaders['user-agent'];
      if (userAgent !== undefined) {
        args.push('-user_agent', userAgent);
      }

      const headerString = Object.entries(options.httpHeaders)
        // ffmpeg has a dedicated option for User-Agent; passing it in -headers is often ignored.
        .filter(([key]) => key.toLowerCase() !== 'user-agent')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') + '\r\n';
      
      if (headerString.trim().length > 0) {
        args.push('-headers', headerString);
      }
    }

    args.push('-i', options.streamUrl);

    // 48 kHz stereo is forced: TeamSpeak's Opus Music codec expects it, and letting 44.1 kHz
    // through means PulseAudio resamples mid-chain, which is audible as artefacts.
    args.push(
      '-vn',
      '-af', 'aresample=async=1:first_pts=0',
      '-ac', '2',
      '-ar', '48000',
    );

    args.push(
      '-f', 'pulse',
      '-name', this.#options.applicationName,
      '-device', this.#options.sinkName,
      '-buffer_duration', '500',
      // No `-re`: the PulseAudio sink provides the clock. Adding it would fight that clock.
      this.#options.applicationName,
    );

    return args;
  }
}

class FfmpegPlaybackHandle implements AudioPlaybackHandle {
  readonly #child: ChildProcess;
  readonly #logger: FfmpegAudioOutputOptions['logger'];
  readonly #startedAtMs = Date.now();
  readonly #startAtSec: number;

  /** Set before any signal is sent, so the exit handler can recognise a deliberate stop. */
  #stopping = false;
  #settled = false;
  #stderrTail = '';
  #killTimer: NodeJS.Timeout | undefined;

  constructor(
    child: ChildProcess,
    options: StartPlaybackOptions,
    logger: FfmpegAudioOutputOptions['logger'],
  ) {
    this.#child = child;
    this.#logger = logger;
    this.#startAtSec = options.startAtSec;

    // ffmpeg reports the actual reason for failure on stderr; keeping the tail turns
    // "playback failed" into something an operator can act on.
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
      this.#settle(options.onEnded, {
        kind: 'failed',
        detail,
        playedSec: this.#playedSec(),
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#stopping || this.#child.exitCode !== null) return;
    this.#stopping = true;

    this.#child.kill('SIGTERM');
    this.#killTimer = setTimeout(() => {
      if (this.#child.exitCode === null) {
        this.#logger.warn('ffmpeg ignored SIGTERM, sending SIGKILL');
        this.#child.kill('SIGKILL');
      }
    }, SIGKILL_DELAY_MS);
    this.#killTimer.unref?.();
  }

  /** How far into the track playback actually reached — the resume point after a crash. */
  #playedSec(): number {
    return this.#startAtSec + (Date.now() - this.#startedAtMs) / 1000;
  }

  #settle(onEnded: (reason: PlaybackEndReason) => void, reason: PlaybackEndReason): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearKillTimer();
    onEnded(reason);
  }

  #clearKillTimer(): void {
    if (this.#killTimer !== undefined) {
      clearTimeout(this.#killTimer);
      this.#killTimer = undefined;
    }
  }
}

/**
 * ffmpeg's stderr is verbose and its last line is usually the useful one. Surfacing a
 * specific cause matters here: "403 Forbidden" tells an operator the media URL expired,
 * while a generic "playback failed" tells them nothing.
 */
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
