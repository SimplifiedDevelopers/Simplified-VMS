import { theme } from '../theme';
import { Modal } from '../components/Modal';
import { popupInputStyle, searchButtonStyle, secondaryButtonStyle } from './PlaybackControls';

interface Props {
  date: string;
  onDateChange: (date: string) => void;
  startTime: string;
  onStartTimeChange: (time: string) => void;
  endTime: string;
  onEndTimeChange: (time: string) => void;
  invalid: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// Extracted from Playback.tsx verbatim - same JSX, same styling.
export function SearchByTimePopup({
  date,
  onDateChange,
  startTime,
  onStartTimeChange,
  endTime,
  onEndTimeChange,
  invalid,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Modal width={320} onDismiss={onCancel}>
      <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>Search by Time</div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '11.5px', color: theme.textMuted }}>Date</span>
          <input type="date" value={date} onChange={(e) => onDateChange(e.target.value)} style={popupInputStyle} />
        </label>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1 }}>
            <span style={{ fontSize: '11.5px', color: theme.textMuted }}>Start Time</span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => onStartTimeChange(e.target.value)}
              style={popupInputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1 }}>
            <span style={{ fontSize: '11.5px', color: theme.textMuted }}>End Time</span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => onEndTimeChange(e.target.value)}
              style={popupInputStyle}
            />
          </label>
        </div>
        {invalid && <span style={{ fontSize: '11px', color: theme.danger }}>End time must be after start time.</span>}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={onCancel} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={invalid}
            style={{
              ...searchButtonStyle,
              opacity: invalid ? 0.5 : 1,
              cursor: invalid ? 'not-allowed' : 'pointer',
            }}
          >
            Search
          </button>
        </div>
      </div>
    </Modal>
  );
}
