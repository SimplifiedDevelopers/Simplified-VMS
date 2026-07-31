import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app, safeStorage } from 'electron';
import type { ChannelInfo, NewDeviceInput, StoredDevice, VendorId } from '../../shared/types';

interface DeviceRecord extends StoredDevice {
  encryptedPassword: string; // base64
}

export interface DeviceCredentials {
  vendor: VendorId;
  host: string;
  port: number;
  username: string;
  password: string;
}

function filePath(): string {
  return join(app.getPath('userData'), 'devices.json');
}

function readAll(): DeviceRecord[] {
  const path = filePath();
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8')) as DeviceRecord[];
}

function writeAll(records: DeviceRecord[]): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf-8');
}

// Handles two vintages of on-disk record: none at all (pre-channels-field),
// plain channel numbers (pre-real-camera-names), and the current
// {channel, label} shape — old records aren't rewritten, just normalized
// on read, same as before.
function normalizeChannels(raw: unknown): ChannelInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => (typeof c === 'number' ? { channel: c, label: `Channel ${c}` } : (c as ChannelInfo)));
}

function toStoredDevice(record: DeviceRecord): StoredDevice {
  const { encryptedPassword: _encryptedPassword, ...rest } = record;
  return { ...rest, channels: normalizeChannels(rest.channels) };
}

function toRecord(id: string, input: NewDeviceInput, channels: ChannelInfo[] = []): DeviceRecord {
  return {
    id,
    name: input.name,
    vendor: input.vendor,
    host: input.host,
    port: input.port,
    httpPort: input.httpPort,
    username: input.username,
    channels,
    encryptedPassword: safeStorage.encryptString(input.password).toString('base64'),
  };
}

export function listDevices(): StoredDevice[] {
  return readAll().map(toStoredDevice);
}

export function addDevice(input: NewDeviceInput): StoredDevice {
  const records = readAll();
  const record = toRecord(randomUUID(), input);
  records.push(record);
  writeAll(records);
  return toStoredDevice(record);
}

export function updateDevice(id: string, input: NewDeviceInput): StoredDevice {
  const records = readAll();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`Device not found: ${id}`);
  // Keep whatever channel list is already known until a fresh login
  // (triggered right after this by the devices:update IPC handler)
  // confirms/replaces it — editing a device shouldn't blank out an
  // already-working channel list just because the save itself doesn't
  // re-fetch synchronously.
  const record = toRecord(id, input, normalizeChannels(records[index].channels));
  records[index] = record;
  writeAll(records);
  return toStoredDevice(record);
}

export function deleteDevice(id: string): void {
  writeAll(readAll().filter((r) => r.id !== id));
}

// Called once a login (from add/update, or the first time Live View needs
// this device's channels) reveals the real channel list, so every later
// lookup can be served from disk instead of hitting the device again.
export function setDeviceChannels(id: string, channels: ChannelInfo[]): void {
  const records = readAll();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return;
  records[index] = { ...records[index], channels };
  writeAll(records);
}

// Main-process-only — credentials never cross the IPC boundary on read.
export function getDeviceCredentials(id: string): DeviceCredentials | null {
  const record = readAll().find((r) => r.id === id);
  if (!record) return null;
  const password = safeStorage.decryptString(Buffer.from(record.encryptedPassword, 'base64'));
  return { vendor: record.vendor, host: record.host, port: record.port, username: record.username, password };
}

// Backup/Restore Configuration and Export/Import Devices List (see
// ipc/backup.ts) need real, portable passwords — encryptedPassword is tied
// to this machine's own DPAPI key via safeStorage, so it wouldn't decrypt
// on a different install. Only ever written straight to a file the user
// explicitly chose (a native Save dialog), never sent back across IPC as a
// bulk list, same handling as getDeviceCredentials above.
export interface DeviceBackupRecord extends StoredDevice {
  password: string;
}

export function listDevicesWithPasswords(): DeviceBackupRecord[] {
  return readAll().map((record) => {
    const { encryptedPassword, ...rest } = record;
    const password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
    return { ...rest, channels: normalizeChannels(rest.channels), password };
  });
}

// Restores a device list from a full-config backup — writes each record
// with its ORIGINAL id (not a fresh one) so custom layout tiles, which
// reference deviceId, still resolve correctly after a restore. Replaces
// the entire on-disk device list wholesale.
export function restoreDevices(records: DeviceBackupRecord[]): void {
  writeAll(
    records.map((r) => ({
      id: r.id,
      name: r.name,
      vendor: r.vendor,
      host: r.host,
      port: r.port,
      httpPort: r.httpPort,
      username: r.username,
      channels: r.channels,
      encryptedPassword: safeStorage.encryptString(r.password).toString('base64'),
    })),
  );
}

// Merges an imported device list (Export/Import Devices List, distinct
// from a full config restore above) into whatever's already saved — these
// are being added as new devices, not restoring exact prior state, so each
// gets a fresh id rather than keeping the imported one (which could
// collide with an existing device, or a second import of the same file).
export function importDevices(records: DeviceBackupRecord[]): StoredDevice[] {
  const existing = readAll();
  const imported: DeviceRecord[] = records.map((r) => ({
    id: randomUUID(),
    name: r.name,
    vendor: r.vendor,
    host: r.host,
    port: r.port,
    httpPort: r.httpPort,
    username: r.username,
    channels: normalizeChannels(r.channels),
    encryptedPassword: safeStorage.encryptString(r.password).toString('base64'),
  }));
  writeAll([...existing, ...imported]);
  return imported.map(toStoredDevice);
}
