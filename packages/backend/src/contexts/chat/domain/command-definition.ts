import type { CommandName, Role } from '@tsmusic/shared';

import type { MessageTarget } from '../../instances/domain/bot-client.ts';
import type { ParsedCommand } from './command-parser.ts';

/**
 * A chat command, declared rather than coded into a switch statement.
 *
 * Everything the dispatcher needs to police a command — who may run it, where it may be
 * invoked from, how often — lives in the declaration next to the behaviour. That is what
 * keeps the dispatch pipeline free of per-command special cases, and it is also what lets
 * `!help` list exactly the commands a given caller may actually use.
 */
export interface CommandDefinition {
  readonly name: CommandName;
  readonly aliases: readonly string[];
  /** Shipping default; a persisted per-instance policy overrides it. */
  readonly defaultRole: Role;
  readonly usage: string;
  readonly summary: string;
  /** Where the command may be invoked from. Most work everywhere. */
  readonly sources: readonly MessageTarget[];
  /**
   * Per-user cooldown. Commands that spawn a process are throttled harder, since a handful
   * of users can otherwise keep several yt-dlp invocations running at once.
   */
  readonly cooldownMs: number;
  readonly handler: CommandHandler;
}

export type CommandHandler = (context: CommandContext) => Promise<CommandReply>;

export interface CommandInvoker {
  readonly uid: string;
  readonly nickname: string;
  readonly clientId: number;
  readonly role: Role;
  readonly serverGroupIds: readonly number[];
}

export interface CommandContext {
  readonly invoker: CommandInvoker;
  readonly command: ParsedCommand;
  readonly source: MessageTarget;
}

/**
 * A reply is data, not a side effect: the handler says what to say, the dispatcher decides
 * where it goes. That keeps handlers testable without a TeamSpeak connection and guarantees
 * a reply always returns to whichever channel the command arrived on.
 */
export interface CommandReply {
  readonly text: string;
  /** Forces a private reply even for a channel command — used for long or noisy output. */
  readonly private?: boolean;
}

export const SILENT_REPLY: CommandReply = Object.freeze({ text: '' });

export function reply(text: string): CommandReply {
  return { text };
}

export function privateReply(text: string): CommandReply {
  return { text, private: true };
}

const ALL_SOURCES: readonly MessageTarget[] = ['channel', 'private', 'poke'];

export const DEFAULT_COOLDOWN_MS = 2_000;
/** Commands that spawn yt-dlp cost real resources, so they are paced more strictly. */
export const RESOLVING_COOLDOWN_MS = 5_000;

export function defineCommand(
  definition: Omit<CommandDefinition, 'aliases' | 'sources' | 'cooldownMs'> &
    Partial<Pick<CommandDefinition, 'aliases' | 'sources' | 'cooldownMs'>>,
): CommandDefinition {
  return {
    aliases: [],
    sources: ALL_SOURCES,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    ...definition,
  };
}

/**
 * Resolves a typed name — canonical or alias — to its definition.
 * Registration rejects duplicates outright: two commands answering to one alias is a
 * configuration bug that should surface at startup, not as mysterious behaviour later.
 */
export class CommandRegistry {
  readonly #byName = new Map<string, CommandDefinition>();
  readonly #definitions: CommandDefinition[] = [];

  register(definition: CommandDefinition): void {
    for (const key of [definition.name, ...definition.aliases]) {
      const existing = this.#byName.get(key);
      if (existing !== undefined) {
        throw new Error(
          `command alias '${key}' is claimed by both '${existing.name}' and '${definition.name}'`,
        );
      }
      this.#byName.set(key, definition);
    }
    this.#definitions.push(definition);
  }

  registerAll(definitions: readonly CommandDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  find(name: string): CommandDefinition | undefined {
    return this.#byName.get(name.toLowerCase());
  }

  get all(): readonly CommandDefinition[] {
    return this.#definitions;
  }
}
