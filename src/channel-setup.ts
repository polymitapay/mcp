// Opening a payment channel: the one piece of channel lifecycle this
// package owns. Signing claims against an already-open channel lives in
// xrpl-channel-client-scheme.ts; this is what makes such a channel exist
// in the first place, so a user never has to hand-craft a
// PaymentChannelCreate and dig its id out of transaction metadata.
//
// Topping a channel up and closing it are NOT here yet -- see the pending
// notes. A user who runs out of deposit today falls back to paying with
// the plain `exact` scheme, which still works.

import {
  Client,
  Wallet,
  isCreatedNode,
  type Node,
  type PaymentChannelCreate,
} from 'xrpl';
import { XRPL_MAINNET_WS_URL, XRPL_TESTNET_WS_URL } from '@x402/xrpl';

const DROPS_PER_XRP = 1_000_000n;

export interface ChannelConfig {
  // The platform wallet every channel must be destined to -- agent-rail
  // refuses to even look up a channel pointing anywhere else.
  payTo: string;
  // The shortest SettleDelay agent-rail accepts. A channel below it is
  // funded and useless: every claim is rejected as
  // channel_settle_delay_too_short.
  minSettleDelaySeconds: number;
}

export async function fetchChannelConfig(agentRailUrl: string): Promise<ChannelConfig> {
  const res = await fetch(`${agentRailUrl}/v1/payment-channels/config`);
  if (!res.ok) {
    throw new Error(`couldn't read the channel config: HTTP ${res.status}`);
  }
  const config = (await res.json()) as Partial<ChannelConfig>;
  if (!config.payTo || typeof config.minSettleDelaySeconds !== 'number') {
    // An older agent-rail that predates this endpoint answers 404, but a
    // proxy or a newer field layout could answer 200 with something else.
    throw new Error('the channel config response was missing payTo or minSettleDelaySeconds');
  }
  return { payTo: config.payTo, minSettleDelaySeconds: config.minSettleDelaySeconds };
}

export function wsUrlFor(network: 'testnet' | 'mainnet'): string {
  return network === 'mainnet' ? XRPL_MAINNET_WS_URL : XRPL_TESTNET_WS_URL;
}

export function xrpToDrops(xrp: string): bigint {
  const [whole, frac = ''] = xrp.split('.');
  const paddedFrac = frac.padEnd(6, '0').slice(0, 6);
  return BigInt(whole || '0') * DROPS_PER_XRP + BigInt(paddedFrac || '0');
}

export function dropsToXrp(drops: bigint): string {
  const whole = drops / DROPS_PER_XRP;
  const frac = drops % DROPS_PER_XRP;
  if (frac === 0n) {
    return whole.toString();
  }
  return `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

// What this account could actually put into a channel right now: its
// balance minus what the ledger keeps locked (the base reserve, plus one
// owner reserve per object it already holds), minus one more owner reserve
// for the channel this is about to create, minus a little room for fees.
// Returns null when the account doesn't exist on the ledger yet -- a
// brand-new mainnet wallet, which can't open anything until it's funded.
export async function spendableDrops(
  client: Client,
  address: string,
): Promise<bigint | null> {
  let balanceDrops: bigint;
  let ownerCount: number;
  try {
    const { result } = await client.request({ command: 'account_info', account: address });
    balanceDrops = BigInt(result.account_data.Balance);
    ownerCount = result.account_data.OwnerCount;
  } catch {
    return null;
  }

  // Read live rather than hardcoded: these are amendment-controlled and
  // have changed before (10 XRP base / 2 XRP per object, until 2024).
  const { result: serverInfo } = await client.request({ command: 'server_info' });
  const ledger = serverInfo.info.validated_ledger;
  if (!ledger) {
    throw new Error("the XRPL node didn't report a validated ledger, so reserves are unknown");
  }
  const baseReserve = xrpToDrops(String(ledger.reserve_base_xrp));
  const ownerReserve = xrpToDrops(String(ledger.reserve_inc_xrp));

  const locked = baseReserve + ownerReserve * BigInt(ownerCount);
  // One extra owner reserve for the channel itself, plus 1 XRP of slack so
  // a user who deposits "everything" can still pay transaction fees.
  const headroom = ownerReserve + DROPS_PER_XRP;
  const spendable = balanceDrops - locked - headroom;
  return spendable > 0n ? spendable : 0n;
}

export interface OpenedChannel {
  channelId: string;
  txHash: string;
}

// Submits the PaymentChannelCreate and digs the channel id out of the
// result. The id is never a field of the transaction: it's the ledger
// index of the PayChannel object the transaction created, which is the
// single most awkward part of doing this by hand.
export async function openPaymentChannel(options: {
  client: Client;
  // Signs with the operating key but is attributed to the funded (master)
  // account -- same Wallet.fromSeed({ masterAddress }) shape used for
  // payments, see xrpl-payment-client.ts.
  wallet: Wallet;
  payTo: string;
  depositDrops: bigint;
  settleDelaySeconds: number;
}): Promise<OpenedChannel> {
  const { client, wallet, payTo, depositDrops, settleDelaySeconds } = options;

  const tx: PaymentChannelCreate = {
    TransactionType: 'PaymentChannelCreate',
    Account: wallet.classicAddress,
    Destination: payTo,
    Amount: depositDrops.toString(),
    SettleDelay: settleDelaySeconds,
    // The key that will sign every claim on this channel. With key
    // rotation this is the OPERATING key, not the master one: agent-rail
    // verifies each claim against exactly this value as recorded on the
    // ledger.
    PublicKey: wallet.publicKey,
  };

  const prepared = await client.autofill(tx);
  const { result } = await client.submitAndWait(prepared, { wallet });

  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null || !('AffectedNodes' in meta)) {
    throw new Error('PaymentChannelCreate returned no metadata to read the channel id from');
  }
  const engineResult = 'TransactionResult' in meta ? meta.TransactionResult : undefined;
  if (engineResult !== 'tesSUCCESS') {
    throw new Error(`PaymentChannelCreate did not succeed (${String(engineResult)})`);
  }
  const created = (meta.AffectedNodes as Node[])
    .filter(isCreatedNode)
    .find((node) => node.CreatedNode.LedgerEntryType === 'PayChannel');
  if (!created) {
    throw new Error('PaymentChannelCreate created no PayChannel entry');
  }

  return { channelId: created.CreatedNode.LedgerIndex, txHash: result.hash };
}
