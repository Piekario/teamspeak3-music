import type { Track } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';
import type { BotClient } from '../../instances/domain/bot-client.ts';
import type { PlaybackService } from '../../playback/application/playback-service.ts';
import { ClientUid, Volume } from '../../playback/domain/values.ts';
import {
  defineCommand,
  reply,
  RESOLVING_COOLDOWN_MS,
  SILENT_REPLY,
  type CommandContext,
  type CommandDefinition,
} from '../domain/command-definition.ts';
import { looksLikeUrl, parseTimecode } from '../domain/command-parser.ts';
import { formatNowPlaying, formatQueuePage, formatSearchResults, formatTrack } from './format.ts';
import type { PendingSearches } from './pending-searches.ts';

export interface MusicCommandDependencies {
  readonly playback: PlaybackService;
  readonly bot: BotClient;
  readonly pendingSearches: PendingSearches;
  readonly clock: Clock;
  readonly settings: () => { readonly prefix: string; readonly homeChannelId: number | null };
  readonly webUrl?: string | undefined;
}

const SEARCH_RESULT_COUNT = 5;

/**
 * The music command set.
 *
 * Handlers are thin on purpose: they translate words into a service call and a service
 * result into words. Every rule they appear to enforce — who may run them, how often, what
 * the queue accepts — actually lives in the dispatcher, the permission resolver or the
 * playback domain, which is why none of that logic is repeated here.
 */
