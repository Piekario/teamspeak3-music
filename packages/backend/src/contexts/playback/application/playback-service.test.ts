import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppEvent, Requester, Track } from '@tsmusic/shared';

import { FakeClock } from '../../../shared-kernel/clock.ts';
import { ok, type Result } from '../../../shared-kernel/result.ts';
import { PlaybackSession } from '../domain/playback-session.ts';
import { DEFAULT_QUEUE_LIMITS, Queue } from '../domain/queue.ts';
import type {
  AudioOutput,
  AudioOutputError,
  AudioPlaybackHandle,
  PlaybackEndReason,
  ResolveError,
  ResolvedTrack,
  StartPlaybackOptions,
  TrackResolver,
  VolumeController,
  VolumeControlError,
} from '../domain/ports.ts';
import { Volume } from '../domain/values.ts';
import { PlaybackService } from './playback-service.ts';

const alice: Requester = { uid: 'uid-alice', nickname: 'Alice' };

function track(overrides: Partial<Track> = {}): Track {
  return {
    source: 'youtube',
    sourceId: 'abc',
    url: 'https://youtu.be/abc',
    title: 'A Track',
    uploader: 'Uploader',
    durationSec: 240,
    thumbnailUrl: null,
    isLive: false,
    ...overrides,
  };
}

/** Resolves whatever it is asked for, and records how often it was asked. */
class FakeResolver implements TrackResolver {
  refreshCount = 0;
  resolveResult: Result<ResolvedTrack, ResolveError> | undefined;
  searchResult: readonly Track[] = [track()];

  supports(): boolean {
    return true;
  }

  async resolveUrl(url: string): Promise<Result<ResolvedTrack, ResolveError>> {
    return this.resolveResult ?? ok({ track: track({ url }), streamUrl: `${url}#stream`, expiresAt: null });
  }

  async refresh(t: Track): Promise<Result<ResolvedTrack, ResolveError>> {
    this.refreshCount += 1;
    return ok({ track: t, streamUrl: `${t.url}#fresh`, expiresAt: null });
  }

  async search(): Promise<Result<readonly Track[], ResolveError>> {
    return ok(this.searchResult);
  }
}

/** Records every start and lets a test end a stream however it likes. */
class FakeAudio implements AudioOutput {
  readonly starts: StartPlaybackOptions[] = [];
  stopCount = 0;
  failNextStart: AudioOutputError | undefined;
  #onEnded: ((reason: PlaybackEndReason) => void) | undefined;

  async start(options: StartPlaybackOptions): Promise<Result<AudioPlaybackHandle, AudioOutputError>> {
    if (this.failNextStart !== undefined) {
      const failure = this.failNextStart;
      this.failNextStart = undefined;
      return { ok: false, error: failure };
    }

    this.starts.push(options);
    this.#onEnded = options.onEnded;

    const self = this;
    return ok({
      async stop() {
        self.stopCount += 1;
      },
    });
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  /** Simulates the stream ending, exactly as the ffmpeg supervisor would report it. */
  endStream(reason: PlaybackEndReason): void {
    const handler = this.#onEnded;
    this.#onEnded = undefined;
    handler?.(reason);
  }

  get lastStartOffset(): number | undefined {
    return this.starts.at(-1)?.startAtSec;
  }
}

class FakeVolume implements VolumeController {
  applied: number[] = [];

  async apply(volume: Volume): Promise<Result<void, VolumeControlError>> {
    this.applied.push(volume.value);
    return ok();
  }

