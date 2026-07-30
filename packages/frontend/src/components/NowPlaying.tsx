import type { PlayerState } from '@tsmusic/shared';

import { useInterpolatedPosition } from '../hooks/use-interpolated-position.ts';
import { formatDuration, progressRatio } from '../lib/format.ts';

interface NowPlayingProps {
  readonly player: PlayerState | null;
  readonly onSeek: (positionSec: number) => void;
}

export function NowPlaying({ player, onSeek }: NowPlayingProps) {
  const position = useInterpolatedPosition(player);
  const current = player?.current ?? null;

  if (current === null) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-800/50 p-6">
        <p className="text-slate-400">Nothing is playing.</p>
      </section>
    );
  }

  const { track, requestedBy } = current;
  const duration = track.durationSec;
  // A livestream has no meaningful length, so scrubbing it would be a lie.
  const seekable = duration !== null && duration > 0;
  const ratio = progressRatio(position, duration);

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-800/50 p-6">
      <div className="flex gap-4">
        {track.thumbnailUrl !== null && (
          <img
            src={track.thumbnailUrl}
            alt=""
            className="h-20 w-20 shrink-0 rounded object-cover"
          />
        )}

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-slate-100" title={track.title}>
            {track.title}
          </h2>
          {track.uploader !== null && (
            <p className="truncate text-sm text-slate-400">{track.uploader}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Requested by {requestedBy.nickname}
            {track.isLive && ' · live'}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <input
          type="range"
          min={0}
          max={seekable ? duration : 1}
          step={1}
          value={seekable ? Math.min(position, duration) : 0}
          disabled={!seekable}
          onChange={(changeEvent) => onSeek(Number(changeEvent.target.value))}
          aria-label="Seek"
          className="w-full accent-emerald-400 disabled:opacity-40"
        />
        <div className="mt-1 flex justify-between text-xs tabular-nums text-slate-400">
          <span>{formatDuration(position)}</span>
          <span>{seekable ? formatDuration(duration) : 'live'}</span>
        </div>
        <div
          className="mt-1 h-1 overflow-hidden rounded bg-slate-700"
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-emerald-400" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
    </section>
  );
}
