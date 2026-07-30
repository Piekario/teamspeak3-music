import type { PlayerState, QueueItem, Track } from '@tsmusic/shared';

import { Duration } from '../../playback/domain/values.ts';

/**
 * Chat formatting.
 *
 * Kept apart from the handlers because TeamSpeak's 1024-character limit makes presentation a
 * real constraint rather than a cosmetic one: a queue of forty tracks has to become
 * something readable, not something truncated mid-entry.
 */

const QUEUE_PAGE_SIZE = 10;
const PROGRESS_BAR_WIDTH = 20;

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'live';
  const duration = Duration.fromSeconds(seconds);
  return duration.ok ? duration.value.format() : '?';
}

export function formatTrack(track: Track): string {
  const uploader = track.uploader === null ? '' : ` — ${track.uploader}`;
  return `${track.title}${uploader} [${formatDuration(track.durationSec)}]`;
}

export function formatNowPlaying(state: PlayerState): string {
  if (state.current === null) return 'Nothing is playing.';

  const track = state.current.track;
  const duration = track.durationSec;
  const position = Math.floor(state.positionSec);

  const bar = duration === null ? '' : `\n${progressBar(position, duration)} `;
  const timing =
    duration === null
      ? `${formatDuration(position)} (live)`
      : `${formatDuration(position)} / ${formatDuration(duration)}`;

  return (
    `Now playing: ${track.title}` +
    (track.uploader === null ? '' : ` — ${track.uploader}`) +
    `${bar}${timing}` +
    `\nRequested by ${state.current.requestedBy.nickname} · volume ${state.volume}%` +
    (state.repeat === 'off' ? '' : ` · repeat ${state.repeat}`)
  );
}

function progressBar(positionSec: number, durationSec: number): string {
  const ratio = durationSec <= 0 ? 0 : Math.min(1, Math.max(0, positionSec / durationSec));
  const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
  return `[${'='.repeat(filled)}${'-'.repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

export interface QueuePage {
  readonly text: string;
  readonly page: number;
  readonly pageCount: number;
}

/**
 * Renders one page of the queue. Paging rather than truncating means the tail of a long
 * queue stays reachable from chat, and the page count tells the caller more exists.
 */
export function formatQueuePage(
  items: readonly QueueItem[],
  requestedPage: number,
  webUrl?: string,
): QueuePage {
  if (items.length === 0) {
    return { text: 'The queue is empty.', page: 1, pageCount: 1 };
  }

  const pageCount = Math.max(1, Math.ceil(items.length / QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage)), pageCount);
  const start = (page - 1) * QUEUE_PAGE_SIZE;
  const slice = items.slice(start, start + QUEUE_PAGE_SIZE);

  const lines = slice.map((item, offset) => {
    const position = start + offset + 1;
    return `${position}. ${formatTrack(item.track)} · ${item.requestedBy.nickname}`;
  });

  const totalSeconds = items.reduce((sum, item) => sum + (item.track.durationSec ?? 0), 0);
  const header = `Queue — ${items.length} track${items.length === 1 ? '' : 's'}, ${formatDuration(totalSeconds)} total (page ${page}/${pageCount})`;
  const footer = pageCount > 1 && webUrl !== undefined ? `\nFull queue: ${webUrl}` : '';

  return { text: `${header}\n${lines.join('\n')}${footer}`, page, pageCount };
}

export function formatSearchResults(tracks: readonly Track[], prefix: string): string {
  const lines = tracks.map((track, index) => `${index + 1}. ${formatTrack(track)}`);
  return `${lines.join('\n')}\nPick one with ${prefix}pick <number>`;
}