  async read(): Promise<Result<number, VolumeControlError>> {
    return ok(this.applied.at(-1) ?? 40);
  }
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function build() {
  const clock = new FakeClock(0);
  const queue = new Queue(DEFAULT_QUEUE_LIMITS);
  const session = new PlaybackSession({ queue, clock });
  const resolver = new FakeResolver();
  const audio = new FakeAudio();
  const volume = new FakeVolume();
  const events: AppEvent[] = [];

  const service = new PlaybackService({
    instanceId: 'party',
    session,
    queue,
    resolvers: [resolver],
    audio,
    volume,
    events: { publish: (event) => events.push(event) },
    clock,
    logger: silentLogger,
  });

  return { clock, queue, session, resolver, audio, volume, events, service };
}

/** Lets queued microtasks settle — the service ends tracks through async callbacks. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('PlaybackService requests', () => {
  it('starts playing immediately when idle', async () => {
    const { service, session, audio } = build();

    const result = await service.request({ url: 'https://youtu.be/abc' }, alice);

    assert.ok(result.ok);
    assert.equal(session.status, 'playing');
    assert.equal(audio.starts.length, 1);
  });

  it('queues behind the current track instead of interrupting it', async () => {
    const { service, session, queue, audio } = build();
    await service.request({ url: 'https://youtu.be/first' }, alice);

    await service.request({ url: 'https://youtu.be/second' }, alice);

    assert.equal(session.current?.track.url, 'https://youtu.be/first');
    assert.equal(queue.length, 1);
    assert.equal(audio.starts.length, 1, 'the second request must not spawn a second stream');
  });

  it('refuses a track that breaks a queue limit and does not start it', async () => {
    const { service, session, queue } = build();
    queue.applyLimits({ ...DEFAULT_QUEUE_LIMITS, maxTrackSeconds: 60 });

    const result = await service.request({ url: 'https://youtu.be/long' }, alice);

    assert.ok(!result.ok);
    assert.equal(result.error.kind, 'queue/track-too-long');
    assert.equal(session.status, 'idle');
  });

  it('resolves the stream URL at playback time, not at enqueue time', async () => {
    // Media URLs expire; a track can sit in the queue longer than its URL lives.
    const { service, resolver } = build();

    await service.request({ url: 'https://youtu.be/abc' }, alice);

    assert.equal(resolver.refreshCount, 1);
  });
});

describe('PlaybackService transport', () => {
  it('advances to the next track when one finishes', async () => {
    const { service, session, audio } = build();
    await service.request({ url: 'https://youtu.be/first' }, alice);
    await service.request({ url: 'https://youtu.be/second' }, alice);

    audio.endStream({ kind: 'completed' });
    await settle();

    assert.equal(session.current?.track.url, 'https://youtu.be/second');
    assert.equal(audio.starts.length, 2);
  });

  it('skips exactly one track — the intentional kill is not mistaken for a crash', async () => {
    // The classic double-skip: stopping the encoder makes it exit, and if that exit is read
    // as a failure the service advances a second time.
    const { service, session, audio } = build();
    await service.request({ url: 'https://youtu.be/first' }, alice);
    await service.request({ url: 'https://youtu.be/second' }, alice);
    await service.request({ url: 'https://youtu.be/third' }, alice);

    await service.skip();
    audio.endStream({ kind: 'cancelled' });
    await settle();

    assert.equal(session.current?.track.url, 'https://youtu.be/second');
  });

  it('goes idle when the queue runs dry', async () => {
    const { service, session, audio } = build();
    await service.request({ url: 'https://youtu.be/only' }, alice);

    audio.endStream({ kind: 'completed' });
    await settle();

    assert.equal(session.status, 'idle');
    assert.equal(session.current, null);
  });

  it('pauses and resumes from the banked position', async () => {
    const { service, session, clock, audio } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    clock.advance(45_000);
    await service.pause();
    assert.equal(session.status, 'paused');

    await service.resume();

    assert.equal(session.status, 'playing');
    assert.equal(audio.lastStartOffset, 45, 'resume must restart the encoder at 45s');
  });

  it('seeks by restarting the stream at the target offset', async () => {
    const { service, audio } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    const target = await service.seek(120);

    assert.ok(target.ok);
    assert.equal(audio.lastStartOffset, 120);
  });

  it('stop clears the queue and leaves nothing playing', async () => {
    const { service, session, queue } = build();
    await service.request({ url: 'https://youtu.be/first' }, alice);
    await service.request({ url: 'https://youtu.be/second' }, alice);

    await service.stop();

    assert.equal(session.status, 'idle');
    assert.equal(session.current, null);
    assert.equal(queue.length, 0);
  });

  it('applies volume to the sink before recording it', async () => {
    const { service, session, volume } = build();
    const target = Volume.create(75);
    assert.ok(target.ok);

    await service.setVolume(target.value);

    assert.deepEqual(volume.applied, [75]);
    assert.equal(session.volume.value, 75);
  });
});

describe('PlaybackService failure handling', () => {
  it('resumes from the last position after a mid-stream failure', async () => {
    const { service, session, audio } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    audio.endStream({ kind: 'failed', detail: 'connection reset', playedSec: 62 });
    await settle();

    assert.equal(session.status, 'playing', 'a mid-stream drop is recoverable');
    assert.equal(audio.lastStartOffset, 62);
  });

  it('gives up after repeated mid-stream failures instead of looping forever', async () => {
    const { service, session, audio } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      audio.endStream({ kind: 'failed', detail: 'connection reset', playedSec: 62 });
      await settle();
    }

    assert.equal(session.status, 'idle');
  });

  it('skips a track that fails immediately and keeps the rest of the queue', async () => {
    const { service, session, audio, queue } = build();
    await service.request({ url: 'https://youtu.be/broken' }, alice);
    await service.request({ url: 'https://youtu.be/good' }, alice);

    audio.endStream({ kind: 'failed', detail: 'HTTP 403 Forbidden', playedSec: 0.4 });
    await settle();

    assert.equal(session.current?.track.url, 'https://youtu.be/good');
    assert.equal(queue.length, 0);
  });

  it('reports the underlying reason so an operator knows which lever to pull', async () => {
    const { service, events, audio } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    audio.endStream({
      kind: 'failed',
      detail: 'Sign in to confirm you are not a bot',
      playedSec: 0.2,
    });
    await settle();

    const logged = events.filter((event) => event.type === 'log');
    assert.ok(
      logged.some((event) => event.payload.message.includes('Sign in to confirm')),
      'the real cause must reach the operator, not a generic failure',
    );
  });
});

describe('PlaybackService queue refill', () => {
  /** Builds a service whose exhaustion hook queues from a scripted "default playlist". */
  function buildWithRefill(playlist: readonly string[]) {
    const clock = new FakeClock(0);
    const queue = new Queue(DEFAULT_QUEUE_LIMITS);
    const session = new PlaybackSession({ queue, clock });
    const audio = new FakeAudio();
    let refills = 0;

    const service = new PlaybackService({
      instanceId: 'party',
      session,
      queue,
      resolvers: [new FakeResolver()],
      audio,
      volume: new FakeVolume(),
      events: { publish: () => {} },
      clock,
      logger: silentLogger,
      onQueueExhausted: async () => {
        refills += 1;
        for (const title of playlist) {
          queue.enqueue(track({ title, url: `https://youtu.be/${title}` }), alice, new Date(0));
        }
      },
    });

    return { service, session, audio, queue, refills: () => refills };
  }

