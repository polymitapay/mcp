// Client-side half used by xrpl-payment-client.ts / xrpl-channel-client-
// scheme.ts when broker mode is active: instead of holding the seed
// itself, this connects to the already-running broker daemon over its
// local socket and asks it to sign. The MCP server process (the one
// `npx -y` re-fetches on every restart) never sees the raw key material --
// only signed blobs/signatures come back.

import { connect } from 'node:net';
import type {
  SignClaimResponse,
  SignErrorResponse,
  SignRequest,
  SignResponse,
  SignTransactionResponse,
} from './protocol.js';

function sendRequest(socketPath: string, request: SignRequest): Promise<SignResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        const parsed = JSON.parse(line) as SignResponse | SignErrorResponse;
        if ('error' in parsed) {
          reject(new Error(`broker refused to sign: ${parsed.error}`));
        } else {
          resolve(parsed);
        }
      } catch (error) {
        reject(error);
      }
    });

    socket.on('error', (error) => {
      reject(
        new Error(
          `couldn't reach the polypay-broker daemon (is it running?): ${error.message}`,
        ),
      );
    });
  });
}

// Matches @x402/xrpl's ClientXrplSigner shape (classicAddress + a sign()
// whose declared return type is `Promise<Result> | Result` -- loose enough
// to cover both createXrplWalletSigner's effectively-synchronous
// implementation and this broker client's genuinely-async one) so either
// can be handed straight to ExactXrplScheme, or assigned to the same local
// variable interchangeably.
type SignResult = { signedTxBlob: string; hash?: string };
export interface BrokerSigner {
  classicAddress: string;
  sign(transaction: Record<string, unknown>): Promise<SignResult> | SignResult;
}

export function createBrokerSigner(
  socketPath: string,
  token: string,
  masterAddress: string,
): BrokerSigner {
  return {
    classicAddress: masterAddress,
    async sign(transaction) {
      const result = await sendRequest(socketPath, { token, kind: 'transaction', transaction });
      return result as SignTransactionResponse;
    },
  };
}

// Used by XrplChannelClientScheme when broker mode is active, instead of
// signing a payment-channel claim with an in-process seed.
export async function signClaimViaBroker(
  socketPath: string,
  token: string,
  channelId: string,
  xrpAmount: string,
): Promise<string> {
  const result = await sendRequest(socketPath, { token, kind: 'claim', channelId, xrpAmount });
  return (result as SignClaimResponse).signature;
}
