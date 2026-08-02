import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearedSessionCookie,
  extractToken,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  tokenMatches,
} from './auth.ts';

const TOKEN = 'a'.repeat(32);

describe('tokenMatches', () => {
  it('accepts the correct token', () => {
    assert.ok(tokenMatches(TOKEN, TOKEN));
  });

  it('rejects a wrong token of the same length', () => {
    assert.ok(!tokenMatches('b'.repeat(32), TOKEN));
  });

  it('rejects tokens of a different length without throwing', () => {
    // A naive constant-time compare throws on length mismatch, which leaks the length.
    assert.doesNotThrow(() => tokenMatches('short', TOKEN));
    assert.ok(!tokenMatches('short', TOKEN));
    assert.ok(!tokenMatches(`${TOKEN}extra`, TOKEN));
  });

  it('rejects a missing token', () => {
    assert.ok(!tokenMatches(undefined, TOKEN));
    assert.ok(!tokenMatches('', TOKEN));
  });

  it('rejects a correct prefix', () => {
    assert.ok(!tokenMatches(TOKEN.slice(0, 31), TOKEN));
  });
});

describe('extractToken', () => {
  it('reads a bearer header', () => {
    assert.equal(extractToken(`Bearer ${TOKEN}`, undefined), TOKEN);
  });

  it('accepts any capitalisation of the scheme', () => {
    assert.equal(extractToken(`bearer ${TOKEN}`, undefined), TOKEN);
    assert.equal(extractToken(`BEARER ${TOKEN}`, undefined), TOKEN);
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(extractToken(`  Bearer   ${TOKEN}  `, undefined), TOKEN);
  });

  it('falls back to the query token, which is how WebSockets authenticate', () => {
    // Browsers cannot set headers on a WebSocket handshake.
    assert.equal(extractToken(undefined, TOKEN), TOKEN);
  });

  it('prefers the header when both are present', () => {
    assert.equal(extractToken(`Bearer ${TOKEN}`, 'query-token'), TOKEN);
  });

  it('returns nothing when there is nothing to read', () => {
    assert.equal(extractToken(undefined, undefined), undefined);
    assert.equal(extractToken('Basic abc123', undefined), undefined);
  });
});

describe('reading the session cookie', () => {
  it('finds the cookie among others', () => {
    const header = 'theme=dark; tsmusic_session=abc123; other=1';

    assert.equal(readCookie(header, SESSION_COOKIE), 'abc123');
  });

  it('tolerates the spacing browsers actually send', () => {
    assert.equal(readCookie('tsmusic_session=abc', SESSION_COOKIE), 'abc');
    assert.equal(readCookie('  tsmusic_session = abc  ', SESSION_COOKIE), 'abc');
  });

  it('does not confuse a cookie whose name merely ends the same way', () => {
    assert.equal(readCookie('not_tsmusic_session=abc', SESSION_COOKIE), undefined);
  });

  it('decodes a value the browser escaped', () => {
    assert.equal(readCookie('tsmusic_session=a%2Bb', SESSION_COOKIE), 'a+b');
  });

  it('answers nothing for a request with no cookies at all', () => {
    assert.equal(readCookie(undefined, SESSION_COOKIE), undefined);
    assert.equal(readCookie('', SESSION_COOKIE), undefined);
  });
});

describe('choosing which credential to read', () => {
  it('prefers the cookie, which is how a browser signs in', () => {
    const found = extractToken('Bearer from-header', 'from-query', 'tsmusic_session=from-cookie');

    assert.equal(found, 'from-cookie');
  });

  it('falls back to the header, which is how scripts sign in', () => {
    assert.equal(extractToken('Bearer from-header', undefined, undefined), 'from-header');
  });

  it('ignores an empty cookie rather than treating it as a credential', () => {
    // A cleared cookie is sent as an empty value, and reading it as one would sign somebody
    // out of the header they also presented.
    assert.equal(extractToken('Bearer from-header', undefined, 'tsmusic_session='), 'from-header');
  });

  it('still accepts the query parameter, for a browser with no cookie yet', () => {
    assert.equal(extractToken(undefined, 'from-query', undefined), 'from-query');
  });
});

describe('issuing the session cookie', () => {
  it('is unreadable to scripts and unusable across sites', () => {
    // The two properties that make this better than localStorage, together: HttpOnly stops a
    // script reading it, SameSite stops another site spending it.
    const cookie = sessionCookie('abc', { secure: true, maxAgeSec: 60 });

    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=60/);
  });

  it('drops Secure on plain HTTP, where it would never come back', () => {
    // A Secure cookie set over HTTP is accepted and never sent again, which looks exactly
    // like a sign-in that silently does nothing.
    assert.doesNotMatch(sessionCookie('abc', { secure: false, maxAgeSec: 60 }), /Secure/);
  });

  it('escapes a value that would otherwise break the header', () => {
    assert.match(sessionCookie('a;b', { secure: false, maxAgeSec: 1 }), /tsmusic_session=a%3Bb/);
  });

  it('clears by expiring immediately', () => {
    assert.match(clearedSessionCookie(false), /Max-Age=0/);
  });
});
