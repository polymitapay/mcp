// Search itself is server-side now: agent-rail computes an embedding per
// tool (from the owner-typed toolName + description) at register/edit
// time, and GET /v1/catalog/search ranks by cosine similarity against the
// query -- real semantic matching, not just literal keyword overlap. This
// class is now a thin adapter: call that endpoint, then map each hit back
// to *this* process's local registry (built by buildToolRegistry, which
// holds the live x402Mcp connection each hit's `tool` id needs for
// polymitapay_call to actually invoke it).
import type { x402MCPClient } from '@x402/mcp';
import type { x402Client } from '@x402/core/client';
import { connectProvider, toNamespace, type RegisteredTool } from './tool-registry.js';

export interface SearchResult {
  tool: string;
  provider: string;
  description: string;
  pricePerCall: string | null;
  pricePerCallRlusd: string | null;
}

interface CatalogSearchHit {
  providerId: string;
  providerName: string;
  toolName: string;
  description: string;
  pricePerCall: string;
  pricePerCallRlusd: string;
}

export class ToolSearchIndex {
  // "providerId::toolName" -> this process's local registry key, so a hit
  // from agent-rail's search can be resolved back to a real, callable
  // x402Mcp connection.
  private readonly registryKeyByProviderTool: Map<string, string>;

  constructor(
    private readonly registry: Map<string, RegisteredTool>,
    private readonly connections: Map<string, x402MCPClient>,
    private readonly paymentClient: x402Client,
    private readonly agentRailUrl: string,
    private readonly network: string,
  ) {
    this.registryKeyByProviderTool = new Map(
      [...registry.entries()].map(([id, tool]) => [
        `${tool.providerId}::${tool.realToolName}`,
        id,
      ]),
    );
  }

  async search(query: string): Promise<SearchResult[]> {
    const url = new URL(`${this.agentRailUrl}/v1/catalog/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('network', this.network);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`catalog search failed: HTTP ${res.status}`);
    }
    const hits = (await res.json()) as CatalogSearchHit[];

    const results: SearchResult[] = [];
    for (const hit of hits) {
      let id = this.registryKeyByProviderTool.get(
        `${hit.providerId}::${hit.toolName}`,
      );
      // A provider approved (or a tool renamed) after this process started
      // isn't in the registry snapshot buildToolRegistry took at launch --
      // connect to it now instead of dropping the hit, so a fresh provider
      // is usable without restarting the whole MCP server.
      if (!id) {
        id = await this.connectMissingProvider(hit);
      }
      if (!id) continue;

      const entry = this.registry.get(id);
      if (!entry) continue;

      results.push({
        tool: id,
        provider: entry.providerName,
        description: entry.description || hit.description,
        pricePerCall: entry.pricePerCall,
        pricePerCallRlusd: entry.pricePerCallRlusd,
      });
    }
    return results;
  }

  private async connectMissingProvider(
    hit: CatalogSearchHit,
  ): Promise<string | undefined> {
    try {
      const x402Mcp = await connectProvider(
        this.agentRailUrl,
        hit.providerId,
        this.paymentClient,
        this.connections,
      );
      // Cross-check against the provider's real tool list, same as
      // buildToolRegistry does -- agent-rail's stored toolName is
      // owner-typed and isn't guaranteed to match what the real MCP
      // actually calls it (see the "PING TOOL" vs "ping" mismatch found
      // 2026-09-07).
      const { tools } = await x402Mcp.listTools();
      const realTool = tools.find((t) => t.name === hit.toolName);
      if (!realTool) {
        console.error(
          `provider ${hit.providerId} (${hit.providerName}) has no real tool named "${hit.toolName}" -- dropping search hit`,
        );
        return undefined;
      }

      const namespace = toNamespace(hit.providerId, hit.providerName);
      const id = `${namespace}__${realTool.name}`;
      this.registry.set(id, {
        providerId: hit.providerId,
        providerName: hit.providerName,
        realToolName: realTool.name,
        description: realTool.description ?? hit.description,
        pricePerCall: hit.pricePerCall,
        pricePerCallRlusd: hit.pricePerCallRlusd,
        x402Mcp,
      });
      this.registryKeyByProviderTool.set(
        `${hit.providerId}::${realTool.name}`,
        id,
      );
      return id;
    } catch (error) {
      console.error(
        `could not lazily connect provider ${hit.providerId} (${hit.providerName}): ${String(error)}`,
      );
      return undefined;
    }
  }
}
