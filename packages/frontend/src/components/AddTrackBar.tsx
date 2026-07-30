import type { Track } from '@tsmusic/shared';
import { useState } from 'react';

import { formatDuration } from '../lib/format.ts';

interface AddTrackBarProps {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly searchResults: readonly Track[];
  readonly onSubmit: (input: string) => void;
  readonly onSearch: (terms: string) => void;
  readonly onPickResult: (track: Track) => void;
  readonly onDismissResults: () => void;
}

/**
 * One input for both links and search terms — the same affordance as `!play` in chat.
 * A URL is queued straight away; anything else is searched, because guessing wrong and
 * queueing an unrelated track is more annoying than one extra click.
 */
export function AddTrackBar({
  disabled,
  busy,
  searchResults,
  onSubmit,
  onSearch,
  onPickResult,
  onDismissResults,
}: AddTrackBarProps) {
  const [value, setValue] = useState('');

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setValue('');
  };

  const search = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSearch(trimmed);
  };

  return (
    <section className="relative">
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(changeEvent) => setValue(changeEvent.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'Enter') submit();
            if (keyEvent.key === 'Escape') onDismissResults();
          }}
          placeholder="Paste a YouTube link, or type to search"
          disabled={disabled}
          aria-label="Track link or search terms"
          className="flex-1 rounded border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-500 disabled:opacity-40"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || busy || value.trim().length === 0}
          className="rounded bg-emerald-500 px-4 py-2 font-medium text-slate-900 disabled:opacity-40"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={search}
          disabled={disabled || busy || value.trim().length === 0}
          className="rounded bg-slate-700 px-4 py-2 text-slate-100 disabled:opacity-40"
        >
          Search
        </button>
      </div>

      {searchResults.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded border border-slate-600 bg-slate-900 shadow-xl">
          <ul className="divide-y divide-slate-700">
            {searchResults.map((track) => (
              <li key={track.sourceId}>
                <button
                  type="button"
                  onClick={() => {
                    onPickResult(track);
                    setValue('');
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-100">{track.title}</p>
                    <p className="truncate text-xs text-slate-500">
                      {track.uploader ?? 'unknown'} · {formatDuration(track.durationSec)}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onDismissResults}
            className="w-full border-t border-slate-700 px-3 py-1 text-xs text-slate-400 hover:bg-slate-800"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
