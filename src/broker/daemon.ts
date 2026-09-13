#!/usr/bin/env node
// The stable half of the broker: the only process that ever holds the
// operating seed in memory. Installed once to a fixed on-disk path (see
// install-macos.ts / install-windows.ts) and run as a persistent OS
// service -- it must NEVER be relaunched via `npx -y` like the MCP server
// package itself, or a malicious publish of that package could just as
// easily replace this too, and the whole point of splitting them apart is
// lost. See the plan this implements for why.

import { createServer, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { Wallet, type Transaction } from 'xrpl';
import { socketPath } from './protocol.js';
import { readCredentials } from './store.js';
import type { SignRequest, SignResponse, SignErrorResponse } from './protocol.js';

function respond(socket: Socket, body: SignResponse | SignErrorResponse): void {
  socket.write(JSON.stringify(body) + '\n');
}

function main(): void {
  const creds = readCredentials();
  const wallet = Wallet.fromSeed(creds.seed, { masterAddress: creds.masterAddress });

  const path = socketPath();
  if (process.platform !== 'win32' && existsSync(path)) {
    // A stale socket file left behind by a previous run that didn't shut
    // down cleanly -- safe to remove, a new listener is about to claim it.
    unlinkSync(path);
  }

  function handleLine(socket: Socket, line: string): void {
    let request: SignRequest;
    try {
      request = JSON.parse(line) as SignRequest;
    } catch {
      respond(socket, { error: 'invalid request' });
      return;
    }
    if (request.token !== creds.token) {
      respond(socket, { error: 'unauthorized' });
      return;
    }
    try {
      const signed = wallet.sign(request.transaction as unknown as Transaction);
      respond(socket, { signedTxBlob: signed.tx_blob, hash: signed.hash });
    } catch (error) {
      respond(socket, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          handleLine(socket, line);
        }
      }
    });
    socket.on('error', () => {
      // A client disconnecting mid-request is routine, not a daemon
      // failure -- nothing to do beyond letting this connection go.
    });
  });

  server.listen(path, () => {
    console.error(`[polypay-broker] listening on ${path}, signing on behalf of ${wallet.address}`);
  });
}

main();
