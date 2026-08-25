// Talks to agent-rail's public, unauthenticated catalog endpoint
// (GET /v1/catalog -- see catalog.controller.ts). Nothing XRPL-specific
// here: this is plain REST against agent-rail's own API, same shape
// regardless of which network/scheme a provider settles on.

export interface CatalogTool {
  toolName: string;
  pricePerCall: string;
  pricePerCallRlusd: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  tools: CatalogTool[];
}

export async function fetchCatalog(
  agentRailUrl: string,
  network: string,
): Promise<CatalogProvider[]> {
  const res = await fetch(`${agentRailUrl}/v1/catalog?network=${network}`);
  if (!res.ok) {
    throw new Error(`failed to fetch catalog: HTTP ${res.status}`);
  }
  return (await res.json()) as CatalogProvider[];
}
