import { Loader2, Music2 } from 'lucide-react';
import { useState } from 'react';

import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import type { useTheme } from '../hooks/use-theme.ts';
import { api } from '../lib/api.ts';

interface TokenGateProps {
  readonly theme: ReturnType<typeof useTheme>;
  readonly onAuthenticated: () => void;
}

/**
 * Collects a token and trades it for a session.
 *
 * The token is verified by the exchange itself, so a typo fails here with a clear message
 * instead of leaving the panel in a state where every later action silently 401s. What comes
 * back is a cookie the server set: the token is never written anywhere a script can read it,
 * and nobody has to type it again on this browser.
 */
export function TokenGate({ theme, onAuthenticated }: TokenGateProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;

    setChecking(true);
    setError(null);

    try {
      await api.signIn(trimmed);
      onAuthenticated();
    } catch {
      setError('That token was not accepted.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-end">
          <ThemeToggle
            preference={theme.preference}
            resolved={theme.resolved}
            onChange={theme.setPreference}
          />
        </div>

        <Card className="p-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="mb-6 flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground"
              >
                <Music2 className="size-4" />
              </span>
              <div>
                <h1 className="font-semibold leading-tight">TeamSpeak Music</h1>
                <p className="text-xs text-muted-foreground">Operator sign-in</p>
              </div>
            </div>

            <label htmlFor="operator-token" className="text-sm font-medium leading-none">
              Token
            </label>
            <Input
              id="operator-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="ADMIN_TOKEN"
              autoComplete="current-password"
              className="mt-1.5"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              From <code className="font-mono">ADMIN_TOKEN</code> in your{' '}
              <code className="font-mono">.env</code>.
            </p>

            {error !== null && (
              <p
                role="alert"
                className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={checking || token.trim().length === 0}
              className="mt-5 w-full"
            >
              {checking && <Loader2 className="animate-spin" />}
              {checking ? 'Checking…' : 'Continue'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
