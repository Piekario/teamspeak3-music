import { useState } from 'react';

import { api, clearStoredToken, storeToken } from '../lib/api.ts';

interface TokenGateProps {
  readonly onAuthenticated: () => void;
}

/**
 * Collects the operator token.
 *
 * The token is verified against a real authenticated request before being accepted, so a
 * typo fails here with a clear message rather than leaving the panel in a state where every
 * later action silently 401s.
 */
export function TokenGate({ onAuthenticated }: TokenGateProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    setChecking(true);
    setError(null);
    storeToken(trimmed);

    try {
      await api.listInstances();
      onAuthenticated();
    } catch {
      clearStoredToken();
      setError('That token was not accepted.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <form
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800/50 p-6"
      >
        <h1 className="text-lg font-semibold text-slate-100">TeamSpeak Music</h1>
        <p className="mt-1 text-sm text-slate-400">
          Enter the operator token from your <code className="text-slate-300">.env</code>.
        </p>

        <input
          type="password"
          value={token}
          onChange={(changeEvent) => setToken(changeEvent.target.value)}
          placeholder="ADMIN_TOKEN"
          aria-label="Operator token"
          autoComplete="current-password"
          className="mt-4 w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100 placeholder:text-slate-600"
        />

        {error !== null && (
          <p role="alert" className="mt-2 text-sm text-rose-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={checking || token.trim().length === 0}
          className="mt-4 w-full rounded bg-emerald-500 px-4 py-2 font-medium text-slate-900 disabled:opacity-40"
        >
          {checking ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
