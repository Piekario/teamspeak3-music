import type { ChannelClient, ChannelRef } from '@tsmusic/shared';

// Re-exported so the rest of the backend can depend on this port alone rather than reaching
// past it into the shared contract package for a type the port already speaks in.
export type { ChannelClient, ChannelRef };

/**
 * The port through which the application talks to a TeamSpeak client.
 *
 * Declared in the domain, implemented in infrastructure: the command handlers and the
 * playback context depend on this interface, never on a socket. That is what lets the whole
 * command layer be tested against an in-memory fake with no TeamSpeak anywhere.
 */
export interface BotClient {
  whoami(): Promise<BotIdentity>;
  currentChannel(): Promise<ChannelRef>;
  listChannels(): Promise<readonly ChannelRef[]>;

  /**
   * Clients in the bot's current channel, with their server groups — the only source of
   * group membership available, since this project deliberately does not use ServerQuery.
   */
  listChannelClients(): Promise<readonly ChannelClient[]>;

  sendChannelMessage(text: string): Promise<void>;
  sendPrivateMessage(clientId: number, text: string): Promise<void>;

  moveToChannel(channelId: number, password?: string): Promise<void>;
  setNickname(nickname: string): Promise<void>;

  /**
   * Beware: in TeamSpeak, muting the output mutes the microphone as well. Muting a music
   * bot's speakers therefore silences the music, which is why the runtime explicitly keeps
   * output unmuted. Preventing the bot from relaying other people's voices is the audio
   * routing's job — the client plays into a sink whose monitor feeds nothing.
   */
  setOutputMuted(muted: boolean): Promise<void>;
  setInputMuted(muted: boolean): Promise<void>;
}

export interface BotIdentity {
  readonly clientId: number;
  readonly channelId: number;
  readonly uid: string;
  readonly nickname: string;
}

/** Where a chat message came from, and therefore where its reply must go. */
export const MESSAGE_TARGETS = ['channel', 'private', 'poke'] as const;
export type MessageTarget = (typeof MESSAGE_TARGETS)[number];

export interface IncomingMessage {
  readonly target: MessageTarget;
  readonly text: string;
  readonly senderClientId: number;
  readonly senderUid: string;
  readonly senderNickname: string;
}

export type MessageListener = (message: IncomingMessage) => void;
