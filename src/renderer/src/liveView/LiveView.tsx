import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { theme } from '../theme';
import type {
  ChannelInfo,
  CustomLayout,
  CustomLayoutTile,
  DeviceConnectionStatus,
  StoredDevice,
  StreamType,
  SystemStats,
} from '../../../shared/types';
import { VideoCanvas } from './VideoCanvas';
import { DigitalZoomLayer } from './DigitalZoom';
import { SaveLayoutDialog } from './SaveLayoutDialog';
import { RenameChannelDialog } from './RenameChannelDialog';
import { TileContextMenu } from './TileContextMenu';
import { ChannelContextMenu } from './ChannelContextMenu';
import { LayoutPickerPopup } from './LayoutPickerPopup';
import { LAYOUTS, getLayoutShape } from './layoutDefs';
import emptyTileCamera from '../assets/empty-tile-camera.png';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CameraIcon, CameraOffIcon, RecordIcon, RestoreIcon, StopIcon } from '../components/icons';

interface TileState {
  deviceId: string;
  deviceName: string;
  channel: number;
  viewHandle: string | null;
  error: string | null;
  streamType: StreamType;
}

// Real-hardware confirmed: NETDEV_RealPlay_V30 (Uniview) can hang
// indefinitely with no error on a real device. There's no native
// cancellation, so this is purely a UI-level give-up — assign() treats a
// call that hasn't resolved within this window as failed and moves on,
// while still handling the real result if/when it eventually arrives (see
// assign()'s own comment).
const START_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Device didn't respond within ${ms / 1000}s — it may be slow or stuck`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface DragPayload {
  type: 'device' | 'channel' | 'tile';
  // Only 'device'/'channel' payloads (dragged from the sidebar) carry a
  // deviceId - a 'tile' payload (dragging one already-playing tile onto
  // another to swap their positions) only needs the source tile's index.
  deviceId?: string;
  channel?: number;
  tileIndex?: number;
}

