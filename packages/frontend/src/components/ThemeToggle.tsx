import { Monitor, Moon, Sun } from 'lucide-react';

import type { ResolvedTheme, ThemePreference } from '../hooks/use-theme.ts';
import { cn } from '../lib/utils.ts';

interface ThemeToggleProps {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  readonly onChange: (preference: ThemePreference) => void;
}

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const satisfies readonly { value: ThemePreference; label: string; Icon: typeof Sun }[];

/**
 * A three-way control rather than a switch, because "follow the system" is a real choice and
 * a two-state toggle silently discards it the first time it is touched.
 */
export function ThemeToggle({ preference, resolved, onChange }: ThemeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex rounded-md border bg-muted/50 p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={value === 'system' ? `System (currently ${resolved})` : label}
            title={label}
            onClick={() => onChange(value)}
            className={cn(
              'rounded-sm p-1.5 transition-colors',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
