// Search itself is server-side now: agent-rail computes an embedding per
// tool (from the owner-typed toolName + description) at register/edit
// time, and GET /v1/catalog/search ranks by cosine similarity against the
// query -- real semantic matching, not just literal keyword overlap. This
// class is now a thin adapter: call that endpoint, then map each hit back
// to *this* process's local registry (built by buildToolRegistry, which
// holds the live x402Mcp connection each hit's `tool` id needs for
// polymitapay_call to actually invoke it).
import type { RegisteredTool } from './tool-registry.js';

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
      // A provider agent-rail knows about but whose real MCP was
      // unreachable when this process's registry was built (see
      // buildToolRegistry's try/catch) -- skip it, same as it already
      // being silently absent from tools/list would.
      const id = this.registryKeyByProviderTool.get(
        `${hit.providerId}::${hit.toolName}`,
      );
      if (!id) continue;

      results.push({
        tool: id,
        provider: hit.providerName,
        description: hit.description,
        pricePerCall: hit.pricePerCall,
        pricePerCallRlusd: hit.pricePerCallRlusd,
      });
    }
    return results;
  }
}
