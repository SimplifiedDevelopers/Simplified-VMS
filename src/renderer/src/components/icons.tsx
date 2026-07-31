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
