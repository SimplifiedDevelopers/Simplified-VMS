// Shared vector icons for video tile placeholders. SVG (not a raster image)
// so it stays crisp at any tile size, including a tile expanded to fill
// the whole grid — a fixed-resolution image would visibly blur at that
// size. Same currentColor pattern as shell/icons.tsx, just for a different
// part of the UI (tile placeholders, not the header buttons).

// Camera-with-a-slash — shown in a Live View/Playback tile both when a
// channel fails to start entirely (offline device, network/auth error) AND
// when it's connected/streaming but the decoded picture itself is blank
// (see main/services/videoHealthCheck.ts) — one consistent icon for "no
// usable video" regardless of cause or channel type (IP or hybrid-DVR
// analog/coax), rather than a second distinct icon for the connected-but-
// blank case (used to be NoSignalIcon, a warning triangle — removed per
// explicit user request: IP channels showed this camera-off icon while
// coax channels showed the triangle, an inconsistency worth just
// eliminating rather than explaining). Matches Feather Icons' "video-off"
// glyph shape (MIT licensed) rather than a downloaded stock icon, to avoid
// embedding an asset of unknown or unlicensed origin in the shipped app.
export function CameraOffIcon({ size = 44 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// Trash can — used for the Delete action in Device Management's device
// list, replacing a plain red "Delete" text link. Matches Feather Icons'
// "trash-2" glyph shape (MIT licensed), same reasoning as CameraOffIcon
// for not using a downloaded/unlicensed asset.
export function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

// Camera — Live View toolbar's Snapshot action. Matches Feather Icons'
// "camera" glyph shape (MIT licensed), same reasoning as CameraOffIcon.
export function CameraIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

// Solid red dot / solid square — the universal record/stop pictogram
// convention rather than a named icon-set glyph, swapped in the Live View
// toolbar based on whether a recording is currently in progress.
export function RecordIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function StopIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

// Counter-clockwise arrow — Live View toolbar's "Restore last closed
// channels" action, next to Close All. Matches Feather Icons' "rotate-ccw"
// glyph shape (MIT licensed), same reasoning as CameraOffIcon.
export function RestoreIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

// Double chevrons — collapse/expand toggle for a side panel (Playback's
// Recording Files list, Live View's device tree). Bigger and bolder than
// the plain '‹'/'›' text characters used here originally, which were hard
// to notice per explicit user feedback. Matches Feather Icons'
// "chevrons-left"/"chevrons-right" glyph shape (MIT licensed), same
// reasoning as CameraOffIcon. `direction` is the way the panel will move
// on click - pass 'left' for a left-pointing double chevron, 'right' for
// right-pointing; the caller picks based on which edge the panel lives on
// and whether this click collapses or expands it.
export function PanelChevronIcon({ direction, size = 18 }: { direction: 'left' | 'right'; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === 'left' ? (
        <>
          <polyline points="11 17 6 12 11 7" />
          <polyline points="18 17 13 12 18 7" />
        </>
      ) : (
        <>
          <polyline points="13 17 18 12 13 7" />
          <polyline points="6 17 11 12 6 7" />
        </>
      )}
    </svg>
  );
}
