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

/** Accepts `Authorization: Bearer <token>`, or a `token` query parameter for WebSockets. */
export function extractToken(
  headerValue: string | undefined,
  queryToken: string | undefined,
): string | undefined {
  if (headerValue !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (match !== null) return match[1];
  }
  // Browsers cannot set headers on a WebSocket handshake, so the socket falls back to a
  // query parameter. Kept out of REST deliberately: query strings end up in access logs.
  return queryToken;
}
