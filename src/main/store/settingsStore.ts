import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';

// The installed app's own folder (the directory containing the .exe) —
// deliberately NOT app.getAppPath()/process.resourcesPath, which point
// inside resources/app.asar. In dev mode app.getPath('exe') resolves to
// node_modules/electron/dist, which isn't a sensible place to create
// user-facing folders, so dev falls back to the project root instead.
function installDir(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : process.cwd();
}

function defaultMediaPath(subfolder: string): string {
  return join(installDir(), 'Media', subfolder);
}

// A function (not a static object) since it calls Electron path APIs —
// evaluating those once at module load, before the app is fully set up,
// risks a stale/wrong install directory; computing fresh on every call
// costs nothing (just string joins).
function getDefaults(): AppSettings {
  return {
    hardwareAcceleration: true,
    univiewGpuDecode: true,
    themeMode: 'dark',
    autoConnectAllDevices: true,
    restoreLiveViewOnStart: false,
    playMode: 'balanced',
    defaultStreamType: 'sub',
    playbackQuality: 'hd',
    playMainStreamInSingleView: true,
    snapshotPath: defaultMediaPath('Snapshot'),
    exportPath: defaultMediaPath('Video Backup'),
    localRecordingPath: defaultMediaPath('Local Recording'),
  };
}

// Physically creates Media/Snapshot, Media/Local Recording, and
// Media/Video Backup next to the installed app so they exist right away
// rather than only appearing the first time each feature actually saves
// something — called once at startup (see main/index.ts). Snapshot/
// Recording/Export already mkdirSync(..., {recursive:true}) their target
// folder on every save regardless, so this is a head start, not something
// those features depend on.
export function ensureDefaultMediaFolders(): void {
  const defaults = getDefaults();
  for (const p of [defaults.snapshotPath, defaults.exportPath, defaults.localRecordingPath]) {
    mkdirSync(p, { recursive: true });
  }
}

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
  const defaults = getDefaults();
  if (!existsSync(path)) return defaults;
  try {
    const merged = { ...defaults, ...JSON.parse(readFileSync(path, 'utf-8')) } as AppSettings;
    // Before this change, snapshotPath/exportPath/localRecordingPath
    // defaulted to '' and writeSettings persists the FULL settings object
    // on every change - so an existing install that's touched any setting
    // at all already has these three baked into settings.json as literal
    // empty strings, which would otherwise permanently shadow the new
    // Media/* defaults above. An empty string here has only ever meant
    // "not configured" for these three fields, never a deliberate value,
    // so treat it as still unset and fall back to the real default.
    if (!merged.snapshotPath) merged.snapshotPath = defaults.snapshotPath;
    if (!merged.exportPath) merged.exportPath = defaults.exportPath;
    if (!merged.localRecordingPath) merged.localRecordingPath = defaults.localRecordingPath;
    return merged;
  } catch {
    return defaults;
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
