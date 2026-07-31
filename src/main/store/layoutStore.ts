import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { CustomLayout, CustomLayoutTile } from '../../shared/types';

function filePath(): string {
  return join(app.getPath('userData'), 'layouts.json');
}

function readAll(): CustomLayout[] {
  const path = filePath();
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8')) as CustomLayout[];
}

function writeAll(records: CustomLayout[]): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf-8');
}

export function listLayouts(): CustomLayout[] {
  return readAll();
}

// Enforced here (not just in the renderer's dialog) since this is the
// actual source of truth — a client-side-only check can't stop a
// double-click firing two save requests before either one's response
// comes back and updates the renderer's local list.
export function saveLayout(name: string, layout: number, tiles: CustomLayoutTile[]): CustomLayout {
  const records = readAll();
  const trimmed = name.trim();
  if (records.some((r) => r.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`A custom layout named "${trimmed}" already exists`);
  }
  const record: CustomLayout = { id: randomUUID(), name: trimmed, layout, tiles };
  records.push(record);
  writeAll(records);
  return record;
}

export function deleteLayout(id: string): void {
  writeAll(readAll().filter((r) => r.id !== id));
}

// Full-config restore (see ipc/backup.ts) — replaces the entire on-disk
// layout list wholesale, preserving each layout's original id (unlike
// saveLayout, which always mints a fresh one and rejects duplicate names),
// since this is meant to bring back an exact prior state.
export function restoreLayouts(records: CustomLayout[]): void {
  writeAll(records);
}