  it('asks for a refill once the queue runs dry', async () => {
    const { service, audio, refills, session } = buildWithRefill(['Default One']);
    await service.request({ url: 'https://youtu.be/first' }, alice);

    audio.endStream({ kind: 'completed' });
    // The refill chain is several awaits deep: exhaustion, the hook, then a nested advance.
    await settle();
    await settle();

    assert.equal(refills(), 1);
    assert.equal(session.current?.track.title, 'Default One', 'and plays what arrived');
  });

  it('never refills after a deliberate stop', async () => {
    // Otherwise !stop looks broken: the music comes straight back.
    const { service, refills } = buildWithRefill(['Default One']);
    await service.request({ url: 'https://youtu.be/first' }, alice);

    await service.stop();
    await settle();

    assert.equal(refills(), 0);
  });

  it('refills again once somebody queues something after a stop', async () => {
    const { service, audio, refills } = buildWithRefill(['Default One']);
    await service.request({ url: 'https://youtu.be/first' }, alice);
    await service.stop();

    await service.request({ url: 'https://youtu.be/second' }, alice);
    audio.endStream({ kind: 'completed' });
    await settle();

    assert.equal(refills(), 1, 'queueing is fresh intent that overrides the earlier stop');
  });

  it('does not spin when the refill yields nothing playable', async () => {
    // A default playlist of dead links would otherwise exhaust, refill, exhaust, forever.
    const { service, audio, refills } = buildWithRefill([]);
    await service.request({ url: 'https://youtu.be/first' }, alice);

    audio.endStream({ kind: 'completed' });
    await settle();

    assert.equal(refills(), 1, 'exactly one attempt, then it stays quiet');
  });

  it('re-arms only once something actually played', async () => {
    const { service, audio, refills } = buildWithRefill(['Default One']);
    await service.request({ url: 'https://youtu.be/first' }, alice);

    audio.endStream({ kind: 'completed' });
    await settle();
    await settle();
    assert.equal(refills(), 1);

    // The refilled track finishes; a second refill is legitimate because playback happened.
    audio.endStream({ kind: 'completed' });
    await settle();
    await settle();
    assert.equal(refills(), 2);
  });
});

describe('PlaybackService events', () => {
  it('stamps every event with the instance it belongs to', async () => {
    const { service, events } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    assert.ok(events.length > 0);
    for (const event of events) {
      assert.equal(event.instanceId, 'party', 'one socket multiplexes many bots');
    }
  });

  it('publishes state and queue changes so no consumer has to poll', async () => {
    const { service, events } = build();
    await service.request({ url: 'https://youtu.be/abc' }, alice);

    const types = new Set(events.map((event) => event.type));
    assert.ok(types.has('player.state'));
    assert.ok(types.has('queue.changed'));
    assert.ok(types.has('track.started'));
  });
});
