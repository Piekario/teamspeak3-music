import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token authentication for the panel.
 *
 * One shared operator token for now, checked in one place so replacing it with real sessions
 * later touches this file and nothing else.
 *
 * The comparison is constant-time. That matters even for a single-operator tool: a naive
 * `===` leaks the token prefix-by-prefix to anyone who can measure response times, and
 * getting it right costs nothing.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;

  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws on length mismatch, which would itself leak the length. Comparing
  // against a padded copy keeps the work constant regardless of what was supplied.
  if (providedBytes.length !== expectedBytes.length) {
    timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }

  return timingSafeEqual(providedBytes, expectedBytes);
}

/** The cookie the panel signs in with. Named plainly; there is nothing to hide about it. */
export const SESSION_COOKIE = 'tsmusic_session';

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * Hand-parsed rather than pulling in a cookie plugin: this reads a single name, and the
 * header's grammar for that is a split on `;` and one on `=`.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/**
 * Finds the credential on a request, in order of preference.
 *
 * The cookie comes first because it is how a browser signs in: set by the server, invisible
 * to scripts, and sent on the WebSocket handshake — which is what lets the socket stop
 * carrying the token in its query string, where it ended up in every access log along the
 * way. The header stays for scripts and curl. The query parameter stays only as a fallback
 * for a browser with no cookie yet.
 */
export function extractToken(
  headerValue: string | undefined,
  queryToken: string | undefined,
  cookieHeader?: string | undefined,
): string | undefined {
  const cookie = readCookie(cookieHeader, SESSION_COOKIE);
  if (cookie !== undefined && cookie.length > 0) return cookie;

  if (headerValue !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (match !== null) return match[1];
  }

  return queryToken;
}

/**
 * The `Set-Cookie` value that signs somebody in.
 *
 * `HttpOnly` is the point of moving off localStorage: a script that manages to run on the
 * panel can read localStorage and post the token anywhere, and can do neither with this.
 * `SameSite=Strict` is what makes that safe — a cookie the browser attaches automatically
 * would otherwise let any other site issue commands as whoever is signed in.
 */
export function sessionCookie(token: string, options: { secure: boolean; maxAgeSec: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSec}`,
  ];
  // Omitted on plain HTTP, or the cookie would be set and never sent back — which looks
  // exactly like a sign-in that silently does nothing.
  if (options.secure) parts.push('Secure');

  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAgeSec: 0 });
}