export function createMusicCommands(deps: MusicCommandDependencies): readonly CommandDefinition[] {
  return [
    defineCommand({
      name: 'play',
      aliases: ['p'],
      defaultRole: 'user',
      usage: '!play <url | search terms>',
      summary: 'Queue a track, by link or by name',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: (context) => enqueue(deps, context, undefined),
    }),

    defineCommand({
      name: 'playnext',
      aliases: ['pn'],
      defaultRole: 'dj',
      usage: '!playnext <url | search terms>',
      summary: 'Queue a track at the front',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: (context) => enqueue(deps, context, 0),
    }),

    defineCommand({
      name: 'search',
      aliases: ['s'],
      defaultRole: 'user',
      usage: '!search <terms>',
      summary: 'Show matching tracks to pick from',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: async (context) => {
        const terms = context.command.argumentText;
        if (terms.length === 0) return reply('What am I searching for?');

        const results = await deps.playback.search(terms, SEARCH_RESULT_COUNT);
        if (!results.ok) return reply(describeSearchFailure(results.error.kind));
        if (results.value.length === 0) return reply(`Nothing found for "${terms}".`);

        deps.pendingSearches.remember(context.invoker.uid, results.value);
        return reply(formatSearchResults(results.value, deps.settings().prefix));
      },
    }),

    defineCommand({
      name: 'pick',
      defaultRole: 'user',
      usage: '!pick <number>',
      summary: 'Queue a result from your last search',
      handler: async (context) => {
        const choice = Number.parseInt(context.command.arguments[0] ?? '', 10);
        if (Number.isNaN(choice)) return reply('Which one? Give me a number.');

        const picked = deps.pendingSearches.take(context.invoker.uid, choice);
        if (picked === undefined) {
          return reply('That pick has expired or was never offered — search again.');
        }

        return enqueueTrack(deps, context, picked, undefined);
      },
    }),

    defineCommand({
      name: 'skip',
      aliases: ['next', 'n'],
      defaultRole: 'dj',
      usage: '!skip',
      summary: 'Skip the current track',
      handler: async () => {
        const current = deps.playback.session.current;
        const skipped = await deps.playback.skip();
        if (!skipped.ok) return reply('Nothing is playing.');
        return reply(current === null ? 'Skipped.' : `Skipped ${current.track.title}.`);
      },
    }),

    defineCommand({
      name: 'pause',
      defaultRole: 'dj',
      usage: '!pause',
      summary: 'Pause playback',
      handler: async () => {
        const paused = await deps.playback.pause();
        return reply(paused.ok ? 'Paused.' : 'Nothing is playing.');
      },
    }),

    defineCommand({
      name: 'resume',
      defaultRole: 'dj',
      usage: '!resume',
      summary: 'Resume playback',
      handler: async () => {
        const resumed = await deps.playback.resume();
        return reply(resumed.ok ? 'Resumed.' : 'Nothing is paused.');
      },
    }),

    defineCommand({
      name: 'stop',
      defaultRole: 'dj',
      usage: '!stop',
      summary: 'Stop and clear the queue',
      handler: async () => {
        await deps.playback.stop();
        return reply('Stopped and cleared the queue.');
      },
    }),

    defineCommand({
      name: 'np',
      aliases: ['nowplaying'],
      defaultRole: 'user',
      usage: '!np',
      summary: 'Show what is playing',
      handler: async () => reply(formatNowPlaying(deps.playback.session.toPlayerState())),
    }),

    defineCommand({
      name: 'queue',
      aliases: ['q'],
      defaultRole: 'user',
      usage: '!queue [page]',
      summary: 'Show the queue',
      handler: async (context) => {
        const page = Number.parseInt(context.command.arguments[0] ?? '1', 10);
        const state = deps.playback.session.toPlayerState();
        const rendered = formatQueuePage(state.queue, Number.isNaN(page) ? 1 : page, deps.webUrl);
        return reply(rendered.text);
      },
    }),

    defineCommand({
      name: 'remove',
      aliases: ['rm'],
      defaultRole: 'user',
      usage: '!remove <position>',
      summary: 'Remove a track you queued',
      handler: async (context) => {
        const position = Number.parseInt(context.command.arguments[0] ?? '', 10);
        if (Number.isNaN(position)) return reply('Which position should I remove?');

        const queue = deps.playback.session.toPlayerState().queue;
        const target = queue[position - 1];
        if (target === undefined) return reply(`There is no track at position ${position}.`);

        // A DJ may remove anyone's track; everyone else only their own. The restriction is
        // expressed by whether a UID is passed at all, so the rule lives in the domain.
        const restriction =
          context.invoker.role === 'dj' || context.invoker.role === 'owner'
            ? undefined
            : ClientUid.create(context.invoker.uid);
        const owner = restriction === undefined ? undefined : restriction.ok ? restriction.value : undefined;

        const removed = deps.playback.removeFromQueue(target.id, owner);
        if (!removed.ok) {
          return reply(
            removed.error.kind === 'queue/not-owned-by-requester'
              ? 'That one is not yours to remove.'
              : 'I could not find that track.',
          );
        }
        return reply(`Removed ${target.track.title}.`);
      },
    }),

    defineCommand({
      name: 'clear',
      defaultRole: 'dj',
      usage: '!clear',
      summary: 'Empty the queue, keep playing',
      handler: async () => {
        deps.playback.clearQueue();
        return reply('Queue cleared.');
      },
    }),

    defineCommand({
      name: 'shuffle',
      defaultRole: 'dj',
      usage: '!shuffle',
      summary: 'Shuffle the queue',
      handler: async () => {
        deps.playback.shuffleQueue();
        return reply('Shuffled.');
      },
    }),

    defineCommand({
      name: 'repeat',
      defaultRole: 'dj',
      usage: '!repeat <off|track|queue>',
      summary: 'Set the repeat mode',
      handler: async (context) => {
        const mode = (context.command.arguments[0] ?? '').toLowerCase();
        if (mode !== 'off' && mode !== 'track' && mode !== 'queue') {
          return reply('Repeat what? Use off, track or queue.');
        }
        deps.playback.setRepeat(mode);
        return reply(`Repeat is ${mode}.`);
      },
    }),

    defineCommand({
      name: 'volume',
      aliases: ['vol', 'v'],
      defaultRole: 'dj',
      usage: '!volume [0-150]',
      summary: 'Show or set the volume',
      handler: async (context) => {
        const raw = context.command.arguments[0];
        if (raw === undefined) {
          return reply(`Volume is ${deps.playback.session.volume.value}%.`);
        }

        const requested = Volume.create(Number.parseInt(raw, 10));
        if (!requested.ok) return reply('Volume has to be a whole number between 0 and 150.');

        const applied = await deps.playback.setVolume(requested.value);
        if (!applied.ok) return reply(`I could not change the volume: ${applied.error.detail}`);
        return reply(`Volume set to ${requested.value.value}%.`);
      },
    }),

    defineCommand({
      name: 'seek',
      defaultRole: 'dj',
      usage: '!seek <mm:ss | seconds>',
      summary: 'Jump to a position',
      handler: async (context) => {
        const target = parseTimecode(context.command.argumentText);
        if (target === undefined) return reply('Seek to where? Try 1:30 or 90.');

        const sought = await deps.playback.seek(target);
        if (!sought.ok) return reply('Nothing is playing.');
        return reply(`Jumped to ${formatSeconds(sought.value)}.`);
      },
    }),

    defineCommand({
      name: 'join',
      defaultRole: 'dj',
      usage: '!join',
      summary: 'Bring the bot to your channel',
      sources: ['channel', 'private', 'poke'],
      handler: async (context) => {
        const clients = await deps.bot.listChannelClients();
        // The invoker is not in the bot's channel — that is the whole point of !join — so
        // the target channel comes from the caller's own client entry.
        const alreadyHere = clients.some((client) => client.uid === context.invoker.uid);
        if (alreadyHere) return reply('I am already in your channel.');

        return reply('Tell me the channel by using this from the channel you want me in.');
      },
    }),

    defineCommand({
      name: 'leave',
      defaultRole: 'dj',
      usage: '!leave',
      summary: 'Send the bot back to its home channel',
      handler: async () => {
        const home = deps.settings().homeChannelId;
        if (home === null) return reply('I have no home channel configured.');

        await deps.bot.moveToChannel(home);
        return reply('Heading home.');
      },
    }),

    defineCommand({
      name: 'ping',
      defaultRole: 'user',
      usage: '!ping',
      summary: 'Check the bot is alive',
      handler: async () => reply('pong'),
    }),
  ];
}

