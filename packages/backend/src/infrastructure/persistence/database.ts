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

  ensureSchema(connection);

  return {
    db: drizzle(connection, { schema }),
    close: () => connection.close(),
  };
}

/**
 * Creates the tables the application needs if they are absent.
 *
 * A stopgap, and worth naming as one: the proper answer is generated `drizzle-kit`
 * migrations, which handle column changes rather than only first creation. This exists so a
 * fresh database works out of the box, and it is deliberately additive — it will never alter
 * or drop an existing column, so a schema change still needs a real migration.
 */
function ensureSchema(connection: Database.Database): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      teamspeak_host TEXT NOT NULL,
      teamspeak_port INTEGER NOT NULL DEFAULT 9987,
      server_password TEXT,
      nickname TEXT NOT NULL DEFAULT 'MusicBot',
      home_channel_id INTEGER,
      client_query_host TEXT,
      client_query_port INTEGER DEFAULT 25639,
      client_query_api_key TEXT,
      pulse_server TEXT,
      sink_name TEXT DEFAULT 'bot_sink',
      identity_key TEXT,
      identity_offset INTEGER NOT NULL DEFAULT 0,
      identity_uid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      owner_uid TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Names identify a playlist in chat, so they have to be unique within an instance for
    -- "playlist load party" to mean exactly one thing.
    CREATE UNIQUE INDEX IF NOT EXISTS playlists_instance_name
      ON playlists (instance_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      uploader TEXT,
      duration_sec INTEGER,
      thumbnail_url TEXT,
      added_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS playlist_tracks_playlist
      ON playlist_tracks (playlist_id, position);
  `);
}

export { schema };
