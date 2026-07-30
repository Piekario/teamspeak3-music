import type { RepeatMode, Track } from '@tsmusic/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AddTrackBar } from '../components/AddTrackBar.tsx';
import { CommandLog } from '../components/CommandLog.tsx';
import { NowPlaying } from '../components/NowPlaying.tsx';
import { QueueList } from '../components/QueueList.tsx';
import { TransportControls } from '../components/TransportControls.tsx';
import { ApiError, api } from '../lib/api.ts';
import { selectInstance, useLiveStore } from '../store/live-store.ts';

interface DashboardPageProps {
  readonly instanceId: string;
}

/**
 * The page an operator actually keeps open.
 *
 * Nothing here holds playback state of its own: every control fires a REST mutation and the
 * resulting WebSocket event updates the store. That single direction is why the panel can
 * never drift out of step with what somebody types in TeamSpeak.
 */
export function DashboardPage({ instanceId }: DashboardPageProps) {
  const live = useLiveStore(selectInstance(instanceId));
  const queryClient = useQueryClient();

  const [searchResults, setSearchResults] = useState<readonly Track[]>([]);
  const [error, setError] = useState<string | null>(null);

  const disabled = live.connection !== 'connected';

  /** Every mutation reports failure the same way, using the backend's own wording. */
  const run = <TArgs extends unknown[]>(action: (...args: TArgs) => Promise<unknown>) =>
    async (...args: TArgs): Promise<void> => {
      setError(null);
      try {
        await action(...args);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Request failed');
      }
    };

  const enqueue = useMutation({
    mutationFn: (input: string) =>
      // Deciding here rather than server-side keeps the API honest: the caller states
      // whether it has a link or a phrase.
      /^https?:\/\//i.test(input)
        ? api.enqueue(instanceId, { url: input })
        : api.enqueue(instanceId, { query: input }),
    onSuccess: () => {
      setSearchResults([]);
      void queryClient.invalidateQueries({ queryKey: ['player', instanceId] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not queue that'),
  });

  const search = useMutation({
    mutationFn: (terms: string) => api.search(instanceId, terms, 5),
    onSuccess: (result) => {
      setSearchResults(result.results);
      setError(null);
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Search failed'),
  });

  return (
    <div className="flex flex-col gap-4">
      {error !== null && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded border border-rose-700 bg-rose-950/50 px-4 py-2 text-sm text-rose-200"
        >
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            ✕
          </button>
        </div>
      )}

      {disabled && (
        <div className="rounded border border-amber-700 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
          This bot is {live.connection}
          {live.connectionError !== null && `: ${live.connectionError}`}. Controls are disabled
          until it reconnects.
        </div>
      )}

      <AddTrackBar
        disabled={disabled}
        busy={enqueue.isPending || search.isPending}
        searchResults={searchResults}
        onSubmit={(input) => enqueue.mutate(input)}
        onSearch={(terms) => search.mutate(terms)}
        onPickResult={(track) => enqueue.mutate(track.url)}
        onDismissResults={() => setSearchResults([])}
      />

      <NowPlaying
        player={live.player}
        onSeek={run((positionSec: number) => api.seek(instanceId, positionSec))}
      />

      <TransportControls
        player={live.player}
        disabled={disabled}
        onPause={run(() => api.pause(instanceId))}
        onResume={run(() => api.resume(instanceId))}
        onSkip={run(() => api.skip(instanceId))}
        onStop={run(() => api.stop(instanceId))}
        onVolume={run((volume: number) => api.setVolume(instanceId, volume))}
        onRepeat={run((mode: RepeatMode) => api.setRepeat(instanceId, mode))}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <QueueList
            queue={live.player?.queue ?? []}
            disabled={disabled}
            onRemove={run((itemId: string) => api.removeFromQueue(instanceId, itemId))}
            onMove={run((itemId: string, toIndex: number) =>
              api.moveInQueue(instanceId, itemId, toIndex),
            )}
            onShuffle={run(() => api.shuffleQueue(instanceId))}
            onClear={run(() => api.clearQueue(instanceId))}
          />
        </div>
        <CommandLog entries={live.commandLog} />
      </div>
    </div>
  );
}
