import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../../shared/types';

// Manual-only, per the office's explicit preference — no periodic background
// polling for updates, so autoDownload/autoInstallOnAppQuit both stay off
// and every step (check, download, install) is a distinct user action
// triggered from Settings > About.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

export function startUpdateStatusBroadcast(send: (status: UpdateStatus) => void): void {
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'not-available' }));
  autoUpdater.on('download-progress', (progress) =>
    send({ state: 'downloading', percent: Math.round(progress.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => send({ state: 'downloaded', version: info.version }));
  // Covers both real check/download failures and the expected local-dev case
  // (running via `npm run dev`/`start` instead of an installed build) where
  // electron-updater refuses to check because the app isn't packaged.
  autoUpdater.on('error', (err) => send({ state: 'error', message: err.message }));
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch(() => {
    // Already surfaced to the renderer via the 'error' listener above.
  });
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch(() => {
    // Already surfaced to the renderer via the 'error' listener above.
  });
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
