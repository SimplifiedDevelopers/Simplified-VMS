import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { theme } from '../theme';
import { VideoCanvas } from '../liveView/VideoCanvas';
import { DigitalZoomLayer } from '../liveView/DigitalZoom';
import { TileContextMenu } from '../liveView/TileContextMenu';
import { MiniCalendar } from './MiniCalendar';
import { CameraOffIcon } from '../components/icons';
import { PauseIcon, PlayIcon, ScissorsIcon, StepForwardIcon, StopIcon } from './icons';
import { Centered, Legend, ToolbarIconButton, TransportButton, ZoomButton } from './PlaybackControls';
import { PlaybackSidebar } from './PlaybackSidebar';
import { RecordingFilesPanel } from './RecordingFilesPanel';
import { ExportPopup } from './ExportPopup';
import { SearchByTimePopup } from './SearchByTimePopup';
import { DownloadsPopup } from './DownloadsPopup';
import {
  DAY_MS,
  emptyTile,
  formatTime,
  LAYOUTS,
  MAX_TILES,
  resourceLevelColor,
  TYPE_COLOR,
  ZOOM_LEVELS,
  zoomLabel,
  type ClipMark,
  type DownloadItem,
  type ExportPopupState,
  type PlaybackTileState,
} from './playbackModel';
import emptyTileCamera from '../assets/empty-tile-camera.png';
import type {
  ChannelInfo,
  DeviceConnectionStatus,
  PlaybackSpeed,
  RecordingSearchFilter,
  RecordingSegment,
  StoredDevice,
  SystemStats,
} from '../../../shared/types';

