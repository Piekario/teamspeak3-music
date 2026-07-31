import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx';
import { Input } from './ui/input.tsx';

export interface NewInstance {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly nickname: string;
  readonly serverPassword: string | null;
}

interface AddInstanceDialogProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (instance: NewInstance) => void;
  readonly onOpenChange: (open: boolean) => void;
}

/** Ids reach log lines and audio stream names, so they stay conservative. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
 * Creating a bot.
 *
 * Only what a bot genuinely cannot start without is asked for. Volume, limits, prefix and
 * permissions all have working defaults and are better adjusted later against a running bot
 * than guessed at in a form.
 */
export function AddInstanceDialog({
  open,
  busy,
  error,
  onSubmit,
  onOpenChange,
}: AddInstanceDialogProps) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(9987);
  const [nickname, setNickname] = useState('MusicBot');
  const [password, setPassword] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);

  useEffect(() => {
    if (open) return;
    setName('');
    setHost('');
    setPort(9987);
    setNickname('MusicBot');
    setPassword('');
    setId('');
    setIdEdited(false);
  }, [open]);

  // Derived from the name until deliberately changed: most people should never have to think
  // about it, but it is permanent, so it stays visible.
  const derivedId = idEdited
    ? id
    : name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);

  const idValid = ID_PATTERN.test(derivedId);
  const canSubmit = name.trim() !== '' && host.trim() !== '' && idValid && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a bot</DialogTitle>
          <DialogDescription>It will join the server as soon as it is created.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            onSubmit({
              id: derivedId,
              name: name.trim(),
              host: host.trim(),
              port,
              nickname: nickname.trim() || 'MusicBot',
              serverPassword: password.trim() === '' ? null : password,
            });
          }}
        >
          <Field id="instance-name" label="Name">
            <Input
              id="instance-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Party Bot"
              autoComplete="off"
            />
          </Field>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field id="instance-host" label="TeamSpeak server">
              <Input
                id="instance-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="ts.example.com"
                autoComplete="off"
              />
            </Field>
            <Field id="instance-port" label="Port">
              <Input
                id="instance-port"
                type="number"
                value={port}
                onChange={(event) => setPort(Number(event.target.value))}
                min={1}
                max={65535}
              />
            </Field>
          </div>

          <Field id="instance-nickname" label="Nickname on the server">
            <Input
              id="instance-nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              autoComplete="off"
            />
          </Field>

          <Field id="instance-password" label="Server password (optional)">
            <Input
              id="instance-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
            />
          </Field>

          <Field
            id="instance-id"
            label="Identifier"
            hint={
              idValid || derivedId === ''
                ? 'Permanent, and used in logs and audio streams.'
                : 'Lowercase letters, digits and dashes only.'
            }
          >
            <Input
              id="instance-id"
              value={derivedId}
              onChange={(event) => {
                setIdEdited(true);
                setId(event.target.value);
              }}
              placeholder="party-bot"
              autoComplete="off"
              className="font-mono text-xs"
            />
          </Field>

          {error !== null && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? 'Creating…' : 'Create bot'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
