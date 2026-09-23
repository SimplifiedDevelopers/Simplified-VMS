import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';

// Previously rooted at the installed app's own folder (dirname of the
// .exe) - confirmed live as a real bug: a per-machine install lands in
// Program Files, which a standard (non-admin) user has no write access to
// at all. The very first launch after any fresh install/update tried to
// mkdirSync these folders there, threw an unhandled EPERM before the
// window was ever created (no crash, no window, nothing in Event Viewer -
// a clean JS-level failure with no attached console to show it), and
// silently killed startup. Running once as Administrator created the
// folders, after which every future launch found them already there and
// never touched Program Files again - explains exactly why only the
// first run after an install/update ever needed elevation. Documents is
// always writable by the current user without elevation, and is a more
// discoverable place for staff to find their own snapshots/recordings
// anyway than digging into the app's own Program Files install folder.
function defaultMediaPath(subfolder: string): string {
  return join(app.getPath('documents'), 'Simplified VMS', subfolder);
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

// Physically creates Snapshot/Video Backup/Local Recording under
// Documents/Simplified VMS so they exist right away rather than only
// appearing the first time each feature actually saves something — called
// once at startup (see main/index.ts). Snapshot/Recording/Export already
// mkdirSync(..., {recursive:true}) their target folder on every save
// regardless, so this is only ever a head start, never something those
// features depend on - each folder is created independently and a
// failure here is swallowed rather than thrown, so a bad path (this
// used to default inside Program Files, unwritable without admin - see
// defaultMediaPath's doc comment - or a user-customized path on a
// removable/network drive that isn't currently available) can never again
// silently kill the rest of startup before the window is even created,
// the way it did before this was caught.
export function ensureDefaultMediaFolders(): void {
  const defaults = getDefaults();
  for (const p of [defaults.snapshotPath, defaults.exportPath, defaults.localRecordingPath]) {
    try {
      mkdirSync(p, { recursive: true });
    } catch {
      // Best-effort only - see doc comment above.
    }
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
