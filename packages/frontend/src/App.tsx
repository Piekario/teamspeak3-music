import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Music2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AddInstanceDialog, type NewInstance } from './components/AddInstanceDialog.tsx';
import { InstanceSwitcher } from './components/InstanceSwitcher.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Button } from './components/ui/button.tsx';
import { Card } from './components/ui/card.tsx';
import { cn } from './lib/utils.ts';
import { useLiveSocket } from './hooks/use-live-socket.ts';
import { useTheme } from './hooks/use-theme.ts';
import { ApiError, api, clearStoredToken, readStoredToken } from './lib/api.ts';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { TokenGate } from './pages/TokenGate.tsx';
import { useLiveStore } from './store/live-store.ts';

export function App() {
  const [authenticated, setAuthenticated] = useState(() => readStoredToken() !== null);
  // Mounted at the root so the theme applies to the sign-in screen too.
  const theme = useTheme();

  if (!authenticated) {
    return <TokenGate theme={theme} onAuthenticated={() => setAuthenticated(true)} />;
  }

  return <Shell theme={theme} onSignOut={() => setAuthenticated(false)} />;
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
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

  // Select the first bot once the list arrives, but never override a deliberate choice.
  useEffect(() => {
    if (selectedId !== null) return;
    const first = instances.data?.instances[0];
    if (first !== undefined) setSelectedId(first.id);
  }, [instances.data, selectedId]);

  const signOut = (): void => {
    clearStoredToken();
    resetLive();
    onSignOut();
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
            onAdd={() => {
              setAddError(null);
              setAddOpen(true);
            }}
          />
        </div>

        <div className="space-y-2 border-t p-3">
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
                Add one and it will join your TeamSpeak server straight away.
              </p>
              <Button className="mx-auto mt-5" onClick={() => setAddOpen(true)}>
                <Plus /> Add a bot
              </Button>
            </Card>
          )}

          {selectedId !== null && selected !== undefined && (
            <>
              <header className="mb-5">
                <h1 className="text-xl font-semibold tracking-tight">{selected.name}</h1>
                <p className="text-sm text-muted-foreground">
                  {selected.teamspeak.host}:{selected.teamspeak.port} · {selected.teamspeak.nickname}
                </p>
              </header>
              <DashboardPage instanceId={selectedId} />
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
