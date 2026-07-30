/**
 * The ClientQuery wire protocol — pure functions, zero I/O.
 *
 * This is the one part of the TeamSpeak integration that can be tested exhaustively without
 * Docker, without an emulated x86 client and without a TeamSpeak server, which is exactly
 * why it is isolated here. Everything stateful lives in `connection.ts`.
 *
 * The format is line-based: `command key=value key2=value2 -flag |key=value2 ...`, where
 * `|` separates repeated items of a list response, and every value is escaped.
 */

/**
 * Escape table from the TeamSpeak query specification. Order matters on the way out:
 * backslash must be escaped first, or it would double-escape the sequences added after it.
 */
const ESCAPE_SEQUENCES: ReadonlyArray<readonly [literal: string, escaped: string]> = [
  ['\\', '\\\\'],
  ['/', '\\/'],
  [' ', '\\s'],
  ['|', '\\p'],
  ['', '\\a'],
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['\v', '\\v'],
];

const UNESCAPE_LOOKUP: ReadonlyMap<string, string> = new Map(
  ESCAPE_SEQUENCES.map(([literal, escaped]) => [escaped[1] as string, literal]),
);

export function escape(value: string): string {
  let escaped = value;
  for (const [literal, replacement] of ESCAPE_SEQUENCES) {
    escaped = escaped.split(literal).join(replacement);
  }
  return escaped;
}

export function unescape(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      // Trailing lone backslash: emit it rather than dropping data.
      result += char;
      continue;
    }
    const literal = UNESCAPE_LOOKUP.get(next);
    result += literal ?? next;
    index += 1;
  }
  return result;
}

/** A single `key=value` group; flags such as `-uid` arrive as keys with an empty value. */
export type ParamMap = Readonly<Record<string, string>>;

export interface ParsedResponse {
  readonly items: readonly ParamMap[];
}

export interface ParsedNotification {
  readonly name: string;
  readonly items: readonly ParamMap[];
}

export interface ParsedError {
  readonly id: number;
  readonly message: string;
  /** Present on permission errors; identifies the permission that was missing. */
  readonly failedPermissionId: number | undefined;
}

const ERROR_LINE = /^error\s/;
const NOTIFICATION_LINE = /^(notify[a-z0-9_]+)(?:\s(.*))?$/i;

export function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line);
}

export function isNotificationLine(line: string): boolean {
  return NOTIFICATION_LINE.test(line);
}

/** Parses one `key=value` cluster, e.g. `clid=7 client_nickname=Bot\sOne`. */
function parseParams(segment: string): ParamMap {
  const params: Record<string, string> = {};
  for (const token of segment.split(' ')) {
    if (token.length === 0) continue;
    const separator = token.indexOf('=');
    if (separator === -1) {
      // A bare flag (`-uid`) or a valueless key. Record it so callers can detect presence.
      params[unescape(token)] = '';
      continue;
    }
    const key = unescape(token.slice(0, separator));
    const value = unescape(token.slice(separator + 1));
    params[key] = value;
  }
  return params;
}

/** Splits a payload on `|` into repeated items. A single-item response yields one entry. */
function parseItems(payload: string): readonly ParamMap[] {
  if (payload.trim().length === 0) return [];
  return payload.split('|').map(parseParams);
}

export function parseResponse(payload: string): ParsedResponse {
  return { items: parseItems(payload) };
}

export function parseNotification(line: string): ParsedNotification | undefined {
  const match = NOTIFICATION_LINE.exec(line);
  if (match === null) return undefined;
  const name = (match[1] as string).toLowerCase();
  return { name, items: parseItems(match[2] ?? '') };
}

export function parseError(line: string): ParsedError | undefined {
  if (!isErrorLine(line)) return undefined;
  const params = parseParams(line.slice('error '.length));
  const id = Number.parseInt(params['id'] ?? '', 10);
  if (Number.isNaN(id)) return undefined;
  const failedPermission = params['failed_permid'];
  return {
    id,
    message: params['msg'] ?? '',
    failedPermissionId:
      failedPermission === undefined ? undefined : Number.parseInt(failedPermission, 10),
  };
}

export type CommandArgument = string | number | boolean;

export interface SerializeOptions {
  readonly params?: Readonly<Record<string, CommandArgument | undefined>>;
  /** Bare flags such as `-uid` or `-groups`. */
  readonly flags?: readonly string[];
}

export function serialize(command: string, options: SerializeOptions = {}): string {
  const parts: string[] = [command];

  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined) continue;
    parts.push(`${escape(key)}=${escape(String(value))}`);
  }

  for (const flag of options.flags ?? []) {
    parts.push(flag.startsWith('-') ? flag : `-${flag}`);
  }

  return parts.join(' ');
}

/** `error id=0 msg=ok` is the protocol's success sentinel. */
export const ERROR_ID_OK = 0;

export class ClientQueryError extends Error {
  readonly id: number;
  readonly rawMessage: string;
  readonly command: string;

  constructor(id: number, rawMessage: string, command: string) {
    super(`ClientQuery command '${command}' failed: ${rawMessage} (id=${id})`);
    this.name = 'ClientQueryError';
    this.id = id;
    this.rawMessage = rawMessage;
    this.command = command;
  }
}
