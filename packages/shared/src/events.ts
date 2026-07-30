import type { ChannelClient, ChannelRef, ConnectionState } from './instance.ts';
import type { PlayerState, QueueItem } from './playback.ts';

/**
 * The WebSocket contract. Server → client only: every mutation goes through REST, so there
 * is exactly one write path and the socket stays a pure read model.
 *
 * Every event carries `instanceId` because one socket multiplexes all bots. The UI's
 * instance switcher is then a filter over this stream, not a reconnect.
 */

export interface EnvelopeBase {
  readonly instanceId: string;
  readonly at: string;
}

export type AppEvent =
  | (EnvelopeBase & { readonly type: 'player.state'; readonly payload: PlayerState })
  | (EnvelopeBase & {
      readonly type: 'queue.changed';
      readonly payload: { readonly queue: readonly QueueItem[] };
    })
  | (EnvelopeBase & {
      readonly type: 'track.started';
      readonly payload: { readonly item: QueueItem };
    })
  | (EnvelopeBase & {
      readonly type: 'track.ended';
      readonly payload: { readonly item: QueueItem; readonly reason: TrackEndReason };
    })
  | (EnvelopeBase & {
      readonly type: 'command.executed';
      readonly payload: CommandLogEntry;
    })
  | (EnvelopeBase & {
      readonly type: 'instance.status';
      readonly payload: {
        readonly connection: ConnectionState;
        readonly error: string | null;
        readonly channel: ChannelRef | null;
        readonly clients: readonly ChannelClient[];
      };
    })
  | (EnvelopeBase & { readonly type: 'log'; readonly payload: LogEntry });

export const TRACK_END_REASONS = ['finished', 'skipped', 'stopped', 'error'] as const;
export type TrackEndReason = (typeof TRACK_END_REASONS)[number];

export interface CommandLogEntry {
  readonly uid: string;
  readonly nickname: string;
  readonly command: string;
  readonly args: string;
  readonly allowed: boolean;
  readonly reply: string | null;
}

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
}

export type AppEventType = AppEvent['type'];

/** Narrowing helper so consumers can switch without casting. */
export function isEventOfType<T extends AppEventType>(
  event: AppEvent,
  type: T,
): event is Extract<AppEvent, { type: T }> {
  return event.type === type;
}
