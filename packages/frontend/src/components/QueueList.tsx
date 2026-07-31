import type { QueueItem } from '@tsmusic/shared';
import { ArrowUp, ListMusic, Shuffle, Trash2, X } from 'lucide-react';

import { formatDuration } from '../lib/format.ts';
import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';

interface QueueListProps {
  readonly queue: readonly QueueItem[];
  readonly disabled: boolean;
  readonly onRemove: (itemId: string) => void;
  readonly onMove: (itemId: string, toIndex: number) => void;
  readonly onShuffle: () => void;
  readonly onClear: () => void;
}

export function QueueList({
  queue,
  disabled,
  onRemove,
  onMove,
  onShuffle,
  onClear,
}: QueueListProps) {
  const totalSeconds = queue.reduce((sum, item) => sum + (item.track.durationSec ?? 0), 0);

  return (
    <Card className="overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-semibold">
            <ListMusic className="size-4 text-muted-foreground" />
            Queue
          </h2>
          <p className="text-xs text-muted-foreground">
            {queue.length === 0
              ? 'empty'
              : `${queue.length} track${queue.length === 1 ? '' : 's'} · ${formatDuration(totalSeconds)}`}
          </p>
        </div>

        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onShuffle}
            disabled={disabled || queue.length < 2}
          >
            <Shuffle /> Shuffle
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={disabled || queue.length === 0}
          >
            <Trash2 /> Clear
          </Button>
        </div>
      </header>

      {queue.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          Nothing queued. Paste a link above or use{' '}
          <code className="font-mono text-xs">!play</code> in TeamSpeak.
        </p>
      ) : (
        <ol className="divide-y">
          {queue.map((item, index) => (
            <li
              key={item.id}
              className="group flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-muted/50"
            >
              <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={item.track.title}>
                  {item.track.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.track.uploader ?? 'unknown'} · {formatDuration(item.track.durationSec)} ·{' '}
                  {item.requestedBy.nickname}
                </p>
              </div>

              {/* Revealed on hover but always reachable by keyboard — focus-within keeps them
                  visible for anyone tabbing through. */}
              <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onMove(item.id, 0)}
                  disabled={disabled || index === 0}
                  aria-label={`Play ${item.track.title} next`}
                  title="Play next"
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(item.id)}
                  disabled={disabled}
                  aria-label={`Remove ${item.track.title}`}
                  title="Remove"
                  className="hover:text-destructive"
                >
                  <X />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
