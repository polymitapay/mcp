// Step 1 of the wallet-mcp-server plan (see PLAN.md, Fase 2a): validate the
// x402 auto-payment loop end to end against a single hardcoded provider,
// before adding catalog discovery or the outbound stdio server. Logs go to
// stderr on purpose -- stdout is reserved for the MCP JSON-RPC channel once
// this becomes a real stdio server.

// Dev-only convenience -- the real published package never reads a .env
// file, the MCP client (Claude Desktop, etc.) injects POLYPAY_* directly
// into process.env via its own config (see PLAN.md, Fase 3).
import 'dotenv/config';
import { Client as XrplClient } from 'xrpl';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { x402MCPClient } from '@x402/mcp';
import { createPaymentClient } from './xrpl-payment-client.js';

const AGENT_RAIL_URL = process.env.POLYPAY_API_URL ?? 'http://localhost:3000';
const PROVIDER_ID =
  process.env.POLYPAY_TEST_PROVIDER_ID ?? '6f68fad7-993c-499b-bbbc-fbda9d5212c9';
const TOOL_NAME = 'summarize';

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

  const xrplClient = new XrplClient('wss://s.altnet.rippletest.net:51233');
  await xrplClient.connect();
  const balanceBefore = await xrplClient.getXrpBalance(walletAddress);
  console.error(`balance before: ${balanceBefore} XRP`);

  const mcpClient = new McpClient({
    name: 'wallet-mcp-server-smoke-test',
    version: '0.1.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${AGENT_RAIL_URL}/mcp/${PROVIDER_ID}`),
  );
  await mcpClient.connect(transport);

  const x402Mcp = new x402MCPClient(mcpClient, paymentClient);

  try {
    const result = await x402Mcp.callTool(TOOL_NAME, {
      text: 'hola desde wallet-mcp-server, paso 1',
    });
    console.error('tool result:', JSON.stringify(result, null, 2));
  } finally {
    await mcpClient.close();
  }

  const balanceAfter = await xrplClient.getXrpBalance(walletAddress);
  console.error(`balance after: ${balanceAfter} XRP`);
  console.error(`spent: ${Number(balanceBefore) - Number(balanceAfter)} XRP`);

  await xrplClient.disconnect();
}

main().catch((error: unknown) => {
  console.error('smoke test failed:', error);
  process.exitCode = 1;
});
