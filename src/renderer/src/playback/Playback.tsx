import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { theme } from '../theme';
import { VideoCanvas } from '../liveView/VideoCanvas';
import { MiniCalendar } from './MiniCalendar';
import { Modal } from '../components/Modal';
import { CameraOffIcon } from '../components/icons';
import emptyTileCamera from '../assets/empty-tile-camera.png';
import type {
  ChannelInfo,
  DeviceConnectionStatus,
  PlaybackSpeed,
  RecordingSearchFilter,
  RecordingSegment,
  RecordingType,
  StoredDevice,
  SystemStats,
} from '../../../shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAYOUTS = [1, 4, 9] as const;
const MAX_TILES = 9;
// Zooming widens the timeline's rendered width (see the zoom control near
// the legend) rather than narrowing the time range it shows — at 1x, a
// short motion clip a few seconds long can be a couple of pixels wide and
// nearly impossible to click precisely; at 16x it's ~16x wider on screen
// for the same click precision, with the container scrolling horizontally.
const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;

const TYPE_COLOR: Record<RecordingType, string> = {
  continuous: theme.accent,
  motion: theme.warning,
  smart: theme.danger,
  other: theme.textFaint,
};

const FILTER_OPTIONS: { value: RecordingSearchFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'continuous', label: 'Continuous' },
  { value: 'motion', label: 'Motion' },
  { value: 'smart', label: 'Smart' },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function resourceLevelColor(percent: number): string {
  if (percent >= 85) return theme.danger;
  if (percent >= 60) return theme.warning;
  return theme.success;
}

function statusColor(status: DeviceConnectionStatus | undefined): string {
  if (!status || status.state === 'connecting') return theme.warning;
  return status.state === 'online' ? theme.success : theme.danger;
}

function statusLabel(status: DeviceConnectionStatus | undefined): string {
  if (!status || status.state === 'connecting') return 'Connecting…';
  return status.state === 'online' ? 'Online' : `Offline — ${status.error}`;
}

// Shows the visible time span at this zoom level (24h / zoom) rather than
// a bare multiplier — "3hrs" tells you directly what you're looking at,
// where "8x" would need mental math every time.
function zoomLabel(zoom: number): string {
  const hours = 24 / zoom;
  const rounded = Number.isInteger(hours) ? hours.toString() : hours.toFixed(1);
  return `${rounded}hr${hours === 1 ? '' : 's'}`;
}

interface PlaybackTileState {
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
}

function emptyTile(): PlaybackTileState {
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
  };
}

interface ClipMark {
  deviceId: string;
  channel: number;
  startMs: number;
}

