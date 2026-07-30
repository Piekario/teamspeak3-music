import { VOLUME_MAX, VOLUME_MIN } from '@tsmusic/shared';

import { err, ok, type Result } from '../../../shared-kernel/result.ts';
import { ValueObject } from '../../../shared-kernel/value-object.ts';

/**
 * Value objects for the playback context.
 *
 * Every one of them validates in a static factory returning `Result`, so an instance that
 * exists is an instance that is valid. Downstream code never re-checks a `Volume` for range
 * or a `ClientUid` for emptiness — that is the whole point of not passing raw numbers and
 * strings around.
 */

export type VolumeError = { readonly kind: 'volume/out-of-range'; readonly value: number };

export class Volume extends ValueObject<number> {
  static create(value: number): Result<Volume, VolumeError> {
    if (!Number.isInteger(value) || value < VOLUME_MIN || value > VOLUME_MAX) {
      return err({ kind: 'volume/out-of-range', value });
    }
    return ok(new Volume(value));
  }

  /** Clamps rather than rejecting — for inputs that are advisory, such as a stored default. */
  static clamp(value: number): Volume {
    const bounded = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(value)));
    return new Volume(bounded);
  }

  asPercent(): string {
    return `${this.value}%`;
  }
}

export type DurationError = { readonly kind: 'duration/negative'; readonly value: number };

export class Duration extends ValueObject<number> {
  static fromSeconds(seconds: number): Result<Duration, DurationError> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return err({ kind: 'duration/negative', value: seconds });
    }
    return ok(new Duration(seconds));
  }

  static zero(): Duration {
    return new Duration(0);
  }

  get seconds(): number {
    return this.value;
  }

  plus(other: Duration): Duration {
    return new Duration(this.value + other.value);
  }

  /** `4:07`, or `1:02:07` once it passes an hour. */
  format(): string {
    const total = Math.floor(this.value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    const paddedSeconds = String(seconds).padStart(2, '0');
    if (hours === 0) return `${minutes}:${paddedSeconds}`;
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
}

export type ClientUidError = { readonly kind: 'client-uid/empty' };

/**
 * A TeamSpeak client's unique identifier — the only stable way to identify a person.
 * Nicknames are freely changeable, so permissions must never key on them.
 */
export class ClientUid extends ValueObject<string> {
  static create(value: string): Result<ClientUid, ClientUidError> {
    const trimmed = value.trim();
    if (trimmed.length === 0) return err({ kind: 'client-uid/empty' });
    return ok(new ClientUid(trimmed));
  }
}

/** Identifies a queue entry, not a track: the same song queued twice yields two ids. */
export class QueueItemId extends ValueObject<string> {
  static create(value: string): QueueItemId {
    return new QueueItemId(value);
  }
}
