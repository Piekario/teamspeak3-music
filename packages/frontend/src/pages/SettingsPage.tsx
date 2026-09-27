import { ROLES, type Role } from '@tsmusic/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PanelAccessCard } from '../components/PanelAccessCard.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.tsx';
import { ApiError, api, type InstanceDetail } from '../lib/api.ts';
import { selectInstance, useLiveStore } from '../store/live-store.ts';

interface SettingsPageProps {
  readonly instanceId: string;
  readonly onDeleted: () => void;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Minutes on screen, seconds on the wire.
 *
 * Rounded up, so a limit typed as a whole number of minutes never refuses a track of exactly
 * that length on a rounding error nobody can see.
 */
function secondsToMinutes(seconds: number): string {
  return String(Math.ceil(seconds / 60));
}

function minutesToSeconds(minutes: string): number {
  const parsed = Number.parseInt(minutes, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed * 60;
}

/** A checkbox with the label and explanation beside it, the shape every toggle here takes. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="text-sm font-medium leading-none">{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/**
 * Everything about one bot that is worth changing after it exists.
 *
 * Passwords are write-only: the backend never returns them, so the fields start empty and an
 * empty field means "leave it as it is" rather than "clear it". Clearing is a deliberate
 * separate action, because silently wiping a channel password on an unrelated edit is the
 * kind of thing nobody notices until the bot cannot rejoin.
 */
export function SettingsPage({ instanceId, onDeleted }: SettingsPageProps) {
  const queryClient = useQueryClient();
  const live = useLiveStore(selectInstance(instanceId));
  const connected = live.connection === 'connected';

  // Shared with the sidebar's copy through the query cache, so opening settings issues no
  // extra request.
  const instances = useQuery({ queryKey: ['instances'], queryFn: () => api.listInstances() });

  const detail = useQuery({
    queryKey: ['instance', instanceId],
    queryFn: () => api.getInstance(instanceId),
  });

  // The server only answers this while the bot is actually connected to it, so there is no
  // point asking otherwise — the field just falls back to plain free text.
  const channels = useQuery({
    queryKey: ['instance', instanceId, 'channels'],
    queryFn: () => api.listChannels(instanceId),
    enabled: connected,
  });

  const [form, setForm] = useState<InstanceDetail | null>(null);
  const [channelPassword, setChannelPassword] = useState('');
  const [serverPassword, setServerPassword] = useState('');
  const [groups, setGroups] = useState<Record<string, Role>>({});
  const [newGroupId, setNewGroupId] = useState('');
  // Held as text, not numbers: a number input mid-edit is briefly empty, and coercing that
  // to 0 would silently turn "clearing the field to retype it" into "no limit".
  const [longestTrack, setLongestTrack] = useState('0');
  const [perUser, setPerUser] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (detail.data === undefined) return;

    // Defaulted rather than trusted. A backend one deploy behind the panel omits fields the
    // form expects, and reading straight through would take the whole screen down with a
    // render error instead of degrading to an empty section.
    setForm({
      ...detail.data,
      grants: {
        identities: detail.data.grants?.identities ?? {},
        serverGroups: detail.data.grants?.serverGroups ?? {},
      },
    });
    setGroups(detail.data.grants?.serverGroups ?? {});
    setLongestTrack(secondsToMinutes(detail.data.playback?.maxTrackSeconds ?? 0));
    setPerUser(String(detail.data.playback?.maxPerUser ?? 0));
  }, [detail.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (form === null) return;
      await api.updateInstance(instanceId, {
        name: form.name,
        teamspeak: {
          host: form.teamspeak.host,
          port: form.teamspeak.port,
          nickname: form.teamspeak.nickname,
          channel: form.teamspeak.channel,
          // Only sent when typed, so an untouched field leaves the stored password alone.
          ...(channelPassword === '' ? {} : { channelPassword }),
        },
        ...(serverPassword === '' ? {} : { serverPassword }),
        playback: {
          pauseWhenAlone: form.playback?.pauseWhenAlone ?? false,
          maxTrackSeconds: minutesToSeconds(longestTrack),
          maxPerUser: Number.parseInt(perUser, 10) || 0,
          allowLiveStreams: form.playback?.allowLiveStreams ?? false,
        },
        connectionSettings: { autoReconnect: form.connectionSettings?.autoReconnect ?? true },
        // Identities are passed through untouched: this screen edits group grants, and
        // sending an empty object would revoke every individual grant as a side effect.
        grants: { serverGroups: groups, identities: form.grants?.identities ?? {} },
      });
    },
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setChannelPassword('');
      setServerPassword('');
      await queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not save'),
  });

  const connection = useMutation({
    mutationFn: (action: 'start' | 'stop') =>
      action === 'start' ? api.startInstance(instanceId) : api.stopInstance(instanceId),
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not change connection'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteInstance(instanceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      onDeleted();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the bot'),
  });

  if (detail.isLoading || form === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            The bot reconnects on its own after a server restart. Disconnecting here stops
            that until you connect it again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Button
            onClick={() => connection.mutate(connected ? 'stop' : 'start')}
            disabled={connection.isPending}
            variant={connected ? 'outline' : 'default'}
          >
            {connection.isPending ? (
              <Loader2 className="animate-spin" />
            ) : connected ? (
              <Plug />
            ) : (
              <PlugZap />
            )}
            {connected ? 'Disconnect' : 'Connect'}
          </Button>
          <Badge variant={connected ? 'default' : 'secondary'}>{live.connection}</Badge>
          {live.channel !== null && (
            <span className="text-sm text-muted-foreground">in {live.channel.name}</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="settings-name" label="Name">
            <Input
              id="settings-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field id="settings-host" label="Host">
              <Input
                id="settings-host"
                value={form.teamspeak.host}
                onChange={(event) =>
                  setForm({ ...form, teamspeak: { ...form.teamspeak, host: event.target.value } })
                }
              />
            </Field>
            <Field id="settings-port" label="Port">
              <Input
                id="settings-port"
                type="number"
                value={form.teamspeak.port}
                onChange={(event) =>
                  setForm({
                    ...form,
                    teamspeak: { ...form.teamspeak, port: Number(event.target.value) },
                  })
                }
              />
            </Field>
          </div>

          <Field id="settings-nickname" label="Nickname">
            <Input
              id="settings-nickname"
              value={form.teamspeak.nickname}
              onChange={(event) =>
                setForm({
                  ...form,
                  teamspeak: { ...form.teamspeak, nickname: event.target.value },
                })
              }
            />
          </Field>

          <Field
            id="settings-server-password"
            label="Server password"
            hint={
              form.hasServerPassword
                ? 'A password is set. Type a new one to replace it.'
                : 'No password set.'
            }
          >
            <Input
              id="settings-server-password"
              type="password"
              value={serverPassword}
              placeholder={form.hasServerPassword ? '••••••••' : ''}
              onChange={(event) => setServerPassword(event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channel</CardTitle>
          <CardDescription>
            Joined on connect and again after every reconnect, since a server restart drops
            the bot into the default channel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            id="settings-channel"
            label="Channel name"
            hint={
              connected
                ? 'Pick one from the list, or type a name — it does not have to exist yet.'
                : 'Leave empty to stay wherever the server puts it. Connect the bot to pick from its channel list.'
            }
          >
            <Input
              id="settings-channel"
              list="settings-channel-options"
              autoComplete="off"
              value={form.teamspeak.channel ?? ''}
              placeholder="Music"
              onChange={(event) =>
                setForm({
                  ...form,
                  teamspeak: {
                    ...form.teamspeak,
                    channel: event.target.value === '' ? null : event.target.value,
                  },
                })
              }
            />
            <datalist id="settings-channel-options">
              {(channels.data?.channels ?? []).map((channel) => (
                <option key={channel.id} value={channel.name} />
              ))}
            </datalist>
          </Field>

          <Field
            id="settings-channel-password"
            label="Channel password"
            hint={
              form.hasChannelPassword
                ? 'A password is set. Type a new one to replace it.'
                : 'No password set.'
            }
          >
            <Input
              id="settings-channel-password"
              type="password"
              value={channelPassword}
              placeholder={form.hasChannelPassword ? '••••••••' : ''}
              onChange={(event) => setChannelPassword(event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Playback</CardTitle>
          <CardDescription>
            Limits are per bot. Zero means no limit — long recordings are what a music bot is
            for, and the one somebody regrets is what <code className="font-mono">!skip</code>{' '}
            is for.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="settings-longest-track"
              label="Longest track (minutes)"
              hint="0 = no limit. A ten-hour mix is 600."
            >
              <Input
                id="settings-longest-track"
                type="number"
                min={0}
                max={1440}
                value={longestTrack}
                onChange={(event) => setLongestTrack(event.target.value)}
              />
            </Field>

            <Field
              id="settings-per-user"
              label="Queued tracks per person"
              hint="0 = no limit. Stops one person filling the queue."
            >
              <Input
                id="settings-per-user"
                type="number"
                min={0}
                max={500}
                value={perUser}
                onChange={(event) => setPerUser(event.target.value)}
              />
            </Field>
          </div>

          <Toggle
            label="Allow live streams"
            hint="A stream never ends, so it holds the queue until somebody skips it. This is the setting that actually guards against that — a length limit cannot, since a stream reports no length."
            checked={form.playback?.allowLiveStreams ?? false}
            onChange={(next) =>
              setForm({ ...form, playback: { ...form.playback, allowLiveStreams: next } })
            }
          />

          <Toggle
            label="Pause when nobody is listening"
            hint="Pauses while the bot is alone in its channel and resumes when somebody returns. A pause you made yourself is never overridden. Leave off for a bot that is meant to keep broadcasting to an empty room."
            checked={form.playback?.pauseWhenAlone ?? false}
            onChange={(next) =>
              setForm({ ...form, playback: { ...form.playback, pauseWhenAlone: next } })
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <Toggle
            label="Reconnect automatically"
            hint="Brings the bot back after a server restart, a network drop or a kick, retrying with a growing delay. Turn it off to make the bot stay wherever you left it — including off the server."
            checked={form.connectionSettings?.autoReconnect ?? true}
            onChange={(next) =>
              setForm({
                ...form,
                connectionSettings: { ...form.connectionSettings, autoReconnect: next },
              })
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who may use the bot</CardTitle>
          <CardDescription>
            Maps a TeamSpeak server group to a role. Everyone else gets the default role
            ({form.permissions.defaultRole}). Roles: user can queue, dj can skip and stop,
            owner can change permissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.entries(groups).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No group grants yet — everyone falls back to the default role.
            </p>
          )}

          {Object.entries(groups).map(([groupId, role]) => (
            <div key={groupId} className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-mono text-sm">#{groupId}</span>
              <Select
                value={role}
                onValueChange={(next) => setGroups({ ...groups, [groupId]: next as Role })}
              >
                <SelectTrigger className="w-40" aria-label={`Role for group ${groupId}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove group ${groupId}`}
                onClick={() => {
                  const next = { ...groups };
                  delete next[groupId];
                  setGroups(next);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-2 border-t pt-3">
            <Input
              value={newGroupId}
              onChange={(event) => setNewGroupId(event.target.value)}
              placeholder="Server group id"
              className="w-40"
              aria-label="Server group id"
            />
            <Button
              variant="outline"
              disabled={!/^\d+$/.test(newGroupId) || newGroupId in groups}
              onClick={() => {
                setGroups({ ...groups, [newGroupId]: 'dj' });
                setNewGroupId('');
              }}
            >
              <Plus /> Add group
            </Button>
            <span className="text-xs text-muted-foreground">
              Find the id in TeamSpeak under Permissions → Server Groups.
            </span>
          </div>
        </CardContent>
      </Card>

      <PanelAccessCard instances={instances.data?.instances ?? []} />

      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          Save changes
        </Button>
        {saved && <span className="text-sm text-success">Saved.</span>}

        <Button
          variant="destructive"
          className="ml-auto"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete "${form.name}"? This cannot be undone.`)) {
              remove.mutate();
            }
          }}
        >
          <Trash2 /> Delete bot
        </Button>
      </div>
    </div>
  );
}
