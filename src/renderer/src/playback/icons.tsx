// Plain vector icons (fill=currentColor), not the Unicode media-control
// glyphs (⏸⏭⏹) they replace — Windows renders those specific codepoints via
// its color-emoji font, which looks visibly different in weight/style from
// Speed's plain text and Sync's plain arrow glyph, even once the buttons
// themselves share identical styling. Same fix already applied once to the
// header icons (see shell/icons.tsx) for the same underlying reason.
export function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 4l14 8-14 8V4z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="4" width="5" height="16" />
      <rect x="14" y="4" width="5" height="16" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" />
    </svg>
  );
}

export function StepForwardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5l11 7-11 7V5z" />
      <rect x="17" y="5" width="3" height="14" />
    </svg>
  );
}

// Scissors — shared by both clip-marker buttons (mark start/end point to
// download), a more immediately recognizable "cut point" symbol than the
// bracket shapes this replaced. Stroke-based (not filled) since scissors
// read much more clearly as an outline than as a solid silhouette at this
// size.
export function ScissorsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

// Right-panel file-list entries' per-item download button.
export function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
