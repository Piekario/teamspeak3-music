/**
 * Time is a dependency, not an ambient global.
 *
 * The playback session computes position from elapsed wall-clock time; injecting the clock
 * is what lets its tests assert "after 30 seconds, position is 30" without sleeping.
 */
export interface Clock {
  now(): Date;
  epochMillis(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  epochMillis: () => Date.now(),
};

/** Test double: time only moves when a test says so. */
export class FakeClock implements Clock {
  #millis: number;

  constructor(start: Date | number = 0) {
    this.#millis = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.#millis);
  }

  epochMillis(): number {
    return this.#millis;
  }

  advance(millis: number): void {
    this.#millis += millis;
  }
}
