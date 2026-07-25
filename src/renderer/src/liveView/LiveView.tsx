import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { theme } from '../theme';
import type { ChannelInfo, DeviceConnectionStatus, StoredDevice, StreamType, SystemStats } from '../../../shared/types';
import { VideoCanvas } from './VideoCanvas';
import { AssignDeviceDialog } from './AssignDeviceDialog';

interface TileState {
  deviceId: string;
  deviceName: string;
  channel: number;
  viewHandle: string | null;
  error: string | null;
}

const LAYOUTS = [1, 4, 9, 16, 25, 36, 64] as const;

interface DragPayload {
  type: 'device' | 'channel';
  deviceId: string;
  channel?: number;
}

export function LiveView() {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(4);
  const [tiles, setTiles] = useState<Record<number, TileState>>({});
  const [assigning, setAssigning] = useState<number | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [channelsByDevice, setChannelsByDevice] = useState<Record<string, ChannelInfo[]>>({});
  const [loadingChannelsFor, setLoadingChannelsFor] = useState<string | null>(null);
  const [channelErrors, setChannelErrors] = useState<Record<string, string | null>>({});
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const channelsRef = useRef(channelsByDevice);
  channelsRef.current = channelsByDevice;
  const playAllChannelsTokenRef = useRef(0);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statusById, setStatusById] = useState<Record<string, DeviceConnectionStatus | undefined>>({});
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

  useEffect(() => {
    window.ssmVms.devices.list().then((list) => {
      setDevices(list);
      list.forEach((device) => {
        window.ssmVms.devices.getStatus(device.id).then((status) => {
          setStatusById((prev) => ({ ...prev, [device.id]: status }));
        });
      });
    });
  }, []);

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
    return () => {
      Object.values(tilesRef.current).forEach((tile) => {
        if (tile.viewHandle) window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle);
      });
    };
  }, []);

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
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return false;
    setAssigning(null);
    const existing = tilesRef.current[tileIndex];
    if (existing?.viewHandle) {
      window.ssmVms.liveView.stop(existing.deviceId, existing.viewHandle);
    }
    setTiles((prev) => ({
      ...prev,
      [tileIndex]: { deviceId, deviceName: device.name, channel, viewHandle: null, error: null },
    }));
    try {
      const viewHandle = await window.ssmVms.liveView.start(deviceId, channel, streamType);
      setTiles((prev) => ({ ...prev, [tileIndex]: { ...prev[tileIndex], viewHandle } }));
      return true;
    } catch (err) {
      setTiles((prev) => ({
        ...prev,
        [tileIndex]: { ...prev[tileIndex], error: err instanceof Error ? err.message : String(err) },
      }));
      return false;
    }
  }

  // A selected tile (single-clicked in the grid) takes priority as the
  // target — otherwise falls back to the first empty tile, same as before.
  function assignToSelectedOrFirstEmptyTile(deviceId: string, channel: number): void {
    const streamType: StreamType = layout === 1 ? 'main' : 'sub';
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
    const token = ++playAllChannelsTokenRef.current;

    let channels: ChannelInfo[];
    try {
      channels = await ensureChannels(deviceId);
    } catch (err) {
      if (token !== playAllChannelsTokenRef.current) return;
      setChannelErrors((prev) => ({ ...prev, [deviceId]: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (token !== playAllChannelsTokenRef.current) return;
    if (channels.length === 0) return;
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;

    const neededLayout = LAYOUTS.find((n) => n >= channels.length) ?? LAYOUTS[LAYOUTS.length - 1];
    const streamType: StreamType = neededLayout === 1 ? 'main' : 'sub';

    await Promise.all(
      Object.values(tilesRef.current).map((tile) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    if (token !== playAllChannelsTokenRef.current) return;
    setTiles({});
    setLayout(neededLayout);
    setSelectedTileIndex(null);
    setExpandedTileIndex(null);

    // Firing every channel's startLiveView back-to-back with no gap
    // overwhelmed a real Uniview NVR's per-stream session/key negotiation -
    // confirmed live: calls failed with NETDEV_E_INVALID_PARAM and an
    // undocumented error 60067 (one below the SDK's own documented
    // NETDEV_E_PUBLICKEYFAIL=60068, pointing at a security/key handshake
    // resource that can't be reused too quickly). The 300ms stagger below
    // (plus the per-session native mutex) fixed the app freeze/crash this
    // used to cause, but individual channels can still fail on their first
    // attempt while the device is under load from opening many streams at
    // once. Rather than giving up on the rest of the grid the moment that
    // happens (which was leaving several channels permanently unopened even
    // though they'd have worked fine on their own), every channel gets
    // attempted, and whichever ones failed get one retry pass after a
    // cool-down long enough for the device's negotiation backlog to clear.
    const channelsToPlay = channels.slice(0, neededLayout);

    async function attemptPass(indices: number[]): Promise<number[]> {
      const failed: number[] = [];
      for (const i of indices) {
        if (token !== playAllChannelsTokenRef.current) return [];
        const ok = await assign(i, deviceId, channelsToPlay[i].channel, streamType);
        if (token !== playAllChannelsTokenRef.current) return [];
        if (!ok) failed.push(i);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return failed;
    }

    const firstPassFailures = await attemptPass(channelsToPlay.map((_, i) => i));
    if (token !== playAllChannelsTokenRef.current) return;
    if (firstPassFailures.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (token !== playAllChannelsTokenRef.current) return;
      await attemptPass(firstPassFailures);
    }
  }

  async function clearTile(tileIndex: number): Promise<void> {
    const tile = tiles[tileIndex];
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

  async function changeLayout(next: (typeof LAYOUTS)[number]): Promise<void> {
    await Promise.all(
      Object.values(tiles).map((tile) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    setTiles({});
    setLayout(next);
    setSelectedTileIndex(null);
    setExpandedTileIndex(null);
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
    if (data.type === 'device') {
      playAllChannels(data.deviceId);
    } else if (data.type === 'channel' && data.channel !== undefined) {
      const streamType: StreamType = layout === 1 ? 'main' : 'sub';
      assign(tileIndex, data.deviceId, data.channel, streamType);
    }
  }

  const columns = Math.ceil(Math.sqrt(layout));
  const rows = Math.ceil(layout / columns);
  const displayIndices = expandedTileIndex !== null ? [expandedTileIndex] : Array.from({ length: layout }, (_, i) => i);
  const gridColumns = expandedTileIndex !== null ? 1 : columns;
  const gridRows = expandedTileIndex !== null ? 1 : rows;

  function renderTile(i: number) {
    const tile = tiles[i];
    const isSelected = selectedTileIndex === i;
    const isExpanded = expandedTileIndex === i;
    return (
      <div
        key={i}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleTileDrop(i, e)}
        onClick={() => setSelectedTileIndex((prev) => (prev === i ? null : i))}
        onDoubleClick={() => {
          if (!tile) return;
          setExpandedTileIndex((prev) => (prev === i ? null : i));
        }}
        style={{
          position: 'relative',
          background: '#000',
          minHeight: 0,
          cursor: 'pointer',
          // outline (not border) so the highlight never nudges the grid's
          // precise pixel sizing — that broke once already (the
          // gridTemplateRows fix) and outline doesn't participate in the
          // box model the way border does.
          outline: isSelected ? `2px solid ${theme.accent}` : 'none',
          outlineOffset: '-2px',
        }}
      >
        {!tile && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAssigning(i);
            }}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              background: 'transparent',
              color: theme.textFaint,
              fontSize: '26px',
              cursor: 'pointer',
            }}
          >
            +
          </button>
        )}

        {tile && (
          <>
            {tile.viewHandle && <VideoCanvas viewHandle={tile.viewHandle} />}
            {!tile.viewHandle && !tile.error && (
              <Centered>
                <span style={{ color: theme.textMuted, fontSize: '12px' }}>Connecting…</span>
              </Centered>
            )}
            {tile.error && (
              <Centered>
                <span style={{ color: theme.danger, fontSize: '11.5px', textAlign: 'center', padding: '0 1rem' }}>
                  {tile.error}
                </span>
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
              <span>
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
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '13px' }}
              >
                &times;
              </button>
            </div>
          </>
        )}
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

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            {LAYOUTS.map((n) => (
              <button
                key={n}
                title={`${n === 1 ? 'Single' : `${n}-channel`} layout`}
                onClick={() => changeLayout(n)}
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '4px',
                  border: `1px solid ${n === layout ? theme.accent : theme.border}`,
                  background: n === layout ? `${theme.accent}1f` : 'transparent',
                  color: n === layout ? theme.accentHover : theme.textMuted,
                  fontSize: '11.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {n}
              </button>
            ))}
          </div>

          <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.2rem 0.35rem', background: theme.border }} />

          <ToolbarIconButton title="Audio — coming soon" disabled>
            &#128266;
          </ToolbarIconButton>
          <ToolbarIconButton title="Snapshot — coming soon" disabled>
            &#128247;
          </ToolbarIconButton>

          <div style={{ flex: 1 }} />

          <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            CPU
            <strong style={{ color: theme.textMuted, fontWeight: 600 }}>
              {stats ? `${stats.cpuPercent}%` : '—'}
            </strong>
          </span>
          <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            Memory
            <strong style={{ color: theme.textMuted, fontWeight: 600 }}>
              {stats ? `${stats.memPercent}%` : '—'}
            </strong>
          </span>
        </div>
      </div>

      {assigning !== null && (
        <AssignDeviceDialog
          devices={devices}
          onCancel={() => setAssigning(null)}
          onAssign={(deviceId, channel) => assign(assigning, deviceId, channel, layout === 1 ? 'main' : 'sub')}
        />
      )}
    </div>
  );
}

function statusColor(status: DeviceConnectionStatus | undefined): string {
  if (!status || status.state === 'connecting') return theme.warning;
  return status.state === 'online' ? theme.success : theme.danger;
}

function statusLabel(status: DeviceConnectionStatus | undefined): string {
  if (!status || status.state === 'connecting') return 'Connecting…';
  return status.state === 'online' ? 'Online' : `Offline — ${status.error}`;
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
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    width: '26px',
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    border: 'none',
    background: 'none',
    color: disabled ? theme.textFaint : theme.textMuted,
    fontSize: '13px',
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
        if (!disabled) e.currentTarget.style.color = theme.text;
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.color = theme.textMuted;
      }}
    >
      {children}
    </button>
  );
}
