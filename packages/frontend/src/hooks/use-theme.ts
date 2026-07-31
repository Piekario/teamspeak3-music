import { useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'tsmusic.theme';

function readPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Theme preference, with `system` as the default rather than a hardcoded choice.
 *
 * Three properties are worth the extra care here. The applied theme follows the operating
 * system while the preference is `system`, so changing it at dusk is reflected without a
 * reload. Transitions are enabled only after the first paint, so a reload does not flash
 * through a colour change. And the resolved theme is exposed separately from the preference,
 * because a toggle has to show what is actually on screen, not the word "system".
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
} {
  const [preference, setStoredPreference] = useState<ThemePreference>(readPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    readPreference() === 'system' ? systemTheme() : (readPreference() as ResolvedTheme),
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = (): void => {
      const next = preference === 'system' ? systemTheme() : preference;
      setResolved(next);
      document.documentElement.classList.toggle('dark', next === 'dark');
    };

    apply();
    // Only meaningful while following the system; a fixed choice ignores it.
    if (preference === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    return undefined;
  }, [preference]);

  useEffect(() => {
    // Deferred a frame so the initial theme lands without animating from the wrong colours.
    const frame = requestAnimationFrame(() => {
      document.documentElement.classList.add('theme-ready');
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const setPreference = (next: ThemePreference): void => {
    setStoredPreference(next);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  };

  return {
    preference,
    resolved,
    setPreference,
    toggle: () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
  };
}
