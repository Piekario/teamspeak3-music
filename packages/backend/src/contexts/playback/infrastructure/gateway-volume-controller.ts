import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import {
  describeGatewayError,
  type GatewayConnection,
} from '../../instances/infrastructure/gateway/gateway-connection.ts';
import type { VolumeControlError, VolumeController } from '../domain/ports.ts';
import type { Volume } from '../domain/values.ts';

/**
 * Volume for the gateway transport.
 *
 * The PulseAudio path could set a level on a sound card and be done with it. Here there is
 * no sink to address, so the gateway scales the samples ahead of its encoder — which is why
 * this is a message rather than a system call, and why the level has to be re-sent to a bot
 * that the gateway has recreated.
 */
export class GatewayVolumeController implements VolumeController {
  readonly #connection: GatewayConnection;
  readonly #botId: string;
  #lastApplied = 40;

  constructor(connection: GatewayConnection, botId: string) {
    this.#connection = connection;
    this.#botId = botId;
  }

  async apply(volume: Volume): Promise<Result<void, VolumeControlError>> {
    const result = await this.#connection.send('bot.setVolume', this.#botId, {
      volume: volume.value,
    });

    if (!result.ok) {
      return err({ kind: 'volume/control-failed', detail: describeGatewayError(result.error) });
    }

    this.#lastApplied = volume.value;
    return ok();
  }

  /**
   * Reports the level this controller last set. The gateway holds no authoritative value to
   * read back — unlike a sound card, which is the state of the world.
   */
  async read(): Promise<Result<number, VolumeControlError>> {
    return ok(this.#lastApplied);
  }
}
