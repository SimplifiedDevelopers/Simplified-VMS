import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app, safeStorage } from 'electron';
import type { NewDeviceInput, StoredDevice, VendorId } from '../../shared/types';

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

function toStoredDevice(record: DeviceRecord): StoredDevice {
  const { encryptedPassword: _encryptedPassword, ...rest } = record;
  // Records written before the channels field existed won't have it.
  return { ...rest, channels: rest.channels ?? [] };
}

function toRecord(id: string, input: NewDeviceInput, channels: number[] = []): DeviceRecord {
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
  const record = toRecord(id, input, records[index].channels);
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
export function setDeviceChannels(id: string, channels: number[]): void {
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
