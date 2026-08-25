// Local, offline keyword search (BM25-style, via minisearch) over the
// aggregated tool registry -- lets polypay_search return a short, relevant
// list instead of the stdio server dumping every real tool into tools/list.
// No embeddings, no network calls, no external dependency beyond the index
// itself; see PLAN.md Fase 2c for why this beats exact-match (misses
// paraphrases) without reaching for semantic search (real added cost/latency
// not justified by today's catalog size).

import MiniSearch from 'minisearch';
import type { RegisteredTool } from './tool-registry.js';

export interface SearchResult {
  tool: string;
  provider: string;
  description: string;
  pricePerCall: string | null;
  pricePerCallRlusd: string | null;
}

// Deliberately generous, not the small fixed "top 3" first floated: search
// hits are lightweight (name + description + price, not full JSON schemas),
// so a wide result set costs little and reduces the odds a legitimate
// tool from a less-favored provider gets silently excluded by a ranking
// tie-break. Real fairness (guaranteeing every competing provider surfaces
// over time, not just "however wide the window is today") is a deliberate
// feature for once the catalog has actual provider density -- not
// buildable, or testable, against the 2 providers we have right now.
const RESULT_LIMIT = 20;

export class ToolSearchIndex {
  private readonly index: MiniSearch;
  private readonly registry: Map<string, RegisteredTool>;

  constructor(registry: Map<string, RegisteredTool>) {
    this.registry = registry;
    this.index = new MiniSearch({
      fields: ['name', 'description', 'providerName'],
    });
    this.index.addAll(
      [...registry.entries()].map(([id, tool]) => ({
        id,
        name: tool.realToolName,
        description: tool.description,
        providerName: tool.providerName,
      })),
    );
  }

  search(query: string): SearchResult[] {
    const hits = this.index.search(query, {
      fuzzy: 0.2,
      prefix: true,
      boost: { name: 2 },
    });
    return hits.slice(0, RESULT_LIMIT).map((hit) => {
      const tool = this.registry.get(hit.id as string);
      if (!tool) {
        throw new Error(`search index out of sync with registry for id ${String(hit.id)}`);
      }
      return {
        tool: hit.id as string,
        provider: tool.providerName,
        description: tool.description,
        pricePerCall: tool.pricePerCall,
        pricePerCallRlusd: tool.pricePerCallRlusd,
      };
    });
  }
}
