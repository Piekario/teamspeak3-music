import type { ConnectionState, InstanceSummary } from '@tsmusic/shared';
import { Plus } from 'lucide-react';

import { cn } from '../lib/utils.ts';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';

interface InstanceSwitcherProps {
  readonly instances: readonly InstanceSummary[];
  readonly selectedId: string | null;
  readonly connectionOf: (instanceId: string) => ConnectionState;
  readonly onSelect: (instanceId: string) => void;
  readonly onAdd: () => void;
}

const CONNECTION: Readonly<Record<ConnectionState, { dot: string; label: string }>> = {
  connected: { dot: 'bg-success', label: 'connected' },
  connecting: { dot: 'bg-warning animate-pulse', label: 'connecting' },
  disconnected: { dot: 'bg-muted-foreground/50', label: 'offline' },
  error: { dot: 'bg-destructive', label: 'error' },
};

/**
 * Switching bots is a local selection, not a reconnect: one socket already carries every
 * instance's events, so a bot you are not looking at stays current in the background.
 */
export function InstanceSwitcher({
  instances,
  selectedId,
  connectionOf,
  onSelect,
  onAdd,
}: InstanceSwitcherProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-2 pb-1.5">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Bots
        </h2>
        <Button variant="ghost" size="icon" className="size-7" onClick={onAdd} title="Add a bot">
          <Plus />
          <span className="sr-only">Add a bot</span>
        </Button>
      </div>

      {instances.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">No bots yet.</p>
      ) : (
        <nav
          aria-label="Bot instances"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
        >
          {instances.map((instance) => {
            // Live status from the socket outranks whatever the REST snapshot carried.
            const connection = connectionOf(instance.id);
            const style = CONNECTION[connection];
            const selected = instance.id === selectedId;

            return (
              <button
                key={instance.id}
                type="button"
                onClick={() => onSelect(instance.id)}
                aria-current={selected ? 'true' : undefined}
                // Stated explicitly: the visible label is split across elements, and status
                // is otherwise carried by colour alone.
                aria-label={`${instance.name}, ${instance.teamspeak.host}, ${style.label}${
                  instance.enabled ? '' : ', disabled'
                }`}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors',
                  selected
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                <span className={cn('size-2 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{instance.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {instance.teamspeak.host}
                  </span>
                </span>
                {!instance.enabled && (
                  <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                    off
                  </Badge>
                )}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
