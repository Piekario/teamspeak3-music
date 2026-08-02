import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, type Role } from '@tsmusic/shared';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { InstanceSummary } from '@tsmusic/shared';

import { ApiError, api } from '../lib/api.ts';
import { formatRelativeTime } from '../lib/format.ts';
import { Button } from './ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx';
import { Input } from './ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';

/** `blocked` is not offered: a credential nobody may use is a deleted credential. */
const GRANTABLE = ROLES.filter((role): role is Exclude<Role, 'blocked'> => role !== 'blocked');

const ROLE_MEANING: Readonly<Record<Exclude<Role, 'blocked'>, string>> = {
  user: 'queue tracks, load playlists, watch',
  dj: 'everything a user can, plus skip, pause, edit the queue and playlists',
  owner: 'everything, including bot settings and handing out access',
};

interface PanelAccessCardProps {
  readonly instances: readonly InstanceSummary[];
}

/**
 * Who may open the panel, and as what.
 *
 * The issued token is shown exactly once, in this card, and never again — only its hash is
 * stored, so nothing here or in the database can produce it a second time. That is the point
 * of storing a hash, and it is worth the inconvenience of having to hand it over there and
 * then.
 */
export function PanelAccessCard({ instances }: PanelAccessCardProps) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'blocked'>>('user');
  const [scope, setScope] = useState<string>('all');
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tokens = useQuery({ queryKey: ['panel-tokens'], queryFn: () => api.listPanelTokens() });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['panel-tokens'] });
  };

  const create = useMutation({
    mutationFn: async () => {
      setError(null);
      return await api.createPanelToken({
        label: label.trim(),
        role,
        instanceId: scope === 'all' ? null : scope,
      });
    },
    onSuccess: async (created) => {
      setIssued({ label: created.label, token: created.token });
      setCopied(false);
      setLabel('');
      await refresh();
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'Could not issue that token.');
    },
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.deletePanelToken(tokenId),
    onSuccess: refresh,
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'Could not revoke that token.');
    },
  });

  const all = tokens.data?.tokens ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Panel access</CardTitle>
        <CardDescription>
          One credential per person, so revoking somebody does not lock out everybody else.
          Roles are the same four the chat commands use.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error !== null && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {issued !== null && (
          <div className="space-y-2 rounded-md border border-success/40 bg-success/10 px-3 py-3">
            <p className="text-sm font-medium">Token for {issued.label}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background/60 px-2 py-1.5 font-mono text-xs">
                {issued.token}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.token);
                  setCopied(true);
                }}
              >
                <Copy /> {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
                Done
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Copy it now — only its hash is stored, so this is the last time anyone can read
              it. If it is lost, revoke this one and issue another.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <label htmlFor="token-label" className="text-sm font-medium leading-none">
              Who it is for
            </label>
            <Input
              id="token-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Ala"
              className="w-44"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="token-role" className="text-sm font-medium leading-none">
              Role
            </label>
            <Select value={role} onValueChange={(next) => setRole(next as typeof role)}>
              <SelectTrigger className="w-32" id="token-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRANTABLE.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="token-scope" className="text-sm font-medium leading-none">
              Which bot
            </label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-44" id="token-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every bot</SelectItem>
                {instances.map((instance) => (
                  <SelectItem key={instance.id} value={instance.id}>
                    {instance.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            disabled={label.trim().length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Issue token
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{role}: {ROLE_MEANING[role]}</p>

        <div className="border-t pt-3">
          {all.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody else has access yet. Your own operator token comes from the environment
              and is not listed here — it cannot be revoked from the panel, by design.
            </p>
          ) : (
            <ul className="divide-y">
              {all.map((token) => (
                <li key={token.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{token.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {token.role}
                      {' · '}
                      {token.instanceId === null
                        ? 'every bot'
                        : (instances.find((item) => item.id === token.instanceId)?.name ??
                          token.instanceId)}
                      {' · '}
                      {token.lastUsedAt === null
                        ? 'never used'
                        : `last used ${formatRelativeTime(token.lastUsedAt)}`}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke access for ${token.label}`}
                    className="hover:text-destructive"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(token.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
