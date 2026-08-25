// The outbound side: an MCP server over stdio that a client (Claude
// Desktop, etc.) spawns locally. Exposes exactly two fixed tools --
// polypay_search and polypay_call -- never one entry per real catalog tool,
// no matter how large the catalog gets (see PLAN.md Fase 2c).
//
// stdout is the JSON-RPC channel here -- nothing but the SDK's own writes
// may touch it. All our own logging goes to stderr (see index.ts).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RegisteredTool } from './tool-registry.js';
import type { ToolSearchIndex } from './search.js';

const SEARCH_TOOL_NAME = 'polypay_search';
const CALL_TOOL_NAME = 'polypay_call';

export async function startServer(
  registry: Map<string, RegisteredTool>,
  searchIndex: ToolSearchIndex,
): Promise<void> {
  const server = new Server(
    { name: 'polypay-wallet-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: SEARCH_TOOL_NAME,
        description:
          'Search the PolyPay catalog for tools matching a query (by name, description, or provider). Returns the closest matches with their provider, description, and price. Call polypay_call with the returned "tool" id to actually invoke one.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What you need done, in plain language.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: CALL_TOOL_NAME,
        description:
          'Invoke a tool previously discovered via polypay_search. Payment (if the tool is priced) is signed and settled automatically with the wallet configured for this server.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'The "tool" id returned by polypay_search.',
            },
            arguments: {
              type: 'object',
              description: "Arguments for the underlying tool, per its own schema returned by polypay_search's description.",
            },
          },
          required: ['tool', 'arguments'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === SEARCH_TOOL_NAME) {
      const query = (args as { query?: unknown })?.query;
      if (typeof query !== 'string') {
        return {
          content: [{ type: 'text', text: '"query" must be a string' }],
          isError: true,
        };
      }
      const results = searchIndex.search(query);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    if (name === CALL_TOOL_NAME) {
      const toolId = (args as { tool?: unknown })?.tool;
      const toolArgs = (args as { arguments?: unknown })?.arguments;
      if (typeof toolId !== 'string') {
        return {
          content: [{ type: 'text', text: '"tool" must be a string (the id from polypay_search)' }],
          isError: true,
        };
      }
      const entry = registry.get(toolId);
      if (!entry) {
        return {
          content: [
            {
              type: 'text',
              text: `unknown tool id "${toolId}" -- call polypay_search first to get a valid id`,
            },
          ],
          isError: true,
        };
      }
      const result = await entry.x402Mcp.callTool(
        entry.realToolName,
        (toolArgs as Record<string, unknown>) ?? {},
      );
      // Reshape rather than pass through x402MCPToolCallResult as-is: it
      // carries paymentMade/paymentResponse fields the CallToolResult schema
      // doesn't know about. Payment proof still reaches the caller, just
      // relocated into _meta, which is where MCP allows arbitrary extras.
      return {
        content: result.content,
        isError: result.isError,
        _meta: {
          'x402/payment-made': result.paymentMade,
          ...(result.paymentResponse
            ? { 'x402/payment-response': result.paymentResponse }
            : {}),
        },
      };
    }

    return {
      content: [{ type: 'text', text: `unknown tool "${name}"` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
