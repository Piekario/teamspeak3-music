import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListMusic, LogOut, Music2, Plus, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AddInstanceDialog, type NewInstance } from './components/AddInstanceDialog.tsx';
import { InstanceSwitcher } from './components/InstanceSwitcher.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Button } from './components/ui/button.tsx';
import { Card } from './components/ui/card.tsx';
import { cn } from './lib/utils.ts';
import { useCan, useIdentity } from './hooks/use-identity.ts';
import { useLiveSocket } from './hooks/use-live-socket.ts';
import { useTheme } from './hooks/use-theme.ts';
import { ApiError, api, readSelectedInstance, storeSelectedInstance } from './lib/api.ts';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { PlaylistsPage } from './pages/PlaylistsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TokenGate } from './pages/TokenGate.tsx';

const TABS = ['player', 'playlists', 'settings'] as const;

const TAB_ICONS = {
  player: <Music2 className="size-3.5" />,
  playlists: <ListMusic className="size-3.5" />,
  settings: <Settings className="size-3.5" />,
} as const;
import { useLiveStore } from './store/live-store.ts';

export function App() {
  // Mounted at the root so the theme applies to the sign-in screen too.
  const theme = useTheme();
  const queryClient = useQueryClient();

  /**
   * Whether the browser already holds a session.
   *
   * Asked of the server rather than read from storage, because the cookie carrying it is
   * invisible to scripts — which is the point of it. No retry: a 401 here is an answer, not
   * a failure worth attempting again.
   */
  const session = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Deliberately blank rather than a spinner: the answer arrives in milliseconds from the
  // same origin, and a flash of loading state before a sign-in form reads as a glitch.
  if (session.isPending) return <div className="h-full bg-background" />;

  if (session.isError) {
    return (
      <TokenGate
        theme={theme}
        onAuthenticated={() => {
          void queryClient.invalidateQueries({ queryKey: ['me'] });
        }}
      />
    );
  }

  return (
    <Shell
      theme={theme}
      onSignOut={() => {
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      }}
    />
  );
}

interface ShellProps {
  readonly theme: ReturnType<typeof useTheme>;
  readonly onSignOut: () => void;
}

