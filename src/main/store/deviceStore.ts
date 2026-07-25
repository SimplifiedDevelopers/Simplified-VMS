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
  return rest;
}

function toRecord(id: string, input: NewDeviceInput): DeviceRecord {
  return {
    id,
    name: input.name,
    vendor: input.vendor,
    host: input.host,
    port: input.port,
    httpPort: input.httpPort,
    username: input.username,
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
  const record = toRecord(id, input);
  records[index] = record;
  writeAll(records);
  return toStoredDevice(record);
}

export function deleteDevice(id: string): void {
  writeAll(readAll().filter((r) => r.id !== id));
}

// Main-process-only — credentials never cross the IPC boundary on read.
export function getDeviceCredentials(id: string): DeviceCredentials | null {
  const record = readAll().find((r) => r.id === id);
  if (!record) return null;
  const password = safeStorage.decryptString(Buffer.from(record.encryptedPassword, 'base64'));
  return { vendor: record.vendor, host: record.host, port: record.port, username: record.username, password };
}
