import { execFile } from 'node:child_process';

import type { Track } from '@tsmusic/shared';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import type { ResolveError, ResolvedTrack, TrackResolver } from '../domain/ports.ts';

export interface YtDlpResolverOptions {
  readonly binary: string;
  /** Provider that supplies PO tokens; without one, datacenter IPs get challenged. */
  readonly potProviderUrl?: string | undefined;
  /** Cookies from a logged-in browser — often the only thing that beats the bot check. */
  readonly cookiesFile?: string | undefined;
  /**
   * Escape hatch for when YouTube changes extraction. Kept as configuration precisely so a
   * fix does not require a rebuild at the moment it is most urgently needed.
   */
  readonly extractorArgs?: string | undefined;
  /**
   * Egress proxy, e.g. `socks5://tunnel:1080`.
   *
   * The single most effective lever on a datacenter IP, and the only one that involves no
   * account. It must be paired with the same proxy on the media fetch: a googlevideo URL is
   * bound to the IP that requested it, so resolving through a proxy and streaming directly
   * yields a 403 every time.
   */
  readonly proxy?: string | undefined;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

/**
 * Resolves YouTube URLs and search terms via the `yt-dlp` binary.
 *
 * `yt-dlp-wrap` is deliberately not used: it has been unmaintained since 2023, and spawning
 * the binary directly is both smaller and one less thing to break when yt-dlp changes.
 *
 * This is the most fragile part of the system by a wide margin — YouTube actively works
 * against it, and breakage arrives without warning. Two consequences are designed in here:
 * every knob that might fix a breakage is configuration rather than code, and failures carry
 * yt-dlp's own words so the operator learns which lever to pull instead of seeing a shrug.
 */
export class YtDlpResolver implements TrackResolver {
  readonly #options: YtDlpResolverOptions;

  constructor(options: YtDlpResolverOptions) {
    this.#options = options;
  }

  supports(url: string): boolean {
    try {
      return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async resolveUrl(url: string): Promise<Result<ResolvedTrack, ResolveError>> {
    const output = await this.#runJson(['--no-playlist', url]);
    if (!output.ok) return output;

    const entry = firstEntry(output.value);
    if (entry === undefined) return err({ kind: 'resolve/not-found', query: url });
    return toResolvedTrack(entry);
  }

  async refresh(track: Track): Promise<Result<ResolvedTrack, ResolveError>> {
    return this.resolveUrl(track.url);
  }

  async search(query: string, limit: number): Promise<Result<readonly Track[], ResolveError>> {
    // `--flat-playlist` keeps search cheap: metadata only, no per-video extraction. The
    // chosen result is resolved properly when it is actually played.
    const output = await this.#runJson([
      '--flat-playlist',
      `ytsearch${Math.max(1, Math.trunc(limit))}:${query}`,
    ]);
    if (!output.ok) return output;

    const entries = collectEntries(output.value);
    if (entries.length === 0) return err({ kind: 'resolve/not-found', query });
    return ok(entries.map(toTrack));
  }

  #buildArgs(commandArgs: readonly string[]): string[] {
    const args = [
      '-J',
      '--no-warnings',
      '--no-progress',
      '--ignore-config',
      '-f',
      'bestaudio[acodec=opus]/bestaudio/best',
    ];

    if (this.#options.proxy !== undefined) {
      args.push('--proxy', this.#options.proxy);
    }

    if (this.#options.cookiesFile !== undefined) {
      args.push('--cookies', this.#options.cookiesFile);
    }

    const extractorArgs = this.#resolveExtractorArgs();
    for (const value of extractorArgs) {
      args.push('--extractor-args', value);
    }

    return [...args, ...commandArgs];
  }

  #resolveExtractorArgs(): string[] {
    const args: string[] = [];
    if (this.#options.extractorArgs !== undefined) {
      args.push(this.#options.extractorArgs);
    }
    if (this.#options.potProviderUrl !== undefined) {
      args.push(`youtube:getpot_bgutil_baseurl=${this.#options.potProviderUrl}`);
    }
    return args;
  }

  #runJson(commandArgs: readonly string[]): Promise<Result<unknown, ResolveError>> {
    const args = this.#buildArgs(commandArgs);

    return new Promise((resolve) => {
      execFile(
        this.#options.binary,
        args,
        {
          timeout: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolve(err(classifyFailure(error, stderr, commandArgs)));
            return;
          }
          try {
            resolve(ok(JSON.parse(stdout) as unknown));
          } catch {
            resolve(err({ kind: 'resolve/tool-failure', detail: 'yt-dlp returned invalid JSON' }));
          }
        },
      );
    });
  }
}

