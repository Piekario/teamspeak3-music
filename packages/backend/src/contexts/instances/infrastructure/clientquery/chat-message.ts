/**
 * TeamSpeak refuses chat messages longer than 1024 characters, and incoming messages arrive
 * wrapped in BBCode. Both are pure text concerns, kept here so the facade stays about
 * intent and the rules are testable on their own.
 */

export const TS3_MESSAGE_LIMIT = 1024;

/**
 * TeamSpeak wraps every URL a user posts in `[URL]…[/URL]`, and clients may add colour or
 * emphasis. Feeding that straight to yt-dlp produces a baffling "unsupported URL" error, so
 * commands are always stripped before parsing.
 */
export function stripBbCode(text: string): string {
  return text
    .replace(/\[URL=[^\]]*\]/gi, '')
    .replace(/\[\/?(?:URL|B|I|U|S|COLOR|SIZE|CENTER|LEFT|RIGHT|LIST|IMG)(?:=[^\]]*)?\]/gi, '')
    .trim();
}

/**
 * Splits a reply into sendable chunks, preferring line boundaries so a queue listing never
 * breaks mid-entry. A single line longer than the limit is hard-split as a last resort.
 */
export function chunkMessage(text: string, limit: number = TS3_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text];

  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    for (const piece of hardSplit(line, limit)) {
      const candidate = current.length === 0 ? piece : `${current}\n${piece}`;
      if (candidate.length <= limit) {
        current = candidate;
        continue;
      }
      if (current.length > 0) chunks.push(current);
      current = piece;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function hardSplit(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const pieces: string[] = [];
  for (let offset = 0; offset < line.length; offset += limit) {
    pieces.push(line.slice(offset, offset + limit));
  }
  return pieces;
}
