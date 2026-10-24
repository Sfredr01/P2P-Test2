import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server';

// stdout belongs to the MCP transport: log to stderr only.
const apiUrl = process.env.P2P_API_URL ?? 'http://localhost:3000';
const server = createMcpServer({ apiUrl, correlationId: process.env.P2P_CORRELATION_ID });

await server.connect(new StdioServerTransport());
console.error(`p2p-api MCP server ready on stdio (API: ${apiUrl})`);
