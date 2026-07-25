import * as os from 'os';
import type { SystemStats } from '../../shared/types';

function cpuTimesSnapshot(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

// os.cpus() times are cumulative since boot, not a live percentage — CPU
// usage has to be derived by diffing two snapshots taken apart in time.
// This keeps the previous snapshot around so each call to getStats() diffs
// against the last one, rather than needing a synchronous sleep.
let previousSnapshot = cpuTimesSnapshot();

function cpuPercent(): number {
  const current = cpuTimesSnapshot();
  const idleDelta = current.idle - previousSnapshot.idle;
  const totalDelta = current.total - previousSnapshot.total;
  previousSnapshot = current;
  if (totalDelta <= 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}

function memPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

export function getStats(): SystemStats {
  return { cpuPercent: cpuPercent(), memPercent: memPercent() };
}

let statsTimer: ReturnType<typeof setInterval> | null = null;

export function startStatsBroadcast(send: (stats: SystemStats) => void): void {
  if (statsTimer) return;
  statsTimer = setInterval(() => send(getStats()), 2000);
}

export function stopStatsBroadcast(): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}
