import type { AppEvent, CommandName } from '@tsmusic/shared';

import type { Clock } from '../../../shared-kernel/clock.ts';
import type { EventPublisher } from '../../../shared-kernel/event-bus.ts';
import type { PermissionResolver, DenialReason } from '../../access/domain/permission-resolver.ts';
import type { ChannelClient, IncomingMessage } from '../../instances/domain/bot-client.ts';
import type { CommandDefinition, CommandInvoker, CommandRegistry } from '../domain/command-definition.ts';
import { parseCommand } from '../domain/command-parser.ts';
import type { CooldownTracker } from './cooldown-tracker.ts';

export interface DispatchSettings {
  readonly prefix: string;
  /**
   * Only clients in the bot's own channel may command it. Stops someone parked in another
   * channel from steering the music of a room they are not in.
   */
  readonly requireSameChannel: boolean;
}

export interface CommandDispatcherOptions {
  readonly instanceId: string;
  readonly registry: CommandRegistry;
  readonly permissions: () => PermissionResolver;
  readonly settings: () => DispatchSettings;
  readonly cooldowns: CooldownTracker;
  readonly clock: Clock;
  readonly events: EventPublisher;
  /** Clients in the bot's channel, used for both the channel check and group lookup. */
  readonly channelClients: () => Promise<readonly ChannelClient[]>;
  readonly respond: (message: IncomingMessage, text: string, forcePrivate: boolean) => Promise<void>;
  readonly onIdentitySeen: (uid: string, nickname: string) => void;
  readonly logger: {
    debug(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
    error(message: string, details?: Record<string, unknown>): void;
  };
}

/**
 * Routes a chat message to a command handler.
 *
 * Implemented as an explicit pipeline — parse, identify, authorise, throttle, invoke — so
 * that each stage can refuse independently and the reason for a refusal is always specific.
 * A handler is only ever reached once every gate has passed, which means handlers contain
 * no permission checks and no rate limiting of their own.
 *
 * A handler that throws must never take the bot down: an exception becomes a one-line
 * apology in chat plus a logged stack trace. A single malformed URL is not worth a restart.
 */
export class CommandDispatcher {
  readonly #options: CommandDispatcherOptions;

  constructor(options: CommandDispatcherOptions) {
    this.#options = options;
  }

  async handle(message: IncomingMessage): Promise<void> {
    const settings = this.#options.settings();
    const parsed = parseCommand(message.text, settings.prefix);
    if (parsed === undefined) return;

    const definition = this.#options.registry.find(parsed.name);
    if (definition === undefined) return; // Unknown commands stay silent; the channel is a chat.

    if (!definition.sources.includes(message.target)) {
      await this.#refuse(message, definition, `${settings.prefix}${definition.name} cannot be used here.`);
      return;
    }

    // No sender means the bot's own message, which it would otherwise answer in a loop.
    //
    // Logged rather than dropped in silence: a transport that fails to report the sender's
    // unique id makes every command vanish here, and a bot that ignores its channel with
    // nothing in the log is a miserable thing to diagnose.
    if (message.senderUid.length === 0) {
      this.#options.logger.debug('ignoring a message with no sender uid', {
        instance: this.#options.instanceId,
        text: message.text.slice(0, 40),
      });
      return;
    }

    this.#options.onIdentitySeen(message.senderUid, message.senderNickname);

    const clients = await this.#safeChannelClients();
    const inChannel = clients.find((client) => client.uid === message.senderUid);

    if (settings.requireSameChannel && inChannel === undefined) {
      await this.#refuse(
        message,
        definition,
        'You have to be in my channel to command me.',
      );
      return;
    }

    const permissions = this.#options.permissions();
    const query = {
      uid: message.senderUid,
      serverGroupIds: inChannel?.serverGroupIds ?? [],
    };
    const decision = permissions.can(query, definition.name);

    if (!decision.allowed) {
      // A blocked user is given nothing at all — not even a refusal to probe against.
      if (decision.reason.kind === 'blocked') {
        this.#publishCommandLog(message, parsed.name, parsed.argumentText, false, null);
        return;
      }
      await this.#refuse(message, definition, describeDenial(decision.reason, settings.prefix));
      return;
    }

    const cooldown = this.#options.cooldowns.remainingMs(
      message.senderUid,
      definition.name,
      definition.cooldownMs,
    );
    if (cooldown > 0) {
      await this.#refuse(
        message,
        definition,
        `Slow down — try again in ${Math.ceil(cooldown / 1000)}s.`,
      );
      return;
    }

    const invoker: CommandInvoker = {
      uid: message.senderUid,
      nickname: message.senderNickname,
      clientId: message.senderClientId,
      role: decision.role,
      serverGroupIds: query.serverGroupIds,
    };

    this.#options.cooldowns.record(message.senderUid, definition.name);

    try {
      const result = await definition.handler({
        invoker,
        command: parsed,
        source: message.target,
      });

      if (result.text.length > 0) {
        await this.#options.respond(message, result.text, result.private === true);
      }
      this.#publishCommandLog(message, definition.name, parsed.argumentText, true, result.text);
    } catch (error) {
      this.#options.logger.error('command handler threw', {
        command: definition.name,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      await this.#options.respond(message, 'Something went wrong running that.', false);
      this.#publishCommandLog(message, definition.name, parsed.argumentText, true, 'error');
    }
  }

  /**
   * A failure to list the channel is not a reason to refuse every command; it degrades to
   * "no group information", which the permission resolver already handles.
   */
  async #safeChannelClients(): Promise<readonly ChannelClient[]> {
    try {
      return await this.#options.channelClients();
    } catch (error) {
      this.#options.logger.warn('could not list channel clients', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async #refuse(
    message: IncomingMessage,
    definition: CommandDefinition,
    text: string,
  ): Promise<void> {
    await this.#options.respond(message, text, false);
    this.#publishCommandLog(message, definition.name, '', false, text);
  }

  #publishCommandLog(
    message: IncomingMessage,
    command: CommandName | string,
    args: string,
    allowed: boolean,
    reply: string | null,
  ): void {
    const event: AppEvent = {
      type: 'command.executed',
      instanceId: this.#options.instanceId,
      at: this.#options.clock.now().toISOString(),
      payload: {
        uid: message.senderUid,
        nickname: message.senderNickname,
        command,
        args,
        allowed,
        reply,
      },
    };
    this.#options.events.publish(event);
  }
}

function describeDenial(reason: DenialReason, prefix: string): string {
  switch (reason.kind) {
    case 'blocked':
      return '';
    case 'not-whitelisted':
      return 'You are not on the allow-list for this bot.';
    case 'command-disabled':
      return `${prefix}${reason.command} is disabled.`;
    case 'insufficient-role':
      return `You need the ${reason.required} role for that (you are ${reason.actual}).`;
  }
}
