// Everything XRPL-specific about signing x402 payments lives here, behind
// createPaymentClient(). The rest of the package only calls this function --
// adding a second network later means a sibling module with the same shape
// (e.g. stellar-payment-client.ts), not a rewrite of the callers.

import { Wallet } from 'xrpl';
import { createXrplWalletSigner } from '@x402/xrpl';
import { ExactXrplScheme } from '@x402/xrpl/exact/client';
import { x402Client } from '@x402/core/client';

export interface PaymentClientHandle {
  paymentClient: x402Client;
  walletAddress: string;
}

export function createPaymentClient(seed: string): PaymentClientHandle {
  const wallet = Wallet.fromSeed(seed);
  const signer = createXrplWalletSigner(wallet);

  // x402Client's default spendControls only auto-approve assets it
  // recognizes as "default" for the network (@x402/xrpl only lists RLUSD,
  // matched by its raw hex currency code -- agent-rail's PaymentRequirements
  // send the human-readable "XRP"/"RLUSD" strings, so neither matches and
  // BOTH options get rejected before any signing happens). Disabled here;
  // the real wallet-mcp-server needs a deliberate spendControls policy
  // (allowedAssets + maxAmountPerPayment) as a user-facing safety rail, not
  // just "off".
  const paymentClient = new x402Client()
    .register('xrpl:*', new ExactXrplScheme(signer))
    .setSpendControls(false);

  return { paymentClient, walletAddress: wallet.address };
}
