import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';

const DEFAULTS: AppSettings = {
  hardwareAcceleration: true,
  univiewGpuDecode: true,
  themeMode: 'dark',
  autoConnectAllDevices: true,
  restoreLiveViewOnStart: false,
  playMode: 'balanced',
  defaultStreamType: 'sub',
  playbackQuality: 'hd',
  playMainStreamInSingleView: true,
  snapshotPath: '',
  exportPath: '',
  localRecordingPath: '',
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

// Lets index.ts broadcast a settings change to every open window (main +
// any popped-out tabs), same shape as connectionManager's onStatusChange —
// needed because each BrowserWindow is a separate renderer that only ever
// read settings once at its own mount time (see App.tsx), so without this a
// popped-out tab's theme (or any other setting) goes stale the moment it's
// changed from a different window, confirmed live: toggling light/dark in
// the main window never updated an already-open detached Live View tab.
const listeners = new Set<(settings: AppSettings) => void>();

export function onSettingsChange(listener: (settings: AppSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSettings(): AppSettings {
  const path = filePath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf-8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(partial: Partial<AppSettings>): AppSettings {
  const merged = { ...readSettings(), ...partial };
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), 'utf-8');
  for (const listener of listeners) listener(merged);
  return merged;
}
