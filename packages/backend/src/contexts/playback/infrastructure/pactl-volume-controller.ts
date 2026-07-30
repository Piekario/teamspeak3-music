import { execFile } from 'node:child_process';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type { VolumeControlError, VolumeController } from '../domain/ports.ts';
import type { Volume } from '../domain/values.ts';

export interface PactlVolumeControllerOptions {
  readonly binary: string;
  /** Same address ffmpeg writes to — the sink lives in the client container. */
  readonly pulseServer: string;
  readonly sinkName: string;
}

const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Sets volume on the PulseAudio sink.
 *
 * Sink volume, not an ffmpeg filter: changing a filter means killing and respawning the
 * encoder, which is audible as a gap, whereas this takes effect instantly and survives
 * track changes without any coordination with the player.
 *
 * The one thing that will make this feel broken regardless of the code: the TeamSpeak
 * client's own microphone processing. Automatic voice gain applies its own dynamic gain on
 * top, so volume changes become non-linear and appear to fight the user. It must be turned
 * off during the client bootstrap — see README.
 */
export class PactlVolumeController implements VolumeController {
  readonly #options: PactlVolumeControllerOptions;

  constructor(options: PactlVolumeControllerOptions) {
    this.#options = options;
  }

  async apply(volume: Volume): Promise<Result<void, VolumeControlError>> {
    const result = await this.#run(['set-sink-volume', this.#options.sinkName, `${volume.value}%`]);
    return result.ok ? ok() : result;
  }

  async read(): Promise<Result<number, VolumeControlError>> {
    const result = await this.#run(['get-sink-volume', this.#options.sinkName]);
    if (!result.ok) return result;

    // `Volume: front-left: 32768 /  50% / -18.06 dB, ...` — the first percentage is enough,
    // since both channels are always set together.
    const match = /(\d+)%/.exec(result.value);
    if (match === null) {
      return err({ kind: 'volume/control-failed', detail: 'could not parse pactl output' });
    }
    return ok(Number.parseInt(match[1] as string, 10));
  }

  #run(args: readonly string[]): Promise<Result<string, VolumeControlError>> {
    return new Promise((resolve) => {
      execFile(
        this.#options.binary,
        ['-s', this.#options.pulseServer, ...args],
        { timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error !== null) {
            const detail = (stderr || error.message).trim();
            resolve(err({ kind: 'volume/control-failed', detail }));
            return;
          }
          resolve(ok(stdout));
        },
      );
    });
  }
}
