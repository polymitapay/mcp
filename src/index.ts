#!/usr/bin/env node
// Entry point: discover the catalog, build the aggregated tool registry +
// search index, then hand off to the stdio MCP server. stdout is reserved
// for the MCP JSON-RPC channel -- every log here goes to stderr on purpose.

// The real published package never reads a .env file -- the MCP client
// (Claude Desktop, etc.) injects POLYPAY_* directly into process.env via
// its own config. Loading one for local development is the `dev` npm
// script's job (node's own --env-file flag), never this module's -- a
// static `import 'dotenv/config'` here would run even for real installs,
// and dotenv is a devDependency only, so it isn't there to import.
import { createPaymentClient } from './xrpl-payment-client.js';
import { fetchCatalog } from './catalog.js';
import { buildToolRegistry } from './tool-registry.js';
import { ToolSearchIndex } from './search.js';
import { startServer } from './server.js';
import { runSetupWizard } from './setup-wizard.js';

const AGENT_RAIL_URL = process.env.POLYPAY_API_URL ?? 'https://api.polymitapay.com';
// Testnet is the default for a first run -- safer for someone trying this
// out for the first time; mainnet (real funds) stays an explicit,
// deliberate opt-in.
const NETWORK: 'testnet' | 'mainnet' =
  process.env.POLYPAY_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

// All optional -- omitted means "no limit", same as before these existed.
function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

async function main() {
  // An MCP client (Claude Desktop, Claude Code, etc.) spawns this over
  // stdio with POLYPAY_WALLET_SEED already injected via its own config --
  // it never has a TTY. Only a human running `npx @polymitapay/mcp`
  // directly, seed not configured yet, gets the interactive wizard;
  // anything else falls straight through to the real server, same as
  // before this existed.
  if (!process.env.POLYPAY_WALLET_SEED && process.stdin.isTTY && process.stdout.isTTY) {
    await runSetupWizard();
    return;
  }

  const seed = requireEnv('POLYPAY_WALLET_SEED');
  const { paymentClient, walletAddress, setPreferredAsset } = createPaymentClient(
    seed,
    NETWORK,
    {
      maxPerCallXrp: optionalEnv('POLYPAY_MAX_PER_CALL_XRP'),
      maxPerCallRlusd: optionalEnv('POLYPAY_MAX_PER_CALL_RLUSD'),
      maxTotalXrp: optionalEnv('POLYPAY_MAX_TOTAL_XRP'),
      maxTotalRlusd: optionalEnv('POLYPAY_MAX_TOTAL_RLUSD'),
    },
  );
  console.error(`using wallet ${walletAddress}`);

  const providers = await fetchCatalog(AGENT_RAIL_URL, NETWORK);
  console.error(`catalog: ${providers.length} approved provider(s) on ${NETWORK}`);

  const registry = await buildToolRegistry(AGENT_RAIL_URL, providers, paymentClient);
  console.error(`discovered ${registry.size} tool(s), ready to search`);

  const searchIndex = new ToolSearchIndex(registry);

  await startServer(registry, searchIndex, setPreferredAsset);
  console.error('polymitapay-wallet-mcp listening on stdio');
}

main().catch((error: unknown) => {
  console.error('wallet-mcp-server failed to start:', error);
  process.exitCode = 1;
});
