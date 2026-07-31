import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { theme } from '../theme';

interface Props {
  onLoggedIn: () => void;
  // False right after an explicit logout (see AppShell.tsx's handleLogout)
  // - stops a saved Auto Login from instantly re-authenticating past the
  // login screen the user just deliberately returned to. This is the exact
  // bug that sank an earlier, cruder version of Auto Login in this app (see
  // the removal note that used to live in AppShell.tsx) - true on every
  // other render, including a fresh app launch.
  allowAutoLogin?: boolean;
}

export function Login({ onLoggedIn, allowAutoLogin = true }: Props) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [savePassword, setSavePassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.ssmVms.prefs.getSavedLogin().then((saved) => {
      if (cancelled) return;
      if (saved) {
        setUsername(saved.username);
        setPassword(saved.password);
        setSavePassword(true);
        setAutoLogin(saved.autoLogin);
        if (saved.autoLogin && allowAutoLogin) {
          attemptLogin(saved.username, saved.password, true, true);
          setReady(true);
          return;
        }
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function attemptLogin(u: string, p: string, save: boolean, auto: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ok = await window.ssmVms.auth.login(u, p);
      if (!ok) {
        setError('Incorrect username or password.');
        return;
      }
      if (save) {
        await window.ssmVms.prefs.saveLogin(u, p, auto);
      } else {
        await window.ssmVms.prefs.clearSavedLogin();
      }
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    attemptLogin(username, password, savePassword, savePassword && autoLogin);
  }

  if (!ready) return null;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <h1 style={{ fontSize: '17px', fontWeight: 600, color: theme.text, margin: '0 0 0.5rem' }}>Sign in</h1>

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

      <div style={{ display: 'flex', gap: '1.2rem' }}>
        <Checkbox
          label="Save password"
          checked={savePassword}
          onChange={(checked) => {
            setSavePassword(checked);
            // Auto login is meaningless without a saved password - keep the
            // two in sync rather than letting the UI show a checked Auto
            // login next to an unchecked Save password.
            if (!checked) setAutoLogin(false);
          }}
        />
        <Checkbox label="Auto login" checked={autoLogin} onChange={setAutoLogin} disabled={!savePassword} />
      </div>

      {error && <div style={{ fontSize: '12.5px', color: theme.danger }}>{error}</div>}

      <button type="submit" disabled={busy} style={primaryButtonStyle}>
        {busy ? 'Signing in…' : 'Login'}
      </button>
    </form>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        fontSize: '12px',
        color: disabled ? theme.textFaint : theme.textMuted,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: theme.accent }}
      />
      {label}
    </label>
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
  width: '100%',
  boxSizing: 'border-box',
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
