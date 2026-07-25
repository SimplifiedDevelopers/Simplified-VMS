import { useState, type CSSProperties, type FormEvent } from 'react';
import { theme } from '../theme';
import { passwordStrength } from '../lib/passwordStrength';
import { AuthLayout } from './AuthLayout';

interface Props {
  onCreated: () => void;
}

export function Setup({ onCreated }: Props) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = passwordStrength(password);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await window.ssmVms.auth.createAdmin(username.trim() || 'admin', password);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <h1 style={{ fontSize: '17px', fontWeight: 600, color: theme.text, margin: '0 0 0.25rem' }}>
          Create Super Administrator
        </h1>
        <p style={{ fontSize: '12.5px', color: theme.textMuted, margin: '0 0 0.5rem' }}>
          This account gates access to the app itself, separate from any camera credentials you add later.
        </p>

        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          style={inputStyle}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="Password"
          style={inputStyle}
          required
        />
        <StrengthMeter strength={strength} />
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          type="password"
          placeholder="Confirm password"
          style={inputStyle}
          required
        />

        {error && <div style={{ fontSize: '12.5px', color: theme.danger }}>{error}</div>}

        <button type="submit" disabled={busy} style={primaryButtonStyle}>
          {busy ? 'Creating…' : 'Next'}
        </button>
      </form>
    </AuthLayout>
  );
}

function StrengthMeter({ strength }: { strength: ReturnType<typeof passwordStrength> }) {
  const levels: Array<{ key: 'weak' | 'medium' | 'strong'; label: string; color: string }> = [
    { key: 'weak', label: 'Weak', color: theme.danger },
    { key: 'medium', label: 'Medium', color: theme.warning },
    { key: 'strong', label: 'Strong', color: theme.success },
  ];
  const activeIndex = levels.findIndex((l) => l.key === strength);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '-0.3rem' }}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {levels.map((level, i) => (
          <div
            key={level.key}
            style={{
              flex: 1,
              height: '4px',
              borderRadius: '2px',
              background: i <= activeIndex ? level.color : theme.surface,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {levels.map((level) => (
          <span
            key={level.key}
            style={{ fontSize: '10.5px', color: level.key === strength ? level.color : theme.textFaint }}
          >
            {level.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: '0.55rem 0.65rem',
  borderRadius: '5px',
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.text,
  fontSize: '13.5px',
  outline: 'none',
};

const primaryButtonStyle: CSSProperties = {
  marginTop: '0.5rem',
  padding: '0.65rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: theme.accentText,
  fontSize: '13.5px',
  fontWeight: 700,
  cursor: 'pointer',
};
