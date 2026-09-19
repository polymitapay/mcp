// Client-side half of the "exact-channel" x402 scheme -- the counterpart
// to agent-rail's XrplChannelFacilitatorScheme/XrplChannelServerScheme.
// Registered alongside the existing ExactXrplScheme (see
// xrpl-payment-client.ts) so a call only ever uses this when the server
// actually offers it and this wallet has an open channel.

import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types';

export const XRPL_CHANNEL_SCHEME = 'exact-channel';
const DROPS_PER_XRP = 1_000_000n;
// How long a call waits for the previous call's claim to be accepted
// before assuming it never will be (see acceptedBaseDrops).
const CLAIM_CATCH_UP_TIMEOUT_MS = 5000;
const CLAIM_CATCH_UP_POLL_MS = 250;

// signPaymentChannelClaim/verifyPaymentChannelClaim want a human XRP
// string, not drops. Plain BigInt arithmetic, matching this package's own
// existing drops<->XRP conversion style (see formatAmountForPreview in
// xrpl-payment-client.ts) rather than pulling in a decimal library just
// for this.
function dropsToHumanXrp(drops: bigint): string {
  const whole = drops / DROPS_PER_XRP;
  const frac = drops % DROPS_PER_XRP;
  if (frac === 0n) {
    return whole.toString();
  }
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

// Abstracts over where the actual signPaymentChannelClaim call happens --
// directly in this process (no broker) or delegated to the broker daemon
// (see src/broker/client.ts's signClaimViaBroker), mirroring the same
// direct-vs-broker split xrpl-payment-client.ts already has for
// transaction signing.
export interface ChannelClaimSigner {
  sign(channelId: string, xrpAmount: string): Promise<string>;
}

export class XrplChannelClientScheme implements SchemeNetworkClient {
  readonly scheme = XRPL_CHANNEL_SCHEME;
  // Serializes claim creation: two tool calls in flight at once would
  // otherwise read the same accepted amount and sign the same claim, and
  // agent-rail only accepts one of them (see its claim_conflict).
  private pending: Promise<unknown> = Promise.resolve();
  // The highest amount this process has signed. Only used to tell "the
  // server hasn't caught up yet" from "that claim was never accepted" --
  // never as the base for the next claim, which always comes from the
  // server (see lastAcceptedDrops).
  private lastSigned = 0n;

  constructor(
    private readonly channelId: string,
    private readonly signer: ChannelClaimSigner,
    private readonly agentRailUrl: string,
  ) {}

  // A claim's amount is cumulative, so signing one means knowing what was
  // already accepted. That count is deliberately NOT kept here: a claim
  // that gets rejected (or a call the provider fails) advances a local
  // count that the server never accepted, and from then on every claim is
  // off by that much -- rejected at best, silently overpaid at worst. The
  // server is the only thing that knows what it actually accepted, so ask
  // it, every time.
  private async lastAcceptedDrops(): Promise<bigint> {
    const res = await fetch(
      `${this.agentRailUrl}/v1/payment-channels/${encodeURIComponent(this.channelId)}`,
    );
    if (!res.ok) {
      throw new Error(`couldn't read the channel's accepted amount: HTTP ${res.status}`);
    }
    const state = (await res.json()) as { lastAcceptedAmount?: string };
    if (typeof state.lastAcceptedAmount !== 'string') {
      throw new Error("channel state response had no 'lastAcceptedAmount'");
    }
    return BigInt(state.lastAcceptedAmount);
  }

  // The claim signed for the previous call is only accepted once that call
  // reaches settle(), which happens after the provider has answered -- so a
  // call starting in the meantime can still read the older amount. Give the
  // server a moment to catch up rather than signing a duplicate claim it
  // would reject. When the previous claim was genuinely rejected (provider
  // error, a claim the server refused), nothing ever catches up, so this
  // gives up and signs from what the server does report -- which is exactly
  // the resync that keeps a rejection from poisoning every later claim.
  private async acceptedBaseDrops(): Promise<bigint> {
    const deadline = Date.now() + CLAIM_CATCH_UP_TIMEOUT_MS;
    for (;;) {
      const accepted = await this.lastAcceptedDrops();
      if (accepted >= this.lastSigned || Date.now() >= deadline) {
        return accepted;
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_CATCH_UP_POLL_MS));
    }
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const run = this.pending.then(async () => {
      // Exactly the price on top of what the server accepted -- it rejects
      // any other increment (claim_increment_not_price), precisely so a
      // drifted client can't be charged more than one call's worth.
      const nextClaimed = (await this.acceptedBaseDrops()) + BigInt(paymentRequirements.amount);
      const amount = nextClaimed.toString();
      const signature = await this.signer.sign(this.channelId, dropsToHumanXrp(nextClaimed));
      this.lastSigned = nextClaimed > this.lastSigned ? nextClaimed : this.lastSigned;
      return {
        x402Version,
        payload: { channelId: this.channelId, amount, signature },
      };
    });
    // Keep the chain going whether or not this one worked -- a failure
    // here means nothing was accepted, so the next call just reads the
    // server's (unchanged) amount again.
    this.pending = run.catch(() => undefined);
    return run;
  }
}
