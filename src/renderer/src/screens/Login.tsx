import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { theme } from '../theme';
import { AuthLayout } from './AuthLayout';

interface Props {
  onLoggedIn: () => void;
}

export function Login({ onLoggedIn }: Props) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [savePassword, setSavePassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
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
        if (saved.autoLogin) {
          attemptLogin(saved.username, saved.password, true, saved.autoLogin);
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
        setReady(true);
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
      setReady(true);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    attemptLogin(username, password, savePassword, autoLogin);
  }

  if (!ready) return <AuthLayout><div /></AuthLayout>;

  return (
    <AuthLayout>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <h1 style={{ fontSize: '17px', fontWeight: 600, color: theme.text, margin: '0 0 0.5rem' }}>Sign in</h1>

        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          style={inputStyle}
        />
        <div style={{ position: 'relative' }}>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Password"
            style={inputStyle}
            required
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <Checkbox label="Save password" checked={savePassword} onChange={setSavePassword} />
            <Checkbox
              label="Auto login"
              checked={autoLogin}
              onChange={(v) => {
                setAutoLogin(v);
                if (v) setSavePassword(true);
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => setShowForgot((v) => !v)}
            style={{ background: 'none', border: 'none', color: theme.accentHover, fontSize: '12px', cursor: 'pointer', padding: 0 }}
          >
            Forgot password?
          </button>
        </div>

        {showForgot && (
          <div style={{ fontSize: '11.5px', color: theme.textMuted, lineHeight: 1.5 }}>
            This account only exists on this computer — there's no remote recovery. Ask whoever set up this
            installation to reset it, or reinstall if this is a fresh setup.
          </div>
        )}

        {error && <div style={{ fontSize: '12.5px', color: theme.danger }}>{error}</div>}

        <button type="submit" disabled={busy} style={primaryButtonStyle}>
          {busy ? 'Signing in…' : 'Login'}
        </button>
      </form>
    </AuthLayout>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '12px', color: theme.textMuted, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: theme.accent }} />
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
