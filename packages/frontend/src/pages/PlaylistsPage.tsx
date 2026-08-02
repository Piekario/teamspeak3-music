import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ListMusic,
  Loader2,
  Play,
  Plus,
  Save,
  Star,
  StarOff,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { useCan } from '../hooks/use-identity.ts';
import { ApiError, api, type PlaylistSummary } from '../lib/api.ts';
import { formatDuration } from '../lib/format.ts';
import { cn } from '../lib/utils.ts';

interface PlaylistsPageProps {
  readonly instanceId: string;
}

/**
 * Playlists for one bot: what is saved, what is in it, and which one plays when the queue
 * runs out.
 *
 * Two panes rather than one list of expanding rows — the tracks are the point of a playlist,
 * and hiding them behind a click makes "is this the right one?" a guessing game.
 */
export function PlaylistsPage({ instanceId }: PlaylistsPageProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [trackUrl, setTrackUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Queueing a saved playlist is queueing; building and deleting them is editing, and the
  // difference is exactly the one the chat commands already draw.
  const canEdit = useCan('dj');

  const playlists = useQuery({
    queryKey: ['playlists', instanceId],
    queryFn: () => api.listPlaylists(instanceId),
  });

  const all = playlists.data?.playlists ?? [];
  // Falls back to the first rather than showing an empty pane, and survives a deletion by
  // never trusting the stored id further than the list that is actually loaded.
  const selected = all.find((item) => item.id === selectedId) ?? all[0];

  const detail = useQuery({
    queryKey: ['playlist', instanceId, selected?.id],
    queryFn: () => api.getPlaylist(instanceId, selected?.id ?? ''),
    enabled: selected !== undefined,
  });

  // Each action is declared through the same hook so that "do it, refresh both panes, and
  // put any failure where somebody can read it" is written once rather than eight times.
  const action = { queryClient, instanceId, playlistId: selected?.id, setError };

  const create = usePlaylistAction(action, async () => {
    const created = await api.createPlaylist(instanceId, newName.trim());
    setNewName('');
    setSelectedId(created.id);
  });

  const saveQueue = usePlaylistAction(action, async () => {
    const created = await api.savePlaylistFromQueue(instanceId, newName.trim());
    setNewName('');
    setSelectedId(created.id);
  });

  const addTrack = usePlaylistAction(action, async () => {
    if (selected === undefined) return;
    await api.addToPlaylist(instanceId, selected.id, trackUrl.trim());
    setTrackUrl('');
  });

  const load = usePlaylistAction(action, async () => {
    if (selected !== undefined) await api.loadPlaylist(instanceId, selected.id);
  });

  const makeDefault = usePlaylistAction(action, async () => {
    if (selected === undefined) return;
    if (selected.isDefault) await api.clearDefaultPlaylist(instanceId);
    else await api.makePlaylistDefault(instanceId, selected.id);
  });

  const remove = usePlaylistAction(action, async () => {
    if (selected === undefined) return;
    await api.deletePlaylist(instanceId, selected.id);
    setSelectedId(null);
  });

  const removeTrack = usePlaylistAction(action, async (trackId?: string) => {
    if (selected === undefined || trackId === undefined) return;
    await api.removeFromPlaylist(instanceId, selected.id, trackId);
  });

  const readOnly = !canEdit;
  const busy =
    create.isPending ||
    saveQueue.isPending ||
    addTrack.isPending ||
    load.isPending ||
    makeDefault.isPending ||
    remove.isPending;

  return (
    <div className="space-y-4">
      {error !== null && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {canEdit && (
      <Card>
        <CardHeader>
          <CardTitle>New playlist</CardTitle>
          <CardDescription>
            Start an empty one, or capture whatever is playing and queued right now.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Playlist name"
            aria-label="New playlist name"
            className="w-56"
          />
          <Button
            variant="outline"
            disabled={newName.trim().length === 0 || busy}
            onClick={() => create.mutate(undefined)}
          >
            <Plus /> Create
          </Button>
          <Button
            variant="outline"
            disabled={newName.trim().length === 0 || busy}
            onClick={() => saveQueue.mutate(undefined)}
          >
            <Save /> Save the queue
          </Button>
        </CardContent>
      </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <header className="flex items-center gap-2 border-b px-5 py-3.5">
            <ListMusic className="size-4 text-muted-foreground" />
            <h2 className="font-semibold">Playlists</h2>
            <span className="ml-auto text-xs text-muted-foreground">{all.length}</span>
          </header>

          {playlists.isPending ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</p>
          ) : all.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              Nothing saved yet.{' '}
              {canEdit ? (
                <>
                  Name one above, or use{' '}
                  <code className="font-mono text-xs">!playlist save</code> in TeamSpeak.
                </>
              ) : (
                'A DJ can save one from the queue.'
              )}
            </p>
          ) : (
            <ul className="divide-y">
              {all.map((playlist) => (
                <li key={playlist.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(playlist.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-muted/50',
                      playlist.id === selected?.id && 'bg-muted',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{playlist.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {describe(playlist)}
                      </span>
                    </span>
                    {playlist.isDefault && <Badge variant="secondary">default</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          {selected === undefined ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              Pick a playlist to see what is in it.
            </p>
          ) : (
            <>
              <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{selected.name}</h2>
                  <p className="text-xs text-muted-foreground">{describe(selected)}</p>
                </div>

                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || selected.trackCount === 0}
                    onClick={() => load.mutate(undefined)}
                  >
                    <Play /> Queue it
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || readOnly}
                    onClick={() => makeDefault.mutate(undefined)}
                    title="Plays automatically when the queue runs out"
                  >
                    {selected.isDefault ? <StarOff /> : <Star />}
                    {selected.isDefault ? 'Unset default' : 'Make default'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || readOnly}
                    className="hover:text-destructive"
                    onClick={() => remove.mutate(undefined)}
                  >
                    <Trash2 /> Delete
                  </Button>
                </div>
              </header>

              {canEdit && (
              <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
                <Input
                  value={trackUrl}
                  onChange={(event) => setTrackUrl(event.target.value)}
                  placeholder="YouTube link — a track or a whole playlist"
                  aria-label="Link to add"
                  className="min-w-56 flex-1"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && trackUrl.trim().length > 0) {
                      addTrack.mutate(undefined);
                    }
                  }}
                />
                <Button
                  variant="outline"
                  disabled={trackUrl.trim().length === 0 || busy}
                  onClick={() => addTrack.mutate(undefined)}
                >
                  {addTrack.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                  Add
                </Button>
              </div>
              )}

              {detail.data === undefined ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</p>
              ) : detail.data.tracks.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                  Empty. Paste a link above to fill it.
                </p>
              ) : (
                <ol className="divide-y">
                  {detail.data.tracks.map((item, index) => (
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
                          {item.track.uploader ?? 'unknown'} ·{' '}
                          {formatDuration(item.track.durationSec)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || readOnly}
                        onClick={() => removeTrack.mutate(item.id)}
                        aria-label={`Remove ${item.track.title}`}
                        className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function describe(playlist: PlaylistSummary): string {
  if (playlist.trackCount === 0) return 'empty';
  return `${playlist.trackCount} track${playlist.trackCount === 1 ? '' : 's'} · ${formatDuration(
    playlist.totalDurationSec,
  )}`;
}

interface ActionContext {
  readonly queryClient: ReturnType<typeof useQueryClient>;
  readonly instanceId: string;
  readonly playlistId: string | undefined;
  readonly setError: (message: string | null) => void;
}

/**
 * One playlist action: run it, refresh both panes, and put any failure where somebody can
 * read it.
 *
 * Both queries are invalidated on every action because the panes show the same data from two
 * angles — adding a track changes the list's count as surely as it changes the track list —
 * and refreshing only the obvious one leaves the other quietly stale.
 */
function usePlaylistAction<T>(
  context: ActionContext,
  action: (argument?: string) => Promise<T>,
) {
  const { queryClient, instanceId, playlistId, setError } = context;

  return useMutation({
    mutationFn: async (argument?: string) => {
      setError(null);
      return await action(argument);
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'Something went wrong.');
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['playlists', instanceId] });
      await queryClient.invalidateQueries({ queryKey: ['playlist', instanceId, playlistId] });
    },
  });
}
