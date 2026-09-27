import type { QueueItem } from '@tsmusic/shared';
import { ArrowUp, GripVertical, ListMusic, Shuffle, Trash2, X } from 'lucide-react';
import type { DragEvent } from 'react';
import { useState } from 'react';

import { formatDuration } from '../lib/format.ts';
import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';

interface QueueListProps {
  readonly queue: readonly QueueItem[];
  readonly disabled: boolean;
  /** Shuffling and clearing touch everybody's tracks, so they are a DJ's to reach. */
  readonly canEditQueue: boolean;
  readonly onRemove: (itemId: string) => void;
  readonly onMove: (itemId: string, toIndex: number) => void;
  readonly onShuffle: () => void;
  readonly onClear: () => void;
}

export function QueueList({
  queue,
  disabled,
  canEditQueue,
  onRemove,
  onMove,
  onShuffle,
  onClear,
}: QueueListProps) {
  const totalSeconds = queue.reduce((sum, item) => sum + (item.track.durationSec ?? 0), 0);
  const canDrag = canEditQueue && !disabled;

  // Drag state lives here rather than per-row: only one row can be dragged at a time, and the
  // drop target needs to be visible on every row while it happens.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const resetDrag = () => {
    setDraggedId(null);
    setOverIndex(null);
  };

  const handleDragStart = (event: DragEvent<HTMLLIElement>, itemId: string) => {
    // A drag gesture that started on a button (remove, play next) is a click, not a reorder.
    if ((event.target as HTMLElement).closest('button')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
    setDraggedId(itemId);
  };

  const handleDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (draggedId === null) return;
    event.preventDefault();
    setOverIndex(index);
  };

  const handleDrop = (event: DragEvent<HTMLLIElement>, index: number) => {
    event.preventDefault();
    if (draggedId !== null) onMove(draggedId, index);
    resetDrag();
  };

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
            disabled={disabled || !canEditQueue || queue.length < 2}
          >
            <Shuffle /> Shuffle
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={disabled || !canEditQueue || queue.length === 0}
          >
            <Trash2 /> Clear
          </Button>
        </div>
      </header>

      {queue.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          Nothing queued. Paste a link above or use{' '}
          <code className="font-mono text-xs">!add</code> in TeamSpeak.
        </p>
      ) : (
        <ol className="max-h-96 divide-y overflow-y-auto">
          {queue.map((item, index) => (
            <li
              key={item.id}
              draggable={canDrag}
              onDragStart={(event) => handleDragStart(event, item.id)}
              onDragOver={(event) => handleDragOver(event, index)}
              onDrop={(event) => handleDrop(event, index)}
              onDragEnd={resetDrag}
              className={`group flex items-center gap-2 px-5 py-2.5 transition-colors hover:bg-muted/50 ${
                draggedId === item.id ? 'opacity-40' : ''
              } ${
                overIndex === index && draggedId !== null && draggedId !== item.id
                  ? 'border-t-2 border-primary'
                  : ''
              }`}
            >
              {canDrag && (
                <GripVertical
                  className="size-4 shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing"
                  aria-hidden="true"
                />
              )}

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
