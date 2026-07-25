import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../theme';

interface Props {
  children: ReactNode;
  width?: number;
  onDismiss?: () => void;
}

export function Modal({ children, width = 420, onDismiss }: Props) {
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss?.();
      }}
      style={backdropStyle}
    >
      <div style={{ ...panelStyle, width }}>{children}</div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const panelStyle: CSSProperties = {
  background: theme.panel,
  border: `1px solid ${theme.border}`,
  borderRadius: '8px',
  boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
};
