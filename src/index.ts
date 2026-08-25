// Entry point (PLAN.md Fase 2c): discover the catalog, build the aggregated
// tool registry + search index, then hand off to the stdio MCP server.
// stdout is reserved for the MCP JSON-RPC channel -- every log here goes to
// stderr on purpose.

// Dev-only convenience -- the real published package never reads a .env
// file, the MCP client (Claude Desktop, etc.) injects POLYPAY_* directly
// into process.env via its own config (see PLAN.md Fase 3).
import 'dotenv/config';
import { createPaymentClient } from './xrpl-payment-client.js';
import { fetchCatalog } from './catalog.js';
import { buildToolRegistry } from './tool-registry.js';
import { ToolSearchIndex } from './search.js';
import { startServer } from './server.js';

const AGENT_RAIL_URL = process.env.POLYPAY_API_URL ?? 'http://localhost:3000';
// PLAN.md recommends testnet as the default for the initial release --
// mainnet stays an explicit, deliberate opt-in.
const NETWORK = process.env.POLYPAY_NETWORK ?? 'testnet';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

async function main() {
  const seed = requireEnv('POLYPAY_WALLET_SEED');
  const { paymentClient, walletAddress } = createPaymentClient(seed);
  console.error(`using wallet ${walletAddress}`);

  const providers = await fetchCatalog(AGENT_RAIL_URL, NETWORK);
  console.error(`catalog: ${providers.length} approved provider(s) on ${NETWORK}`);

  const registry = await buildToolRegistry(AGENT_RAIL_URL, providers, paymentClient);
  console.error(`discovered ${registry.size} tool(s), ready to search`);

  const searchIndex = new ToolSearchIndex(registry);

  await startServer(registry, searchIndex);
  console.error('polypay-wallet-mcp listening on stdio');
}

main().catch((error: unknown) => {
  console.error('wallet-mcp-server failed to start:', error);
  process.exitCode = 1;
});
