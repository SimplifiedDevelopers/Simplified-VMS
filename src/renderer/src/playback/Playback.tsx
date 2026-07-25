import { useEffect, useState } from 'react';
import { theme } from '../theme';
import type { StoredDevice } from '../../../shared/types';

const LAYOUTS = [1, 4, 9] as const;

export function Playback() {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]>(4);

  useEffect(() => {
    window.ssmVms.devices.list().then((list) => {
      setDevices(list);
      setSelectedDeviceId(list[0]?.id ?? null);
    });
  }, []);

  const columns = Math.ceil(Math.sqrt(layout));

  return (
    <div style={{ height: '100%', display: 'flex' }}>
      <div
        style={{
          width: '240px',
          flexShrink: 0,
          borderRight: `1px solid ${theme.border}`,
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          overflowY: 'auto',
        }}
      >
        <div>
          <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '0.4rem' }}>DEVICE</div>
          <select
            value={selectedDeviceId ?? ''}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            style={selectStyle}
          >
            {devices.length === 0 && <option value="">No devices yet</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '0.4rem' }}>DATE</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={selectStyle} />
        </div>

        <button disabled style={{ ...searchButtonStyle, opacity: 0.5, cursor: 'not-allowed' }} title="Playback backend not built yet">
          Search
        </button>

        <div style={{ fontSize: '11px', color: theme.textFaint, lineHeight: 1.5, marginTop: 'auto' }}>
          Playback isn't wired to a device yet — this is the UI shell, ready for when the recording-search backend
          lands.
        </div>
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
              onClick={() => setLayout(n)}
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
          {Array.from({ length: layout }).map((_, i) => (
            <div
              key={i}
              style={{
                background: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: theme.textFaint,
                fontSize: '11px',
              }}
            >
              No recording loaded
            </div>
          ))}
        </div>

        <div style={{ borderTop: `1px solid ${theme.border}`, padding: '0.6rem 0.9rem' }}>
          <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.5rem', opacity: 0.4 }}>
            {['⏮', '▶', '⏹', '⏭'].map((glyph) => (
              <span key={glyph} style={{ fontSize: '14px', color: theme.textMuted }}>
                {glyph}
              </span>
            ))}
          </div>
          <div
            style={{
              height: '22px',
              borderRadius: '3px',
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              position: 'relative',
              opacity: 0.5,
            }}
          >
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
              00:00 — 24:00 timeline (coming soon)
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const selectStyle = {
  width: '100%',
  padding: '0.45rem 0.55rem',
  borderRadius: '5px',
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.text,
  fontSize: '12.5px',
  boxSizing: 'border-box' as const,
};

const searchButtonStyle = {
  padding: '0.5rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: '#04201c',
  fontSize: '12.5px',
  fontWeight: 600,
};
