// Everything XRPL-specific about signing x402 payments lives here, behind
// createPaymentClient(). The rest of the package only calls this function --
// adding a second network later means a sibling module with the same shape
// (e.g. stellar-payment-client.ts), not a rewrite of the callers.

import { Client, Wallet, type TrustSet } from 'xrpl';
import {
  createXrplWalletSigner,
  RLUSD_CURRENCY,
  RLUSD_MAINNET_ISSUER,
  RLUSD_TESTNET_ISSUER,
  XRPL_MAINNET_WS_URL,
  XRPL_TESTNET_WS_URL,
} from '@x402/xrpl';
import { ExactXrplScheme } from '@x402/xrpl/exact/client';
import { x402Client } from '@x402/core/client';

// A generous trust line limit -- this is a ceiling on how much RLUSD the
// wallet could ever hold, not an amount actually sent. Opening it once with
// room to spare avoids ever having to raise it again as the wallet accrues
// balance from unrelated payments it receives.
const RLUSD_TRUST_LINE_LIMIT = '1000000000';

export interface PaymentClientHandle {
  paymentClient: x402Client;
  walletAddress: string;
  // Biases the *next* payment toward this asset (case-insensitive, e.g.
  // "XRP" or "RLUSD") when the provider accepts more than one. Applies to
  // every payment made through paymentClient until changed again -- the
  // caller (server.ts) is responsible for resetting it to null after each
  // polypay_call so a preference never leaks into a later, unrelated call
  // that didn't ask for one.
  setPreferredAsset: (asset: string | null) => void;
}

export function createPaymentClient(
  seed: string,
  network: 'testnet' | 'mainnet',
): PaymentClientHandle {
  const wallet = Wallet.fromSeed(seed);
  const signer = createXrplWalletSigner(wallet);

  let preferredAsset: string | null = null;
  function setPreferredAsset(asset: string | null) {
    preferredAsset = asset;
  }

  // Lazily-connected, reused for the life of this process -- opening a fresh
  // WebSocket connection per trust-line check would work but is wasteful
  // when most calls never need one (only the first RLUSD payment per issuer
  // does; see verifiedIssuers below).
  const wsUrl = network === 'mainnet' ? XRPL_MAINNET_WS_URL : XRPL_TESTNET_WS_URL;
  let xrplClient: Client | null = null;
  async function getXrplClient(): Promise<Client> {
    if (!xrplClient) {
      xrplClient = new Client(wsUrl);
    }
    const client = xrplClient;
    if (!client.isConnected()) {
      await client.connect();
    }
    return client;
  }

  // Once confirmed present for an issuer, trust lines don't disappear on
  // their own -- caching this in memory for the process's lifetime avoids an
  // account_lines round-trip on every single RLUSD call, not just the first.
  const verifiedIssuers = new Set<string>();

  async function ensureRlusdTrustLine(issuer: string): Promise<void> {
    if (verifiedIssuers.has(issuer)) {
      return;
    }
    const client = await getXrplClient();
    const { result } = await client.request({
      command: 'account_lines',
      account: wallet.address,
      peer: issuer,
    });
    const hasTrustLine = result.lines.some(
      (line) => line.currency === RLUSD_CURRENCY,
    );
    if (!hasTrustLine) {
      const tx: TrustSet = {
        TransactionType: 'TrustSet',
        Account: wallet.address,
        LimitAmount: {
          currency: RLUSD_CURRENCY,
          issuer,
          value: RLUSD_TRUST_LINE_LIMIT,
        },
      };
      const prepared = await client.autofill(tx);
      const signed = wallet.sign(prepared);
      const { result: submitResult } = await client.submitAndWait(
        signed.tx_blob,
      );
      const meta = submitResult.meta;
      const engineResult =
        meta && typeof meta === 'object' && 'TransactionResult' in meta
          ? meta.TransactionResult
          : undefined;
      if (engineResult !== 'tesSUCCESS') {
        throw new Error(
          `TrustSet did not succeed (${String(engineResult)})`,
        );
      }
    }
    verifiedIssuers.add(issuer);
  }

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
    .setSpendControls(false)
    // Filters the accepted requirements down to the preferred asset before
    // the default selector (accepts[0]) runs, so choosing an asset needs no
    // custom selector -- and never hard-fails a call: if the provider
    // doesn't actually offer the preferred asset this call, the filter
    // yields nothing and we fall back to the full list instead.
    .registerPolicy((_x402Version, requirements) => {
      if (!preferredAsset) {
        return requirements;
      }
      const matches = requirements.filter(
        (r) => r.asset.toLowerCase() === preferredAsset!.toLowerCase(),
      );
      return matches.length > 0 ? matches : requirements;
    })
    // Runs after the selector has already picked which requirement to pay,
    // whether that came from an explicit asset preference or the plain
    // default -- so this catches every RLUSD payment, not just the ones
    // routed here through setPreferredAsset.
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      if (selectedRequirements.asset.toLowerCase() !== 'rlusd') {
        return;
      }
      const issuer =
        (selectedRequirements.extra?.issuer as string | undefined) ??
        (network === 'mainnet' ? RLUSD_MAINNET_ISSUER : RLUSD_TESTNET_ISSUER);
      try {
        await ensureRlusdTrustLine(issuer);
      } catch (error) {
        return {
          abort: true,
          reason: `could not open the RLUSD trust line needed for this payment: ${String(error)}`,
        };
      }
    });

  return { paymentClient, walletAddress: wallet.address, setPreferredAsset };
}
