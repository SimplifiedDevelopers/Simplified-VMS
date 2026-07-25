import { theme } from '../theme';
import { Modal } from './Modal';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = 'Yes', onCancel, onConfirm }: Props) {
  return (
    <Modal width={380} onDismiss={onCancel}>
      <div style={{ padding: '1.25rem 1.5rem 1rem', borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>{title}</span>
      </div>
      <div style={{ padding: '1.5rem', display: 'flex', gap: '0.9rem', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '22px', lineHeight: 1, color: theme.warning }}>&#9888;</span>
        <span style={{ fontSize: '13.5px', color: theme.text, lineHeight: 1.5 }}>{message}</span>
      </div>
      <div
        style={{
          padding: '0 1.5rem 1.5rem',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.6rem',
        }}
      >
        <button onClick={onCancel} style={secondaryButtonStyle}>
          No
        </button>
        <button onClick={onConfirm} style={primaryButtonStyle}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

const primaryButtonStyle = {
  padding: '0.5rem 1.1rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: '#04201c',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle = {
  padding: '0.5rem 1.1rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '13px',
  cursor: 'pointer',
};
