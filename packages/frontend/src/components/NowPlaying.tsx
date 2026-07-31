import type { PlayerState } from '@tsmusic/shared';
import { Music2, Radio } from 'lucide-react';
import { useState } from 'react';

import { useInterpolatedPosition } from '../hooks/use-interpolated-position.ts';
import { formatDuration } from '../lib/format.ts';
import { Badge } from './ui/badge.tsx';
import { Card } from './ui/card.tsx';
import { Slider } from './ui/slider.tsx';

interface NowPlayingProps {
  readonly player: PlayerState | null;
  readonly disabled: boolean;
  readonly onSeek: (positionSec: number) => void;
}

export function NowPlaying({ player, disabled, onSeek }: NowPlayingProps) {
  const position = useInterpolatedPosition(player);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const current = player?.current ?? null;

  if (current === null) {
    return (
      <Card className="flex items-center gap-4 p-5">
        <div className="grid size-16 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Music2 className="size-6" />
        </div>
        <div>
          <p className="font-medium">Nothing is playing</p>
          <p className="text-sm text-muted-foreground">
            Add a track above, or use <code className="font-mono text-xs">!play</code> in
            TeamSpeak.
          </p>
        </div>
      </Card>
    );
  }

  const { track, requestedBy } = current;
  const duration = track.durationSec;
  // A livestream has no meaningful length, so offering to scrub it would be a lie.
  const seekable = duration !== null && duration > 0;
  // While dragging, the bar follows the pointer rather than the server, which would otherwise
  // yank it back on every incoming state update.
  const shown = scrubbing ?? position;

  return (
    <Card className="overflow-hidden">
      <div className="flex gap-4 p-5">
        {track.thumbnailUrl === null ? (
          <div className="grid size-20 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Music2 className="size-7" />
          </div>
        ) : (
          <img
            src={track.thumbnailUrl}
            alt=""
            className="size-20 shrink-0 rounded-md object-cover"
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" title={track.title}>
              {track.title}
            </h2>
            {track.isLive && (
              <Badge variant="destructive" className="shrink-0">
                <Radio className="size-3" /> Live
              </Badge>
            )}
          </div>

          {track.uploader !== null && (
            <p className="truncate text-sm text-muted-foreground">{track.uploader}</p>
          )}
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Requested by {requestedBy.nickname}
          </p>
        </div>
      </div>

      <div className="px-5 pb-5">
        <Slider
          value={[seekable ? Math.min(shown, duration) : 0]}
          max={seekable ? duration : 1}
          step={1}
          disabled={disabled || !seekable}
          aria-label="Seek"
          onValueChange={([value]) => setScrubbing(value ?? 0)}
          onValueCommit={([value]) => {
            if (value !== undefined) onSeek(value);
            setScrubbing(null);
          }}
        />

        <div className="mt-2 flex justify-between text-xs tabular-nums text-muted-foreground">
          <span>{formatDuration(shown)}</span>
          <span>{seekable ? formatDuration(duration) : 'live'}</span>
        </div>
      </div>
    </Card>
  );
}
