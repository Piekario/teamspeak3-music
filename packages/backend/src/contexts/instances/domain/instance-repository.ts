import type { InstanceConfig } from './instance.ts';

/**
 * Persistence port for bot instances.
 *
 * Instances stop being a read-only file the moment the panel can create them, and two things
 * then have to survive a restart: the configuration itself, and the TeamSpeak identity the
 * gateway generated. The identity matters more than it looks — a bot's unique id derives
 * from it, and server groups are granted against that id, so losing it returns the bot as a
 * stranger with every permission revoked.
 */
export interface StoredIdentity {
  readonly key: string | null;
  readonly offset: number;
  readonly uid: string | null;
}

export interface InstanceRepository {
  list(): Promise<readonly InstanceConfig[]>;
  findById(id: string): Promise<InstanceConfig | undefined>;
  save(config: InstanceConfig): Promise<void>;
  delete(id: string): Promise<void>;

  readIdentity(instanceId: string): Promise<StoredIdentity>;
  /** Called once, when the gateway issues an identity for a bot that had none. */
  saveIdentity(instanceId: string, identity: StoredIdentity): Promise<void>;
}
