import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app, safeStorage } from 'electron';
import type { SavedLogin } from '../../shared/types';

interface PrefsFile {
  savedUsername?: string;
  encryptedPassword?: string; // base64
  autoLogin?: boolean;
}

function filePath(): string {
  return join(app.getPath('userData'), 'prefs.json');
}

function readPrefs(): PrefsFile {
  const path = filePath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as PrefsFile;
}

function writePrefs(prefs: PrefsFile): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8');
}

export function getSavedLogin(): SavedLogin | null {
  const prefs = readPrefs();
  if (!prefs.savedUsername || !prefs.encryptedPassword) return null;
  const password = safeStorage.decryptString(Buffer.from(prefs.encryptedPassword, 'base64'));
  return { username: prefs.savedUsername, password, autoLogin: prefs.autoLogin ?? false };
}

export function saveLogin(username: string, password: string, autoLogin: boolean): void {
  writePrefs({
    savedUsername: username,
    encryptedPassword: safeStorage.encryptString(password).toString('base64'),
    autoLogin,
  });
}

export function clearSavedLogin(): void {
  writePrefs({});
}
