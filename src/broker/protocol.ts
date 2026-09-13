// The IPC contract between the MCP server process (re-fetched via `npx -y`
// on every client restart -- see the plan this closes) and the stable,
// once-installed broker daemon that's the only thing holding the signing
// key. Deliberately tiny: the daemon only ever answers "sign this prepared
// transaction," nothing else -- it never sees anything about *why* a
// payment is being made.

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SignRequest {
  token: string;
  transaction: Record<string, unknown>;
}

export interface SignResponse {
  signedTxBlob: string;
  hash: string;
}

export interface SignErrorResponse {
  error: string;
}

export function brokerDir(): string {
  return join(homedir(), '.polypay', 'broker');
}

export function credentialsPath(): string {
  return join(brokerDir(), 'credentials.json');
}

// Windows has no filesystem-visible Unix domain sockets -- named pipes live
// in their own `\\.\pipe\` namespace instead, not under brokerDir().
export function socketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\polypay-broker';
  }
  return join(brokerDir(), 'broker.sock');
}
