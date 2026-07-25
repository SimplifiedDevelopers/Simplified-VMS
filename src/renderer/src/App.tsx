import { useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { VideoTile } from './VideoTile';

interface FormState {
  host: string;
  port: string;
  username: string;
  password: string;
  channel: string;
}

const initialForm: FormState = {
  host: '',
  port: '8000',
  username: 'admin',
  password: '',
  channel: '1',
};

export function App() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [viewHandle, setViewHandle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const field =
    (key: keyof FormState) =>
    (e: ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function handleLogin(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await window.vms.login('hikvision', {
        host: form.host,
        port: Number(form.port),
        username: form.username,
        password: form.password,
      });
      setSessionId(session.sessionId);
      const handle = await window.vms.startLiveView(session.sessionId, Number(form.channel), 'main');
      setViewHandle(handle);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (sessionId && viewHandle) {
    return (
      <div style={{ height: '100vh', background: '#111', padding: '1rem', boxSizing: 'border-box' }}>
        <VideoTile sessionId={sessionId} viewHandle={viewHandle} />
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#111',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <form
        onSubmit={handleLogin}
        style={{
          width: '320px',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          padding: '1.5rem',
          borderRadius: '8px',
          border: '1px solid #333',
          background: '#1a1a1a',
        }}
      >
        <h1 style={{ fontSize: '16px', color: '#eee', margin: '0 0 0.5rem' }}>SSM VMS — Hikvision</h1>

        <input placeholder="Host / IP" value={form.host} onChange={field('host')} style={inputStyle} required />
        <input placeholder="Port" value={form.port} onChange={field('port')} style={inputStyle} required />
        <input placeholder="Username" value={form.username} onChange={field('username')} style={inputStyle} required />
        <input
          placeholder="Password"
          type="password"
          value={form.password}
          onChange={field('password')}
          style={inputStyle}
          required
        />
        <input placeholder="Channel" value={form.channel} onChange={field('channel')} style={inputStyle} required />

        <button type="submit" disabled={busy} style={buttonStyle}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>

        {error && <div style={{ color: '#f66', fontSize: '13px' }}>{error}</div>}
      </form>
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: '0.5rem',
  borderRadius: '4px',
  border: '1px solid #333',
  background: '#0d0d0d',
  color: '#eee',
  fontSize: '14px',
};

const buttonStyle: CSSProperties = {
  padding: '0.6rem',
  borderRadius: '4px',
  border: 'none',
  background: '#2563eb',
  color: '#fff',
  fontSize: '14px',
  cursor: 'pointer',
};
