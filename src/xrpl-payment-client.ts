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

const DROPS_PER_XRP = 1_000_000n;
// Exported so setup-wizard.ts can validate spend-limit input with the same
// rule this module enforces, instead of a second regex drifting from it.
export const DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;

function parseDecimalEnvAmount(envVarName: string, value: string): string {
  if (!DECIMAL_AMOUNT_RE.test(value)) {
    throw new Error(
      `${envVarName} must be a plain decimal number (e.g. "5" or "1.5"), got "${value}"`,
    );
  }
  return value;
}

// Converts a human XRP amount ("5", "1.5") into an integer drops string --
// XRPL's own atomic unit, and what payment requirements and spendControls'
// per-asset caps both use.
function xrpToDrops(xrp: string): bigint {
  const [whole, frac = ''] = xrp.split('.');
  const fracDrops = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * DROPS_PER_XRP + BigInt(fracDrops || '0');
}

export interface SpendLimits {
  // Per-call caps, enforced by x402Client's own spendControls before a
  // payment is ever signed.
  maxPerCallXrp?: string; // human XRP, e.g. "5"
  maxPerCallRlusd?: string; // human RLUSD (~USD), e.g. "2"
  // Cumulative caps for the life of this process -- x402Client has no
  // concept of these (its spendControls is per-payment only), so they're
  // tracked and enforced here by hand. Resets on restart; a real multi-day
  // budget would need this persisted somewhere, which is a bigger change
  // than this first pass.
  maxTotalXrp?: string;
  maxTotalRlusd?: string;
}

export interface PaymentClientHandle {
  paymentClient: x402Client;
  walletAddress: string;
  // Biases the *next* payment toward this asset (case-insensitive, e.g.
  // "XRP" or "RLUSD") when the provider accepts more than one. Applies to
  // every payment made through paymentClient until changed again -- the
  // caller (server.ts) is responsible for resetting it to null after each
  // polymitapay_call so a preference never leaks into a later, unrelated call
  // that didn't ask for one.
  setPreferredAsset: (asset: string | null) => void;
}