// isActive defaults to true so a popped-out window (PopoutWindow.tsx,
// always its own visible OS window — no tab-hiding concept applies there)
// doesn't need to pass anything; AppShell explicitly passes the real
// tab-visibility value since Live View's own tab can be hidden behind a
// different one while staying mounted.
export function LiveView({ isActive = true }: { isActive?: boolean } = {}) {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(4);
  const [tiles, setTiles] = useState<Record<number, TileState>>({});
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [channelsByDevice, setChannelsByDevice] = useState<Record<string, ChannelInfo[]>>({});
  const [loadingChannelsFor, setLoadingChannelsFor] = useState<string | null>(null);
  const [channelErrors, setChannelErrors] = useState<Record<string, string | null>>({});
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  // Read by the unmount-cleanup effect below, which needs the CURRENT
  // layout at whatever moment the tab actually gets closed — an effect
  // with an empty deps array only ever sees the value from its own first
  // render otherwise (a stale closure), not this component's latest one.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const channelsRef = useRef(channelsByDevice);
  channelsRef.current = channelsByDevice;
  const gridOperationTokenRef = useRef(0);
  // Per-tile generation counter — incremented every time a NEW assign()
  // call starts for that tile index. A slow/hung startLiveView call
  // (confirmed live: NETDEV_RealPlay_V30 can genuinely hang on a real
  // Uniview device with no error and no built-in timeout) has no
  // cancellation mechanism, so if the user reassigns that same tile to a
  // different device before the hung call finally resolves, the stale
  // result must not be allowed to land in a tile that's moved on —
  // confirmed live: a Uniview channel's late-resolving viewHandle ended up
  // rendering into a tile the user had since reassigned to a TVT channel,
  // and the orphaned TVT session was never stopped since nothing else
  // referenced its viewHandle anymore, leaking a live session on that
  // device.
  const tileGenerationRef = useRef<Record<number, number>>({});
  // Serializes back-to-back assign() calls for the SAME tile — confirmed
  // live: rapidly double-clicking a tile to expand (upgrades to main
  // stream) then double-clicking again to collapse (back to sub) before
  // the first native startLiveView call had finished dispatched a second
  // concurrent startLiveView for the same channel. tileGenerationRef above
  // only discards a stale call's *result*, it doesn't stop the already-
  // in-flight native call itself — two concurrent RealPlay attempts on the
  // same channel is exactly what real Uniview hardware can't handle
  // (NETDEV_RealPlay_V30 error 60067, the same undocumented key-
  // negotiation limit this project hit before with unpaced bulk starts),
  // and a hung one can tie up a native worker thread indefinitely (see the
  // UV_THREADPOOL_SIZE comment in main/index.ts).
  const tileAssignInFlightRef = useRef<Record<number, Promise<boolean> | undefined>>({});
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statusById, setStatusById] = useState<Record<string, DeviceConnectionStatus | undefined>>({});
  // Keyed by viewHandle, not tile index — matches how frames/setFrameDelivery
  // are already addressed. See main/services/videoHealthCheck.ts: only
  // updated on an actual health transition, not continuously.
  const [videoHealthByHandle, setVideoHealthByHandle] = useState<Record<string, boolean>>({});
  // Single click selects a tile (highlighted outline) as the target for the
  // next channel picked from the sidebar, instead of always falling back to
  // "first empty tile" — lets you point at a specific spot in the grid
  // before choosing what plays there. Double-click a filled tile to expand
  // it to fill the whole grid; double-click again to restore exactly what
  // was there before (every other tile's stream keeps running in the
  // background the whole time — expanding just stops rendering them, it
  // never calls stop() on their sessions).
  const [selectedTileIndex, setSelectedTileIndex] = useState<number | null>(null);
  const [expandedTileIndex, setExpandedTileIndex] = useState<number | null>(null);
  // Tracks which single tile the mouse is currently over, so the
  // individual-close × only appears on hover instead of permanently
  // occupying the corner of every playing tile.
  const [hoveredTileIndex, setHoveredTileIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tileIndex: number; x: number; y: number } | null>(null);
  // Right-click menu on a single channel in the sidebar's device tree
  // (distinct from `contextMenu` above, which is a grid tile's own menu).
  const [channelContextMenu, setChannelContextMenu] = useState<{ deviceId: string; channel: number; x: number; y: number } | null>(
    null,
  );
  const [renamingChannel, setRenamingChannel] = useState<{ deviceId: string; channel: number; currentLabel: string } | null>(null);
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false);
  const [devicesCollapsed, setDevicesCollapsed] = useState(false);
  const [customLayoutsCollapsed, setCustomLayoutsCollapsed] = useState(false);
  const [customLayouts, setCustomLayouts] = useState<CustomLayout[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);
  const [pendingDeleteLayout, setPendingDeleteLayout] = useState<CustomLayout | null>(null);
  // Real OS-level fullscreen (edge-to-edge, no title bar), not just
  // maximizing the window — combined with hiding the sidebar/toolbar so
  // only the video grid itself is on screen. Distinct from AppShell's own
  // window, which stays exactly as it was underneath; this only changes
  // what Live View renders and asks the main process to toggle the
  // window's real fullscreen state.
  const [gridFullscreen, setGridFullscreen] = useState(false);

  // With only one tile actually on screen — either a genuine 1-camera grid
  // or any layout with a tile double-click-expanded to fill it — that tile
  // IS "the" channel for Snapshot/Record and the selection outline, whether
  // or not it was ever explicitly clicked. Without this, both stayed
  // disabled after switching to single-view until the tile was clicked
  // once first, confirmed as a real annoyance live.
  function getEffectiveSelectedTileIndex(): number | null {
    if (expandedTileIndex !== null) return expandedTileIndex;
    if (layout === 1) return 0;
    return selectedTileIndex;
  }

  // Whatever was playing right before the last Close All — lets the
  // Restore button bring it back in one click. In-memory/session-only
  // (unlike lastLiveViewStateStore's on-disk "Start App" restore, which
  // survives an app relaunch); this is just an undo for one specific
  // action, not a general session snapshot.
  const [lastClosedSnapshot, setLastClosedSnapshot] = useState<{
    layout: (typeof LAYOUTS)[number];
    tiles: { tileIndex: number; deviceId: string; channel: number; streamType: StreamType }[];
  } | null>(null);

  // Keyed by viewHandle (not tile index, same convention as
  // videoHealthByHandle) — Snapshot/Record grab the selected tile's own
  // live <canvas> straight off this map rather than keeping a second,
  // separate decode/render path in sync with what's already on screen.
  const canvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // Which viewHandle is currently being recorded, if any — recording is
  // one-at-a-time across the whole grid (a single toolbar button, not a
  // per-tile control), and deliberately keeps recording whatever was
  // selected when Record was clicked even if the selection changes
  // afterward; only closing/reassigning that specific tile stops it (see
  // the auto-stop effect below).
  const [recordingHandle, setRecordingHandle] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingMetaRef = useRef<{ deviceName: string; channel: number } | null>(null);
  // Brief inline status text next to the Snapshot/Record toolbar icons
  // ("Snapshot saved", "Set a path in Settings first", etc.) — self-clears
  // after a few seconds rather than needing a dismiss action for what's
  // always a short, disposable confirmation. `path` is only set on a
  // successful save, making the message clickable to reveal the file in
  // Explorer (reuses playback's existing openExportLocation — plain
  // shell.showItemInFolder under the hood, nothing playback-specific
  // about it).
  const [actionMessage, setActionMessage] = useState<{ text: string; path?: string } | null>(null);
  const actionMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showActionMessage(text: string, path?: string): void {
    setActionMessage({ text, path });
    if (actionMessageTimerRef.current) clearTimeout(actionMessageTimerRef.current);
    actionMessageTimerRef.current = setTimeout(() => setActionMessage(null), 10000);
  }

  function stopRecording(): void {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecordingHandle(null);
  }

  // If the tile being recorded gets closed, reassigned, or swapped away
  // mid-recording, its viewHandle disappears from `tiles` — stop (and
  // save whatever was captured so far) instead of recording a now-
  // orphaned MediaStream indefinitely.
  useEffect(() => {
    if (!recordingHandle) return;
    const stillPresent = Object.values(tiles).some((t) => t.viewHandle === recordingHandle);
    if (!stillPresent) stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, recordingHandle]);

  // Which tile (if any) has Digital Zoom's interactive mode on — mouse
  // wheel/click-drag on that specific tile zoom/pan it (see
  // DigitalZoom.tsx); every other tile behaves normally. One at a time,
  // same convention as recording. The actual scale/pan lives inside
  // DigitalZoomLayer itself (keyed by viewHandle there), not here — this
  // is just "which tile is currently listening for zoom gestures."
  const [zoomTileIndex, setZoomTileIndex] = useState<number | null>(null);

  useEffect(() => {
    if (zoomTileIndex === null) return;
    if (!tiles[zoomTileIndex]?.viewHandle) setZoomTileIndex(null);
  }, [tiles, zoomTileIndex]);

  // Core snapshot capture for a single tile, shared by the toolbar's
  // Snapshot button (effective-selected tile), the tile context menu's own
  // Snapshot item (whichever tile was right-clicked, not necessarily
  // selected — same "acts on that specific tile" convention as Close), and
  // Snapshot All (every playing tile at once).
  async function snapshotTile(tileIndex: number): Promise<{ ok: boolean; path?: string; error?: string }> {
    const tile = tilesRef.current[tileIndex];
    if (!tile?.viewHandle) return { ok: false, error: 'Not playing.' };
    const canvas = canvasesRef.current.get(tile.viewHandle);
    if (!canvas) return { ok: false, error: 'No frame to capture yet.' };
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return { ok: false, error: 'No frame to capture yet.' };
    const buffer = await blob.arrayBuffer();
    return window.ssmVms.liveView.saveSnapshot(tile.deviceName, tile.channel, buffer);
  }

  async function takeSnapshot(tileIndex?: number): Promise<void> {
    const idx = tileIndex ?? getEffectiveSelectedTileIndex();
    if (idx === null || idx === undefined) return;
    const result = await snapshotTile(idx);
    if (result.ok) showActionMessage(`Snapshot saved to ${result.path}`, result.path);
    else showActionMessage(`Snapshot failed: ${result.error ?? 'unknown error'}`);
  }

  async function snapshotAllTiles(): Promise<void> {
    const filledIndices = Object.keys(tilesRef.current)
      .map(Number)
      .filter((i) => tilesRef.current[i]?.viewHandle);
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

  function startRecording(tileIndex?: number): void {
    const idx = tileIndex ?? getEffectiveSelectedTileIndex();
    if (idx === null || idx === undefined) return;
    const tile = tiles[idx];
    if (!tile?.viewHandle) return;
    const canvas = canvasesRef.current.get(tile.viewHandle);
    if (!canvas) return;

    const stream = canvas.captureStream(15);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : undefined;
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      showActionMessage('Recording failed to start.');
      return;
    }

    recordedChunksRef.current = [];
    recordingMetaRef.current = { deviceName: tile.deviceName, channel: tile.channel };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      const meta = recordingMetaRef.current;
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      recordedChunksRef.current = [];
      if (!meta || blob.size === 0) return;
      const buffer = await blob.arrayBuffer();
      const result = await window.ssmVms.liveView.saveRecording(meta.deviceName, meta.channel, buffer);
      if (result.ok) showActionMessage(`Recording saved to ${result.path}`, result.path);
      else showActionMessage(`Recording failed: ${result.error ?? 'unknown error'}`);
    };
    recorder.start(1000);
    mediaRecorderRef.current = recorder;
    setRecordingHandle(tile.viewHandle);
  }

  function toggleRecording(): void {
    if (recordingHandle) stopRecording();
    else startRecording();
  }

  // Context menu's own "Start/Stop Local Recording" item — targets
  // whichever tile was right-clicked specifically, same as toggleRecording
  // above but scoped to one tile instead of the toolbar's effective
  // selection. If that tile is the one currently recording, this stops it;
  // otherwise it starts a new recording there (implicitly replacing any
  // other in-progress recording, since only one runs at a time).
  function toggleRecordingForTile(tileIndex: number): void {
    const tile = tiles[tileIndex];
    if (tile?.viewHandle && tile.viewHandle === recordingHandle) stopRecording();
    else startRecording(tileIndex);
  }

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

  useEffect(() => {
    window.ssmVms.layouts.list().then(setCustomLayouts);
  }, []);

  useEffect(() => {
    window.ssmVms.devices.list().then(setDevices);
    // One bulk call instead of one devices:getStatus round trip (and one
    // React state update/re-render) per device — for a 50+ device fleet
    // that was 50+ separate IPC calls firing in a burst at mount, found
    // via a resource-usage audit.
    window.ssmVms.devices.getAllStatuses().then((statuses) => {
      setStatusById((prev) => ({ ...prev, ...statuses }));
    });
  }, []);

  // "Start App" (settings.restoreLiveViewOnStart) — restores whatever was
  // playing when the app last closed. This only ever attempts once
  // (hasAttemptedStartupRestoreRef), and only once `devices` has actually
  // loaded from the devices.list() call above — without waiting, assign()
  // would race that fetch and fail every tile with "device not found" even
  // though the device genuinely exists, just hasn't loaded into state yet.
  // The real one-shot-per-app-LAUNCH guarantee lives on the main-process
  // side (liveView:consumeStartupRestoreState only ever returns real data
  // to the first caller in the process) — this ref just avoids firing that
  // IPC call more than once from THIS component if `devices` updates again
  // later (e.g. a device added while already on this page).
  const hasAttemptedStartupRestoreRef = useRef(false);
  useEffect(() => {
    if (hasAttemptedStartupRestoreRef.current) return;
    if (devices.length === 0) return;
    hasAttemptedStartupRestoreRef.current = true;
    window.ssmVms.liveView.consumeStartupRestoreState().then((saved) => {
      if (!saved || saved.tiles.length === 0) return;
      const token = ++gridOperationTokenRef.current;
      setLayout(saved.layout as (typeof LAYOUTS)[number]);
      const streamType: StreamType = saved.layout === 1 ? 'main' : 'sub';
      playAssignmentsStaggered(
        saved.tiles.map((t) => ({ tileIndex: t.tileIndex, deviceId: t.deviceId, channel: t.channel, streamType })),
        token,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices]);

  // Keeps a running snapshot of the current layout/tiles on disk so "Start
  // App" always has something reasonably fresh to restore, regardless of
  // whether the app closes cleanly or not (unlike a save-on-quit approach,
  // which a crash or force-quit would skip entirely). Debounced — without
  // it, a staggered playAllChannels() across a full 64-tile grid would fire
  // a save on every single tile assignment.
  useEffect(() => {
    const timer = setTimeout(() => {
      const tilesToSave: CustomLayoutTile[] = Object.entries(tiles).map(([tileIndex, tile]) => ({
        tileIndex: Number(tileIndex),
        deviceId: tile.deviceId,
        channel: tile.channel,
      }));
      window.ssmVms.liveView.saveLastSessionState({ layout, tiles: tilesToSave });
    }, 800);
    return () => clearTimeout(timer);
  }, [tiles, layout]);

  // Live push whenever any device's connection status changes — same
  // status the connection manager keeps for Device Management, just shown
  // here too so the device you're about to drag into the grid already
  // tells you whether it's actually reachable.
  useEffect(() => {
    return window.ssmVms.devices.onStatusChanged((deviceId, status) => {
      setStatusById((prev) => ({ ...prev, [deviceId]: status }));
    });
  }, []);

  useEffect(() => window.ssmVms.system.onStats(setStats), []);

  useEffect(() => {
    return window.ssmVms.liveView.onVideoHealth((viewHandle, healthy) => {
      setVideoHealthByHandle((prev) => ({ ...prev, [viewHandle]: healthy }));
    });
  }, []);

  useEffect(() => {
    return () => {
      Object.values(tilesRef.current).forEach((tile) => {
        if (tile.viewHandle) window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle);
      });
      // Closing the Live View tab (as opposed to just switching away from
      // it, which keeps this component mounted-but-hidden - see AppShell's
      // "every opened tab stays mounted" comment) is exactly when the
      // debounced save effect above can't be trusted: its own cleanup
      // cancels whatever save was pending the instant this component
      // unmounts, so the very last, most important update - "it's now
      // empty" - silently never reaches disk, leaving Start App to restore
      // a grid the user explicitly closed. Written immediately here
      // instead of relying on that debounce.
      window.ssmVms.liveView.saveLastSessionState({ layout: layoutRef.current, tiles: [] });
    };
  }, []);

  // Pauses/resumes frame delivery for every currently-playing tile based
  // on whether this tab is the one actually visible (isActive) and,
  // within that, whether the tile itself is currently displayed (not
  // hidden behind an expanded tile) — see VmsAdapter.setFrameDelivery's
  // doc comment. A hidden tile's native session keeps running (so it
  // resumes instantly, same as expand/collapse already did before this),
  // it just stops paying the decode/convert/IPC cost for frames nobody
  // renders — confirmed via a real resource-usage audit to be the single
  // largest source of unnecessary CPU/memory use across a large fleet.
  // Re-syncs whenever any of these change, including a tile newly
  // getting (or losing) a viewHandle.
  useEffect(() => {
    let cancelled = false;
    const entries = Object.entries(tiles);

    // Pausing is cheap and safe to fire instantly for every tile at once —
    // it only ever reduces load. Resuming is different: collapsing an
    // expanded tile can resume 7+ tiles' frame delivery in the same
    // instant, each immediately starting to decode+convert+paint again —
    // confirmed live on real hardware (an older i7-2600 office machine)
    // that this burst was enough to make the whole renderer unresponsive
    // ("Not Responding") for several seconds, even though every underlying
    // native call completed normally (diagnostic logging ruled out an
    // actual SDK hang). Staggering resumes, same idea as the existing
    // 300ms per-channel start stagger elsewhere in this file, spreads that
    // burst out instead of asking this machine to decode 7+ streams in the
    // same event-loop tick.
    const toResume: [number, string, string][] = [];
    entries.forEach(([indexStr, tile]) => {
      if (!tile.viewHandle) return;
      const index = Number(indexStr);
      const shouldDeliver = isActive && (expandedTileIndex === null || expandedTileIndex === index);
      if (shouldDeliver) {
        toResume.push([index, tile.deviceId, tile.viewHandle]);
      } else {
        window.ssmVms.liveView.setFrameDelivery(tile.deviceId, tile.viewHandle, false);
      }
    });

    (async () => {
      for (const [, deviceId, viewHandle] of toResume) {
        if (cancelled) return;
        window.ssmVms.liveView.setFrameDelivery(deviceId, viewHandle, true);
        if (toResume.length > 1) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isActive, expandedTileIndex, tiles]);

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

  // Sidebar channel context menu's Rename — local-only override (see
  // deviceStore.ts's renameDeviceChannel), so this just needs to refresh
  // channelsByDevice with whatever the main process persisted, not touch
  // any live session (the channel might not even be playing anywhere).
  async function renameChannel(deviceId: string, channel: number, label: string): Promise<void> {
    const updated = await window.ssmVms.devices.renameChannel(deviceId, channel, label);
    if (updated) setChannelsByDevice((prev) => ({ ...prev, [deviceId]: updated }));
  }

  async function toggleExpand(deviceId: string): Promise<void> {
    if (expandedDeviceId === deviceId) {
      setExpandedDeviceId(null);
      return;
    }
    setExpandedDeviceId(deviceId);
    await loadChannels(deviceId);
  }

  async function assign(
    tileIndex: number,
    deviceId: string,
    channel: number,
    streamType: StreamType,
  ): Promise<boolean> {
    // Wait for any prior in-flight assign() on this exact tile to fully
    // settle (success, failure, or timeout) before dispatching another
    // native startLiveView — see tileAssignInFlightRef's doc comment for
    // why this matters. Calls targeting *other* tiles are never blocked by
    // this, only same-tile calls are serialized.
    const prior = tileAssignInFlightRef.current[tileIndex];
    if (prior) await prior.catch(() => false);

    const resultPromise = doAssign(tileIndex, deviceId, channel, streamType);
    tileAssignInFlightRef.current[tileIndex] = resultPromise;
    try {
      return await resultPromise;
    } finally {
      if (tileAssignInFlightRef.current[tileIndex] === resultPromise) {
        delete tileAssignInFlightRef.current[tileIndex];
      }
    }
  }

  async function doAssign(
    tileIndex: number,
    deviceId: string,
    channel: number,
    streamType: StreamType,
  ): Promise<boolean> {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return false;
    const existing = tilesRef.current[tileIndex];
    if (existing?.viewHandle) {
      // Awaited, not fire-and-forget — confirmed live via diagnostic
      // logging that starting a NEW stream for a channel whose OLD stream
      // hadn't finished tearing down yet (e.g. expanding a tile upgrades
      // it to main stream, restarting the same channel it was already
      // playing as sub) can make NETDEV_RealPlay_V30 hang indefinitely on
      // this device — the old session's teardown and the new one's setup
      // were racing inside the device's own session negotiation. Waiting
      // for stop() to fully complete first, even though it's now a
      // properly async native call, removes that race.
      //
      // Wrapped in its own timeout (same class of native call, same
      // real-hardware hang risk as start — no reason to assume stop is
      // any safer) — without this, a hung stop would block this whole
      // function forever with nothing to catch it, unlike start() which
      // already has withTimeout below.
      await withTimeout(
        window.ssmVms.liveView.stop(existing.deviceId, existing.viewHandle),
        START_TIMEOUT_MS,
      ).catch(() => undefined);
    }

    const myGeneration = (tileGenerationRef.current[tileIndex] ?? 0) + 1;
    tileGenerationRef.current[tileIndex] = myGeneration;

    setTiles((prev) => ({
      ...prev,
      [tileIndex]: { deviceId, deviceName: device.name, channel, viewHandle: null, error: null, streamType },
    }));

    const startPromise = window.ssmVms.liveView.start(deviceId, channel, streamType);

    // If this call is still pending after the timeout below, or if the
    // tile it targeted has since been reassigned, its eventual real result
    // is handled here instead of the normal path — stopping an orphaned
    // viewHandle the UI no longer references rather than leaking a live
    // session on the device, or worse, letting it land in a tile that's
    // moved on to something else.
    startPromise.then(
      (viewHandle) => {
        if (tileGenerationRef.current[tileIndex] === myGeneration) return; // handled by the normal path below
        window.ssmVms.liveView.stop(deviceId, viewHandle).catch(() => undefined);
      },
      () => undefined,
    );

    try {
      const viewHandle = await withTimeout(startPromise, START_TIMEOUT_MS);
      if (tileGenerationRef.current[tileIndex] !== myGeneration) return false; // reassigned while waiting
      setTiles((prev) => ({ ...prev, [tileIndex]: { ...prev[tileIndex], viewHandle } }));
      return true;
    } catch (err) {
      if (tileGenerationRef.current[tileIndex] !== myGeneration) return false;
      setTiles((prev) => ({
        ...prev,
        [tileIndex]: { ...prev[tileIndex], error: err instanceof Error ? err.message : String(err) },
      }));
      return false;
    }
  }

  // A selected tile (single-clicked in the grid) takes priority as the
  // target — otherwise falls back to the first empty tile, same as before.
  // streamTypeOverride is set by the sidebar channel's own context menu
  // ("Main Stream"/"Sub Stream") to force a specific stream regardless of
  // the layout-based default below; plain click/drag leaves it unset.
  function assignToSelectedOrFirstEmptyTile(deviceId: string, channel: number, streamTypeOverride?: StreamType): void {
    const streamType: StreamType = streamTypeOverride ?? (layout === 1 ? 'main' : 'sub');
    if (selectedTileIndex !== null && selectedTileIndex < layout) {
      assign(selectedTileIndex, deviceId, channel, streamType);
      return;
    }
    for (let i = 0; i < layout; i++) {
      if (!tilesRef.current[i]) {
        assign(i, deviceId, channel, streamType);
        return;
      }
    }
  }

  // Shared by playAllChannels and loadCustomLayout — both fire a batch of
  // startLiveView calls at once and need the same protection: a 300ms
  // stagger (firing them back-to-back overwhelmed a real Uniview NVR's
  // per-stream session/key negotiation - NETDEV_E_INVALID_PARAM followed by
  // an undocumented error 60067, one below the SDK's own documented
  // NETDEV_E_PUBLICKEYFAIL=60068), plus one retry pass after a longer
  // cool-down for whichever channels failed on the first attempt (rather
  // than abandoning the rest of the grid the moment a couple of channels
  // fail, which was leaving channels unopened that would have worked fine
  // on their own). `token` is the caller's gridOperationTokenRef snapshot,
  // so a newer grid-wide operation (switching devices, loading a different
  // custom layout, changing layout) cancels this one instead of racing it.
  async function playAssignmentsStaggered(
    assignments: { tileIndex: number; deviceId: string; channel: number; streamType: StreamType }[],
    token: number,
  ): Promise<void> {
    async function attemptPass(
      list: { tileIndex: number; deviceId: string; channel: number; streamType: StreamType }[],
    ): Promise<typeof list> {
      const failed: typeof list = [];
      for (const a of list) {
        if (token !== gridOperationTokenRef.current) return [];
        const ok = await assign(a.tileIndex, a.deviceId, a.channel, a.streamType);
        if (token !== gridOperationTokenRef.current) return [];
        if (!ok) failed.push(a);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return failed;
    }

    const firstPassFailures = await attemptPass(assignments);
    if (token !== gridOperationTokenRef.current) return;
    if (firstPassFailures.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (token !== gridOperationTokenRef.current) return;
      await attemptPass(firstPassFailures);
    }
  }

  async function playAllChannels(deviceId: string): Promise<void> {
    // Nothing previously stopped a second playAllChannels call (e.g. the
    // user switching to another device and back) from starting while an
    // earlier call's staggered loop below was still mid-flight. The two
    // loops then raced on the same `tiles` state and fired overlapping
    // startLiveView calls - confirmed live as the cause of a real freeze
    // (wrong tile count, channels stuck "Connecting…" forever) on top of
    // the NETDEV errors below. This token makes a newer call cancel any
    // older one still running: after every await, a stale loop checks its
    // token against the latest one and bails out instead of continuing to
    // issue calls into state a newer call has already taken over.
    const token = ++gridOperationTokenRef.current;

    let channels: ChannelInfo[];
    try {
      channels = await ensureChannels(deviceId);
    } catch (err) {
      if (token !== gridOperationTokenRef.current) return;
      setChannelErrors((prev) => ({ ...prev, [deviceId]: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (token !== gridOperationTokenRef.current) return;
    if (channels.length === 0) return;
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;

    // A selected tile means "start the new device's channels here" -
    // fills forward into whichever other tiles in the CURRENT layout are
    // still empty (wrapping around), without touching the layout size or
    // anything already playing elsewhere. Confirmed live as a real bug:
    // dragging a device in with a tile selected used to ignore the
    // selection entirely, wipe the whole grid, and refill from tile 0 -
    // closing out channels the user had deliberately left running.
    if (selectedTileIndex !== null) {
      const anchor = selectedTileIndex;
      setSelectedTileIndex(null);
      const streamType: StreamType = layout === 1 ? 'main' : 'sub';
      const order = Array.from({ length: layout }, (_, offset) => (anchor + offset) % layout);
      const targetIndices = order
        .filter((i) => i === anchor || !tilesRef.current[i])
        .slice(0, channels.length);
      await playAssignmentsStaggered(
        targetIndices.map((tileIndex, i) => ({ tileIndex, deviceId, channel: channels[i].channel, streamType })),
        token,
      );
      return;
    }

    const neededLayout = LAYOUTS.find((n) => n >= channels.length) ?? LAYOUTS[LAYOUTS.length - 1];
    const streamType: StreamType = neededLayout === 1 ? 'main' : 'sub';

    await Promise.all(
      Object.values(tilesRef.current).map((tile) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    if (token !== gridOperationTokenRef.current) return;
    setTiles({});
    setLayout(neededLayout);
    setSelectedTileIndex(null);
    setExpandedTileIndex(null);

    const channelsToPlay = channels.slice(0, neededLayout);
    await playAssignmentsStaggered(
      channelsToPlay.map((ch, i) => ({ tileIndex: i, deviceId, channel: ch.channel, streamType })),
      token,
    );
  }

  async function saveCurrentLayout(name: string): Promise<void> {
    const tilesToSave: CustomLayoutTile[] = Object.entries(tilesRef.current).map(([tileIndex, tile]) => ({
      tileIndex: Number(tileIndex),
      deviceId: tile.deviceId,
      channel: tile.channel,
    }));
    const saved = await window.ssmVms.layouts.save(name, layout, tilesToSave);
    setCustomLayouts((prev) => [...prev, saved]);
    setSavingLayout(false);
  }

  async function deleteCustomLayoutById(id: string): Promise<void> {
    await window.ssmVms.layouts.delete(id);
    setCustomLayouts((prev) => prev.filter((l) => l.id !== id));
  }

  async function loadCustomLayout(custom: CustomLayout): Promise<void> {
    const token = ++gridOperationTokenRef.current;

    await Promise.all(
      Object.values(tilesRef.current).map((tile) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    if (token !== gridOperationTokenRef.current) return;
    setTiles({});
    setLayout(custom.layout as (typeof LAYOUTS)[number]);
    setSelectedTileIndex(null);
    setExpandedTileIndex(null);

    const streamType: StreamType = custom.layout === 1 ? 'main' : 'sub';
    await playAssignmentsStaggered(
      custom.tiles.map((t) => ({ tileIndex: t.tileIndex, deviceId: t.deviceId, channel: t.channel, streamType })),
      token,
    );
  }

  async function clearTile(tileIndex: number): Promise<void> {
    const tile = tiles[tileIndex];
    // Bumping this here too (not just in assign()) means a still-pending
    // hung startLiveView call for this exact tile — the user cleared it,
    // not reassigned it to something else — gets stopped when it finally
    // resolves instead of silently resurrecting a viewHandle into a tile
    // the user explicitly emptied.
    tileGenerationRef.current[tileIndex] = (tileGenerationRef.current[tileIndex] ?? 0) + 1;
    if (tile?.viewHandle) {
      await window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle);
    }
    setTiles((prev) => {
      const next = { ...prev };
      delete next[tileIndex];
      return next;
    });
    setSelectedTileIndex((prev) => (prev === tileIndex ? null : prev));
    setExpandedTileIndex((prev) => (prev === tileIndex ? null : prev));
  }

  // Per explicit request: sub stream is the default for every multi-tile
  // grid (lower bandwidth/decode cost across many channels at once — see
  // the resource-usage pass this was part of), full main-quality stream
  // only for whichever single channel is actually being looked at closely
  // — either the whole grid set to a 1-camera layout (already handled by
  // the streamType=layout===1?'main':'sub' calls elsewhere), or expanding
  // one tile to fill the grid within a bigger layout. Restarts that one
  // tile's session at the new quality rather than just resizing what's
  // rendered, so expanding actually gets you the sharper picture, not just
  // a bigger sub-stream image. Only relevant when layout > 1 — expanding a
  // layout-1 grid has nothing else to hide and that tile is already main.
  // Reverted the earlier "upgrade to main stream on expand" behavior —
  // confirmed live on real hardware (an office UNV NVR) that switching a
  // channel to main stream via this path could trigger a genuine,
  // non-recovering freeze of the whole app. Diagnostic logging on the
  // native side showed the startLiveView/stopLiveView calls themselves
  // completing successfully every time, meaning whatever actually hangs
  // happens inside the vendor SDK's own internal handling of the
  // main-stream feed itself, after the API call already returned — not
  // something fixable from this side without a native debugger attached.
  // Expanding a tile now only ever changes layout/which tile is shown, the
  // same safe behavior as before this session — it never touches stream
  // quality.
  function toggleExpandTile(i: number): void {
    setExpandedTileIndex((prev) => (prev === i ? null : i));
  }

  async function changeLayout(next: (typeof LAYOUTS)[number]): Promise<void> {
    // Only tiles that no longer fit in the new (smaller) layout get
    // stopped — picking a *bigger* layout to add more cameras alongside
    // what's already playing used to stop and clear everything, closing
    // out every channel just to make room for slots that were already
    // empty. Everything that still fits keeps playing untouched.
    const overflowing = Object.entries(tilesRef.current).filter(([tileIndex]) => Number(tileIndex) >= next);
    await Promise.all(
      overflowing.map(([, tile]) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    if (overflowing.length > 0) {
      setTiles((prev) => {
        const updated = { ...prev };
        overflowing.forEach(([tileIndex]) => delete updated[Number(tileIndex)]);
        return updated;
      });
    }
    setLayout(next);
    setSelectedTileIndex((prev) => (prev !== null && prev >= next ? null : prev));
    setExpandedTileIndex((prev) => (prev !== null && prev >= next ? null : prev));
  }

  async function closeAllTiles(): Promise<void> {
    // Cancels any in-flight staggered playAllChannels()/loadCustomLayout()
    // loop so it stops issuing further assign() calls for channels that
    // haven't loaded yet — confirmed live as a real bug: hitting Close All
    // mid-load correctly stopped whatever had already connected, but the
    // still-running staggered loop kept going regardless and opened the
    // channels behind it, undoing the close.
    ++gridOperationTokenRef.current;
    // Also bump every tile's generation, not just the ones already showing
    // a viewHandle — a tile whose assign() call is still awaiting its
    // startLiveView promise has no viewHandle yet, so the stop-loop below
    // can't touch it, but its eventual result would otherwise land back in
    // `tiles` after this function already cleared it. Bumping the
    // generation makes doAssign's own check discard/auto-stop that stale
    // result instead — see clearTile's matching comment for the same
    // pattern applied to a single tile.
    for (let i = 0; i < layout; i++) {
      tileGenerationRef.current[i] = (tileGenerationRef.current[i] ?? 0) + 1;
    }

    const closedTiles = Object.entries(tilesRef.current).map(([tileIndex, tile]) => ({
      tileIndex: Number(tileIndex),
      deviceId: tile.deviceId,
      channel: tile.channel,
      streamType: tile.streamType,
    }));
    if (closedTiles.length > 0) {
      setLastClosedSnapshot({ layout, tiles: closedTiles });
    }

    await Promise.all(
      Object.values(tilesRef.current).map((tile) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    setTiles({});
    setSelectedTileIndex(null);
    setExpandedTileIndex(null);
  }

  // Restore button next to Close All — replays exactly what closeAllTiles
  // just captured above. Same staggered-load mechanism "Start App" already
  // uses to restore across an app relaunch (playAssignmentsStaggered),
  // just fed from the in-memory snapshot instead of disk.
  function restoreLastClosed(): void {
    if (!lastClosedSnapshot) return;
    const token = ++gridOperationTokenRef.current;
    setLayout(lastClosedSnapshot.layout);
    playAssignmentsStaggered(lastClosedSnapshot.tiles, token);
  }

  function handleTileDrop(tileIndex: number, e: React.DragEvent): void {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    let data: DragPayload;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data.type === 'device' && data.deviceId) {
      playAllChannels(data.deviceId);
    } else if (data.type === 'channel' && data.deviceId && data.channel !== undefined) {
      const streamType: StreamType = layout === 1 ? 'main' : 'sub';
      assign(tileIndex, data.deviceId, data.channel, streamType);
    } else if (data.type === 'tile' && data.tileIndex !== undefined && data.tileIndex !== tileIndex) {
      swapTiles(data.tileIndex, tileIndex);
    }
  }

  // Purely a client-side rearrange - no native calls involved. Each tile's
  // viewHandle already identifies a real, still-running decode session
  // server-side; swapping which grid index a TileState lives under just
  // moves which VideoCanvas prop it's passed to next render, same as
  // moving a browser tab doesn't restart the page. Handles all 3 real
  // cases: swapping two filled tiles, and moving a filled tile onto an
  // empty one (the empty slot just needs the key deleted, not set to
  // undefined, so `!tile` checks elsewhere keep working).
  function swapTiles(fromIndex: number, toIndex: number): void {
    setTiles((prev) => {
      const next = { ...prev };
      const source = prev[fromIndex];
      const target = prev[toIndex];
      if (target) next[fromIndex] = target;
      else delete next[fromIndex];
      if (source) next[toIndex] = source;
      else delete next[toIndex];
      return next;
    });
    setSelectedTileIndex((prev) => {
      if (prev === fromIndex) return toIndex;
      if (prev === toIndex) return fromIndex;
      return prev;
    });
  }

  // Uniform layouts (4, 9, 16...) fall back to the plain sqrt-based
  // columns/rows math they always used; "mixed" layouts (6, 10 — one or
  // more larger tiles alongside smaller ones) carry an explicit per-tile
  // cell/span definition instead — see layoutDefs.ts, the single source of
  // truth this and the toolbar's layout-picker popup both read from.
  const layoutShape = getLayoutShape(layout);
  const columns = layoutShape.columns;
  const rows = layoutShape.rows;
  const effectiveSelectedTileIndex = getEffectiveSelectedTileIndex();
  const selectedTile = effectiveSelectedTileIndex !== null ? tiles[effectiveSelectedTileIndex] : undefined;
  const displayIndices = expandedTileIndex !== null ? [expandedTileIndex] : Array.from({ length: layout }, (_, i) => i);
  const gridColumns = expandedTileIndex !== null ? 1 : columns;
  const gridRows = expandedTileIndex !== null ? 1 : rows;

  function renderTile(i: number) {
    const tile = tiles[i];
    const isSelected = effectiveSelectedTileIndex === i;
    const isExpanded = expandedTileIndex === i;
    const isHovered = hoveredTileIndex === i;
    // Only apply a mixed layout's explicit cell/span when the whole grid
    // is actually showing (not the expanded single-tile view, which is
    // always its own plain 1x1 grid — applying a span meant for a 3x3 or
    // 4x4 base grid there would place the tile outside that 1x1 container
    // instead of filling it).
    const cell = expandedTileIndex === null ? layoutShape.cells?.[i] : undefined;
    return (
      <div
        key={i}
        // Only a filled tile can be the drag SOURCE (nothing to swap out of
        // an empty one) - it can still be a drop TARGET either way, handled
        // by handleTileDrop/swapTiles above. Disabled while this tile is
        // the active Digital Zoom target - a drag gesture there means
        // "rubber-band select a zoom region", not "swap tiles".
        draggable={Boolean(tile) && zoomTileIndex !== i}
        onDragStart={(e) => {
          if (!tile) return;
          e.dataTransfer.setData('application/json', JSON.stringify({ type: 'tile', tileIndex: i }));
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleTileDrop(i, e)}
        onClick={() => setSelectedTileIndex((prev) => (prev === i ? null : i))}
        onDoubleClick={() => {
          // Double-click already collapses/expands the single-channel
          // view, which is usually exactly when Digital Zoom gets used —
          // exit zoom at the same time instead of leaving it zoomed in
          // once back in the full grid.
          if (zoomTileIndex === i) setZoomTileIndex(null);
          toggleExpandTile(i);
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
          gridColumn: cell ? `${cell.col} / span ${cell.colSpan}` : undefined,
          gridRow: cell ? `${cell.row} / span ${cell.rowSpan}` : undefined,
          // Rapid click/double-click on the tile (especially the empty-tile
          // placeholder image) was getting picked up as a native text/image
          // selection, showing the browser's blue "selected" highlight —
          // this is a click target, not selectable content.
          userSelect: 'none',
          WebkitUserSelect: 'none',
          // outline (not border) so the highlight never nudges the grid's
          // precise pixel sizing — that broke once already (the
          // gridTemplateRows fix) and outline doesn't participate in the
          // box model the way border does.
          outline: isSelected ? `2px solid ${theme.selection}` : 'none',
          outlineOffset: '-2px',
        }}
      >
        {!tile && (
          // Purely a visual placeholder now — channels only get assigned
          // from the sidebar (drag or click), never from this tile
          // directly, so there's nothing here to click.
          <Centered>
            <img
              src={emptyTileCamera}
              alt=""
              draggable={false}
              style={{ width: '46px', height: '46px', opacity: 0.55, WebkitUserDrag: 'none' } as CSSProperties}
            />
          </Centered>
        )}

        {tile && (
          <>
            {tile.viewHandle && (
              <DigitalZoomLayer key={tile.viewHandle} active={zoomTileIndex === i}>
                <VideoCanvas
                  viewHandle={tile.viewHandle}
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
                  title="Connected, but the video signal looks blank — check the camera/coax connection"
                  style={{ color: theme.warning, opacity: 0.85, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}
                >
                  <CameraOffIcon size={40} />
                  <span style={{ fontSize: '11px', fontWeight: 600 }}>No Signal</span>
                </div>
              </Centered>
            )}
            {!tile.viewHandle && !tile.error && (
              <Centered>
                <span style={{ color: theme.textMuted, fontSize: '12px' }}>Connecting…</span>
              </Centered>
            )}
            {tile.error && (
              <Centered>
                <div title={tile.error} style={{ color: theme.textFaint, opacity: 0.7 }}>
                  <CameraOffIcon size={44} />
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
                padding: '0.3rem 0.5rem',
                background: 'linear-gradient(rgba(0,0,0,0.6), transparent)',
                fontSize: '11px',
                color: '#fff',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                {tile.viewHandle && tile.viewHandle === recordingHandle && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: theme.danger, fontWeight: 700 }}>
                    <RecordIcon size={9} />
                    REC
                  </span>
                )}
                {tile.deviceName} · ch{tile.channel}
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

  const gridElement = (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
        // Without this, rows sized themselves to each canvas's actual
        // decoded pixel height (e.g. 1080px) instead of splitting the
        // container height evenly - confirmed live: a 16-channel grid
        // only ever showed 3 of its 4 rows, with the rest of the window
        // left blank below it, even maximized.
        gridTemplateRows: `repeat(${gridRows}, 1fr)`,
        gap: '2px',
        background: theme.border,
        overflow: 'hidden',
      }}
    >
      {displayIndices.map((i) => renderTile(i))}
    </div>
  );

  // Shared with the fullscreen branch below - a tile's right-click menu
  // (including Snapshot/Record and the Full Screen toggle itself) needs to
  // keep working once already in fullscreen, not just from the normal
  // toolbar+sidebar layout.
  const contextMenuElement = contextMenu && (
    <TileContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      hasContent={Boolean(tiles[contextMenu.tileIndex])}
      isGridFullscreen={gridFullscreen}
      isRecordingThisTile={Boolean(recordingHandle) && tiles[contextMenu.tileIndex]?.viewHandle === recordingHandle}
      isZoomedTile={zoomTileIndex === contextMenu.tileIndex}
      currentStream={tiles[contextMenu.tileIndex]?.streamType}
      anyTilesFilled={Object.keys(tiles).length > 0}
      onDismiss={() => setContextMenu(null)}
      onClose={() => clearTile(contextMenu.tileIndex)}
      onCloseAll={() => closeAllTiles()}
      onFullScreen={() => toggleGridFullscreen()}
      onSelectStream={(streamType) => {
        const tile = tiles[contextMenu.tileIndex];
        if (tile) assign(contextMenu.tileIndex, tile.deviceId, tile.channel, streamType);
      }}
      onSnapshot={() => takeSnapshot(contextMenu.tileIndex)}
      onSnapshotAll={() => snapshotAllTiles()}
      onToggleRecording={() => toggleRecordingForTile(contextMenu.tileIndex)}
      onToggleZoom={() => setZoomTileIndex((prev) => (prev === contextMenu.tileIndex ? null : contextMenu.tileIndex))}
    />
  );

  // Real OS-level fullscreen, showing nothing but the grid itself — no
  // sidebar, no toolbar, no tab bar (this covers the whole viewport,
  // including AppShell's tabs, even though AppShell stays mounted
  // underneath unchanged). Distinct from just maximizing the window, which
  // still leaves everything else on screen - explicitly what was asked for.
  if (gridFullscreen) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: theme.bg, display: 'flex' }}>
        {gridElement}
        {contextMenuElement}
        <button
          onClick={toggleGridFullscreen}
          title="Exit fullscreen (Esc)"
          style={{
            position: 'absolute',
            top: '0.6rem',
            right: '0.6rem',
            width: '30px',
            height: '30px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            border: 'none',
            background: 'rgba(0, 0, 0, 0.45)',
            color: '#fff',
            fontSize: '15px',
            cursor: 'pointer',
          }}
        >
          &#10005;
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex' }}>
      <div
        style={{
          width: '220px',
          flexShrink: 0,
          borderRight: `1px solid ${theme.border}`,
          overflowY: 'auto',
          padding: '0.5rem',
        }}
      >
        <SidebarSectionHeader
          title="Devices"
          collapsed={devicesCollapsed}
          onToggle={() => setDevicesCollapsed((prev) => !prev)}
        />
        {!devicesCollapsed && (
          <div style={{ marginBottom: '0.75rem' }}>
            {devices.length === 0 && (
              <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.75rem' }}>No devices yet.</div>
            )}
            {devices.map((device) => (
          <div key={device.id} style={{ marginBottom: '0.15rem' }}>
            <div
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData('application/json', JSON.stringify({ type: 'device', deviceId: device.id }))
              }
              onClick={() => toggleExpand(device.id)}
              onDoubleClick={() => playAllChannels(device.id)}
              title="Click to expand · double-click or drag to play all channels"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.5rem',
                borderRadius: '4px',
                cursor: 'grab',
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {device.name}
              </span>
            </div>

            {expandedDeviceId === device.id && (
              <div style={{ paddingLeft: '1.4rem' }}>
                {loadingChannelsFor === device.id && (
                  <div style={{ fontSize: '11px', color: theme.textFaint, padding: '0.3rem 0' }}>Loading…</div>
                )}
                {channelErrors[device.id] && (
                  <div style={{ padding: '0.3rem 0', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    <span style={{ fontSize: '11px', color: theme.danger }}>{channelErrors[device.id]}</span>
                    <button
                      onClick={() => loadChannels(device.id)}
                      style={{
                        alignSelf: 'flex-start',
                        background: 'none',
                        border: `1px solid ${theme.borderLight}`,
                        borderRadius: '4px',
                        color: theme.textMuted,
                        fontSize: '10.5px',
                        padding: '0.15rem 0.5rem',
                        cursor: 'pointer',
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {(channelsByDevice[device.id] ?? []).map((ch) => (
                  <div
                    key={ch.channel}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData(
                        'application/json',
                        JSON.stringify({ type: 'channel', deviceId: device.id, channel: ch.channel }),
                      )
                    }
                    onClick={() => assignToSelectedOrFirstEmptyTile(device.id, ch.channel)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setChannelContextMenu({ deviceId: device.id, channel: ch.channel, x: e.clientX, y: e.clientY });
                    }}
                    title="Click to play in the selected tile (or the next open one) · drag onto a tile to place it there"
                    style={{
                      padding: '0.3rem 0.5rem',
                      borderRadius: '4px',
                      cursor: 'grab',
                      fontSize: '12px',
                      color: theme.textMuted,
                    }}
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
        )}

        <SidebarSectionHeader
          title="Custom Layouts"
          collapsed={customLayoutsCollapsed}
          onToggle={() => setCustomLayoutsCollapsed((prev) => !prev)}
        />
        {!customLayoutsCollapsed && (
          <div>
            {customLayouts.length === 0 && (
              <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.75rem' }}>
                No custom layouts yet — use the save icon in the toolbar below.
              </div>
            )}
            {customLayouts.map((cl) => (
              <div
                key={cl.id}
                onClick={() => loadCustomLayout(cl)}
                title={`Click to load "${cl.name}" (${cl.layout}-channel layout)`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.4rem',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  color: theme.text,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = theme.surface)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cl.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDeleteLayout(cl);
                  }}
                  title="Delete this custom layout"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: theme.textFaint,
                    cursor: 'pointer',
                    fontSize: '13px',
                    flexShrink: 0,
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {gridElement}

        {/* Toolbar for grid layout + per-channel tools (audio, snapshot,
            etc. get added here as they're built) + live host resource
            usage, at the bottom of the page rather than a dedicated top
            row — leaves the top of the page free for the video itself and
            groups everything that acts on "the grid as a whole" in one
            place. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.45rem 0.75rem',
            borderTop: `1px solid ${theme.border}`,
            background: theme.panel,
            flexShrink: 0,
          }}
        >
          <div style={{ position: 'relative' }}>
            <ToolbarIconButton
              title="Choose grid layout"
              onClick={() => setLayoutPickerOpen((prev) => !prev)}
              active={layoutPickerOpen}
            >
              &#9638;
            </ToolbarIconButton>
            {layoutPickerOpen && (
              <LayoutPickerPopup
                current={layout}
                onSelect={changeLayout}
                onDismiss={() => setLayoutPickerOpen(false)}
              />
            )}
          </div>

          <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.2rem 0.35rem', background: theme.border }} />

          <ToolbarIconButton
            title={Object.keys(tiles).length === 0 ? 'Assign at least one channel first' : 'Save current layout'}
            disabled={Object.keys(tiles).length === 0}
            onClick={() => setSavingLayout(true)}
          >
            &#128190;
          </ToolbarIconButton>
          <ToolbarIconButton
            title={Object.keys(tiles).length === 0 ? 'No channels playing' : 'Close all channels'}
            disabled={Object.keys(tiles).length === 0}
            onClick={closeAllTiles}
            danger
          >
            &#10005;
          </ToolbarIconButton>
          <ToolbarIconButton
            title={
              Object.keys(tiles).length > 0
                ? 'Close all channels first'
                : lastClosedSnapshot
                  ? 'Restore all channels'
                  : 'Nothing to restore yet'
            }
            disabled={Object.keys(tiles).length > 0 || !lastClosedSnapshot}
            onClick={restoreLastClosed}
          >
            <RestoreIcon />
          </ToolbarIconButton>
          <ToolbarIconButton
            title={selectedTile?.viewHandle ? 'Take Snapshot' : 'Select a playing channel first'}
            disabled={!selectedTile?.viewHandle}
            onClick={() => takeSnapshot()}
          >
            <CameraIcon />
          </ToolbarIconButton>
          <ToolbarIconButton
            title={
              recordingHandle
                ? 'Stop Recording'
                : selectedTile?.viewHandle
                  ? 'Start Recording'
                  : 'Select a playing channel first'
            }
            disabled={!recordingHandle && !selectedTile?.viewHandle}
            danger={Boolean(recordingHandle)}
            onClick={toggleRecording}
          >
            {recordingHandle ? <StopIcon /> : <RecordIcon />}
          </ToolbarIconButton>

          {actionMessage && (
            <span
              title={actionMessage.path ? 'Click to open file location' : undefined}
              onClick={actionMessage.path ? () => window.ssmVms.playback.openExportLocation(actionMessage.path!) : undefined}
              style={{
                fontSize: '11px',
                color: actionMessage.path ? theme.accentHover : theme.textMuted,
                marginLeft: '0.3rem',
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

          <div style={{ flex: 1 }} />

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

          <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.2rem 0.35rem', background: theme.border }} />

          <ToolbarIconButton title="Full Screen" onClick={toggleGridFullscreen}>
            &#9974;
          </ToolbarIconButton>
        </div>
      </div>

      {savingLayout && <SaveLayoutDialog onSave={saveCurrentLayout} onCancel={() => setSavingLayout(false)} />}

      {pendingDeleteLayout && (
        <ConfirmDialog
          title="Delete Custom Layout"
          message={`Delete "${pendingDeleteLayout.name}"? This can't be undone.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDeleteLayout(null)}
          onConfirm={() => {
            deleteCustomLayoutById(pendingDeleteLayout.id);
            setPendingDeleteLayout(null);
          }}
        />
      )}

      {contextMenuElement}

      {channelContextMenu && (
        <ChannelContextMenu
          x={channelContextMenu.x}
          y={channelContextMenu.y}
          onDismiss={() => setChannelContextMenu(null)}
          onRename={() => {
            const label = channelsByDevice[channelContextMenu.deviceId]?.find((c) => c.channel === channelContextMenu.channel)?.label ?? '';
            setRenamingChannel({ deviceId: channelContextMenu.deviceId, channel: channelContextMenu.channel, currentLabel: label });
          }}
          onMainStream={() => assignToSelectedOrFirstEmptyTile(channelContextMenu.deviceId, channelContextMenu.channel, 'main')}
          onSubStream={() => assignToSelectedOrFirstEmptyTile(channelContextMenu.deviceId, channelContextMenu.channel, 'sub')}
        />
      )}

      {renamingChannel && (
        <RenameChannelDialog
          currentLabel={renamingChannel.currentLabel}
          onCancel={() => setRenamingChannel(null)}
          onSave={async (label) => {
            await renameChannel(renamingChannel.deviceId, renamingChannel.channel, label);
            setRenamingChannel(null);
          }}
        />
      )}
    </div>
  );
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

function SidebarSectionHeader({
  title,
  collapsed,
  onToggle,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        padding: '0.35rem 0.5rem',
        cursor: 'pointer',
        fontSize: '10.5px',
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: theme.textFaint,
      }}
    >
      <span style={{ fontSize: '9px', width: '9px' }}>{collapsed ? '▸' : '▾'}</span>
      {title}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}

function ToolbarIconButton({
  title,
  disabled,
  danger,
  active,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  // Used for "close all channels" so it visually stands out from the
  // neutral tool icons around it, rather than blending in as just another
  // gray icon for an action that affects the whole grid at once.
  danger?: boolean;
  // Used for the layout-picker icon while its popup is open — a persistent
  // highlight rather than just the transient hover color, so it's clear
  // which icon that popup belongs to.
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const restColor = disabled ? theme.textFaint : danger ? theme.danger : active ? theme.accentHover : theme.textMuted;
  const hoverColor = danger ? theme.danger : theme.text;
  const style: CSSProperties = {
    width: '26px',
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    border: 'none',
    background: active ? theme.accentFaint : 'none',
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
