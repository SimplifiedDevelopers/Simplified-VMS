import { useEffect, useState } from 'react';
import { Splash } from './screens/Splash';
import { Setup } from './screens/Setup';
import { Login } from './screens/Login';
import { AppShell } from './shell/AppShell';

type Phase = 'splash' | 'setup' | 'login' | 'app';

export function App() {
  const [phase, setPhase] = useState<Phase>('splash');
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    window.ssmVms.auth.status().then((status) => setHasAdmin(status.hasAdminAccount));
  }, []);

  useEffect(() => {
    if (splashDone && hasAdmin !== null) {
      setPhase(hasAdmin ? 'login' : 'setup');
    }
  }, [splashDone, hasAdmin]);

  if (phase === 'splash') {
    return <Splash onDone={() => setSplashDone(true)} />;
  }
  if (phase === 'setup') {
    return <Setup onCreated={() => setPhase('login')} />;
  }
  if (phase === 'login') {
    return <Login onLoggedIn={() => setPhase('app')} />;
  }
  return <AppShell onLoggedOut={() => setPhase('login')} />;
}
