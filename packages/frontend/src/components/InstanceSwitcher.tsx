import type { ConnectionState, InstanceSummary } from '@tsmusic/shared';

interface InstanceSwitcherProps {
  readonly instances: readonly InstanceSummary[];
  readonly selectedId: string | null;
  readonly connectionOf: (instanceId: string) => ConnectionState;
  readonly onSelect: (instanceId: string) => void;
}

const CONNECTION_STYLES: Readonly<Record<ConnectionState, { dot: string; label: string }>> = {
  connected: { dot: 'bg-emerald-400', label: 'connected' },
  connecting: { dot: 'bg-amber-400 animate-pulse', label: 'connecting' },
  disconnected: { dot: 'bg-slate-500', label: 'offline' },
  error: { dot: 'bg-rose-500', label: 'error' },
};

/**
 * Switching bots is a local selection, not a reconnect: one socket already carries every
 * instance's events, so a bot you are not looking at stays up to date in the background.
 */
export function InstanceSwitcher({
  instances,
  selectedId,
  connectionOf,
  onSelect,
}: InstanceSwitcherProps) {
  if (instances.length === 0) {
    return <p className="px-3 py-2 text-sm text-slate-400">No bots configured.</p>;
  }

  return (
    <nav aria-label="Bot instances" className="flex flex-col gap-1">
      {instances.map((instance) => {
        // Live status from the socket outranks the value the REST snapshot was created with.
        const connection = connectionOf(instance.id);
        const style = CONNECTION_STYLES[connection];
        const selected = instance.id === selectedId;

        return (
          <button
            key={instance.id}
            type="button"
            onClick={() => onSelect(instance.id)}
            aria-current={selected ? 'true' : undefined}
            // The visible label is split across nested spans with a decorative status dot,
            // which leaves the computed accessible name unreliable. Stating it explicitly
            // also folds in the connection status, which is otherwise conveyed by colour alone.
            aria-label={`${instance.name}, ${instance.teamspeak.host}, ${style.label}${
              instance.enabled ? '' : ', disabled'
            }`}
            className={`flex items-center gap-2 rounded px-3 py-2 text-left text-sm ${
              selected ? 'bg-slate-700 text-slate-100' : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{instance.name}</span>
              <span className="block truncate text-xs text-slate-500">
                {instance.teamspeak.host} · {style.label}
              </span>
            </span>
            {!instance.enabled && (
              <span className="shrink-0 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                off
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
