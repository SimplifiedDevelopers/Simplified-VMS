import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import type { ChannelInfo, StoredDevice, StreamType } from '../../../shared/types';
import { VideoCanvas } from './VideoCanvas';
import { AssignDeviceDialog } from './AssignDeviceDialog';

interface TileState {
  deviceId: string;
  deviceName: string;
  channel: number;
  viewHandle: string | null;
  error: string | null;
}

const LAYOUTS = [1, 4, 9, 16] as const;

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

  useEffect(() => {
    window.ssmVms.devices.list().then(setDevices);
  }, []);

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
  ): Promise<void> {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;
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
    } catch (err) {
      setTiles((prev) => ({
        ...prev,
        [tileIndex]: { ...prev[tileIndex], error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  function assignToFirstEmptyTile(deviceId: string, channel: number): void {
    const streamType: StreamType = layout === 1 ? 'main' : 'sub';
    for (let i = 0; i < layout; i++) {
      if (!tilesRef.current[i]) {
        assign(i, deviceId, channel, streamType);
        return;
      }
    }
  }

  async function playAllChannels(deviceId: string): Promise<void> {
    let channels: ChannelInfo[];
    try {
      channels = await ensureChannels(deviceId);
    } catch (err) {
      setChannelErrors((prev) => ({ ...prev, [deviceId]: err instanceof Error ? err.message : String(err) }));
      return;
    }
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
    setTiles({});
    setLayout(neededLayout);

    channels.slice(0, neededLayout).forEach((ch, i) => assign(i, deviceId, ch.channel, streamType));
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
  }

  async function changeLayout(next: (typeof LAYOUTS)[number]): Promise<void> {
    await Promise.all(
      Object.values(tiles).map((tile) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    setTiles({});
    setLayout(next);
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
                    onClick={() => assignToFirstEmptyTile(device.id, ch.channel)}
                    title="Click to play in the next open tile · drag onto a tile to place it there"
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
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.6rem 0.9rem',
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <span style={{ fontSize: '11.5px', color: theme.textMuted, marginRight: '0.3rem' }}>Layout</span>
          {LAYOUTS.map((n) => (
            <button
              key={n}
              onClick={() => changeLayout(n)}
              style={{
                padding: '0.3rem 0.6rem',
                borderRadius: '4px',
                border: `1px solid ${n === layout ? theme.accent : theme.border}`,
                background: n === layout ? `${theme.accent}1f` : 'transparent',
                color: n === layout ? theme.accent : theme.textMuted,
                fontSize: '11.5px',
                cursor: 'pointer',
              }}
            >
              {n}
            </button>
          ))}
        </div>

        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: '2px',
            background: theme.border,
            overflow: 'hidden',
          }}
        >
          {Array.from({ length: layout }).map((_, i) => {
            const tile = tiles[i];
            return (
              <div
                key={i}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleTileDrop(i, e)}
                style={{ position: 'relative', background: '#000', minHeight: 0 }}
              >
                {!tile && (
                  <button
                    onClick={() => setAssigning(i)}
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
                      </span>
                      <button
                        onClick={() => clearTile(i)}
                        style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '13px' }}
                      >
                        &times;
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}
