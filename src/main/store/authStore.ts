import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';

interface AuthFile {
  username: string;
  salt: string;
  hash: string;
}

function filePath(): string {
  return join(app.getPath('userData'), 'admin-account.json');
}

function readAuthFile(): AuthFile | null {
  const path = filePath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as AuthFile;
}

function writeAuthFile(data: AuthFile): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64);
}

export function hasAdminAccount(): boolean {
  return readAuthFile() !== null;
}

export function createAdminAccount(username: string, password: string): void {
  const salt = randomBytes(16);
  const hash = hashPassword(password, salt);
  writeAuthFile({ username, salt: salt.toString('hex'), hash: hash.toString('hex') });
}

export function verifyLogin(username: string, password: string): boolean {
  const account = readAuthFile();
  if (!account || account.username !== username) return false;
  const salt = Buffer.from(account.salt, 'hex');
  const expected = Buffer.from(account.hash, 'hex');
  const actual = hashPassword(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
