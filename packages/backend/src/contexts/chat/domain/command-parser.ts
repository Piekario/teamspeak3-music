/**
 * Turns a chat line into a command invocation.
 *
 * BBCode is already stripped by the ClientQuery adapter, so this layer deals purely with
 * prefix, name and arguments. Keeping it a pure function means every quirk below is pinned
 * by a fast test rather than discovered on a live server.
 */

export interface ParsedCommand {
  readonly name: string;
  /** Everything after the command name, trimmed. Handlers parse it as they see fit. */
  readonly argumentText: string;
  readonly arguments: readonly string[];
}

export function parseCommand(text: string, prefix: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (prefix.length === 0 || !trimmed.startsWith(prefix)) return undefined;

  const withoutPrefix = trimmed.slice(prefix.length).trim();
  if (withoutPrefix.length === 0) return undefined;

  const separatorIndex = firstWhitespaceIndex(withoutPrefix);
  const name = (separatorIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, separatorIndex))
    .toLowerCase();
  const argumentText = separatorIndex === -1 ? '' : withoutPrefix.slice(separatorIndex).trim();

  return {
    name,
    argumentText,
    arguments: argumentText.length === 0 ? [] : argumentText.split(/\s+/),
  };
}

function firstWhitespaceIndex(text: string): number {
  const match = /\s/.exec(text);
  return match?.index ?? -1;
}

/**
 * Parses `mm:ss`, `h:mm:ss` or a plain number of seconds — the three ways people naturally
 * write a seek target.
 */
export function parseTimecode(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(trimmed)) return undefined;

  const parts = trimmed.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some(Number.isNaN)) return undefined;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Recognises a URL without throwing, so free text falls through to search. */
export function looksLikeUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
