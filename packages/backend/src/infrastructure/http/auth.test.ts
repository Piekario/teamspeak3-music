import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractToken, tokenMatches } from './auth.ts';

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
