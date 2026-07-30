import type { AppEvent, ChannelClient, ChannelRef, CommandLogEntry, ConnectionState, PlayerState } from '@tsmusic/shared';
import { create } from 'zustand';

/**
 * The live read model, driven entirely by WebSocket events.
 *
 * State is keyed by instance id because one socket carries every bot. Switching bots in the
 * panel is therefore a selector change, not a reconnect — and events for a bot you are not
 * currently looking at still keep its state warm.
 */

export interface InstanceLiveState {
  readonly player: PlayerState | null;
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
  readonly channel: ChannelRef | null;
  readonly clients: readonly ChannelClient[];
  readonly commandLog: readonly TimestampedCommand[];
}

export interface TimestampedCommand extends CommandLogEntry {
  readonly at: string;
}

/** Bounded so a long-running party cannot grow the tab's memory without limit. */
const COMMAND_LOG_LIMIT = 100;

const EMPTY_INSTANCE: InstanceLiveState = {
  player: null,
  connection: 'disconnected',
  connectionError: null,
  channel: null,
  clients: [],
  commandLog: [],
};

interface LiveStore {
  readonly socketConnected: boolean;
  readonly byInstance: Readonly<Record<string, InstanceLiveState>>;
  apply(event: AppEvent): void;
  setSocketConnected(connected: boolean): void;
  reset(): void;
}

export const useLiveStore = create<LiveStore>((set) => ({
  socketConnected: false,
  byInstance: {},

  setSocketConnected: (connected) => set({ socketConnected: connected }),

  reset: () => set({ byInstance: {}, socketConnected: false }),

  apply: (event) =>
    set((state) => {
      const current = state.byInstance[event.instanceId] ?? EMPTY_INSTANCE;
      const next = reduce(current, event);
      if (next === current) return state;

      return { byInstance: { ...state.byInstance, [event.instanceId]: next } };
    }),
}));

/**
 * Pure reducer, exported so its behaviour can be tested without React or a socket.
 */
export function reduce(state: InstanceLiveState, event: AppEvent): InstanceLiveState {
  switch (event.type) {
    case 'player.state':
      return { ...state, player: event.payload };

    case 'queue.changed':
      // A queue delta without a preceding full state has nothing to merge into; ignoring it
      // is correct because a `player.state` always follows.
      if (state.player === null) return state;
      return { ...state, player: { ...state.player, queue: event.payload.queue } };

    case 'instance.status':
      return {
        ...state,
        connection: event.payload.connection,
        connectionError: event.payload.error,
        channel: event.payload.channel,
        clients: event.payload.clients,
      };

    case 'command.executed':
      return {
        ...state,
        commandLog: [{ ...event.payload, at: event.at }, ...state.commandLog].slice(
          0,
          COMMAND_LOG_LIMIT,
        ),
      };

    // Track transitions are already reflected by the `player.state` that accompanies them,
    // and `log` is surfaced through the player's own error field.
    case 'track.started':
    case 'track.ended':
    case 'log':
      return state;
  }
}

export function selectInstance(instanceId: string | null) {
  return (store: LiveStore): InstanceLiveState =>
    instanceId === null ? EMPTY_INSTANCE : (store.byInstance[instanceId] ?? EMPTY_INSTANCE);
}

export { EMPTY_INSTANCE };
