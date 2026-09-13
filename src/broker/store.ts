// Reads/writes the one file the broker daemon owns that this package's own
// setup wizard doesn't otherwise manage: the operating seed + auth token,
// generated fresh at install time, never shipped as part of the npm
// package itself.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { brokerDir, credentialsPath } from './protocol.js';

export interface BrokerCredentials {
  seed: string;
  masterAddress: string;
  token: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function writeCredentials(creds: BrokerCredentials): void {
  mkdirSync(brokerDir(), { recursive: true });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(creds));
  // Same rationale as the Claude Desktop config: this file holds a signing
  // key, so at least keep it unreadable by other local accounts. Windows
  // has no POSIX mode bits (chmod there only toggles read-only), so this
  // only does real work on darwin/linux.
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
  }
}

export function readCredentials(): BrokerCredentials {
  return JSON.parse(readFileSync(credentialsPath(), 'utf-8')) as BrokerCredentials;
}

export function credentialsExist(): boolean {
  return existsSync(credentialsPath());
}
