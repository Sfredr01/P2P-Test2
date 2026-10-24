import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApiClient } from './apiClient';
import { TOOLS, type ToolArgs, type ToolDef } from './tools';

export interface McpServerOptions {
  apiUrl: string;
  correlationId?: string;
  fetch?: typeof fetch;
}

/** Thin MCP wrapper over the P2P HTTP API: no business logic lives here. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const api = createApiClient({
    apiUrl: options.apiUrl,
    correlationId: options.correlationId ?? randomUUID(),
    fetch: options.fetch ?? globalThis.fetch,
  });
  const server = new McpServer({ name: 'p2p-api', version: '1.0.0' });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.method === 'GET', openWorldHint: false },
      },
      async (args: ToolArgs) => {
        const { status, body, usedKey } = await invoke(api, tool, args);
        const result = usedKey === undefined ? body : { ...asObject(body), idempotency_key: usedKey };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: status >= 400 || status === 0,
        };
      },
    );
  }
  return server;
}

async function invoke(api: ReturnType<typeof createApiClient>, tool: ToolDef, args: ToolArgs) {
  const path = tool.path(args);
  if (tool.method === 'GET') return { ...(await api.get(path)), usedKey: undefined };

  const usedKey = typeof args.idempotency_key === 'string' ? args.idempotency_key : randomUUID();
  const body = Object.fromEntries(Object.entries(args).filter(([key]) => !tool.nonBodyKeys.includes(key)));
  return { ...(await api.post(path, body, usedKey)), usedKey };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { response: value };
}
