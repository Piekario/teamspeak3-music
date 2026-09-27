import { asc, eq } from 'drizzle-orm';
import type { QueueItem } from '@tsmusic/shared';

import type { QueueRepository } from '../../contexts/playback/domain/ports.ts';
import type { Db } from './database.ts';
import { queueSnapshots } from './schema.ts';

/**
 * SQLite-backed write-behind mirror of the live queue.
 *
 * Whole-queue replace: a queue is small and changes as a unit — a move, a shuffle or a clear
 * touches every position at once — so deleting and reinserting the handful of rows it holds
 * costs less than diffing against what is stored.
 */
export class DrizzleQueueRepository implements QueueRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async load(instanceId: string): Promise<readonly QueueItem[]> {
    const rows = this.#db
      .select()
      .from(queueSnapshots)
      .where(eq(queueSnapshots.instanceId, instanceId))
      .orderBy(asc(queueSnapshots.position))
      .all();

    return rows.map((row) => JSON.parse(row.payload) as QueueItem);
  }

  async save(instanceId: string, items: readonly QueueItem[]): Promise<void> {
    this.#db.transaction((tx) => {
      tx.delete(queueSnapshots).where(eq(queueSnapshots.instanceId, instanceId)).run();
      if (items.length === 0) return;

      tx.insert(queueSnapshots)
        .values(items.map((item, position) => ({ instanceId, position, payload: JSON.stringify(item) })))
        .run();
    });
  }
}