interface ExportPopupState {
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
interface DownloadItem {
  handle: string;
  deviceId: string;
  deviceName: string;
  channel: number;
  channelLabel: string;
  path: string;
  progress: number;
  done: boolean;
  // Set once the file's actually been checked on disk after reaching
  // 100% — a vendor reporting "done" doesn't necessarily mean the
  // transfer genuinely succeeded (confirmed live on TVT: a failed
  // transfer still reports 100%, producing a 0-byte "successful" export).
  error?: string;
}

// isActive defaults to true so a popped-out window (PopoutWindow.tsx,
// always its own visible OS window — no tab-hiding concept applies there)
// doesn't need to pass anything; AppShell explicitly passes the real
// tab-visibility value since Playback's own tab can be hidden behind a
// different one while staying mounted.
export function Playback({ isActive = true }: { isActive?: boolean } = {}) {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(4);
  const [tiles, setTiles] = useState<PlaybackTileState[]>(() => Array.from({ length: MAX_TILES }, emptyTile));
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  // Guards playTileFrom against overlapping invocations for the SAME tile
  // — confirmed live as a real bug: a slow vendor's stop()/start() (Dahua,
  // whose native stop/start calls can take a long time) leaves a wide
  // window where an impatient extra click re-enters playTileFrom before
  // the first call's stop+start has resolved and updated tile.viewHandle,
  // so the second call reads the same stale handle, redundantly stops it,
  // and starts its OWN new session — repeat that a few times and native
  // playback sessions pile up concurrently (confirmed live: 7 simultaneous
  // 1080p decodes for one Dahua channel from a handful of clicks), pegging
  // CPU well beyond what a single session would. A fast vendor's stop/
  // start calls close this window quickly enough that it's very hard to
  // hit; Dahua's slowness makes it easy.
  const tileTransitionsRef = useRef<Set<number>>(new Set());
  const [selectedTileIndex, setSelectedTileIndex] = useState(0);
  // Same expand/restore behavior as Live View's grid: double-click a
  // filled tile to have it fill the whole grid, double-click again to go
  // back to exactly what was there — every other tile's playback session
  // keeps running the whole time, this only stops rendering them.
  const [expandedTileIndex, setExpandedTileIndex] = useState<number | null>(null);
  // Same hover-reveal close button as Live View's grid — tracks which
  // single tile the mouse is over so the individual-close × only appears
  // on hover.
  const [hoveredTileIndex, setHoveredTileIndex] = useState<number | null>(null);

  // toISOString() is always UTC, not local time - once local time passes
  // whatever hour lines up with UTC midnight (4 PM-ish for US Eastern),
  // that would default "today" to tomorrow's date instead, silently
  // searching/exporting a day that hasn't happened yet locally. Confirmed
  // live as the real cause of an apparently-empty calendar/search.
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [filters, setFilters] = useState<RecordingSearchFilter[]>(['all']);
  const [zoom, setZoom] = useState<(typeof ZOOM_LEVELS)[number]>(1);

  // 'all' is mutually exclusive with the other three checkboxes — checking
  // it clears the rest, and checking any individual type clears 'all'.
  function toggleFilter(value: RecordingSearchFilter): void {
    if (value === 'all') {
      setFilters(['all']);
      return;
    }
    setFilters((prev) => {
      const withoutAll = prev.filter((f) => f !== 'all');
      const next = withoutAll.includes(value) ? withoutAll.filter((f) => f !== value) : [...withoutAll, value];
      return next.length === 0 ? ['all'] : next;
    });
  }
  const [stats, setStats] = useState<SystemStats | null>(null);
  // Keyed by viewHandle — see LiveView.tsx's matching comment.
  const [videoHealthByHandle, setVideoHealthByHandle] = useState<Record<string, boolean>>({});
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  // Sidebar device tree — mirrors Live View's own sidebar exactly, except
  // clicking a channel assigns it to the selected tile for searching
  // instead of starting a live stream.
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [channelsByDevice, setChannelsByDevice] = useState<Record<string, ChannelInfo[]>>({});
  const [loadingChannelsFor, setLoadingChannelsFor] = useState<string | null>(null);
  const [channelErrors, setChannelErrors] = useState<Record<string, string | null>>({});
  const channelsRef = useRef(channelsByDevice);
  channelsRef.current = channelsByDevice;

  const [clipMark, setClipMark] = useState<ClipMark | null>(null);
  // Live time-under-cursor while hovering the timeline — replaces the old
  // native `title` tooltip on each segment (type + start/end), which only
  // ever appeared after the browser's own hover delay and only over a
  // filled segment. This follows the mouse continuously across the whole
  // bar (filled or empty) and shows just the time, not the recording type.
  const [timelineHoverX, setTimelineHoverX] = useState<number | null>(null);
  const [timelineHoverMs, setTimelineHoverMs] = useState<number | null>(null);
  const [exportPopup, setExportPopup] = useState<ExportPopupState | null>(null);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [downloadsPopupOpen, setDownloadsPopupOpen] = useState(false);
  // Right-side "recording files" panel — a second way to download besides
  // the Mark Start/Mark End clip markers: lists the selected tile's already
  // -fetched segments (same data backing the bottom timeline), filterable
  // by type, each downloadable directly at its own exact start/end instead
  // of requiring the user to scrub and mark points manually.
  const [fileListFilter, setFileListFilter] = useState<'all' | 'continuous' | 'motion'>('all');

  // Dismissing (or Cancel-ing) the last remaining download left the popup
  // open showing just its empty "No downloads." state instead of actually
  // closing — confirmed live as a real annoyance. Auto-close the instant
  // the list empties out while it's open, rather than leaving that blank
  // shell behind.
  useEffect(() => {
    if (downloadsPopupOpen && downloads.length === 0) setDownloadsPopupOpen(false);
  }, [downloads, downloadsPopupOpen]);
  const [statusById, setStatusById] = useState<Record<string, DeviceConnectionStatus | undefined>>({});

  const selectedTile = tiles[selectedTileIndex];

  useEffect(() => {
    window.ssmVms.devices.list().then(setDevices);
    // Devices connect at app boot, well before this tab is ever opened —
    // onStatusChanged below only pushes FUTURE changes, so without this
    // initial fetch every already-online device would show as undefined
    // (falls back to the "connecting" orange color) until its next status
    // change. One bulk call instead of one devices:getStatus round trip
    // per device — for a 50+ device fleet that was 50+ separate IPC calls
    // firing in a burst at mount, found via a resource-usage audit.
    window.ssmVms.devices.getAllStatuses().then((statuses) => {
      setStatusById((prev) => ({ ...prev, ...statuses }));
    });
  }, []);

  // Same live status feed Live View's sidebar already subscribes to — a
  // device you're picking a channel from here is exactly as relevant to
  // know is actually reachable as one you're about to drag into Live View.
  useEffect(() => {
    return window.ssmVms.devices.onStatusChanged((deviceId, status) => {
      setStatusById((prev) => ({ ...prev, [deviceId]: status }));
    });
  }, []);

  useEffect(() => window.ssmVms.system.onStats(setStats), []);

  useEffect(() => {
    return window.ssmVms.playback.onVideoHealth((viewHandle, healthy) => {
      setVideoHealthByHandle((prev) => ({ ...prev, [viewHandle]: healthy }));
    });
  }, []);

  // Stops every tile's active session on true unmount (the tab being
  // closed — AppShell keeps opened tabs mounted otherwise). Reads from a
  // ref, not the tiles state directly, since an effect with an empty
  // dependency array would otherwise close over the very first render's
  // (empty) tiles forever.
  useEffect(() => {
    return () => {
      tilesRef.current.forEach((t) => {
        if (t.deviceId && t.viewHandle) window.ssmVms.playback.stop(t.deviceId, t.viewHandle).catch(() => undefined);
      });
    };
  }, []);

  // Once a tile's frame delivery gets paused because its own clip is being
  // exported, it stays paused even after that export finishes — per
  // explicit request, finishing a download should leave the tile stopped
  // (search results/timeline still there to pick something else) rather
  // than silently resuming playback the user never asked to resume. Keyed
  // by viewHandle rather than device/channel so it only affects THIS
  // specific playback session — picking a new segment (a fresh
  // stop+restart, hence a new viewHandle) plays normally, unaffected by a
  // previous session's completed export.
  const stayPausedAfterExportRef = useRef<Set<string>>(new Set());

  // Pauses/resumes frame delivery for every currently-playing tile based
  // on whether this tab is the one actually visible (isActive), whether
  // the tile itself is currently displayed (not hidden behind an expanded
  // tile), and whether that exact device/channel is currently being
  // exported — see VmsAdapter.setFrameDelivery's doc comment and
  // LiveView.tsx's matching effect. A hidden/exporting tile's native
  // session keeps running (so it resumes instantly), it just stops paying
  // the decode/convert/IPC cost for frames nobody renders. The export case
  // specifically: exporting already runs its own independent decode
  // session (clipExporter.ts) for the exact same channel/range — on-screen
  // preview of that same clip while its own export is running would just
  // be a second, redundant decode for content the export doesn't need
  // rendered, on top of everything else already competing for the CPU.
  useEffect(() => {
    let cancelled = false;
    const exportingKeys = new Set(
      downloads.filter((d) => !d.done).map((d) => `${d.deviceId}:${d.channel}`),
    );
    // Pausing is instant for every tile (only ever reduces load); resuming
    // is staggered — see LiveView.tsx's matching effect for why: resuming
    // several tiles' frame delivery in the same instant (e.g. collapsing
    // an expanded tile back to a full grid) confirmed live to overwhelm
    // an older machine's renderer badly enough to show "Not Responding,"
    // even though every underlying native call completed normally.
    const toResume: Array<{ deviceId: string; viewHandle: string }> = [];
    tiles.forEach((tile, index) => {
      if (!tile.deviceId || !tile.viewHandle) return;
      const isExporting = tile.channel !== null && exportingKeys.has(`${tile.deviceId}:${tile.channel}`);
      if (isExporting) stayPausedAfterExportRef.current.add(tile.viewHandle);
      const staysPaused = stayPausedAfterExportRef.current.has(tile.viewHandle);
      const shouldDeliver =
        isActive && (expandedTileIndex === null || expandedTileIndex === index) && !isExporting && !staysPaused;
      if (shouldDeliver) {
        toResume.push({ deviceId: tile.deviceId, viewHandle: tile.viewHandle });
      } else {
        window.ssmVms.playback.setFrameDelivery(tile.deviceId, tile.viewHandle, false);
      }
    });

    (async () => {
      for (const { deviceId, viewHandle } of toResume) {
        if (cancelled) return;
        window.ssmVms.playback.setFrameDelivery(deviceId, viewHandle, true);
        if (toResume.length > 1) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isActive, expandedTileIndex, tiles, downloads]);

  // Polls every currently-playing (non-paused) tile's position at once,
  // rather than one interval per tile — this vendor's SDK has no
  // push-based position event, only poll-on-demand (NETDEV_PLAY_CTRL_
  // GETPLAYTIME), so this is the cheapest way to keep every tile's scrub
  // cursor honest simultaneously.
  useEffect(() => {
    const interval = setInterval(() => {
      tilesRef.current.forEach((t, i) => {
        if (!t.deviceId || !t.viewHandle || t.isPaused) return;
        window.ssmVms.playback.getTime(t.deviceId, t.viewHandle).then((ms) => {
          if (ms > 0) updateTile(i, { currentMs: ms });
        });
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Guards stopBackup from firing twice for the same handle - the polling
  // interval can see pct>=100 again before the async finalize/verify chain
  // below has set `done: true` in state.
  const finalizingHandlesRef = useRef<Set<string>>(new Set());

  // Polls every download that isn't finished yet — runs independently of
  // whether the export popup is even open, since downloads keep going in
  // the background after it closes.
  useEffect(() => {
    const interval = setInterval(() => {
      setDownloads((prev) => {
        const active = prev.filter((d) => !d.done);
        if (active.length === 0) return prev;
        active.forEach((d) => {
          window.ssmVms.playback.getBackupProgress(d.deviceId, d.handle).then((pct) => {
            setDownloads((cur) => cur.map((item) => (item.handle === d.handle ? { ...item, progress: pct } : item)));
            if (pct < 100) return;
            if (finalizingHandlesRef.current.has(d.handle)) return;
            finalizingHandlesRef.current.add(d.handle);
            // Confirmed against TVT's own SDK demo (BackupDlg.cpp): it
            // always calls NET_SDK_StopGetFile once the download hits
            // 100%, even on a normal successful finish, not just on
            // cancel. Without that finalize call the SDK never actually
            // flushes/closes the file, so a transfer that legitimately
            // reports "complete" still leaves a permanent 0-byte file on
            // disk. stopBackup already wraps that native call — this was
            // previously only ever invoked from the Cancel button.
            window.ssmVms.playback
              .stopBackup(d.deviceId, d.handle)
              .catch(() => undefined)
              .finally(() => {
                // Even with finalize now in place, verify the file itself
                // before marking this done rather than trusting the
                // vendor's own progress signal alone (see DownloadItem
                // .error's doc comment).
                window.ssmVms.playback.verifyExportedFile(d.path).then(({ ok, size }) => {
                  setDownloads((cur) =>
                    cur.map((item) =>
                      item.handle === d.handle
                        ? {
                            ...item,
                            done: true,
                            error: ok ? undefined : `Export failed — the saved file is ${size === 0 ? 'empty (0 bytes)' : 'missing'}.`,
                          }
                        : item,
                    ),
                  );
                });
              });
          });
        });
        return prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  function updateTile(index: number, partial: Partial<PlaybackTileState>): void {
    setTiles((prev) => prev.map((t, i) => (i === index ? { ...t, ...partial } : t)));
  }

  function dayRangeMs(): { startMs: number; endMs: number } {
    const startMs = new Date(`${date}T00:00:00`).getTime();
    return { startMs, endMs: startMs + DAY_MS };
  }

  async function searchTile(index: number, deviceId: string, channel: number): Promise<void> {
    updateTile(index, { searching: true, error: null });
    const { startMs, endMs } = dayRangeMs();
    try {
      const segments = await window.ssmVms.playback.findRecordings(deviceId, channel, startMs, endMs, filters);
      updateTile(index, { segments, searching: false });
    } catch (err) {
      updateTile(index, { searching: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function stopTile(index: number): Promise<void> {
    const tile = tilesRef.current[index];
    if (!tile.deviceId || !tile.viewHandle) return;
    try {
      await window.ssmVms.playback.stop(tile.deviceId, tile.viewHandle);
    } catch {
      // ignore — tile is being reset regardless
    }
  }

  // Individual-close × on a tile's hover overlay — mirrors Live View's
  // clearTile, just resetting back to emptyTile() instead of deleting a
  // record, since Playback's tiles are a fixed-length array, not a sparse
  // map of assigned indices.
  async function clearTile(index: number): Promise<void> {
    await stopTile(index);
    setTiles((prev) => prev.map((t, i) => (i === index ? emptyTile() : t)));
    setExpandedTileIndex((prev) => (prev === index ? null : prev));
  }

  // Drag one tile onto another to swap their on-screen positions - purely a
  // client-side rearrange, no native calls, same reasoning as Live View's
  // own swapTiles: each tile's viewHandle already identifies a real,
  // still-playing (or paused) native session, so moving which array index
  // a PlaybackTileState lives at just changes which VideoCanvas prop it's
  // passed to next render.
  function swapTiles(fromIndex: number, toIndex: number): void {
    setTiles((prev) => {
      const next = [...prev];
      next[fromIndex] = prev[toIndex];
      next[toIndex] = prev[fromIndex];
      return next;
    });
    setSelectedTileIndex((prev) => {
      if (prev === fromIndex) return toIndex;
      if (prev === toIndex) return fromIndex;
      return prev;
    });
  }

  // Assigning a channel always targets the currently selected tile
  // (there's always exactly one selected, unlike Live View where selection
  // can be cleared) — overwrites whatever was there, stopping its playback
  // first.
  async function assignChannelToTile(deviceId: string, channel: number): Promise<void> {
    const index = selectedTileIndex;
    // Diagnostic: reported live that switching devices leaves the calendar
    // showing the previous device's day dots and the day-view search
    // finding nothing for the newly picked one — logging the actual
    // before/after tile state to see whether selectedTileIndex/the
    // previous tile's deviceId is what's expected at the moment of switch.
    // eslint-disable-next-line no-console
    console.log(
      '[playback-diag] assignChannelToTile index=%d prevDeviceId=%s prevChannel=%s -> newDeviceId=%s newChannel=%s',
      index, tilesRef.current[index]?.deviceId, tilesRef.current[index]?.channel, deviceId, channel,
    );
    await stopTile(index);
    const device = devices.find((d) => d.id === deviceId);
    const channelLabel = channelsRef.current[deviceId]?.find((c) => c.channel === channel)?.label ?? `Channel ${channel}`;
    updateTile(index, {
      ...emptyTile(),
      deviceId,
      deviceName: device?.name ?? deviceId,
      channel,
      channelLabel,
    });
    await searchTile(index, deviceId, channel);
  }

  // Re-searches every currently-assigned tile — used when the date/filter
  // changes (each tile's previous search results are for a different day)
  // and by the explicit Search button (a manual "refresh everything now").
  async function researchAllTiles(): Promise<void> {
    await Promise.all(
      tilesRef.current.map(async (t, i) => {
        if (t.deviceId && t.channel !== null) {
          await stopTile(i);
          updateTile(i, { viewHandle: null, isPaused: false, currentMs: null, playStartMs: null, playEndMs: null });
          await searchTile(i, t.deviceId, t.channel);
        }
      }),
    );
  }

  useEffect(() => {
    researchAllTiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, filters]);

  async function playTileFrom(index: number, startMs: number, endMs: number): Promise<void> {
    // See tileTransitionsRef's own doc comment - ignore a re-entrant call
    // for this same tile rather than letting it race the one already in
    // flight (which would each read the same stale viewHandle and start
    // their own redundant session). The user's click isn't lost forever —
    // once the in-flight transition finishes and updates state, a repeat
    // click lands cleanly against the new, correct viewHandle.
    if (tileTransitionsRef.current.has(index)) return;
    tileTransitionsRef.current.add(index);
    try {
      const tile = tilesRef.current[index];
      if (!tile.deviceId || tile.channel === null) return;
      const sameSegmentAlreadyOpen =
        tile.viewHandle !== null && tile.playStartMs !== null && tile.playEndMs !== null &&
        startMs >= tile.playStartMs && startMs <= tile.playEndMs;
      try {
        if (sameSegmentAlreadyOpen) {
          await window.ssmVms.playback.control(tile.deviceId, tile.viewHandle!, 'seek', startMs);
          updateTile(index, { isPaused: false, currentMs: startMs });
          return;
        }
        if (tile.viewHandle) await window.ssmVms.playback.stop(tile.deviceId, tile.viewHandle);
        const handle = await window.ssmVms.playback.start(tile.deviceId, tile.channel, startMs, endMs);
        updateTile(index, {
          viewHandle: handle,
          isPaused: false,
          currentMs: startMs,
          playStartMs: startMs,
          playEndMs: endMs,
          error: null,
        });
      } catch (err) {
        updateTile(index, {
          viewHandle: null,
          isPaused: false,
          currentMs: null,
          playStartMs: null,
          playEndMs: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      tileTransitionsRef.current.delete(index);
    }
  }

  function handleTimelineClick(e: MouseEvent<HTMLDivElement>): void {
    const segments = selectedTile.segments;
    if (segments.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const { startMs: dayStartMs } = dayRangeMs();
    const clickedMs = dayStartMs + fraction * DAY_MS;
    const segment = segments.find((s) => clickedMs >= s.startMs && clickedMs <= s.endMs);
    if (segment) playTileFrom(selectedTileIndex, clickedMs, segment.endMs);
  }

  function handleTimelineHover(e: MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.min(1, Math.max(0, x / rect.width));
    const { startMs: dayStartMs } = dayRangeMs();
    setTimelineHoverX(x);
    setTimelineHoverMs(dayStartMs + fraction * DAY_MS);
  }

  function activeTileIndices(): number[] {
    return tiles.map((_, i) => i).filter((i) => i < layout && tiles[i].viewHandle);
  }

  async function handlePlayPause(): Promise<void> {
    const goingToPause = !selectedTile.isPaused;
    const command = goingToPause ? 'pause' : 'resume';
    await Promise.all(
      activeTileIndices().map(async (i) => {
        const t = tilesRef.current[i];
        try {
          await window.ssmVms.playback.control(t.deviceId!, t.viewHandle!, command);
          updateTile(i, { isPaused: goingToPause });
        } catch {
          // leave that tile's state untouched — its own error surface (if
          // any) will show up next time it's interacted with directly
        }
      }),
    );
  }

  async function handleStopAll(): Promise<void> {
    await Promise.all(
      activeTileIndices().map(async (i) => {
        await stopTile(i);
        updateTile(i, { viewHandle: null, isPaused: false, currentMs: null, playStartMs: null, playEndMs: null });
      }),
    );
  }

  async function handleCloseAll(): Promise<void> {
    await Promise.all(tiles.map((_, i) => stopTile(i)));
    setTiles(Array.from({ length: MAX_TILES }, emptyTile));
    setSelectedTileIndex(0);
    setClipMark(null);
  }

  async function handleFrameStep(): Promise<void> {
    if (!selectedTile.isPaused) return;
    await Promise.all(
      activeTileIndices()
        .filter((i) => tilesRef.current[i].isPaused)
        .map((i) => {
          const t = tilesRef.current[i];
          return window.ssmVms.playback.control(t.deviceId!, t.viewHandle!, 'stepFrame').catch(() => undefined);
        }),
    );
  }

  async function handleSpeedCycle(): Promise<void> {
    const next: PlaybackSpeed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    setSpeed(next);
    await Promise.all(
      activeTileIndices().map((i) => {
        const t = tilesRef.current[i];
        return window.ssmVms.playback.control(t.deviceId!, t.viewHandle!, 'setSpeed', next).catch(() => undefined);
      }),
    );
  }

  // Aligns every other active tile to the selected tile's current position
  // — manual, not automatic, since independently-opened recordings
  // naturally drift apart (different start points, different decode
  // pacing) and forcing continuous auto-sync would fight normal per-tile
  // scrubbing/pausing.
  async function handleSync(): Promise<void> {
    const reference = selectedTile.currentMs;
    if (reference === null) return;
    await Promise.all(
      activeTileIndices()
        .filter((i) => i !== selectedTileIndex)
        .map(async (i) => {
          const t = tilesRef.current[i];
          if (t.playStartMs === null || t.playEndMs === null) return;
          if (reference < t.playStartMs || reference > t.playEndMs) return; // outside this tile's open range
          try {
            await window.ssmVms.playback.control(t.deviceId!, t.viewHandle!, 'seek', reference);
            updateTile(i, { currentMs: reference });
          } catch {
            // that tile just doesn't sync this time — not fatal
          }
        }),
    );
  }

  function handleMarkStart(): void {
    if (!selectedTile.deviceId || selectedTile.channel === null || selectedTile.currentMs === null) return;
    setClipMark({ deviceId: selectedTile.deviceId, channel: selectedTile.channel, startMs: selectedTile.currentMs });
  }

  const markMatchesSelectedTile =
    clipMark !== null && clipMark.deviceId === selectedTile.deviceId && clipMark.channel === selectedTile.channel;

  function handleMarkEnd(): void {
    if (!markMatchesSelectedTile || selectedTile.currentMs === null || !selectedTile.deviceId || selectedTile.channel === null) {
      return;
    }
    const startMs = Math.min(clipMark!.startMs, selectedTile.currentMs);
    const endMs = Math.max(clipMark!.startMs, selectedTile.currentMs);
    const deviceId = selectedTile.deviceId;
    const channel = selectedTile.channel;
    setExportPopup({
      deviceId,
      deviceName: selectedTile.deviceName ?? deviceId,
      channel,
      channelLabel: selectedTile.channelLabel ?? `Channel ${channel}`,
      startMs,
      endMs,
      path: null,
      choosing: false,
    });
    setClipMark(null);
    // Prefills from Settings' Export Path (Video tab) if one is configured
    // — "Change Destination…" in the popup still opens a real Save dialog
    // to override for this one clip. Null (no setting configured) just
    // leaves the popup in its original "choose a destination" state.
    window.ssmVms.playback.getDefaultExportPath(deviceId, channel, startMs).then((path) => {
      if (!path) return;
      setExportPopup((prev) =>
        prev && prev.deviceId === deviceId && prev.channel === channel && prev.startMs === startMs
          ? { ...prev, path }
          : prev,
      );
    });
  }

  // Right-panel file-list's own download trigger — reuses the exact same
  // export popup/download flow as the Mark Start/Mark End clip markers,
  // just pre-filled with this entry's already-known exact start/end instead
  // of whatever the user happened to scrub to.
  function handleDownloadSegment(seg: RecordingSegment): void {
    if (!selectedTile.deviceId || selectedTile.channel === null) return;
    const deviceId = selectedTile.deviceId;
    const channel = selectedTile.channel;
    setExportPopup({
      deviceId,
      deviceName: selectedTile.deviceName ?? deviceId,
      channel,
      channelLabel: selectedTile.channelLabel ?? `Channel ${channel}`,
      startMs: seg.startMs,
      endMs: seg.endMs,
      path: null,
      choosing: false,
    });
    window.ssmVms.playback.getDefaultExportPath(deviceId, channel, seg.startMs).then((path) => {
      if (!path) return;
      setExportPopup((prev) =>
        prev && prev.deviceId === deviceId && prev.channel === channel && prev.startMs === seg.startMs
          ? { ...prev, path }
          : prev,
      );
    });
  }

  async function handleChooseExportPath(): Promise<void> {
    if (!exportPopup) return;
    setExportPopup({ ...exportPopup, choosing: true });
    const path = await window.ssmVms.playback.chooseExportPath(exportPopup.deviceId, exportPopup.channel, exportPopup.startMs);
    setExportPopup((prev) => (prev ? { ...prev, path, choosing: false } : prev));
  }

  // Per explicit request: the popup closes the instant Download is clicked
  // — it does not wait around to show progress. The transfer keeps running
  // server-side regardless of whether anything in the UI is watching it;
  // the download is tracked in `downloads` from here on, surfaced via the
  // small indicator next to the clip-marker buttons instead.
  async function handleStartExportDownload(): Promise<void> {
    if (!exportPopup || !exportPopup.path) return;
    const { deviceId, deviceName, channel, channelLabel, startMs, endMs, path } = exportPopup;
    setExportPopup(null);
    try {
      const handle = await window.ssmVms.playback.startBackup(deviceId, channel, startMs, endMs, path);
      setDownloads((prev) => [...prev, { handle, deviceId, deviceName, channel, channelLabel, path, progress: 0, done: false }]);
    } catch (err) {
      // Export is currently disabled server-side (see main/ipc/playback.ts)
      // — surfaced here in the same Downloads list as a real transfer's
      // failure would be, rather than the click silently doing nothing.
      setDownloads((prev) => [
        ...prev,
        {
          handle: `failed-${Date.now()}`,
          deviceId,
          deviceName,
          channel,
          channelLabel,
          path,
          progress: 0,
          done: true,
          error: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
  }

  function handleCancelExport(): void {
    setExportPopup(null);
  }

  async function handleStopDownload(handle: string): Promise<void> {
    const item = downloads.find((d) => d.handle === handle);
    if (!item) return;
    await window.ssmVms.playback.stopBackup(item.deviceId, handle).catch(() => undefined);
    setDownloads((prev) => prev.filter((d) => d.handle !== handle));
  }

  function handleDismissDownload(handle: string): void {
    setDownloads((prev) => prev.filter((d) => d.handle !== handle));
  }

  function handleOpenDownloadLocation(path: string): void {
    window.ssmVms.playback.openExportLocation(path);
  }

  async function handleChangeLayout(next: (typeof LAYOUTS)[number]): Promise<void> {
    await Promise.all(
      tiles.map((t, i) => (i >= next && t.viewHandle ? stopTile(i) : Promise.resolve())),
    );
    setTiles((prev) => prev.map((t, i) => (i >= next ? emptyTile() : t)));
    if (selectedTileIndex >= next) setSelectedTileIndex(0);
    setLayout(next);
  }

  // --- sidebar device tree (mirrors Live View's) ---

  async function ensureChannels(deviceId: string): Promise<ChannelInfo[]> {
    const cached = channelsRef.current[deviceId];
    if (cached) return cached;
    const channels = await window.ssmVms.liveView.getChannels(deviceId);
    setChannelsByDevice((prev) => ({ ...prev, [deviceId]: channels }));
    return channels;
  }

  async function loadChannels(deviceId: string): Promise<void> {
    setLoadingChannelsFor(deviceId);
    setChannelErrors((prev) => ({ ...prev, [deviceId]: null }));
    try {
      await ensureChannels(deviceId);
    } catch (err) {
      setChannelErrors((prev) => ({ ...prev, [deviceId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoadingChannelsFor(null);
    }
  }

  async function toggleExpandDevice(deviceId: string): Promise<void> {
    if (expandedDeviceId === deviceId) {
      setExpandedDeviceId(null);
      return;
    }
    setExpandedDeviceId(deviceId);
    await loadChannels(deviceId);
  }

  const columns = layout === 1 ? 1 : layout === 4 ? 2 : 3;
  const displayIndices = expandedTileIndex !== null ? [expandedTileIndex] : Array.from({ length: layout }, (_, i) => i);
  const gridColumns = expandedTileIndex !== null ? 1 : columns;
  const gridRows = expandedTileIndex !== null ? 1 : Math.ceil(layout / columns);
  const { startMs: dayStartMs } = dayRangeMs();
  const fileListEntries = selectedTile.segments.filter((s) => fileListFilter === 'all' || s.type === fileListFilter);

  return (
    <div style={{ height: '100%', display: 'flex' }}>
      <div
        style={{
          width: '220px',
          flexShrink: 0,
          borderRight: `1px solid ${theme.border}`,
          padding: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        {/* Only the device tree scrolls — Recording Type, the calendar, and
            Search below stay put and always visible, regardless of how many
            devices/channels are expanded above or how short the window is.
            Previously the whole sidebar was one scrolling column, so a
            long/expanded device list could push the calendar out of view
            entirely. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '0.2rem' }}>DEVICES</div>
          <div style={{ marginTop: '-0.5rem' }}>
            {devices.length === 0 && <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.5rem' }}>No devices yet.</div>}
            {devices.map((device) => (
            <div key={device.id} style={{ marginBottom: '0.1rem' }}>
              <div
                onClick={() => toggleExpandDevice(device.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.35rem 0.4rem',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  color: theme.text,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = theme.surface)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: theme.textFaint, fontSize: '10px', width: '10px' }}>
                  {expandedDeviceId === device.id ? '▾' : '▸'}
                </span>
                <span
                  title={statusLabel(statusById[device.id])}
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: statusColor(statusById[device.id]),
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device.name}</span>
              </div>

              {expandedDeviceId === device.id && (
                <div style={{ paddingLeft: '1.4rem' }}>
                  {loadingChannelsFor === device.id && (
                    <div style={{ fontSize: '11px', color: theme.textFaint, padding: '0.3rem 0' }}>Loading…</div>
                  )}
                  {channelErrors[device.id] && (
                    <div style={{ padding: '0.3rem 0' }}>
                      <span style={{ fontSize: '11px', color: theme.danger }}>{channelErrors[device.id]}</span>
                    </div>
                  )}
                  {(channelsByDevice[device.id] ?? []).map((ch) => (
                    <div
                      key={ch.channel}
                      onClick={() => assignChannelToTile(device.id, ch.channel)}
                      style={{ padding: '0.25rem 0.4rem', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', color: theme.textMuted }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = theme.surface)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {ch.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '0.4rem', textAlign: 'center' }}>
            RECORDING TYPE
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem 0.5rem' }}>
            {FILTER_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '12px', color: theme.text, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={filters.includes(opt.value)}
                  onChange={() => toggleFilter(opt.value)}
                  style={{ width: '13px', height: '13px', accentColor: theme.accent, cursor: 'pointer', flexShrink: 0 }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <MiniCalendar
          selectedDate={date}
          onSelect={setDate}
          deviceId={selectedTile.deviceId}
          channel={selectedTile.channel}
          filters={filters}
        />

        <button onClick={researchAllTiles} style={searchButtonStyle}>
          Search
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Video grid */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
            gridTemplateRows: `repeat(${gridRows}, 1fr)`,
            gap: '2px',
            background: theme.border,
          }}
        >
          {displayIndices.map((i) => renderTile(i))}
        </div>

        {/* Full-width timeline — moved here (below the grid) instead of a
            cramped sidebar strip, giving it real room for a proper 24h ruler. */}
        <div style={{ borderTop: `1px solid ${theme.border}`, padding: '0.5rem 0.9rem 0.3rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', marginBottom: '0.35rem' }}>
            <div style={{ display: 'flex', gap: '0.6rem', fontSize: '10px', color: theme.textFaint }}>
              <Legend color={TYPE_COLOR.continuous} label="Continuous" />
              <Legend color={TYPE_COLOR.motion} label="Motion" />
              <Legend color={TYPE_COLOR.smart} label="Smart" />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '10px', color: theme.textFaint }}>
              <ZoomButton
                disabled={zoom === ZOOM_LEVELS[0]}
                onClick={() => setZoom(ZOOM_LEVELS[Math.max(0, ZOOM_LEVELS.indexOf(zoom) - 1)])}
              >
                −
              </ZoomButton>
              <span style={{ minWidth: '38px', textAlign: 'center', color: theme.textMuted }}>{zoomLabel(zoom)}</span>
              <ZoomButton
                disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
                onClick={() => setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, ZOOM_LEVELS.indexOf(zoom) + 1)])}
              >
                +
              </ZoomButton>
            </div>

            <span style={{ justifySelf: 'end', fontSize: '11px', color: theme.textMuted }}>
              {selectedTile.deviceName
                ? `${selectedTile.deviceName} · ${selectedTile.channelLabel}${selectedTile.searching ? ' — searching…' : ''}`
                : 'No channel selected for this tile'}
            </span>
          </div>

          {/* Zoom widens this inner wrapper (not the outer container) and
              lets it scroll horizontally — a short motion clip that's a
              couple of pixels wide at 1x becomes proportionally easier to
              click at higher zoom. handleTimelineClick's fraction math
              (offsetX / rect.width) needs no changes for this to work:
              rect.width and clientX are both already viewport-relative and
              account for scroll position automatically. */}
          <div style={{ overflowX: zoom > 1 ? 'auto' : 'hidden' }}>
            <div style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
              <div
                onClick={handleTimelineClick}
                onMouseMove={handleTimelineHover}
                onMouseLeave={() => {
                  setTimelineHoverX(null);
                  setTimelineHoverMs(null);
                }}
                style={{
                  height: '52px',
                  borderRadius: '3px',
                  background: theme.surface,
                  border: `1px solid ${theme.border}`,
                  position: 'relative',
                  cursor: selectedTile.segments.length > 0 ? 'pointer' : 'default',
                  overflow: 'hidden',
                }}
              >
                {selectedTile.segments.map((seg, i) => {
                  const left = ((seg.startMs - dayStartMs) / DAY_MS) * 100;
                  const width = ((seg.endMs - seg.startMs) / DAY_MS) * 100;
                  return (
                    <div
                      key={i}
                      style={{
                        position: 'absolute',
                        left: `${left}%`,
                        width: `${Math.max(width, 0.15)}%`,
                        top: 0,
                        bottom: 0,
                        background: TYPE_COLOR[seg.type],
                        opacity: 0.75,
                      }}
                    />
                  );
                })}
                {timelineHoverX !== null && timelineHoverMs !== null && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${timelineHoverX}px`,
                      top: 0,
                      bottom: 0,
                      width: '1px',
                      background: theme.textFaint,
                      pointerEvents: 'none',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: '3px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        whiteSpace: 'nowrap',
                        fontSize: '10.5px',
                        color: theme.text,
                        background: theme.panel,
                        border: `1px solid ${theme.border}`,
                        borderRadius: '3px',
                        padding: '0.1rem 0.35rem',
                        pointerEvents: 'none',
                      }}
                    >
                      {formatTime(timelineHoverMs)}
                    </span>
                  </div>
                )}
                {clipMark && markMatchesSelectedTile && (
                  <div
                    title={`Clip start: ${formatTime(clipMark.startMs)}`}
                    style={{
                      position: 'absolute',
                      left: `${((clipMark.startMs - dayStartMs) / DAY_MS) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: '2px',
                      background: theme.success,
                    }}
                  />
                )}
                {selectedTile.currentMs !== null && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${((selectedTile.currentMs - dayStartMs) / DAY_MS) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: '2px',
                      background: theme.text,
                    }}
                  />
                )}
                {selectedTile.segments.length === 0 && (selectedTile.searching || selectedTile.deviceId) && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '10.5px',
                      color: theme.textFaint,
                    }}
                  >
                    {selectedTile.searching ? 'Searching…' : 'No recordings found for this day'}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', color: theme.textFaint, marginTop: '2px' }}>
                {Array.from({ length: 13 }, (_, i) => (
                  <span key={i}>{String(i * 2).padStart(2, '0')}:00</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom bar — a true 3-column grid (not flex+spacers) so the
            center transport cluster stays visually centered regardless of
            how wide the left/right groups are. Layout/Close-all live on the
            left (where the transport controls used to sit); the transport
            controls themselves (play/pause, frame-step, stop, speed, sync,
            clip markers) are the visually prominent group in the middle —
            larger and filled, unlike the small flat icon buttons elsewhere,
            so they read as "the main controls" at a glance. */}
        <div
          style={{
            borderTop: `1px solid ${theme.border}`,
            padding: '0.6rem 0.9rem',
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            {LAYOUTS.map((n) => (
              <button
                key={n}
                onClick={() => handleChangeLayout(n)}
                style={{
                  padding: '0.3rem 0.55rem',
                  borderRadius: '4px',
                  border: `1px solid ${n === layout ? theme.accent : theme.border}`,
                  background: n === layout ? theme.accentFaint : 'transparent',
                  color: n === layout ? theme.accentHover : theme.textMuted,
                  fontSize: '11.5px',
                  cursor: 'pointer',
                }}
              >
                {n}
              </button>
            ))}
            <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.15rem 0.4rem', background: theme.border }} />
            <ToolbarIconButton title="Close all" danger onClick={handleCloseAll}>
              &#10005;
            </ToolbarIconButton>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <TransportButton title={selectedTile.isPaused ? 'Play' : 'Pause'} disabled={!selectedTile.viewHandle} onClick={handlePlayPause}>
              {selectedTile.isPaused ? <PlayIcon /> : <PauseIcon />}
            </TransportButton>
            <TransportButton title="Frame by frame" disabled={!selectedTile.isPaused} onClick={handleFrameStep}>
              <StepForwardIcon />
            </TransportButton>
            <TransportButton title="Stop" disabled={!selectedTile.viewHandle} onClick={handleStopAll}>
              <StopIcon />
            </TransportButton>
            <TransportButton title={`Speed: ${speed}x (click to cycle 1x → 2x → 4x)`} disabled={!selectedTile.viewHandle} onClick={handleSpeedCycle}>
              {speed}x
            </TransportButton>
            <TransportButton title="Sync playback position across cameras" disabled={activeTileIndices().length < 2} onClick={handleSync}>
              &#8646;
            </TransportButton>

            <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.1rem 0.2rem', background: theme.border }} />

            <TransportButton title="Mark Start Point to Download" disabled={!selectedTile.viewHandle} onClick={handleMarkStart}>
              <ScissorsIcon />
            </TransportButton>
            <TransportButton
              title="Mark End Point to Download"
              disabled={!markMatchesSelectedTile || !selectedTile.viewHandle}
              onClick={handleMarkEnd}
            >
              <ScissorsIcon />
            </TransportButton>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.6rem' }}>
            {/* Centered in the gap between the transport controls and the
                playback time/CPU/Memory readout, rather than tacked onto
                the end of the tightly-packed transport button group. */}
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
              {downloads.length > 0 &&
                (() => {
                  const avgProgress = downloads.reduce((sum, d) => sum + d.progress, 0) / downloads.length;
                  return (
                    <button
                      onClick={() => setDownloadsPopupOpen(true)}
                      title={`${downloads.filter((d) => !d.done).length} download(s) in progress — click for details`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '0.3rem 0.5rem',
                        borderRadius: '4px',
                        border: `1px solid ${theme.border}`,
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ width: '40px', height: '5px', borderRadius: '3px', background: theme.border, overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${avgProgress}%`,
                            height: '100%',
                            background: downloads.some((d) => !d.done)
                              ? theme.accent
                              : downloads.some((d) => d.error)
                                ? theme.danger
                                : theme.success,
                            transition: 'width 0.2s',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: '10.5px', color: theme.textMuted }}>{Math.round(avgProgress)}%</span>
                    </button>
                  );
                })()}
            </div>
            <span style={{ fontSize: '11.5px', color: theme.textMuted }}>
              {selectedTile.currentMs ? formatTime(selectedTile.currentMs) : '--:--:--'}
            </span>
            <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.1rem 0.2rem', background: theme.border }} />
            <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              CPU
              <strong style={{ color: stats ? resourceLevelColor(stats.cpuPercent) : theme.textMuted, fontWeight: 600 }}>
                {stats ? `${stats.cpuPercent}%` : '—'}
              </strong>
            </span>
            <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              Memory
              <strong style={{ color: stats ? resourceLevelColor(stats.memPercent) : theme.textMuted, fontWeight: 600 }}>
                {stats ? `${stats.memPercent}%` : '—'}
              </strong>
            </span>
          </div>
        </div>
      </div>

      {/* Right-side recording-files panel — same width as the left device
          tree sidebar, additive to (not a replacement for) the bottom
          timeline + Mark Start/Mark End clip-marker flow above. Lists the
          selected tile's already-fetched segments so a real recorded range
          can be downloaded directly, without needing to scrub/mark points
          manually first. */}
      <div
        style={{
          width: '220px',
          flexShrink: 0,
          borderLeft: `1px solid ${theme.border}`,
          padding: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.6rem',
        }}
      >
        <div style={{ fontSize: '11px', color: theme.textMuted }}>RECORDING FILES</div>
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          {(['all', 'continuous', 'motion'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFileListFilter(t)}
              style={{
                flex: 1,
                padding: '0.3rem 0',
                borderRadius: '4px',
                border: `1px solid ${t === fileListFilter ? theme.accent : theme.border}`,
                background: t === fileListFilter ? theme.accentFaint : 'transparent',
                color: t === fileListFilter ? theme.accentHover : theme.textMuted,
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              {t === 'all' ? 'All' : t === 'continuous' ? 'Continuous' : 'Motion'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {!selectedTile.deviceId && (
            <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.5rem' }}>
              No channel selected for this tile.
            </div>
          )}
          {selectedTile.deviceId && fileListEntries.length === 0 && (
            <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.5rem' }}>
              {selectedTile.searching ? 'Searching…' : 'No recordings found for this day'}
            </div>
          )}
          {fileListEntries.map((seg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.4rem',
                padding: '0.4rem 0.5rem',
                borderRadius: '4px',
                border: `1px solid ${theme.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflow: 'hidden' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: TYPE_COLOR[seg.type], flexShrink: 0 }} />
                <span style={{ fontSize: '11px', color: theme.text, whiteSpace: 'nowrap' }}>
                  {formatTime(seg.startMs)} – {formatTime(seg.endMs)}
                </span>
              </div>
              <button
                onClick={() => handleDownloadSegment(seg)}
                title="Download this recording"
                style={{
                  background: 'none',
                  border: 'none',
                  color: theme.textMuted,
                  cursor: 'pointer',
                  padding: '0.15rem',
                  display: 'flex',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = theme.accentHover)}
                onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
              >
                <DownloadIcon />
              </button>
            </div>
          ))}
        </div>
      </div>

      {exportPopup && (
        <Modal width={380} onDismiss={handleCancelExport}>
          <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>Export Recording</div>
            <div style={{ fontSize: '12px', color: theme.textMuted }}>
              {formatTime(exportPopup.startMs)} — {formatTime(exportPopup.endMs)}
            </div>

            <button onClick={handleChooseExportPath} disabled={exportPopup.choosing} style={secondaryButtonStyle}>
              {exportPopup.choosing ? 'Choosing…' : exportPopup.path ? 'Change Destination…' : 'Choose Destination…'}
            </button>
            {exportPopup.path && (
              <div style={{ fontSize: '11px', color: theme.textFaint, wordBreak: 'break-all' }}>{exportPopup.path}</div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={handleCancelExport} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                onClick={handleStartExportDownload}
                disabled={!exportPopup.path}
                style={{ ...searchButtonStyle, opacity: exportPopup.path ? 1 : 0.5, cursor: exportPopup.path ? 'pointer' : 'not-allowed' }}
              >
                Download
              </button>
            </div>
          </div>
        </Modal>
      )}

      {downloadsPopupOpen && (
        <Modal width={420} onDismiss={() => setDownloadsPopupOpen(false)}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '1rem 1.25rem',
              borderBottom: `1px solid ${theme.border}`,
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>Downloads</span>
            <button
              onClick={() => setDownloadsPopupOpen(false)}
              style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '16px', cursor: 'pointer' }}
            >
              &times;
            </button>
          </div>
          <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {downloads.length === 0 && (
              <div style={{ fontSize: '12px', color: theme.textFaint }}>No downloads.</div>
            )}
            {downloads.map((d) => (
              <div
                key={d.handle}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                  padding: '0.6rem',
                  borderRadius: '5px',
                  border: `1px solid ${theme.border}`,
                }}
              >
                <div style={{ fontSize: '12.5px', color: theme.text, fontWeight: 600 }}>
                  {d.deviceName} · {d.channelLabel}
                </div>
                <div style={{ fontSize: '11px', color: theme.textFaint, wordBreak: 'break-all' }}>{d.path}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: theme.border, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${d.progress}%`,
                        height: '100%',
                        background: d.error ? theme.danger : d.done ? theme.success : theme.accent,
                        transition: 'width 0.2s',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: '11px', color: theme.textMuted, width: '32px', textAlign: 'right' }}>
                    {Math.round(d.progress)}%
                  </span>
                </div>
                {d.error && <div style={{ fontSize: '11px', color: theme.danger }}>{d.error}</div>}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={() => handleOpenDownloadLocation(d.path)} style={secondaryButtonStyle}>
                    Open
                  </button>
                  {d.done ? (
                    <button onClick={() => handleDismissDownload(d.handle)} style={secondaryButtonStyle}>
                      Dismiss
                    </button>
                  ) : (
                    <button onClick={() => handleStopDownload(d.handle)} style={secondaryButtonStyle}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );

  function renderTile(i: number) {
    const tile = tiles[i];
    const isSelected = selectedTileIndex === i;
    const isExpanded = expandedTileIndex === i;
    const isHovered = hoveredTileIndex === i;
    return (
      <div
        key={i}
        // Only a filled tile can be the drag SOURCE (nothing to swap out of
        // an empty one) - it can still be a drop TARGET either way.
        draggable={Boolean(tile.deviceId)}
        onDragStart={(e) => {
          if (!tile.deviceId) return;
          e.dataTransfer.setData('text/plain', String(i));
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const raw = e.dataTransfer.getData('text/plain');
          const fromIndex = Number(raw);
          if (raw === '' || Number.isNaN(fromIndex) || fromIndex === i) return;
          swapTiles(fromIndex, i);
        }}
        onClick={() => setSelectedTileIndex(i)}
        onDoubleClick={() => setExpandedTileIndex((prev) => (prev === i ? null : i))}
        onMouseEnter={() => setHoveredTileIndex(i)}
        onMouseLeave={() => setHoveredTileIndex((prev) => (prev === i ? null : prev))}
        style={{
          position: 'relative',
          background: '#000',
          minHeight: 0,
          cursor: 'pointer',
          // Rapid click/double-click on the tile (especially the empty-tile
          // placeholder image) was getting picked up as a native text/image
          // selection, showing the browser's blue "selected" highlight —
          // this is a click target, not selectable content.
          userSelect: 'none',
          WebkitUserSelect: 'none',
          outline: isSelected ? `2px solid ${theme.selection}` : 'none',
          outlineOffset: '-2px',
        }}
      >
        {!tile.deviceId && (
          <Centered>
            <img
              src={emptyTileCamera}
              alt=""
              draggable={false}
              style={{ width: '40px', height: '40px', opacity: 0.55, WebkitUserDrag: 'none' } as CSSProperties}
            />
          </Centered>
        )}

        {tile.deviceId && (
          <>
            {tile.viewHandle && <VideoCanvas viewHandle={tile.viewHandle} subscribe={window.ssmVms.playback.onFrame} />}
            {tile.viewHandle && videoHealthByHandle[tile.viewHandle] === false && (
              <Centered>
                <div
                  title="Playing, but the video signal looks blank — check the camera/coax connection"
                  style={{ color: theme.warning, opacity: 0.85, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}
                >
                  <CameraOffIcon size={36} />
                  <span style={{ fontSize: '11px', fontWeight: 600 }}>No Signal</span>
                </div>
              </Centered>
            )}
            {tile.error && (
              <Centered>
                <div title={tile.error} style={{ color: theme.textFaint, opacity: 0.7 }}>
                  <CameraOffIcon size={40} />
                </div>
              </Centered>
            )}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.25rem 0.45rem',
                background: 'linear-gradient(rgba(0,0,0,0.6), transparent)',
                fontSize: '10.5px',
                color: '#fff',
              }}
            >
              <span>
                {tile.deviceName} · {tile.channelLabel}
                {isExpanded && (
                  <span style={{ color: 'rgba(255,255,255,0.6)', marginLeft: '0.4rem' }}>
                    (double-click to restore)
                  </span>
                )}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  clearTile(i);
                }}
                title="Close this channel"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '13px',
                  opacity: isHovered ? 1 : 0,
                  pointerEvents: isHovered ? 'auto' : 'none',
                  transition: 'opacity 0.1s',
                }}
              >
                &times;
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '2px', background: color }} />
      {label}
    </div>
  );
}

function ZoomButton({ disabled, onClick, children }: { disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '16px',
        height: '16px',
        borderRadius: '3px',
        border: `1px solid ${theme.border}`,
        background: 'transparent',
        color: disabled ? theme.textFaint : theme.textMuted,
        fontSize: '11px',
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Plain vector icons (fill=currentColor), not the Unicode media-control
// glyphs (⏸⏭⏹) they replace — Windows renders those specific codepoints via
// its color-emoji font, which looks visibly different in weight/style from
// Speed's plain text and Sync's plain arrow glyph, even once the buttons
// themselves share identical styling. Same fix already applied once to the
// header icons (see shell/icons.tsx) for the same underlying reason.
function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 4l14 8-14 8V4z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="4" width="5" height="16" />
      <rect x="14" y="4" width="5" height="16" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" />
    </svg>
  );
}

function StepForwardIcon() {
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
function ScissorsIcon() {
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
function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function ToolbarIconButton({
  title,
  disabled,
  danger,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const restColor = disabled ? theme.textFaint : danger ? theme.danger : theme.textMuted;
  const hoverColor = danger ? theme.danger : theme.text;
  const style: CSSProperties = {
    minWidth: '26px',
    height: '26px',
    padding: '0 0.35rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    border: 'none',
    background: 'none',
    color: restColor,
    fontSize: '13px',
    fontWeight: danger ? 700 : 400,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.color = restColor;
      }}
    >
      {children}
    </button>
  );
}

// Deliberately larger and filled (not the small flat ToolbarIconButton
// style) — this is the main playback control cluster (play/pause,
// frame-step, stop, speed, sync, clip markers), and needs to visually read
// as "the main controls" at a glance rather than blend in with the smaller
// utility icons (layout/close-all/CPU-mem) around it. `primary` gives
// play/pause an accent fill so it's the first thing the eye lands on,
// matching how most media players treat their play button.
function TransportButton({
  title,
  disabled,
  primary,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  primary?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    minWidth: '40px',
    height: '40px',
    padding: '0 0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '8px',
    border: primary ? 'none' : `1px solid ${theme.border}`,
    background: disabled ? theme.surface : primary ? theme.accent : theme.surface,
    color: disabled ? theme.textFaint : primary ? theme.accentText : theme.text,
    fontSize: '16px',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
    transition: 'background 100ms ease',
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = primary ? theme.accentHover : theme.surfaceHover;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = primary ? theme.accent : theme.surface;
      }}
    >
      {children}
    </button>
  );
}

const searchButtonStyle = {
  padding: '0.5rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: theme.accentText,
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  padding: '0.5rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '12.5px',
  cursor: 'pointer',
  flex: 1,
};
