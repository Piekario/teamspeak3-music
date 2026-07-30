import type { PlayerState } from '@tsmusic/shared';
import { useEffect, useState } from 'react';

import { interpolatePosition } from '../lib/format.ts';

/**
 * Playback position, advanced locally between server events.
 *
 * The backend deliberately never ticks position over the wire — it sends a value plus the
 * instant it was measured. Driving the progress bar from `requestAnimationFrame` here gives
 * smooth motion while the server stays quiet, and it costs nothing when playback is paused
 * because the loop is not started at all.
 */
export function useInterpolatedPosition(player: PlayerState | null): number {
  const [position, setPosition] = useState(0);

  const isPlaying = player?.status === 'playing';
  const reportedPosition = player?.positionSec ?? 0;
  const measuredAt = player?.positionUpdatedAt ?? '';

  useEffect(() => {
    if (!isPlaying) {
      setPosition(reportedPosition);
      return;
    }

    let frame = 0;
    const tick = (): void => {
      setPosition(interpolatePosition(reportedPosition, measuredAt, true));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [isPlaying, reportedPosition, measuredAt]);

  return position;
}