// isActive defaults to true so a popped-out window (PopoutWindow.tsx,
// always its own visible OS window — no tab-hiding concept applies there)
// doesn't need to pass anything; AppShell explicitly passes the real
// tab-visibility value since Playback's own tab can be hidden behind a
// different one while staying mounted.
export function Playback({ isActive = true }: { isActive?: boolean } = {}) {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(1);
  const [tiles, setTiles] = useState<PlaybackTileState[]>(() => Array.from({ length: MAX_TILES }, emptyTile));
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  // Set the moment app quit genuinely starts (main/index.ts's before-quit,
  // via system:appQuitting) — checked by every setInterval-based poll
  // below so they stop calling into the main process immediately instead
  // of continuing to hit its now-thrown "App is closing." for however
  // long the rest of quit's own cleanup takes. Confirmed live: without
  // this, the getTime poll alone kept firing every second for the whole
  // wait, each one logged as a real (if harmless) "Error occurred in
  // handler" — pure noise stacked on top of the exact wait this exists to
  // keep short.
  const appQuittingRef = useRef(false);
  useEffect(() => window.ssmVms.system.onAppQuitting(() => (appQuittingRef.current = true)), []);
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

  // Right-click quick menu — same TileContextMenu component Live View
  // uses, minus Select Stream (playback has no main/sub concept — see
  // VmsAdapter.startPlayback's own doc comment), Local Recording, and PTZ
  // (neither makes sense for reviewing already-recorded footage).
  const [contextMenu, setContextMenu] = useState<{ tileIndex: number; x: number; y: number } | null>(null);
  // Which tile (if any) has Digital Zoom's interactive mode on — same
  // convention as Live View's own zoomTileIndex.
  const [zoomTileIndex, setZoomTileIndex] = useState<number | null>(null);
  const [gridFullscreen, setGridFullscreen] = useState(false);
  // Keyed by viewHandle — Snapshot grabs the tile's own live <canvas>
  // straight off this map rather than keeping a second decode/render path
  // in sync with what's already on screen (same convention as Live View's
  // own canvasesRef).
  const canvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const [actionMessage, setActionMessage] = useState<{ text: string; path?: string } | null>(null);
  const actionMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showActionMessage(text: string, path?: string): void {
    setActionMessage({ text, path });
    if (actionMessageTimerRef.current) clearTimeout(actionMessageTimerRef.current);
    actionMessageTimerRef.current = setTimeout(() => setActionMessage(null), 10000);
  }

  // With only one tile actually on screen — either a genuine 1-camera
  // layout or any layout with a tile double-click-expanded to fill it —
  // that tile IS "the" channel for Snapshot/the context menu's implicit
  // target, whether or not it was ever explicitly clicked. Same fix as
  // Live View's own getEffectiveSelectedTileIndex.
  function getEffectiveSelectedTileIndex(): number {
    if (expandedTileIndex !== null) return expandedTileIndex;
    return selectedTileIndex;
  }

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
  // Set by "Search by Time" (below) to narrow the timeline/recording-file
  // search to a specific sub-day window instead of the calendar's default
  // whole-day range. Cleared whenever a new calendar day is picked, since
  // that's the "just give me the whole day" action.
  const [customRangeMs, setCustomRangeMs] = useState<{ startMs: number; endMs: number } | null>(null);
  const [searchByTimeOpen, setSearchByTimeOpen] = useState(false);
  const [searchByTimeDate, setSearchByTimeDate] = useState(date);
  const [searchByTimeStart, setSearchByTimeStart] = useState('00:00');
  const [searchByTimeEnd, setSearchByTimeEnd] = useState('23:59');

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
  // Collapsed to a thin strip (just an expand button) to reclaim grid
  // width when the file list isn't needed — mirrors the chevron pattern
  // Live View's own sidebar sections already use.
  const [fileListCollapsed, setFileListCollapsed] = useState(false);

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

  // Pauses frame delivery for every hidden tile (tab not active, or another
  // tile expanded over it) so its native session keeps running invisibly
  // and resumes instantly, no reconnect, once visible again — see
  // VmsAdapter.setFrameDelivery's doc comment and LiveView.tsx's matching
  // effect. A tile whose exact device/channel is currently being exported
  // is handled differently below: pausing alone wasn't enough — confirmed
  // live, CPU still spiked to 55-96% across all 4 vendors during an export,
  // because the vendor SDK's own decode still runs on every incoming frame
  // even when the frame-paused check skips our RGBA conversion/IPC send.
  // Exporting already runs its own independent decode session
  // (clipExporter.ts) for the exact same channel/range, so the on-screen
  // tile's session is fully stopped instead, freeing the SDK decode itself
  // rather than just the conversion/IPC cost layered on top of it. This
  // intentionally does not resume once the export finishes (matches the
  // prior pause-based behavior, which was also one-way per explicit
  // request) — there's no session left to resume; picking a new segment
  // starts a fresh one.
  useEffect(() => {
    if (appQuittingRef.current) return;
    let cancelled = false;
    const exportingKeys = new Set(
      downloads.filter((d) => !d.done).map((d) => `${d.deviceId}:${d.channel}`),
    );
    // Pausing/stopping is instant for every tile (only ever reduces load);
    // resuming is staggered — see LiveView.tsx's matching effect for why:
    // resuming several tiles' frame delivery in the same instant (e.g.
    // collapsing an expanded tile back to a full grid) confirmed live to
    // overwhelm an older machine's renderer badly enough to show "Not
    // Responding," even though every underlying native call completed
    // normally.
    const toResume: Array<{ deviceId: string; viewHandle: string }> = [];
    tiles.forEach((tile, index) => {
      if (!tile.deviceId || !tile.viewHandle) return;
      const isExporting = tile.channel !== null && exportingKeys.has(`${tile.deviceId}:${tile.channel}`);
      if (isExporting) {
        // stopTile also prunes this viewHandle out of videoHealthByHandle —
        // reused here (instead of calling window.ssmVms.playback.stop
        // directly) so that cleanup applies on this path too, not just the
        // explicit close/reassign/research ones. Remembers the position via
        // stoppedAtMs/stoppedEndMs, same as the explicit Stop button, so the
        // Resume button can pick up exactly where the export interrupted
        // this tile rather than the user needing to re-find that spot.
        stopTile(index);
        updateTile(index, {
          viewHandle: null,
          isPaused: false,
          currentMs: null,
          playStartMs: null,
          playEndMs: null,
          stoppedAtMs: tile.currentMs,
          stoppedEndMs: tile.playEndMs,
        });
        return;
      }
      const shouldDeliver = isActive && (expandedTileIndex === null || expandedTileIndex === index);
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
  // cursor honest simultaneously. Skipped entirely while this tab isn't the
  // active one — confirmed live as a real gap: unlike the frame-delivery
  // effect right below, this kept firing a getTime IPC/native round trip
  // per playing tile every second even while the user had switched to a
  // completely different tab (e.g. Live View) and couldn't see the result.
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      if (appQuittingRef.current) return;
      tilesRef.current.forEach((t, i) => {
        if (!t.deviceId || !t.viewHandle || t.isPaused) return;
        window.ssmVms.playback.getTime(t.deviceId, t.viewHandle).then((ms) => {
          if (ms > 0) updateTile(i, { currentMs: ms });
        });
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  // Guards stopBackup from firing twice for the same handle - the polling
  // interval can see pct>=100 again before the async finalize/verify chain
  // below has set `done: true` in state.
  const finalizingHandlesRef = useRef<Set<string>>(new Set());

  // Polls every download that isn't finished yet — runs independently of
  // whether the export popup is even open, since downloads keep going in
  // the background after it closes. Skips paused ones too - their progress
  // is frozen server-side until Resume, so there's nothing new to poll for.
  useEffect(() => {
    const interval = setInterval(() => {
      if (appQuittingRef.current) return;
      setDownloads((prev) => {
        const active = prev.filter((d) => !d.done && !d.paused);
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

  // The calendar's whole selected day - always this, regardless of any
  // custom Search by Time window, since the timeline itself keeps its
  // normal full-day scale (only which recordings get FETCHED narrows; see
  // activeSearchRangeMs below).
  function dayRangeMs(): { startMs: number; endMs: number } {
    const startMs = new Date(`${date}T00:00:00`).getTime();
    return { startMs, endMs: startMs + DAY_MS };
  }

  // Whole calendar day by default; a custom sub-day window (set by "Search
  // by Time") overrides that until the next calendar day pick clears it.
  // Used only to bound the actual findRecordings query - NOT for the
  // timeline's own visual scale, which stays full-day (dayRangeMs above)
  // so a narrow search still shows where in the day it falls rather than
  // stretching to fill the whole bar.
  function activeSearchRangeMs(): { startMs: number; endMs: number } {
    return customRangeMs ?? dayRangeMs();
  }

  async function searchTile(index: number, deviceId: string, channel: number): Promise<void> {
    updateTile(index, { searching: true, error: null });
    const { startMs, endMs } = activeSearchRangeMs();
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
    // Confirmed live: fast-forward speed persisted across a stop/close/
    // channel switch, so the NEXT thing played silently inherited whatever
    // multiplier was left over from the last one. speed is a single value
    // shared across all tiles (handleSpeedCycle applies it to every active
    // tile at once), so resetting it here - the one chokepoint every stop/
    // close/reassign already funnels through - covers all three reported
    // cases without needing a per-tile speed field.
    setSpeed(1);
    // videoHealthByHandle otherwise keeps every viewHandle this tab has
    // ever played, forever — confirmed live as unbounded, real growth over
    // a long session with many channel switches, each getting its own
    // never-reused handle.
    const { viewHandle } = tile;
    setVideoHealthByHandle((prev) => {
      if (!(viewHandle in prev)) return prev;
      const next = { ...prev };
      delete next[viewHandle];
      return next;
    });
    try {
      await window.ssmVms.playback.stop(tile.deviceId, viewHandle);
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

  // Context menu's "Close All" — simpler than Live View's own version
  // (no staggered background loading to cancel here; assignChannelToTile
  // is a single direct call, not a multi-channel staggered loop).
  async function closeAllTiles(): Promise<void> {
    await Promise.all(tilesRef.current.map((_, i) => stopTile(i)));
    setTiles(Array.from({ length: MAX_TILES }, emptyTile));
    setExpandedTileIndex(null);
  }

  // Core snapshot capture for a single tile, shared by the context menu's
  // own Snapshot item (whichever tile was right-clicked, not necessarily
  // selected) and Snapshot All (every playing tile at once) — same
  // convention as Live View's own snapshotTile.
  async function snapshotTile(tileIndex: number): Promise<{ ok: boolean; path?: string; error?: string }> {
    const tile = tilesRef.current[tileIndex];
    if (!tile?.viewHandle) return { ok: false, error: 'Not playing.' };
    const canvas = canvasesRef.current.get(tile.viewHandle);
    if (!canvas) return { ok: false, error: 'No frame to capture yet.' };
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return { ok: false, error: 'No frame to capture yet.' };
    const buffer = await blob.arrayBuffer();
    return window.ssmVms.playback.saveSnapshot(tile.deviceName ?? tile.deviceId ?? 'device', tile.channel ?? 0, buffer);
  }

  async function takeSnapshot(tileIndex?: number): Promise<void> {
    const idx = tileIndex ?? getEffectiveSelectedTileIndex();
    const result = await snapshotTile(idx);
    if (result.ok) showActionMessage(`Snapshot saved to ${result.path}`, result.path);
    else showActionMessage(`Snapshot failed: ${result.error ?? 'unknown error'}`);
  }

  async function snapshotAllTiles(): Promise<void> {
    const filledIndices = tilesRef.current
      .map((t, i) => (t.viewHandle ? i : -1))
      .filter((i) => i >= 0);
    if (filledIndices.length === 0) {
      showActionMessage('No channels playing.');
      return;
    }
    const results = await Promise.all(filledIndices.map((i) => snapshotTile(i)));
    const succeeded = results.filter((r) => r.ok).length;
    showActionMessage(
      succeeded === results.length
        ? `Snapshot All: saved ${succeeded} channel${succeeded === 1 ? '' : 's'}.`
        : `Snapshot All: saved ${succeeded} of ${results.length} channel${results.length === 1 ? '' : 's'}.`,
    );
  }

  // Real OS-level fullscreen toggle, available from the context menu.
  // Unlike Live View's own Full Screen (which also hides its sidebar/
  // toolbar down to just the grid), Playback keeps its normal layout —
  // the calendar/search/file-list sidebar stays available since reviewing
  // footage is a more sidebar-driven workflow than watching a live grid.
  async function toggleGridFullscreen(): Promise<void> {
    const next = !gridFullscreen;
    setGridFullscreen(next);
    await window.ssmVms.system.setFullScreen(next);
  }

  useEffect(() => {
    if (!gridFullscreen) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') toggleGridFullscreen();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridFullscreen]);

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

  // A tile counts as busy if it's actively playing (viewHandle set) or has
  // an in-progress download for its exact device/channel — an export pauses
  // on-screen playback (see the frame-delivery effect below), so viewHandle
  // alone would miss a tile that's mid-download but currently paused.
  function isTileBusy(tile: PlaybackTileState): boolean {
    if (tile.viewHandle !== null) return true;
    return (
      tile.deviceId !== null &&
      tile.channel !== null &&
      downloads.some((d) => !d.done && d.deviceId === tile.deviceId && d.channel === tile.channel)
    );
  }

  // Assigning a channel normally targets the currently selected tile
  // (there's always exactly one selected, unlike Live View where selection
  // can be cleared) — but overwriting a busy tile would kill an in-progress
  // playback session or export. If the selected tile is busy, land in the
  // next empty tile within the current layout instead (and select it), so
  // the busy tile is left running untouched. Falls back to the selected
  // tile if every visible tile is busy.
  async function assignChannelToTile(deviceId: string, channel: number): Promise<void> {
    let index = selectedTileIndex;
    if (isTileBusy(tilesRef.current[index])) {
      const freeIndex = tilesRef.current.findIndex((t, i) => i < layout && t.deviceId === null);
      if (freeIndex !== -1) {
        index = freeIndex;
        setSelectedTileIndex(freeIndex);
      }
    }
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
          // stoppedAtMs/stoppedEndMs explicitly cleared here (unlike the
          // export-triggered stop above) - a date/filter change means any
          // remembered position is for a different day's context, wrong to
          // resume into.
          updateTile(i, {
            viewHandle: null,
            isPaused: false,
            currentMs: null,
            playStartMs: null,
            playEndMs: null,
            stoppedAtMs: null,
            stoppedEndMs: null,
          });
          await searchTile(i, t.deviceId, t.channel);
        }
      }),
    );
  }

  useEffect(() => {
    researchAllTiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, filters, customRangeMs]);

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
          // stoppedAtMs/stoppedEndMs cleared on every play action (not just
          // an explicit Resume click) - confirmed live as a real gap
          // otherwise: stop, then click a totally different segment, and
          // the Resume button stayed enabled pointing at the now-unrelated
          // old stop position instead of reflecting what's actually
          // playing.
          updateTile(index, { isPaused: false, currentMs: startMs, stoppedAtMs: null, stoppedEndMs: null });
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
          stoppedAtMs: null,
          stoppedEndMs: null,
        });
      } catch (err) {
        updateTile(index, {
          viewHandle: null,
          isPaused: false,
          currentMs: null,
          playStartMs: null,
          playEndMs: null,
          stoppedAtMs: null,
          stoppedEndMs: null,
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

  // Tiles with a remembered stop position (see PlaybackTileState's
  // stoppedAtMs doc comment) - distinct from activeTileIndices, since a
  // stopped tile's viewHandle is null by definition.
  function resumableTileIndices(): number[] {
    return tiles.map((_, i) => i).filter((i) => i < layout && tiles[i].stoppedAtMs !== null);
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
        const t = tilesRef.current[i];
        const stoppedAtMs = t.currentMs;
        const stoppedEndMs = t.playEndMs;
        await stopTile(i);
        updateTile(i, {
          viewHandle: null,
          isPaused: false,
          currentMs: null,
          playStartMs: null,
          playEndMs: null,
          stoppedAtMs,
          stoppedEndMs,
        });
      }),
    );
  }

  // Resumes every stopped-but-resumable tile from the exact point it was
  // stopped at (see PlaybackTileState's stoppedAtMs doc comment), rather
  // than requiring the user to re-find and re-click that spot on the
  // timeline. Clears stoppedAtMs/stoppedEndMs via playTileFrom's own
  // updateTile call (playStartMs/playEndMs get set to the same values,
  // making the old stoppedAtMs/stoppedEndMs redundant - explicitly cleared
  // here too so a later Stop can't ever see a stale pair from two segments
  // ago if something in between skipped updating them).
  async function handleResumeFromStop(): Promise<void> {
    // stoppedAtMs/stoppedEndMs get cleared inside playTileFrom itself once
    // the new session actually starts, not here.
    await Promise.all(
      resumableTileIndices().map((i) => {
        const t = tilesRef.current[i];
        if (t.stoppedAtMs === null || t.stoppedEndMs === null) return Promise.resolve();
        return playTileFrom(i, t.stoppedAtMs, t.stoppedEndMs);
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
    const next: PlaybackSpeed = speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 8 : 1;
    setSpeed(next);
    await Promise.all(
      activeTileIndices().map(async (i) => {
        const t = tilesRef.current[i];
        // TVT's native SDK crashes the whole app when its own "reset to
        // normal speed" call is made on a session that's currently
        // accelerated - confirmed live (twice) via Windows Event Viewer
        // showing a divide-by-zero INSIDE the vendor's own DLL, not our
        // code. There's no safe way found to call that reset once
        // accelerated, so returning to 1x sidesteps it entirely for TVT by
        // restarting the playback session fresh at the current position -
        // a brand-new session always starts at 1x, no reset call needed.
        // Deliberately does NOT go through playTileFrom: its own "same
        // segment already open" shortcut would just seek the EXISTING
        // still-accelerated session instead of truly restarting it (since
        // resuming at the current position within the same segment matches
        // that shortcut's condition exactly - confirmed live as why the
        // first version of this fix still crashed), and even clearing
        // viewHandle via updateTile first can't reliably prevent that
        // here - updateTile's setTiles is async, so tilesRef.current isn't
        // guaranteed to reflect the clear yet by the time playTileFrom
        // would read it a line later, with no await in between to let
        // React's render actually catch up. Calling start()/updateTile
        // directly, like playTileFrom's own "fresh start" branch does,
        // sidesteps that race entirely.
        const device = devices.find((d) => d.id === t.deviceId);
        if (next === 1 && device?.vendor === 'tvt' && t.currentMs !== null && t.playEndMs !== null &&
            t.deviceId && t.channel !== null) {
          const resumeMs = t.currentMs;
          const resumeEndMs = t.playEndMs;
          await stopTile(i);
          try {
            const handle = await window.ssmVms.playback.start(t.deviceId, t.channel, resumeMs, resumeEndMs);
            updateTile(i, {
              viewHandle: handle,
              isPaused: false,
              currentMs: resumeMs,
              playStartMs: resumeMs,
              playEndMs: resumeEndMs,
              error: null,
            });
          } catch (err) {
            updateTile(i, {
              viewHandle: null,
              isPaused: false,
              currentMs: null,
              playStartMs: null,
              playEndMs: null,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        await window.ssmVms.playback.control(t.deviceId!, t.viewHandle!, 'setSpeed', next).catch(() => undefined);
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
    window.ssmVms.playback.getDefaultExportPath(deviceId, channel, startMs, endMs).then((path) => {
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
    window.ssmVms.playback.getDefaultExportPath(deviceId, channel, seg.startMs, seg.endMs).then((path) => {
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
    const path = await window.ssmVms.playback.chooseExportPath(
      exportPopup.deviceId,
      exportPopup.channel,
      exportPopup.startMs,
      exportPopup.endMs,
    );
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
      setDownloads((prev) => [
        ...prev,
        { handle, deviceId, deviceName, channel, channelLabel, path, progress: 0, done: false, paused: false },
      ]);
    } catch (err) {
      // A real startBackup failure (e.g. ONVIF's "not supported" error, or
      // a connection drop) — surfaced here in the same Downloads list a
      // transfer's own failure would be, rather than the click silently
      // doing nothing.
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
          paused: false,
          error: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
  }

  function handleCancelExport(): void {
    setExportPopup(null);
  }

  const searchByTimeInvalid =
    new Date(`${searchByTimeDate}T${searchByTimeEnd}:00`).getTime() <=
    new Date(`${searchByTimeDate}T${searchByTimeStart}:00`).getTime();

  // Sets the narrower window activeSearchRangeMs() then uses instead of
  // the calendar's default whole day — the effect watching customRangeMs
  // (alongside date/filters) re-searches every tile automatically once
  // this resolves, same as picking a new calendar day already does.
  function handleConfirmSearchByTime(): void {
    if (searchByTimeInvalid) return;
    const startMs = new Date(`${searchByTimeDate}T${searchByTimeStart}:00`).getTime();
    const endMs = new Date(`${searchByTimeDate}T${searchByTimeEnd}:00`).getTime();
    setCustomRangeMs({ startMs, endMs });
    setDate(searchByTimeDate);
    setSearchByTimeOpen(false);
  }

  async function handleStopDownload(handle: string): Promise<void> {
    const item = downloads.find((d) => d.handle === handle);
    if (!item) return;
    await window.ssmVms.playback.stopBackup(item.deviceId, handle).catch(() => undefined);
    setDownloads((prev) => prev.filter((d) => d.handle !== handle));
    finalizingHandlesRef.current.delete(handle);
  }

  async function handlePauseDownload(handle: string): Promise<void> {
    const item = downloads.find((d) => d.handle === handle);
    if (!item) return;
    setDownloads((prev) => prev.map((d) => (d.handle === handle ? { ...d, paused: true } : d)));
    await window.ssmVms.playback.pauseBackup(item.deviceId, handle).catch(() => undefined);
  }

  async function handleResumeDownload(handle: string): Promise<void> {
    const item = downloads.find((d) => d.handle === handle);
    if (!item) return;
    setDownloads((prev) => prev.map((d) => (d.handle === handle ? { ...d, paused: false } : d)));
    await window.ssmVms.playback.resumeBackup(item.deviceId, handle).catch(() => undefined);
  }

  function handleDismissDownload(handle: string): void {
    setDownloads((prev) => prev.filter((d) => d.handle !== handle));
    finalizingHandlesRef.current.delete(handle);
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
      <PlaybackSidebar
        devices={devices}
        expandedDeviceId={expandedDeviceId}
        onToggleExpandDevice={toggleExpandDevice}
        loadingChannelsFor={loadingChannelsFor}
        channelErrors={channelErrors}
        channelsByDevice={channelsByDevice}
        onAssignChannel={assignChannelToTile}
        statusById={statusById}
        filters={filters}
        onToggleFilter={toggleFilter}
        selectedDeviceId={selectedTile.deviceId}
        selectedChannel={selectedTile.channel}
        onOpenSearchByTime={() => {
          setSearchByTimeDate(date);
          setSearchByTimeStart('00:00');
          setSearchByTimeEnd('23:59');
          setSearchByTimeOpen(true);
        }}
        calendar={
          <MiniCalendar
            selectedDate={date}
            onSelect={(d) => {
              // Picking a new calendar day means "show me this whole day" —
              // clears any narrower window a previous Search by Time set.
              setCustomRangeMs(null);
              setDate(d);
            }}
            deviceId={selectedTile.deviceId}
            channel={selectedTile.channel}
            filters={filters}
          />
        }
      />

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
            <TransportButton
              title="Resume from where it was stopped"
              disabled={selectedTile.stoppedAtMs === null}
              onClick={handleResumeFromStop}
            >
              <PlayIcon />
            </TransportButton>
            <TransportButton title={`Speed: ${speed}x (click to cycle 1x → 2x → 4x → 8x)`} disabled={!selectedTile.viewHandle} onClick={handleSpeedCycle}>
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
                  // Only the downloads still actually in flight — averaging
                  // in ones that already finished (sitting at 100%) or
                  // failed (sitting at 0%) was reporting a number that
                  // didn't match the transfer actually happening right now.
                  const activeDownloads = downloads.filter((d) => !d.done);
                  const avgProgress =
                    activeDownloads.length > 0
                      ? activeDownloads.reduce((sum, d) => sum + d.progress, 0) / activeDownloads.length
                      : 100;
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
            {actionMessage && (
              <span
                title={actionMessage.path ? 'Click to open file location' : undefined}
                onClick={actionMessage.path ? () => window.ssmVms.playback.openExportLocation(actionMessage.path!) : undefined}
                style={{
                  fontSize: '11px',
                  color: actionMessage.path ? theme.accentHover : theme.textMuted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '320px',
                  cursor: actionMessage.path ? 'pointer' : 'default',
                  textDecoration: actionMessage.path ? 'underline' : 'none',
                }}
              >
                {actionMessage.text}
              </span>
            )}
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

      <RecordingFilesPanel
        collapsed={fileListCollapsed}
        onSetCollapsed={setFileListCollapsed}
        filter={fileListFilter}
        onSetFilter={setFileListFilter}
        hasDeviceSelected={!!selectedTile.deviceId}
        searching={selectedTile.searching}
        entries={fileListEntries}
        onPlaySegment={(seg) => playTileFrom(selectedTileIndex, seg.startMs, seg.endMs)}
        onDownloadSegment={handleDownloadSegment}
      />

      {exportPopup && (
        <ExportPopup
          exportPopup={exportPopup}
          onChooseExportPath={handleChooseExportPath}
          onCancel={handleCancelExport}
          onStartDownload={handleStartExportDownload}
        />
      )}

      {searchByTimeOpen && (
        <SearchByTimePopup
          date={searchByTimeDate}
          onDateChange={setSearchByTimeDate}
          startTime={searchByTimeStart}
          onStartTimeChange={setSearchByTimeStart}
          endTime={searchByTimeEnd}
          onEndTimeChange={setSearchByTimeEnd}
          invalid={searchByTimeInvalid}
          onCancel={() => setSearchByTimeOpen(false)}
          onConfirm={handleConfirmSearchByTime}
        />
      )}

      {downloadsPopupOpen && (
        <DownloadsPopup
          downloads={downloads}
          onClose={() => setDownloadsPopupOpen(false)}
          onOpenLocation={handleOpenDownloadLocation}
          onDismiss={handleDismissDownload}
          onPause={handlePauseDownload}
          onResume={handleResumeDownload}
          onStop={handleStopDownload}
        />
      )}

      {contextMenu && (
        <TileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasContent={Boolean(tiles[contextMenu.tileIndex]?.deviceId)}
          isGridFullscreen={gridFullscreen}
          isZoomedTile={zoomTileIndex === contextMenu.tileIndex}
          anyTilesFilled={tiles.some((t) => t.deviceId)}
          showPtz={false}
          onDismiss={() => setContextMenu(null)}
          onClose={() => clearTile(contextMenu.tileIndex)}
          onCloseAll={() => closeAllTiles()}
          onFullScreen={() => toggleGridFullscreen()}
          onSnapshot={() => takeSnapshot(contextMenu.tileIndex)}
          onSnapshotAll={() => snapshotAllTiles()}
          onToggleZoom={() => setZoomTileIndex((prev) => (prev === contextMenu.tileIndex ? null : contextMenu.tileIndex))}
        />
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
        // Disabled while this tile is the active Digital Zoom target - a
        // drag gesture there means "rubber-band select a zoom region", not
        // "swap tiles" (same convention as Live View's own grid).
        draggable={Boolean(tile.deviceId) && zoomTileIndex !== i}
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
        onDoubleClick={() => {
          // Double-click already collapses/expands the single-channel view,
          // which is usually exactly when Digital Zoom gets used — exit
          // zoom at the same time instead of leaving it zoomed in once
          // back in the full grid (same convention as Live View's grid).
          if (zoomTileIndex === i) setZoomTileIndex(null);
          setExpandedTileIndex((prev) => (prev === i ? null : i));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ tileIndex: i, x: e.clientX, y: e.clientY });
        }}
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
            {tile.viewHandle && (
              <DigitalZoomLayer key={tile.viewHandle} active={zoomTileIndex === i}>
                <VideoCanvas
                  viewHandle={tile.viewHandle}
                  subscribe={window.ssmVms.playback.onFrame}
                  onCanvasRef={(el) => {
                    const handle = tile.viewHandle;
                    if (!handle) return;
                    if (el) canvasesRef.current.set(handle, el);
                    else canvasesRef.current.delete(handle);
                  }}
                />
              </DigitalZoomLayer>
            )}
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
