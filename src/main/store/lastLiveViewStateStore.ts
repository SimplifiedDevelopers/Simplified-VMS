import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { LastLiveViewState } from '../../shared/types';

// A single auto-saved snapshot of Live View's current layout/tiles, kept
// separate from the user-visible Custom Layouts list (layoutStore.ts) so it
// never shows up there as a stray entry. Powers "Start App"
// (AppSettings.restoreLiveViewOnStart, see ipc/liveView.ts's consuming
// handler for the one-shot-per-process read).
function filePath(): string {
  return join(app.getPath('userData'), 'lastLiveViewState.json');
}

export function getLastLiveViewState(): LastLiveViewState | null {
  const path = filePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LastLiveViewState;
  } catch {
    return null;
  }
}

export function saveLastLiveViewState(state: LastLiveViewState): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}
