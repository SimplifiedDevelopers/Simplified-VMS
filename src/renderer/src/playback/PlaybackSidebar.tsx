import type { ReactNode } from 'react';
import { theme } from '../theme';
import { searchButtonStyle } from './PlaybackControls';
import { FILTER_OPTIONS, statusColor, statusLabel } from './playbackModel';
import type {
  ChannelInfo,
  DeviceConnectionStatus,
  RecordingSearchFilter,
  StoredDevice,
} from '../../../shared/types';

interface Props {
  devices: StoredDevice[];
  expandedDeviceId: string | null;
  onToggleExpandDevice: (deviceId: string) => void;
  loadingChannelsFor: string | null;
  channelErrors: Record<string, string | null>;
  channelsByDevice: Record<string, ChannelInfo[]>;
  onAssignChannel: (deviceId: string, channel: number) => void;
  statusById: Record<string, DeviceConnectionStatus | undefined>;
  filters: RecordingSearchFilter[];
  onToggleFilter: (value: RecordingSearchFilter) => void;
  selectedDeviceId: string | null;
  selectedChannel: number | null;
  onOpenSearchByTime: () => void;
  // Kept as a render prop (not imported directly) so this component doesn't
  // need to know MiniCalendar's own implementation, only where it slots in.
  calendar: ReactNode;
}

// The left device tree / recording-type filter / calendar / Search by Time
// sidebar — extracted from Playback.tsx verbatim (same JSX, same styling),
// just given its own file and a props boundary instead of reaching directly
// into the parent's state and handlers.
export function PlaybackSidebar({
  devices,
  expandedDeviceId,
  onToggleExpandDevice,
  loadingChannelsFor,
  channelErrors,
  channelsByDevice,
  onAssignChannel,
  statusById,
  filters,
  onToggleFilter,
  onOpenSearchByTime,
  selectedDeviceId,
  selectedChannel,
  calendar,
}: Props) {
  return (
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
              onClick={() => onToggleExpandDevice(device.id)}
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
                    onClick={() => onAssignChannel(device.id, ch.channel)}
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
                onChange={() => onToggleFilter(opt.value)}
                style={{ width: '13px', height: '13px', accentColor: theme.accent, cursor: 'pointer', flexShrink: 0 }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      {calendar}

      <button
        onClick={onOpenSearchByTime}
        disabled={!selectedDeviceId || selectedChannel === null}
        style={{
          ...searchButtonStyle,
          opacity: !selectedDeviceId || selectedChannel === null ? 0.5 : 1,
          cursor: !selectedDeviceId || selectedChannel === null ? 'not-allowed' : 'pointer',
        }}
      >
        Search by Time
      </button>
    </div>
  );
}
