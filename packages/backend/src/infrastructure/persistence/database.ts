import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Opens the SQLite database with the pragmas this workload actually needs.
 *
 * WAL matters here specifically: the bot writes history and queue snapshots while HTTP
 * requests read playlists and settings, and without WAL those readers block behind every
 * write. `foreign_keys` is off by default in SQLite, so the cascade rules declared in the
 * schema would silently do nothing unless it is turned on per connection.
 */
export function openDatabase(path: string): { db: Db; close: () => void } {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const connection = new Database(path);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  // A queue snapshot write racing an HTTP read should wait briefly, not fail outright.
  connection.pragma('busy_timeout = 5000');
  connection.pragma('synchronous = NORMAL');

  return {
    db: drizzle(connection, { schema }),
    close: () => connection.close(),
  };
}

export { schema };
