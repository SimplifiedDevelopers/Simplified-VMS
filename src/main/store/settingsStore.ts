import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';

const DEFAULTS: AppSettings = {
  hardwareAcceleration: true,
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
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
  return merged;
}
