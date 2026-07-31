import type { PlayerState, RepeatMode } from '@tsmusic/shared';
import { Pause, Play, Repeat, Repeat1, Square, SkipForward, Volume2, VolumeX } from 'lucide-react';

import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Slider } from './ui/slider.tsx';

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

const REPEAT_LABELS: Readonly<Record<RepeatMode, string>> = {
  off: 'No repeat',
  track: 'Repeat track',
  queue: 'Repeat queue',
};

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
  const isPlaying = player?.status === 'playing';
  const hasTrack = player?.current != null;
  const volume = player?.volume ?? 40;
  const repeat = player?.repeat ?? 'off';

  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <Button
        onClick={isPlaying ? onPause : onResume}
        disabled={disabled || !hasTrack}
        className="w-24"
      >
        {isPlaying ? <Pause /> : <Play />}
        {isPlaying ? 'Pause' : 'Play'}
      </Button>

      <Button variant="outline" onClick={onSkip} disabled={disabled || !hasTrack}>
        <SkipForward /> Skip
      </Button>

      <Button variant="ghost" onClick={onStop} disabled={disabled || !hasTrack}>
        <Square /> Stop
      </Button>

      <div className="mx-1 h-6 w-px bg-border" aria-hidden="true" />

      <Select
        value={repeat}
        onValueChange={(value) => onRepeat(value as RepeatMode)}
        disabled={disabled}
      >
        <SelectTrigger className="w-40" aria-label="Repeat mode">
          {repeat === 'track' ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(REPEAT_LABELS) as RepeatMode[]).map((mode) => (
            <SelectItem key={mode} value={mode}>
              {REPEAT_LABELS[mode]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="ml-auto flex items-center gap-3">
        {volume === 0 ? (
          <VolumeX className="size-4 text-muted-foreground" />
        ) : (
          <Volume2 className="size-4 text-muted-foreground" />
        )}
        <Slider
          value={[volume]}
          // 150 rather than 100: the encoder can amplify, and quiet sources genuinely need it.
          max={150}
          step={1}
          disabled={disabled}
          aria-label="Volume"
          onValueChange={([value]) => onVolume(value ?? 0)}
          className="w-36"
        />
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
          {volume}%
        </span>
      </div>
    </Card>
  );
}