/**
 * Turns yt-dlp's stderr into an error the operator can act on. The distinction that matters
 * most is a bot challenge versus an ordinary failure: the former means "supply cookies or a
 * PO token", and reporting it plainly in chat is what stops a Saturday-night outage from
 * becoming an investigation.
 */
/**
 * The shape `child_process` actually hands back on failure. Declared structurally rather
 * than reusing `ErrnoException`, whose `code` is typed as a string even though exec reports
 * an exit status here, and which knows nothing about `killed`.
 */
export interface ProcessFailure {
  readonly message: string;
  readonly code?: string | number | null;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
}

export function classifyFailure(
  error: ProcessFailure,
  stderr: string,
  commandArgs: readonly string[],
): ResolveError {
  if (error.code === 'ENOENT') {
    return { kind: 'resolve/tool-failure', detail: 'yt-dlp binary not found' };
  }
  if (error.killed === true || error.signal === 'SIGTERM') {
    return { kind: 'resolve/timeout' };
  }

  const message = stderr.trim();
  const lowered = message.toLowerCase();

  if (
    lowered.includes('sign in to confirm') ||
    lowered.includes('confirm you') ||
    lowered.includes('bot')
  ) {
    return {
      kind: 'resolve/blocked',
      detail: firstErrorLine(message) ?? 'YouTube demanded sign-in verification',
    };
  }
  if (lowered.includes('unsupported url')) {
    return { kind: 'resolve/unsupported-url', url: commandArgs.at(-1) ?? '' };
  }
  if (
    lowered.includes('video unavailable') ||
    lowered.includes('private video') ||
    lowered.includes('does not exist') ||
    lowered.includes('no video results')
  ) {
    return { kind: 'resolve/not-found', query: commandArgs.at(-1) ?? '' };
  }

  return {
    kind: 'resolve/tool-failure',
    detail: firstErrorLine(message) ?? error.message,
  };
}

function firstErrorLine(stderr: string): string | undefined {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('ERROR:'))
    ?.replace(/^ERROR:\s*/, '');
}

// ─── yt-dlp JSON mapping ────────────────────────────────────────────────────

interface YtDlpEntry {
  readonly id?: string;
  readonly title?: string;
  readonly uploader?: string;
  readonly channel?: string;
  readonly duration?: number;
  readonly thumbnail?: string;
  readonly webpage_url?: string;
  readonly url?: string;
  readonly is_live?: boolean;
  readonly live_status?: string;
  readonly entries?: readonly YtDlpEntry[];
  readonly requested_downloads?: readonly { readonly url?: string }[];
}

function firstEntry(payload: unknown): YtDlpEntry | undefined {
  const entry = payload as YtDlpEntry | undefined;
  if (entry === undefined) return undefined;
  if (entry.entries !== undefined) return entry.entries[0];
  return entry;
}

function collectEntries(payload: unknown): readonly YtDlpEntry[] {
  const root = payload as YtDlpEntry | undefined;
  if (root === undefined) return [];
  if (root.entries !== undefined) return root.entries;
  return [root];
}

export function toTrack(entry: YtDlpEntry): Track {
  const id = entry.id ?? '';
  return {
    source: 'youtube',
    sourceId: id,
    url: entry.webpage_url ?? (id.length > 0 ? `https://www.youtube.com/watch?v=${id}` : ''),
    title: entry.title ?? 'Unknown title',
    uploader: entry.uploader ?? entry.channel ?? null,
    // A livestream reports no duration; `null` means unknown, never zero.
    durationSec: typeof entry.duration === 'number' && entry.duration > 0 ? entry.duration : null,
    thumbnailUrl: entry.thumbnail ?? null,
    isLive: entry.is_live === true || entry.live_status === 'is_live',
  };
}

function toResolvedTrack(entry: YtDlpEntry): Result<ResolvedTrack, ResolveError> {
  const streamUrl = entry.requested_downloads?.[0]?.url ?? entry.url;
  if (streamUrl === undefined || streamUrl.length === 0) {
    return err({ kind: 'resolve/tool-failure', detail: 'yt-dlp returned no playable stream URL' });
  }

  return ok({
    track: toTrack(entry),
    streamUrl,
    expiresAt: expiryOf(streamUrl),
  });
}

/**
 * Media URLs carry their own expiry as a query parameter. Reading it lets a queued track be
 * re-resolved lazily instead of failing at the moment it finally comes up to play.
 */
export function expiryOf(streamUrl: string): Date | null {
  try {
    const expire = new URL(streamUrl).searchParams.get('expire');
    if (expire === null) return null;
    const epochSeconds = Number.parseInt(expire, 10);
    if (Number.isNaN(epochSeconds)) return null;
    return new Date(epochSeconds * 1000);
  } catch {
    return null;
  }
}
