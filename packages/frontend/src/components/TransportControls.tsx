import type { PlayerState, RepeatMode } from '@tsmusic/shared';

interface TransportControlsProps {
  readonly player: PlayerState | null;
  readonly disabled: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onSkip: () => void;
  readonly onStop: () => void;
  readonly onVolume: (volume: number) => void;
  readonly onRepeat: (mode: RepeatMode) => void;
}

const REPEAT_MODES: readonly RepeatMode[] = ['off', 'track', 'queue'];

export function TransportControls({
  player,
  disabled,
  onPause,
  onResume,
  onSkip,
  onStop,
  onVolume,
  onRepeat,
}: TransportControlsProps) {
  const status = player?.status ?? 'idle';
  const isPlaying = status === 'playing';
  const hasTrack = player?.current !== null && player?.current !== undefined;

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <button
        type="button"
        onClick={isPlaying ? onPause : onResume}
        disabled={disabled || !hasTrack}
        className="rounded bg-emerald-500 px-4 py-2 font-medium text-slate-900 disabled:opacity-40"
      >
        {isPlaying ? 'Pause' : 'Resume'}
      </button>

      <button
        type="button"
        onClick={onSkip}
        disabled={disabled || !hasTrack}
        className="rounded bg-slate-700 px-4 py-2 text-slate-100 disabled:opacity-40"
      >
        Skip
      </button>

      <button
        type="button"
        onClick={onStop}
        disabled={disabled || !hasTrack}
        className="rounded bg-slate-700 px-4 py-2 text-slate-100 disabled:opacity-40"
      >
        Stop
      </button>

      <label className="ml-2 flex items-center gap-2 text-sm text-slate-300">
        Repeat
        <select
          value={player?.repeat ?? 'off'}
          onChange={(changeEvent) => onRepeat(changeEvent.target.value as RepeatMode)}
          disabled={disabled}
          className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-slate-100"
        >
          {REPEAT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>

      <label className="ml-auto flex items-center gap-2 text-sm text-slate-300">
        Volume
        <input
          type="range"
          min={0}
          // 150 rather than 100: the sink can amplify, and quiet sources genuinely need it.
          max={150}
          step={1}
          value={player?.volume ?? 40}
          onChange={(changeEvent) => onVolume(Number(changeEvent.target.value))}
          disabled={disabled}
          className="w-40 accent-emerald-400 disabled:opacity-40"
        />
        <span className="w-12 text-right tabular-nums">{player?.volume ?? 40}%</span>
      </label>
    </section>
  );
}