export function createPaymentClient(
  seed: string,
  network: 'testnet' | 'mainnet',
  spendLimits: SpendLimits = {},
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

  // -- Spend limits (see the TODO this closes: MAX_PER_CALL / MAX_TOTAL) --

  const maxPerCallXrpDrops =
    spendLimits.maxPerCallXrp !== undefined
      ? xrpToDrops(
          parseDecimalEnvAmount(
            'POLYPAY_MAX_PER_CALL_XRP',
            spendLimits.maxPerCallXrp,
          ),
        )
      : null;
  const maxTotalXrpDrops =
    spendLimits.maxTotalXrp !== undefined
      ? xrpToDrops(
          parseDecimalEnvAmount('POLYPAY_MAX_TOTAL_XRP', spendLimits.maxTotalXrp),
        )
      : null;
  const maxPerCallRlusd =
    spendLimits.maxPerCallRlusd !== undefined
      ? parseDecimalEnvAmount(
          'POLYPAY_MAX_PER_CALL_RLUSD',
          spendLimits.maxPerCallRlusd,
        )
      : null;
  const maxTotalRlusd =
    spendLimits.maxTotalRlusd !== undefined
      ? Number(
          parseDecimalEnvAmount(
            'POLYPAY_MAX_TOTAL_RLUSD',
            spendLimits.maxTotalRlusd,
          ),
        )
      : null;

  // Atomic (XRP drops, exact) vs a plain Number (RLUSD) -- RLUSD amounts are
  // always small decimal strings here, and this is a soft safety-rail
  // total, not the money itself (the real transaction amount is still the
  // exact string XRPL settles), so float imprecision at these scales isn't
  // a real risk.
  let spentXrpDrops = 0n;
  let spentRlusd = 0;

  function isRlusdAsset(asset: string): boolean {
    return asset.toLowerCase() === RLUSD_CURRENCY.toLowerCase();
  }

  // Human-readable amount for the preview log line -- RLUSD requirements
  // are already a plain decimal string (see the comment on maxPerCallRlusd
  // above), XRP requirements are atomic drops and need converting.
  function formatAmountForPreview(asset: string, amount: string): string {
    if (isRlusdAsset(asset)) {
      return `${amount} RLUSD`;
    }
    const drops = BigInt(amount);
    const whole = drops / DROPS_PER_XRP;
    const frac = drops % DROPS_PER_XRP;
    const fracStr =
      frac === 0n ? '' : `.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
    return `${whole}${fracStr} XRP`;
  }

  const paymentClient = new x402Client()
    .register('xrpl:*', new ExactXrplScheme(signer))
    // The SDK's own per-payment cap. Only XRP needs an explicit
    // allowedAssets entry to remain payable at all once this is enabled --
    // it isn't a "default asset" for @x402/xrpl (only RLUSD is), so with
    // spendControls on and no entry it gets rejected outright, cap or not.
    // RLUSD passes the allowlist on its own; its per-call cap is the
    // top-level USD figure, not a per-asset atomic one -- that path only
    // accepts whole-number amounts, and RLUSD's are always decimal (e.g.
    // "1.5"). Left fully off (false) when neither cap is configured, same
    // as before -- see the comment on setSpendControls(false) history.
    .setSpendControls(
      maxPerCallXrpDrops === null && maxPerCallRlusd === null
        ? false
        : {
            allowedAssets: [
              {
                network: 'xrpl:*',
                asset: 'XRP',
                ...(maxPerCallXrpDrops !== null
                  ? { maxAmountPerPayment: maxPerCallXrpDrops.toString() }
                  : {}),
              },
            ],
            maxAmountPerPayment:
              maxPerCallRlusd !== null ? `$${maxPerCallRlusd}` : false,
          },
    )
    // Filters the accepted requirements down to the preferred asset before
    // the default selector (accepts[0]) runs, so choosing an asset needs no
    // custom selector -- and never hard-fails a call: if the provider
    // doesn't actually offer the preferred asset this call, the filter
    // yields nothing and we fall back to the full list instead.
    //
    // "RLUSD" (what server.ts's polymitapay_call accepts as `asset`) is a
    // human label -- the wire-level requirement's own `asset` field for
    // RLUSD is never that string, it's RLUSD_CURRENCY's 40-char hex
    // currency code (confirmed live: a real RLUSD requirement's `asset`
    // was "524C555344..."). Comparing preferredAsset against r.asset with
    // plain string equality therefore NEVER matched RLUSD, silently fell
    // through to the unfiltered list, and the default selector picked
    // whatever came first (XRP) -- explicitly asking to pay in RLUSD
    // always paid in XRP instead. Route the RLUSD case through the same
    // isRlusdAsset() check already used correctly elsewhere in this file.
    .registerPolicy((_x402Version, requirements) => {
      if (!preferredAsset) {
        return requirements;
      }
      const wantsRlusd = preferredAsset.toLowerCase() === 'rlusd';
      const matches = requirements.filter((r) =>
        wantsRlusd
          ? isRlusdAsset(r.asset)
          : r.asset.toLowerCase() === preferredAsset!.toLowerCase(),
      );
      return matches.length > 0 ? matches : requirements;
    })
    // Runs after the selector has already picked which requirement to pay,
    // whether that came from an explicit asset preference or the plain
    // default -- so this catches every payment, not just the ones routed
    // here through setPreferredAsset. Budget check first (cheap, no network)
    // so a call over the cumulative limit never bothers opening a trust
    // line for a payment it's about to refuse anyway.
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      // Logged first, before any check below can abort -- so even a call
      // rejected by a spend limit still leaves a record of what it would
      // have paid. This is a stderr audit line, not an interactive
      // confirmation: the stdio server declares no MCP `elicitation`
      // capability, so there's no channel to pause and wait for a human
      // "yes" mid-call yet.
      console.error(
        `[polymitapay] payment preview: ${formatAmountForPreview(selectedRequirements.asset, selectedRequirements.amount)} -> ${selectedRequirements.payTo} (${selectedRequirements.network})`,
      );

      const rlusd = isRlusdAsset(selectedRequirements.asset);

      if (rlusd && maxTotalRlusd !== null) {
        const amount = Number(selectedRequirements.amount);
        const wouldBe = spentRlusd + amount;
        if (wouldBe > maxTotalRlusd) {
          return {
            abort: true,
            reason: `this payment (${amount} RLUSD) would bring this session's total to ${wouldBe} RLUSD, over the configured POLYPAY_MAX_TOTAL_RLUSD of ${maxTotalRlusd}`,
          };
        }
      }
      if (!rlusd && maxTotalXrpDrops !== null) {
        const amountDrops = BigInt(selectedRequirements.amount);
        const wouldBeDrops = spentXrpDrops + amountDrops;
        if (wouldBeDrops > maxTotalXrpDrops) {
          return {
            abort: true,
            reason: `this payment (${amountDrops} drops) would bring this session's total to ${wouldBeDrops} drops, over the configured POLYPAY_MAX_TOTAL_XRP (${maxTotalXrpDrops} drops)`,
          };
        }
      }

      if (rlusd) {
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
      }
    })
    // Only counts toward the cumulative total once the facilitator actually
    // confirms settlement -- a signed-but-rejected payment (bad verify,
    // failed settle) never happened as far as the wallet's spend is
    // concerned.
    .onPaymentResponse(async ({ requirements, settleResponse }) => {
      if (!settleResponse?.success) {
        return;
      }
      if (isRlusdAsset(requirements.asset)) {
        spentRlusd += Number(requirements.amount);
      } else {
        spentXrpDrops += BigInt(requirements.amount);
      }
    });

  return { paymentClient, walletAddress: wallet.address, setPreferredAsset };
}
