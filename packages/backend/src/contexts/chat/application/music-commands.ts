import { roleSatisfies, type Track } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';
import type { BotClient } from '../../instances/domain/bot-client.ts';
import {
  describePlaylistError,
  type PlaylistService,
} from '../../catalog/application/playlist-service.ts';
import type { PlaybackService } from '../../playback/application/playback-service.ts';
import { ClientUid, Volume } from '../../playback/domain/values.ts';
import type { CommandName } from '@tsmusic/shared';

import {
  CommandRegistry,
  defineCommand,
  reply,
  RESOLVING_COOLDOWN_MS,
  SILENT_REPLY,
  type CommandContext,
  type CommandDefinition,
  type CommandInvoker,
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
  /**
   * Read lazily: `!help` has to describe the registry it lives in, which does not exist yet
   * when these definitions are built.
   */
  readonly registry: () => CommandRegistry;
  /** Same rule the dispatcher applies, so help never lists what it would then refuse. */
  readonly canUse: (invoker: CommandInvoker, command: CommandName) => boolean;
  /**
   * Playlist storage, absent when the instance runs without it. Read lazily for the same
   * reason as the registry: it is built from the playback service these commands close over.
   */
  readonly playlists: () => PlaylistService | undefined;
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
      summary: 'Play a track now, interrupting whatever is playing',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: (context) => enqueue(deps, context, { position: 0, interrupt: true }),
    }),

    defineCommand({
      name: 'add',
      aliases: ['a'],
      defaultRole: 'user',
      usage: '!add <url | search terms>',
      summary: 'Add a track to the end of the queue',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: (context) => enqueue(deps, context, {}),
    }),

    defineCommand({
      name: 'playnext',
      aliases: ['pn'],
      defaultRole: 'dj',
      usage: '!playnext <url | search terms>',
      summary: 'Queue a track at the front',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: (context) => enqueue(deps, context, { position: 0 }),
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

    defineCommand({
      name: 'playlist',
      aliases: ['pl'],
      defaultRole: 'user',
      usage: '!playlist [list | show <name> | load <name> | save <name> | add <name> <url> | default <name> | delete <name>]',
      summary: 'Saved playlists: play them, build them, pick the default',
      cooldownMs: RESOLVING_COOLDOWN_MS,
      handler: (context) => handlePlaylist(deps, context),
    }),

    defineCommand({
      name: 'help',
      aliases: ['?', 'commands'],
      defaultRole: 'user',
      usage: '!help [command]',
      summary: 'List what you can do',
      handler: async (context) => {
        const prefix = deps.settings().prefix;
        const registry = deps.registry();
        const named = context.command.arguments[0];

        if (named !== undefined) {
          const definition = registry.find(named.replace(prefix, ''));
          // Unknown and not-allowed are answered identically on purpose: telling somebody a
          // command exists but is closed to them is an invitation to go looking for a way in.
          if (definition === undefined || !deps.canUse(context.invoker, definition.name)) {
            return reply(`No command called "${named}" that you can use.`);
          }

          const aliases =
            definition.aliases.length === 0
              ? ''
              : `\nAlso: ${definition.aliases.map((alias) => prefix + alias).join(', ')}`;

          return reply(
            `${prefix}${definition.name} — ${definition.summary}\n` +
              `Usage: ${definition.usage.replace(/^!/, prefix)}${aliases}`,
          );
        }

        // Only what this person may actually run. A list full of commands that refuse them
        // is worse than no list at all.
        const usable = registry.all.filter((definition) =>
          deps.canUse(context.invoker, definition.name),
        );

        if (usable.length === 0) return reply('You cannot use any commands here.');

        const lines = usable.map(
          (definition) => `${prefix}${definition.name} — ${definition.summary}`,
        );

        return reply(
          `${lines.join('\n')}\n` +
            `Ask about one with ${prefix}help <command>.`,
        );
      },
    }),
  ];
}

/**
 * Everything `!playlist` can do, dispatched on its first word.
 *
 * Sub-commands rather than a command each, because `!playlist load party` reads the way
 * people already talk about playlists and keeps eight more names out of `!help`. The ones
 * that change something are gated at DJ, while listing and loading stay open — the risk of
 * somebody playing a saved playlist is nothing next to the risk of somebody deleting one.
 */