function Shell({ theme, onSignOut }: ShellProps) {
  // Mounted once for the whole panel: one socket carries every bot's events.
  useLiveSocket();

  const socketConnected = useLiveStore((state) => state.socketConnected);
  const byInstance = useLiveStore((state) => state.byInstance);
  const resetLive = useLiveStore((state) => state.reset);
  const queryClient = useQueryClient();

  // Remembered across reloads: which bot you are looking at is a place in the app, and
  // being dropped back on the first one after every refresh makes a two-bot panel tiring.
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedInstance());
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState<'player' | 'playlists' | 'settings'>('player');
  const identity = useIdentity();
  const isOwner = useCan('owner');
  const [addError, setAddError] = useState<string | null>(null);

  const instances = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.listInstances(),
  });

  const createInstance = useMutation({
    mutationFn: (instance: NewInstance) =>
      api.createInstance({
        id: instance.id,
        name: instance.name,
        teamspeak: {
          host: instance.host,
          port: instance.port,
          nickname: instance.nickname,
        },
        serverPassword: instance.serverPassword,
      }),
    onSuccess: async (created) => {
      setAddOpen(false);
      setAddError(null);
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      setSelectedId(created.id);
    },
    onError: (error) =>
      setAddError(error instanceof ApiError ? error.message : 'Could not create the bot'),
  });

  // Falls back to the first bot once the list arrives — including when the remembered one
  // has since been deleted, which would otherwise leave the panel addressing a bot that is
  // not there.
  useEffect(() => {
    const all = instances.data?.instances;
    if (all === undefined) return;
    if (selectedId !== null && all.some((instance) => instance.id === selectedId)) return;

    setSelectedId(all[0]?.id ?? null);
  }, [instances.data, selectedId]);

  useEffect(() => {
    storeSelectedInstance(selectedId);
  }, [selectedId]);

  const signOut = (): void => {
    // Clearing the cookie is the server's to do; the panel only asks and forgets what it
    // was showing.
    void api.signOut().finally(() => {
      resetLive();
      queryClient.clear();
      onSignOut();
    });
  };

  const selected = instances.data?.instances.find((instance) => instance.id === selectedId);

  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-card">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground"
          >
            <Music2 className="size-4" />
          </span>
          <span className="text-sm font-semibold">TeamSpeak Music</span>
        </div>

        <div className="min-h-0 flex-1 px-2">
          <InstanceSwitcher
            instances={instances.data?.instances ?? []}
            selectedId={selectedId}
            connectionOf={(id) => byInstance[id]?.connection ?? 'disconnected'}
            onSelect={setSelectedId}
            onAdd={
              isOwner
                ? () => {
                    setAddError(null);
                    setAddOpen(true);
                  }
                : undefined
            }
          />
        </div>

        <div className="space-y-2 border-t p-3">
          {/* Who you are signed in as, because several people now share this panel and the
              answer decides which controls are missing. */}
          {identity !== undefined && (
            <p className="truncate px-2 text-xs text-muted-foreground" title={identity.label}>
              {identity.label} · {identity.role}
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  socketConnected ? 'bg-success' : 'bg-destructive',
                )}
                aria-hidden="true"
              />
              {socketConnected ? 'Live' : 'Reconnecting…'}
            </span>
            <ThemeToggle
              preference={theme.preference}
              resolved={theme.resolved}
              onChange={theme.setPreference}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            className="w-full justify-start px-2 text-muted-foreground"
          >
            <LogOut /> Sign out
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-6">
          {instances.isLoading && (
            <p className="text-sm text-muted-foreground">Loading bots…</p>
          )}

          {instances.isError && (
            <Card role="alert" className="border-destructive/40 p-5">
              <p className="font-medium text-destructive">Could not reach the backend.</p>
              <Button variant="outline" className="mt-3" onClick={() => void instances.refetch()}>
                Retry
              </Button>
            </Card>
          )}

          {instances.isSuccess && instances.data.instances.length === 0 && (
            <Card className="p-10 text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Music2 className="size-5" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">No bots yet</h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {isOwner
                  ? 'Add one and it will join your TeamSpeak server straight away.'
                  : 'Nothing has been shared with you yet — ask whoever runs the panel.'}
              </p>
              {isOwner && (
                <Button className="mx-auto mt-5" onClick={() => setAddOpen(true)}>
                  <Plus /> Add a bot
                </Button>
              )}
            </Card>
          )}

          {selectedId !== null && selected !== undefined && (
            <>
              <header className="mb-5 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold tracking-tight">
                    {selected.name}
                  </h1>
                  <p className="truncate text-sm text-muted-foreground">
                    {selected.teamspeak.host}:{selected.teamspeak.port} ·{' '}
                    {selected.teamspeak.nickname}
                    {selected.teamspeak.channel !== null && ` · ${selected.teamspeak.channel}`}
                  </p>
                </div>

                <div className="flex shrink-0 rounded-md border bg-muted/50 p-0.5">
                  {TABS.filter((value) => value !== 'settings' || isOwner).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTab(value)}
                      aria-current={tab === value ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm capitalize transition-colors',
                        tab === value
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {TAB_ICONS[value]}
                      {value}
                    </button>
                  ))}
                </div>
              </header>

              {tab === 'player' && <DashboardPage instanceId={selectedId} />}
              {tab === 'playlists' && <PlaylistsPage instanceId={selectedId} />}
              {tab === 'settings' && isOwner && (
                <SettingsPage
                  instanceId={selectedId}
                  onDeleted={() => {
                    setSelectedId(null);
                    setTab('player');
                  }}
                />
              )}
            </>
          )}
        </div>
      </main>

      <AddInstanceDialog
        open={addOpen}
        busy={createInstance.isPending}
        error={addError}
        onSubmit={(instance) => createInstance.mutate(instance)}
        onOpenChange={setAddOpen}
      />
    </div>
  );
}
