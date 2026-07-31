import type { ThemeMode } from '../../shared/types';

// Values are CSS custom properties (see global.css for the actual dark/light
// hex values), not hardcoded hex strings — this lets every component keep
// using `theme.xxx` completely unchanged (including the many module-level
// style objects defined outside any component function, which couldn't use
// a React context/hook) while still supporting a real light/dark switch:
// the browser repaints instantly when the `data-theme` attribute changes,
// with no React re-render involved at all.
export const theme = {
  bg: 'var(--bg)',
  panel: 'var(--panel)',
  surface: 'var(--surface)',
  surfaceHover: 'var(--surface-hover)',
  border: 'var(--border)',
  borderLight: 'var(--border-light)',
  text: 'var(--text)',
  textMuted: 'var(--text-muted)',
  textFaint: 'var(--text-faint)',
  // Sampled directly from the SSM logo (Security Systems & MORE.png) —
  // same brand navy in both palettes, only backgrounds/borders/text flip.
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentPressed: 'var(--accent-pressed)',
  // Navy is dark — anything sitting on an accent-colored background needs
  // light text, unlike the old teal which paired with dark text.
  accentText: 'var(--accent-text)',
  // Translucent accent tints for "selected/active" backgrounds and
  // decorative glows — real per-theme colors (see global.css), not a
  // runtime `${theme.accent}1f` hex-alpha-suffix hack, since that breaks
  // the moment theme.accent stops being a plain 6-digit hex string.
  accentFaint: 'var(--accent-faint)',
  accentGlow: 'var(--accent-glow)',
  // Live View's selected-tile outline — separate from `accent` because
  // navy is too dark to reliably read against a black video tile once the
  // eye is calibrated to a bright light-mode UI (confirmed live: the
  // outline was effectively invisible in light mode). Same navy as accent
  // in dark mode, a brighter blue in light mode — see global.css.
  selection: 'var(--selection)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  success: 'var(--success)',
} as const;

// Fired after the data-theme attribute changes so components that can't
// just rely on CSS (e.g. Logo, which swaps between two actual PNG assets
// rather than a color) can react without needing a shared context.
export const THEME_CHANGE_EVENT = 'ssm-theme-changed';

// 'auto' isn't a real CSS state — data-theme is always set to an actual
// resolved 'light'/'dark'. Cached here (rather than fetched fresh on every
// applyThemeMode call, which would need to be async) since App.tsx keeps it
// current via system.getSystemPrefersDark()/onSystemThemeChanged(); a plain
// synchronous default of true just means "auto" briefly resolves to dark
// before that first IPC round-trip lands, same instant as every other
// theme-affecting setting load.
let systemPrefersDark = true;
let currentMode: ThemeMode = 'dark';

export function setSystemPrefersDark(prefersDark: boolean): void {
  systemPrefersDark = prefersDark;
}

export function applyThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  const resolved = mode === 'auto' ? (systemPrefersDark ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

// Called when the OS's own light/dark setting changes live (see
// App.tsx's system.onSystemThemeChanged subscription) so an "auto" choice
// actually follows it immediately rather than only on next launch. A no-op
// unless the currently configured mode is actually 'auto'.
export function reapplyIfAuto(): void {
  if (currentMode === 'auto') applyThemeMode('auto');
}

export function getCurrentThemeMode(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
