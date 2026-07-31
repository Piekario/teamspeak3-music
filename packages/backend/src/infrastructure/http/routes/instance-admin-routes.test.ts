import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { updateInstanceSchema } from './instance-admin-routes.ts';

describe('updateInstanceSchema', () => {
  it('accepts a change to one TeamSpeak field', () => {
    // The obvious way to rename a bot. A shallow `.partial()` rejected this, because `host`
    // stayed required inside `teamspeak` — so renaming through the API was impossible unless
    // the caller happened to resend the address too.
    const parsed = updateInstanceSchema.safeParse({ teamspeak: { nickname: 'DJ' } });

    assert.ok(parsed.success);
    assert.equal(parsed.data.teamspeak?.nickname, 'DJ');
    assert.equal(parsed.data.teamspeak?.host, undefined);
  });

  it('accepts an empty body', () => {
    assert.equal(updateInstanceSchema.safeParse({}).success, true);
  });

  it('still rejects a field that is the wrong type', () => {
    const parsed = updateInstanceSchema.safeParse({ teamspeak: { port: 'nine' } });

    assert.equal(parsed.success, false);
  });

  it('leaves an absent field absent rather than filling in a default', () => {
    // The handler reads "absent" as "leave it alone", so a default here would quietly
    // overwrite a stored channel with null on every unrelated edit.
    const parsed = updateInstanceSchema.safeParse({ name: 'Renamed' });

    assert.ok(parsed.success);
    assert.equal(parsed.data.teamspeak, undefined);
    assert.equal(parsed.data.enabled, undefined);
  });
});
