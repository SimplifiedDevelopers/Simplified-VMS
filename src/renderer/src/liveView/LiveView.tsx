import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import type { StoredDevice } from '../../../shared/types';
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

export function LiveView() {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(4);
  const [tiles, setTiles] = useState<Record<number, TileState>>({});
  const [assigning, setAssigning] = useState<number | null>(null);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;

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

  async function assign(tileIndex: number, deviceId: string, channel: number): Promise<void> {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;
    setAssigning(null);
    setTiles((prev) => ({
      ...prev,
      [tileIndex]: { deviceId, deviceName: device.name, channel, viewHandle: null, error: null },
    }));
    try {
      const streamType = layout === 1 ? 'main' : 'sub';
      const viewHandle = await window.ssmVms.liveView.start(deviceId, channel, streamType);
      setTiles((prev) => ({ ...prev, [tileIndex]: { ...prev[tileIndex], viewHandle } }));
    } catch (err) {
      setTiles((prev) => ({
        ...prev,
        [tileIndex]: { ...prev[tileIndex], error: err instanceof Error ? err.message : String(err) },
      }));
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
  }

  async function changeLayout(next: (typeof LAYOUTS)[number]): Promise<void> {
    await Promise.all(
      Object.entries(tiles).map(([, tile]) =>
        tile.viewHandle ? window.ssmVms.liveView.stop(tile.deviceId, tile.viewHandle) : Promise.resolve(),
      ),
    );
    setTiles({});
    setLayout(next);
  }

  const columns = Math.ceil(Math.sqrt(layout));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
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
            <div key={i} style={{ position: 'relative', background: '#000', minHeight: 0 }}>
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

      {assigning !== null && (
        <AssignDeviceDialog
          devices={devices}
          onCancel={() => setAssigning(null)}
          onAssign={(deviceId, channel) => assign(assigning, deviceId, channel)}
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
