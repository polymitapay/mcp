// Aggregates every provider's tools into one flat, namespaced map. This is
// the data source for search.ts (discovery) -- it's never exposed directly
// as tools/list entries; the stdio server always exposes exactly two fixed
// tools (polypay_search, polypay_call) instead, since a large catalog
// exposed one-tool-per-entry would put every real tool's schema into the
// agent's context on every turn (see server.ts).

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { x402MCPClient } from '@x402/mcp';
import type { x402Client } from '@x402/core/client';
import type { CatalogProvider } from './catalog.js';

export interface RegisteredTool {
  providerId: string;
  providerName: string;
  realToolName: string;
  description: string;
  // Absent when the provider left this specific tool unpriced (it runs for
  // free through the proxy -- see mcp-proxy.controller.ts).
  pricePerCall: string | null;
  pricePerCallRlusd: string | null;
  x402Mcp: x402MCPClient;
}

// mcp:// resource URLs and provider names can contain almost anything --
// collapse to a safe namespace prefix so the result is a valid, readable
// tool id once joined with "__realToolName". Always suffixed with a short
// slice of the provider's id (unique by construction, unlike `name`, which
// two different providers can pick identically -- two providers wrapping the
// same public MCP with the same default name, one falling back to the same
// mcpUrl, etc.). Without this, the second provider processed silently
// overwrote the first's entries in the registry Map -- one provider's tools
// disappeared with no warning, not even a name collision the agent could see
// and pick between.
function toNamespace(provider: CatalogProvider): string {
  const sanitizedName = provider.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const shortId = provider.id.replace(/-/g, '').slice(0, 8);
  return `${sanitizedName}_${shortId}`;
}

export async function buildToolRegistry(
  agentRailUrl: string,
  providers: CatalogProvider[],
  paymentClient: x402Client,
): Promise<Map<string, RegisteredTool>> {
  const registry = new Map<string, RegisteredTool>();

  for (const provider of providers) {
    try {
      const mcpClient = new McpClient({
        name: 'wallet-mcp-server',
        version: '0.1.0',
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${agentRailUrl}/mcp/${provider.id}`),
      );
      await mcpClient.connect(transport);

      // Wrapped once per provider and kept in the registry entry -- tools/call
      // routing (polypay_call) reuses this same x402Mcp instance instead of
      // reconnecting per call.
      const x402Mcp = new x402MCPClient(mcpClient, paymentClient);
      const { tools } = await x402Mcp.listTools();

      const namespace = toNamespace(provider);
      for (const tool of tools) {
        const priced = provider.tools.find((t) => t.toolName === tool.name);
        registry.set(`${namespace}__${tool.name}`, {
          providerId: provider.id,
          providerName: provider.name,
          realToolName: tool.name,
          description: tool.description ?? '',
          pricePerCall: priced?.pricePerCall ?? null,
          pricePerCallRlusd: priced?.pricePerCallRlusd ?? null,
          x402Mcp,
        });
      }
    } catch (error) {
      // A provider's real MCP being down shouldn't take out the whole
      // registry -- skip it and keep going, same principle as agent-rail's
      // own mcp-proxy.controller.ts (fetchRealTools failures don't 500 the
      // whole tools/list either).
      console.error(
        `skipping provider ${provider.id} (${provider.name}): ${String(error)}`,
      );
    }
  }

  return registry;
}
