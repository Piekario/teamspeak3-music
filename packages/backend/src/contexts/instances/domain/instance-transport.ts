import type { ConnectionState } from '@tsmusic/shared';

import type { AudioOutput } from '../../playback/domain/ports.ts';
import type { BotClient, MessageListener } from './bot-client.ts';

/**
 * Everything an instance needs in order to exist on TeamSpeak: a way to talk to it, a way to
 * make sound, and a lifecycle.
 *
 * The two implementations are genuinely different systems — one drives a headless GUI client
 * over a local socket and pushes audio into a virtual sound card, the other speaks the
 * TeamSpeak protocol directly and streams PCM to a shared process. The instance runtime is
 * indifferent to which is in use, which is the point: the choice is a line of configuration
 * rather than a fork in the code.
 */
export interface InstanceTransport {
  readonly bot: BotClient;
  readonly audio: AudioOutput;

  /** Begins connecting. Implementations reconnect on their own. */
  start(): void;
  stop(): Promise<void>;

  onMessage(listener: MessageListener): () => void;
  onConnectionChange(listener: (state: ConnectionState, error: string | null) => void): void;
}

/**
 * Builds the transport for one instance. Declared as a factory rather than a constructed
 * object so the runtime can be rebuilt on reconfiguration without the composition root
 * having to know when that happens.
 */
export type InstanceTransportFactory = (options: {
  readonly instanceId: string;
  readonly onReady: () => Promise<void>;
}) => InstanceTransport;
