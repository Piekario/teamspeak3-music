/**
 * Display formatting shared by the panel's components.
 */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';

  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const paddedSecs = String(secs).padStart(2, '0');
  if (hours === 0) return `${minutes}:${paddedSecs}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSecs}`;
}

/**
 * Playback position as of *now*.
 *
 * The backend sends a position plus the moment it was measured, never a tick. Interpolating
 * here means the progress bar moves smoothly at the browser's frame rate while the server
 * stays silent between real events — no 1 Hz stream of updates for every connected panel.
 */
export function interpolatePosition(
  positionSec: number,
  positionUpdatedAt: string,
  isPlaying: boolean,
  now: number = Date.now(),
): number {
  if (!isPlaying) return positionSec;

  const measuredAt = Date.parse(positionUpdatedAt);
  if (Number.isNaN(measuredAt)) return positionSec;

  const elapsedSec = Math.max(0, (now - measuredAt) / 1000);
  return positionSec + elapsedSec;
}

export function progressRatio(positionSec: number, durationSec: number | null): number {
  if (durationSec === null || durationSec <= 0) return 0;
  return Math.min(1, Math.max(0, positionSec / durationSec));
}

export function formatRelativeTime(isoTimestamp: string, now: number = Date.now()): string {
  const at = Date.parse(isoTimestamp);
  if (Number.isNaN(at)) return '';

  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
