import type { QueueItem } from '@tsmusic/shared';

import { formatDuration } from '../lib/format.ts';

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
    <section className="rounded-lg border border-slate-700 bg-slate-800/50">
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
        <h2 className="font-semibold text-slate-100">
          Queue{' '}
          <span className="text-sm font-normal text-slate-400">
            {queue.length} track{queue.length === 1 ? '' : 's'} · {formatDuration(totalSeconds)}
          </span>
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onShuffle}
            disabled={disabled || queue.length < 2}
            className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-100 disabled:opacity-40"
          >
            Shuffle
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={disabled || queue.length === 0}
            className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-100 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </header>

      {queue.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-400">
          The queue is empty. Add something above, or use <code className="text-slate-300">!play</code> in
          TeamSpeak.
        </p>
      ) : (
        <ol className="divide-y divide-slate-700">
          {queue.map((item, index) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2">
              <span className="w-6 shrink-0 text-right text-sm tabular-nums text-slate-500">
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-100" title={item.track.title}>
                  {item.track.title}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {item.track.uploader ?? 'unknown'} · {formatDuration(item.track.durationSec)} ·{' '}
                  {item.requestedBy.nickname}
                </p>
              </div>

              <div className="flex shrink-0 gap-1">
                {/* Moving to index 0 is the panel's equivalent of !playnext. */}
                <button
                  type="button"
                  onClick={() => onMove(item.id, 0)}
                  disabled={disabled || index === 0}
                  title="Play next"
                  aria-label={`Play ${item.track.title} next`}
                  className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  disabled={disabled}
                  title="Remove"
                  aria-label={`Remove ${item.track.title}`}
                  className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
