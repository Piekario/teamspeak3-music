import type { Track } from '@tsmusic/shared';
import { Loader2, Plus, Search } from 'lucide-react';
import { useState } from 'react';

import { formatDuration } from '../lib/format.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

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
 * One input for both links and search terms, mirroring `!add` in chat: it appends rather
 * than interrupting, which is what a text field with a button reads as.
 *
 * A URL is queued straight away; anything else is searched rather than guessed at, because
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
  const empty = value.trim().length === 0;

  const submit = (): void => {
    if (empty) return;
    onSubmit(value.trim());
    setValue('');
  };

  return (
    <section className="relative">
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
            if (event.key === 'Escape') onDismissResults();
          }}
          placeholder="Paste a YouTube link, or type to search"
          disabled={disabled}
          aria-label="Track link or search terms"
        />
        <Button onClick={submit} disabled={disabled || busy || empty}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Add
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            if (!empty) onSearch(value.trim());
          }}
          disabled={disabled || busy || empty}
        >
          <Search /> Search
        </Button>
      </div>

      {searchResults.length > 0 && (
        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          <ul className="divide-y">
            {searchResults.map((track) => (
              <li key={track.sourceId}>
                <button
                  type="button"
                  onClick={() => {
                    onPickResult(track);
                    setValue('');
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{track.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
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
            className="w-full border-t px-4 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
