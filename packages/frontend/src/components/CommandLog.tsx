import { MessageSquare } from 'lucide-react';

import { formatRelativeTime } from '../lib/format.ts';
import type { TimestampedCommand } from '../store/live-store.ts';
import { Card } from './ui/card.tsx';

interface CommandLogProps {
  readonly entries: readonly TimestampedCommand[];
}

/**
 * A live view of what people are typing in TeamSpeak.
 *
 * Refusals are shown as prominently as successes on purpose: "why did the bot ignore me" is
 * the most common question an operator gets, and the answer is almost always a role or a
 * cooldown that only this log makes visible.
 */
export function CommandLog({ entries }: CommandLogProps) {
  return (
    <Card className="overflow-hidden">
      <header className="border-b px-5 py-3.5">
        <h2 className="flex items-center gap-2 font-semibold">
          <MessageSquare className="size-4 text-muted-foreground" />
          Chat commands
        </h2>
      </header>

      {entries.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="max-h-80 divide-y overflow-y-auto">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex items-start gap-2.5 px-5 py-2.5">
              <span
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                  entry.allowed ? 'bg-success' : 'bg-destructive'
                }`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  <span className="text-muted-foreground">{entry.nickname}</span>{' '}
                  <span className="font-mono text-xs">
                    {entry.command}
                    {entry.args.length > 0 && ` ${entry.args}`}
                  </span>
                </p>
                {entry.reply !== null && entry.reply.length > 0 && (
                  <p
                    className={`truncate text-xs ${
                      entry.allowed ? 'text-muted-foreground' : 'text-destructive'
                    }`}
                  >
                    {entry.reply}
                  </p>
                )}
              </div>
              <time className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTime(entry.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
