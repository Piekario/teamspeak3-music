import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { InstanceSwitcher } from './components/InstanceSwitcher.tsx';
import { useLiveSocket } from './hooks/use-live-socket.ts';
import { TokenGate } from './pages/TokenGate.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { api, clearStoredToken, readStoredToken } from './lib/api.ts';
import { useLiveStore } from './store/live-store.ts';

export function App() {
  const [authenticated, setAuthenticated] = useState(() => readStoredToken() !== null);

  if (!authenticated) {
    return <TokenGate onAuthenticated={() => setAuthenticated(true)} />;
  }

  return <Shell onSignOut={() => setAuthenticated(false)} />;
}

function Shell({ onSignOut }: { readonly onSignOut: () => void }) {
  // Mounted once for the whole panel: a single socket carries every bot's events.
  useLiveSocket();

  const socketConnected = useLiveStore((state) => state.socketConnected);
  const byInstance = useLiveStore((state) => state.byInstance);
  const resetLive = useLiveStore((state) => state.reset);

  const instances = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.listInstances(),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  return (
    <div className="flex min-h-screen bg-slate-900 text-slate-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-950 p-3">
        <h1 className="px-3 py-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          TeamSpeak Music
        </h1>

        <InstanceSwitcher
          instances={instances.data?.instances ?? []}
          selectedId={selectedId}
          connectionOf={(id) => byInstance[id]?.connection ?? 'disconnected'}
          onSelect={setSelectedId}
        />

        <div className="mt-auto px-3 py-2">
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <span
              className={`h-2 w-2 rounded-full ${socketConnected ? 'bg-emerald-400' : 'bg-rose-500'}`}
              aria-hidden="true"
            />
            {socketConnected ? 'live' : 'reconnecting…'}
          </p>
          <button
            type="button"
            onClick={signOut}
            className="mt-2 text-xs text-slate-500 hover:text-slate-300"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        {instances.isLoading && <p className="text-slate-400">Loading bots…</p>}

        {instances.isError && (
          <div role="alert" className="rounded border border-rose-700 bg-rose-950/50 px-4 py-3">
            <p className="text-rose-200">Could not reach the backend.</p>
            <button
              type="button"
              onClick={() => void instances.refetch()}
              className="mt-2 rounded bg-slate-700 px-3 py-1 text-sm"
            >
              Retry
            </button>
          </div>
        )}

        {selectedId !== null && <DashboardPage instanceId={selectedId} />}

        {instances.isSuccess && instances.data.instances.length === 0 && (
          <p className="text-slate-400">
            No bots configured. Add one to <code>instances.json</code> and run{' '}
            <code>pnpm instances:generate</code>.
          </p>
        )}
      </main>
    </div>
  );
}