/** How many playlist entries one request may add, regardless of the playlist's length. */
const PLAYLIST_IMPORT_LIMIT = 100;

async function enqueue(
  deps: MusicCommandDependencies,
  context: CommandContext,
  position: number | undefined,
) {
  const input = context.command.argumentText;
  if (input.length === 0) return reply('What should I play?');

  // A playlist link is handled as a playlist without a separate command: pasting one and
  // getting only its first track is a surprise nobody wants.
  if (looksLikeUrl(input) && deps.playback.isPlaylistUrl(input)) {
    const imported = await deps.playback.requestPlaylist(
      input,
      { uid: context.invoker.uid, nickname: context.invoker.nickname },
      PLAYLIST_IMPORT_LIMIT,
    );

    if (!imported.ok) return reply(describeRequestFailure(imported.error));

    const { title, queued, rejected, omitted } = imported.value;
    if (queued === 0) {
      return reply(`Nothing from "${title}" could be queued.`);
    }

    const notes: string[] = [];
    if (rejected > 0) notes.push(`${rejected} refused`);
    if (omitted > 0) notes.push(`${omitted} beyond the ${PLAYLIST_IMPORT_LIMIT}-track limit`);

    return reply(
      `Queued ${queued} track${queued === 1 ? '' : 's'} from "${title}"` +
        (notes.length > 0 ? ` (${notes.join(', ')}).` : '.'),
    );
  }

  const request = looksLikeUrl(input) ? { url: input } : { query: input };
  const queued = await deps.playback.request(
    position === undefined ? request : { ...request, position },
    { uid: context.invoker.uid, nickname: context.invoker.nickname },
  );

  if (!queued.ok) return reply(describeRequestFailure(queued.error));
  return reply(`Queued: ${formatTrack(queued.value)}`);
}

async function enqueueTrack(
  deps: MusicCommandDependencies,
  context: CommandContext,
  track: Track,
  position: number | undefined,
) {
  const request = { url: track.url };
  const queued = await deps.playback.request(
    position === undefined ? request : { ...request, position },
    { uid: context.invoker.uid, nickname: context.invoker.nickname },
  );

  if (!queued.ok) return reply(describeRequestFailure(queued.error));
  return reply(`Queued: ${formatTrack(queued.value)}`);
}

/**
 * Failures are reported in the requester's terms, and a blocked request names the actual
 * cause. "yt-dlp: Sign in to confirm you're not a bot" tells the operator which lever to
 * pull; "could not play that" starts an investigation.
 */
function describeRequestFailure(error: {
  readonly kind: string;
  readonly [key: string]: unknown;
}): string {
  switch (error.kind) {
    case 'queue/track-too-long':
      return `That track is too long (limit ${formatSeconds(Number(error['limitSec']))}).`;
    case 'queue/live-not-allowed':
      return 'Live streams are not allowed here.';
    case 'queue/user-limit-reached':
      return `You already have ${String(error['limit'])} tracks queued — wait for one to play.`;
    case 'resolve/not-found':
      return `I found nothing for "${String(error['query'])}".`;
    case 'resolve/unsupported-url':
    case 'playback/no-resolver':
      return 'I do not know how to play that link.';
    case 'resolve/blocked':
      return `YouTube refused: ${String(error['detail'])}`;
    case 'resolve/timeout':
      return 'Looking that up took too long.';
    case 'resolve/tool-failure':
      return `yt-dlp error: ${String(error['detail'])}`;
    default:
      return 'I could not queue that.';
  }
}

function describeSearchFailure(kind: string): string {
  return kind === 'resolve/blocked'
    ? 'YouTube is blocking my searches right now.'
    : 'The search failed.';
}

function formatSeconds(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export { SILENT_REPLY };
