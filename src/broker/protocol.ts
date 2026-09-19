// The IPC contract between the MCP server process (re-fetched via `npx -y`
// on every client restart -- see the plan this closes) and the stable,
// once-installed broker daemon that's the only thing holding the signing
// key. Deliberately tiny: the daemon only ever answers "sign this prepared
// transaction" or "sign this payment-channel claim," nothing else -- it
// never sees anything about *why* a payment is being made.

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SignTransactionRequest {
  token: string;
  kind: 'transaction';
  transaction: Record<string, unknown>;
}

// A payment-channel claim isn't a transaction -- signPaymentChannelClaim
// signs only {channel, amount} with the raw private key, not a prepared
// tx object (see XrplChannelClientScheme). xrpAmount is human XRP, matching
// that function's own parameter convention.
export interface SignClaimRequest {
  token: string;
  kind: 'claim';
  channelId: string;
  xrpAmount: string;
}

export type SignRequest = SignTransactionRequest | SignClaimRequest;

export interface SignTransactionResponse {
  signedTxBlob: string;
  hash: string;
}

export interface SignClaimResponse {
  signature: string;
}

export type SignResponse = SignTransactionResponse | SignClaimResponse;

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
