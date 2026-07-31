import type { InstanceConfig } from '../contexts/instances/domain/instance.ts';
import type { InstanceTransport } from '../contexts/instances/domain/instance-transport.ts';
import { ClientQueryTransport } from '../contexts/instances/infrastructure/clientquery/clientquery-transport.ts';
import { GatewayTransport } from '../contexts/instances/infrastructure/gateway/gateway-transport.ts';
import type { GatewayConnection } from '../contexts/instances/infrastructure/gateway/gateway-connection.ts';
import type { VolumeController } from '../contexts/playback/domain/ports.ts';
import { PactlVolumeController } from '../contexts/playback/infrastructure/pactl-volume-controller.ts';
import { GatewayVolumeController } from '../contexts/playback/infrastructure/gateway-volume-controller.ts';
import type { Clock } from '../shared-kernel/clock.ts';
import type { ScopedLogger } from '../infrastructure/logging/logger.ts';
import type { AppConfig } from '../config.ts';

export interface TransportBuild {
  readonly transport: InstanceTransport;
  readonly volume: VolumeController;
}

export interface TransportDependencies {
  readonly appConfig: AppConfig;
  readonly clock: Clock;
  readonly logger: ScopedLogger;
  /** Present only when the gateway transport is selected. */
  readonly gateway?: GatewayConnection | undefined;
  readonly onIdentityIssued: (instanceId: string, key: string, offset: number, uid: string) => void;
  readonly storedIdentity: (instanceId: string) => { key: string | null; offset: number };
}

/**
 * Chooses the transport for an instance.
 *
 * The two paths differ in more than their wire protocol — one needs a sound server and a
 * container per bot, the other needs neither — so volume control is selected here alongside
 * them rather than assumed. Keeping the choice in the composition root is what stops the
 * word "PulseAudio" from appearing anywhere the domain can see it.
 */
export function buildTransport(
  deps: TransportDependencies,
  config: InstanceConfig,
  onReady: () => Promise<void>,
): TransportBuild {
  const { appConfig } = deps;

  if (appConfig.TS3_TRANSPORT === 'gateway') {
    const gateway = deps.gateway;
    if (gateway === undefined) {
      throw new Error('TS3_TRANSPORT=gateway requires a gateway connection');
    }

    const transport = new GatewayTransport({
      config,
      connection: gateway,
      logger: deps.logger,
      ffmpegBinary: appConfig.FFMPEG_BINARY,
      pcmHost: appConfig.GATEWAY_PCM_HOST,
      pcmPort: appConfig.GATEWAY_PCM_PORT,
      proxy: appConfig.YTDLP_PROXY,
      onReady,
      identity: deps.storedIdentity(config.id),
      onIdentityIssued: (key, offset, uid) =>
        deps.onIdentityIssued(config.id, key, offset, uid),
    });

    return {
      transport,
      volume: new GatewayVolumeController(gateway, config.id),
    };
  }

  return {
    transport: new ClientQueryTransport({
      config,
      clock: deps.clock,
      logger: deps.logger,
      ffmpegBinary: appConfig.FFMPEG_BINARY,
      pactlBinary: appConfig.PACTL_BINARY,
      proxy: appConfig.YTDLP_PROXY,
      onReady,
    }),
    volume: new PactlVolumeController({
      binary: appConfig.PACTL_BINARY,
      pulseServer: config.audio.pulseServer,
      sinkName: config.audio.sinkName,
    }),
  };
}