async function handlePlaylist(deps: MusicCommandDependencies, context: CommandContext) {
  const playlists = deps.playlists();
  if (playlists === undefined) return reply('Playlists are not available on this bot.');

  const prefix = deps.settings().prefix;
  const [action = 'list', ...rest] = context.command.arguments;
  const name = rest.join(' ').trim();
  const mayEdit = roleSatisfies(context.invoker.role, 'dj');

  switch (action.toLowerCase()) {
    case 'list': {
      const all = await playlists.list();
      if (all.length === 0) {
        return reply(`No playlists yet. Make one with ${prefix}playlist save <name>.`);
      }

      const lines = all.map(
        (playlist) =>
          `${playlist.name} — ${playlist.trackCount} track${playlist.trackCount === 1 ? '' : 's'}` +
          (playlist.isDefault ? ' (default)' : ''),
      );
      return reply(lines.join('\n'));
    }

    case 'show': {
      if (name.length === 0) return reply(`Which one? ${prefix}playlist show <name>`);

      const playlist = await playlists.find(name);
      if (playlist === undefined) return reply(`There is no playlist called "${name}".`);
      if (playlist.tracks.length === 0) return reply(`"${playlist.name}" is empty.`);

      // Capped: a chat message is 1024 characters, and a 200-track playlist would be cut off
      // mid-word by the server rather than by us.
      const shown = playlist.tracks.slice(0, PLAYLIST_PREVIEW_COUNT);
      const lines = shown.map((item, index) => `${index + 1}. ${formatTrack(item.track)}`);
      const remaining = playlist.tracks.length - shown.length;

      return reply(
        `${playlist.name}:\n${lines.join('\n')}` +
          (remaining > 0 ? `\n…and ${remaining} more.` : ''),
      );
    }

    case 'load':
    case 'play': {
      if (name.length === 0) return reply(`Which one? ${prefix}playlist load <name>`);

      const loaded = await playlists.load(name, {
        uid: context.invoker.uid,
        nickname: context.invoker.nickname,
      });
      if (!loaded.ok) return reply(describePlaylistError(loaded.error));

      const { playlist, queued, rejected } = loaded.value;
      return reply(
        `Queued ${queued} track${queued === 1 ? '' : 's'} from "${playlist.name}"` +
          (rejected > 0 ? ` (${rejected} refused).` : '.'),
      );
    }

    case 'save': {
      if (!mayEdit) return reply('You cannot change playlists.');
      if (name.length === 0) return reply(`Save it as what? ${prefix}playlist save <name>`);

      const saved = await playlists.saveCurrentQueue(name, context.invoker.uid);
      if (!saved.ok) return reply(describePlaylistError(saved.error));

      return reply(
        `Saved the queue as "${saved.value.name}". Play it with ${prefix}playlist load ${saved.value.name}.`,
      );
    }

    case 'add': {
      if (!mayEdit) return reply('You cannot change playlists.');

      // The URL is the last word, so playlist names may contain spaces.
      const url = rest.at(-1) ?? '';
      const target = rest.slice(0, -1).join(' ').trim();
      if (target.length === 0 || !looksLikeUrl(url)) {
        return reply(`${prefix}playlist add <name> <url>`);
      }

      const playlist = await playlists.find(target);
      if (playlist === undefined) return reply(`There is no playlist called "${target}".`);

      const added = await playlists.addFromUrl(playlist.id, url);
      if (!added.ok) return reply(describePlaylistError(added.error));

      const omitted =
        added.value.omitted > 0 ? ` (${added.value.omitted} beyond the import limit)` : '';
      return reply(
        `Added ${added.value.added} track${added.value.added === 1 ? '' : 's'} to "${playlist.name}"${omitted}.`,
      );
    }

    case 'default': {
      if (!mayEdit) return reply('You cannot change playlists.');

      // No name clears the default rather than erroring: "stop refilling" is a thing people
      // want, and there is no other way to ask for it.
      if (name.length === 0) {
        await playlists.setDefault(null);
        return reply('Cleared the default playlist; the queue will just run out now.');
      }

      const playlist = await playlists.find(name);
      if (playlist === undefined) return reply(`There is no playlist called "${name}".`);

      await playlists.setDefault(playlist.id);
      return reply(`"${playlist.name}" now plays when the queue runs out.`);
    }

    case 'delete':
    case 'remove': {
      if (!mayEdit) return reply('You cannot change playlists.');
      if (name.length === 0) return reply(`Delete which one? ${prefix}playlist delete <name>`);

      const playlist = await playlists.find(name);
      if (playlist === undefined) return reply(`There is no playlist called "${name}".`);

      await playlists.delete(playlist.id);
      return reply(`Deleted "${playlist.name}".`);
    }

    default:
      return reply(`I do not know ${prefix}playlist ${action}. Try ${prefix}help playlist.`);
  }
}

/** As many entries as fit comfortably in one chat message. */
const PLAYLIST_PREVIEW_COUNT = 10;

/** How many playlist entries one request may add, regardless of the playlist's length. */
const PLAYLIST_IMPORT_LIMIT = 100;

/**
 * How a request joins the queue.
 *
 * `!play` and `!add` differ only in this, so they share one path rather than two that would
 * drift: both resolve the same way, refuse the same things and answer with the same wording.
 */
interface EnqueueMode {
  /** Where in the queue it lands; the end when absent. */
  readonly position?: number;
  /** Whether to cut short whatever is playing so this starts immediately. */
  readonly interrupt?: boolean;
}

async function enqueue(
  deps: MusicCommandDependencies,
  context: CommandContext,
  mode: EnqueueMode,
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
  return await submit(deps, context, request, mode);
}

async function enqueueTrack(
  deps: MusicCommandDependencies,
  context: CommandContext,
  track: Track,
  position: number | undefined,
) {
  return await submit(
    deps,
    context,
    { url: track.url },
    position === undefined ? {} : { position },
  );
}

/**
 * Queues one resolved request and, for `!play`, cuts the current track short so it starts
 * straight away.
 *
 * Whether something was playing is read *before* queueing, not after: with an idle bot the
 * queue itself starts the new track, and a skip issued afterwards would skip the very track
 * somebody just asked for.
 */
async function submit(
  deps: MusicCommandDependencies,
  context: CommandContext,
  request: { url: string } | { query: string },
  mode: EnqueueMode,
) {
  const wasPlaying = deps.playback.session.isActive;

  const queued = await deps.playback.request(
    mode.position === undefined ? request : { ...request, position: mode.position },
    { uid: context.invoker.uid, nickname: context.invoker.nickname },
  );

  if (!queued.ok) return reply(describeRequestFailure(queued.error));

  if (mode.interrupt === true && wasPlaying) {
    await deps.playback.skip();
    return reply(`Playing now: ${formatTrack(queued.value)}`);
  }

  return reply(
    wasPlaying
      ? `Queued: ${formatTrack(queued.value)}`
      : `Playing now: ${formatTrack(queued.value)}`,
  );
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
    case 'resolve/age-restricted':
      return 'That one is 18+. YouTube only serves it to a signed-in, age-verified account, so I need cookies from one before I can play it.';
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
