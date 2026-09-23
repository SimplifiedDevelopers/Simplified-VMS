import { theme } from '../theme';
import type {
  DeviceConnectionStatus,
  RecordingSearchFilter,
  RecordingSegment,
  RecordingType,
} from '../../../shared/types';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const LAYOUTS = [1, 4, 9] as const;
export const MAX_TILES = 9;
// Zooming widens the timeline's rendered width (see the zoom control near
// the legend) rather than narrowing the time range it shows — at 1x, a
// short motion clip a few seconds long can be a couple of pixels wide and
// nearly impossible to click precisely; at 16x it's ~16x wider on screen
// for the same click precision, with the container scrolling horizontally.
export const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;

export const TYPE_COLOR: Record<RecordingType, string> = {
  continuous: theme.accent,
  motion: theme.warning,
  smart: theme.danger,
  other: theme.textFaint,
};

export const FILTER_OPTIONS: { value: RecordingSearchFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'continuous', label: 'Continuous' },
  { value: 'motion', label: 'Motion' },
  { value: 'smart', label: 'Smart' },
];

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function resourceLevelColor(percent: number): string {
  if (percent >= 85) return theme.danger;
  if (percent >= 60) return theme.warning;
  return theme.success;
}

export function statusColor(status: DeviceConnectionStatus | undefined): string {
  if (!status || status.state === 'connecting') return theme.warning;
  return status.state === 'online' ? theme.success : theme.danger;
}

export function statusLabel(status: DeviceConnectionStatus | undefined): string {
  if (!status || status.state === 'connecting') return 'Connecting…';
  return status.state === 'online' ? 'Online' : `Offline — ${status.error}`;
}

// Shows the visible time span at this zoom level (24h / zoom) rather than
// a bare multiplier — "3hrs" tells you directly what you're looking at,
// where "8x" would need mental math every time.
export function zoomLabel(zoom: number): string {
  const hours = 24 / zoom;
  const rounded = Number.isInteger(hours) ? hours.toString() : hours.toFixed(1);
  return `${rounded}hr${hours === 1 ? '' : 's'}`;
}

export interface PlaybackTileState {
  deviceId: string | null;
  deviceName: string | null;
  channel: number | null;
  channelLabel: string | null;
  segments: RecordingSegment[];
  searching: boolean;
  viewHandle: string | null;
  isPaused: boolean;
  currentMs: number | null;
  // The [start, end] range viewHandle was actually opened with — a seek is
  // only valid within this exact range (confirmed live: seeking a
  // different recording's time range failed with NETDEV_E_PLAYER_INVALID_
  // PARAM, and left the tile stuck retrying the same broken seek forever
  // until this range check was added).
  playStartMs: number | null;
  playEndMs: number | null;
  error: string | null;
  // Set by handleStopAll right before it clears currentMs/playEndMs below
  // - lets the Resume button (next to Stop) restart playback from the
  // exact point it was stopped at, instead of the user needing to re-find
  // and re-click that spot on the timeline. null whenever there's nothing
  // to resume (never played, or already resumed/replaced by a new
  // segment - both paths reset the tile via emptyTile()).
  stoppedAtMs: number | null;
  stoppedEndMs: number | null;
}

export function emptyTile(): PlaybackTileState {
  return {
    deviceId: null,
    deviceName: null,
    channel: null,
    channelLabel: null,
    segments: [],
    searching: false,
    viewHandle: null,
    isPaused: false,
    currentMs: null,
    playStartMs: null,
    playEndMs: null,
    error: null,
    stoppedAtMs: null,
    stoppedEndMs: null,
  };
}

export interface ClipMark {
  deviceId: string;
  channel: number;
  startMs: number;
}

export interface ExportPopupState {
  deviceId: string;
  deviceName: string;
  channel: number;
  channelLabel: string;
  startMs: number;
  endMs: number;
  path: string | null;
  choosing: boolean;
}

// A clip download that's been started — tracked independently of
// ExportPopupState so the export popup can close the instant "Download" is
// clicked (per explicit request: downloads run in the background, not
// blocking the popup) while progress keeps updating here. Surfaced via a
// small indicator next to the clip-marker buttons; clicking it opens the
// Downloads popup listing every item below.
export interface DownloadItem {
  handle: string;
  deviceId: string;
  deviceName: string;
  channel: number;
  channelLabel: string;
  path: string;
  progress: number;
  done: boolean;
  // User-paused via the Downloads popup's own Pause button — distinct from
  // done/error, and from a tile's on-screen setFrameDelivery pause (that's
  // about not rendering a preview nobody's looking at; this actually stops
  // and later resumes the export's own native session).
  paused: boolean;
  // Set once the file's actually been checked on disk after reaching
  // 100% — a vendor reporting "done" doesn't necessarily mean the
  // transfer genuinely succeeded (confirmed live on TVT: a failed
  // transfer still reports 100%, producing a 0-byte "successful" export).
  error?: string;
}
