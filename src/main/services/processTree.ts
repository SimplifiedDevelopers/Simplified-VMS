import { execFile, type ChildProcess } from 'child_process';

// Shared between onvif.ts (its RTSP-decode ffmpeg) and clipExporter.ts (its
// encode ffmpeg) — plain SIGTERM/.kill() doesn't reliably tear down
// ffmpeg's process tree on Windows, taskkill /T (tree) /F (force) does.
export function killProcessTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) {
      resolve();
      return;
    }
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => resolve());
  });
}
