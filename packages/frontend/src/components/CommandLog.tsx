import type { TimestampedCommand } from '../store/live-store.ts';
import { formatRelativeTime } from '../lib/format.ts';

interface CommandLogProps {
  readonly entries: readonly TimestampedCommand[];
}

/**
 * A live view of what people are typing in TeamSpeak.
 *
 * Refusals are shown as prominently as successes on purpose: "why did the bot ignore me"
 * is the most common question an operator gets, and the answer is almost always a role or
 * a cooldown that only this log makes visible.
 */
export function CommandLog({ entries }: CommandLogProps) {
  if (entries.length === 0) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-300">Chat commands</h2>
        <p className="text-sm text-slate-500">Nothing yet.</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <h2 className="mb-2 text-sm font-semibold text-slate-300">Chat commands</h2>
      <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
        {entries.map((entry, index) => (
          <li
            key={`${entry.at}-${index}`}
            className="flex items-start gap-2 border-b border-slate-700/50 pb-1 last:border-0"
          >
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                entry.allowed ? 'bg-emerald-400' : 'bg-rose-500'
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-slate-200">
                <span className="text-slate-400">{entry.nickname}</span>{' '}
                <span className="font-mono">
                  {entry.command}
                  {entry.args.length > 0 && ` ${entry.args}`}
                </span>
              </p>
              {entry.reply !== null && entry.reply.length > 0 && (
                <p
                  className={`truncate text-xs ${entry.allowed ? 'text-slate-500' : 'text-rose-400'}`}
                >
                  {entry.reply}
                </p>
              )}
            </div>
            <time className="shrink-0 text-xs text-slate-600">
              {formatRelativeTime(entry.at)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
