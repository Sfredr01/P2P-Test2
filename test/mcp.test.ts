import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApp } from '../src/app';
import { openDb, type Db } from '../src/db/connection';
import { seed } from '../src/db/seed';
import { createMcpServer } from '../src/mcp/server';

const CORRELATION_ID = 'mcp-test-corr';

// Tool responses are JSON text; the shape is asserted per test, so keep it loose here.
type Body = any;

interface ToolResult {
  isError: boolean;
  body: Body;
}

const EXPECTED_TOOL_NAMES = [
  'list_vendors',
  'list_skus',
  'create_purchase_order',
  'submit_purchase_order',
  'receive_goods',
  'get_purchase_order',
  'create_invoice',
  'match_invoice',
  'approve_invoice',
  'get_invoice',
  'debug_get_state',
];

/** Starts the real Express app on an ephemeral port with a fresh seeded in-memory DB. */
async function startApi(): Promise<{ db: Db; httpServer: Server; apiUrl: string }> {
  const db = openDb(':memory:');
  seed(db);
  const app = createApp(db);
  const httpServer = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('API server has no port');
  return { db, httpServer, apiUrl: `http://127.0.0.1:${address.port}` };
}

async function stopApi(httpServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
    httpServer.closeAllConnections();
  });
}

/** Links an McpServer to a Client over an in-memory transport pair. */
async function connectMcp(apiUrl: string): Promise<{ server: McpServer; client: Client }> {
  const server = createMcpServer({ apiUrl, correlationId: CORRELATION_ID });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { server, client };
}

describe('MCP tool server', () => {
  let httpServer: Server | undefined;
  let server: McpServer | undefined;
  let client: Client | undefined;
  let apiUrl = '';

  /** Calls a tool and parses the single text content item as JSON. */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (!client) throw new Error('client not connected');
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? 'null') };
  }

  beforeEach(async () => {
    const api = await startApi();
    httpServer = api.httpServer;
    apiUrl = api.apiUrl;
    const connected = await connectMcp(apiUrl);
    server = connected.server;
    client = connected.client;
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (httpServer) await stopApi(httpServer);
    client = undefined;
    server = undefined;
    httpServer = undefined;
  });

  /** Runs the happy path through the tools only. Returns the ids the tests need. */
  async function runFullFlow(receivedQty = 30, invoiceAmount = '375.00') {
    const created = await call('create_purchase_order', {
      vendor_id: 'ven_acme',
      line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
    });
    const poId: string = created.body.data.id;
    const lineId: string = created.body.data.line_items[0].id;

    await call('submit_purchase_order', { purchase_order_id: poId });
    await call('receive_goods', {
      purchase_order_id: poId,
      received_by: 'dock-1',
      line_items: [{ line_item_id: lineId, qty: receivedQty }],
    });
    const invoice = await call('create_invoice', {
      vendor_id: 'ven_acme',
      po_id: poId,
      invoice_number: 'INV-MCP-1',
      amount: invoiceAmount,
    });
    const invoiceId: string = invoice.body.data.id;
    await call('match_invoice', { invoice_id: invoiceId });
    const approved = await call('approve_invoice', { invoice_id: invoiceId });
    return { poId, lineId, invoiceId, approved };
  }

  describe('tool registry', () => {
    it('lists exactly the documented tools', async () => {
      const { tools } = await client!.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    });

    it('gives every tool a non-empty description and an object input schema', async () => {
      const { tools } = await client!.listTools();
      for (const tool of tools) {
        expect(tool.description, `${tool.name} description`).toBeTruthy();
        expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe('object');
      }
    });

    it('create_purchase_order accepts vendor_id, line_items and idempotency_key', async () => {
      const { tools } = await client!.listTools();
      const createPo = tools.find((tool) => tool.name === 'create_purchase_order');
      expect(createPo).toBeDefined();
      expect(Object.keys(createPo?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(['vendor_id', 'line_items', 'idempotency_key']),
      );
    });
  });

  describe('reads', () => {
    it('list_vendors returns the three seeded vendors', async () => {
      const res = await call('list_vendors');
      expect(res.isError).toBe(false);
      expect(res.body.data).toHaveLength(3);
    });
  });

  describe('agent flow via tools', () => {
    it('create_purchase_order returns a DRAFT PO with idempotency key and next_actions', async () => {
      const res = await call('create_purchase_order', {
        vendor_id: 'ven_acme',
        line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
      });
      expect(res.isError).toBe(false);
      expect(res.body.data.status).toBe('DRAFT');
      expect(typeof res.body.idempotency_key).toBe('string');
      expect(res.body.idempotency_key.length).toBeGreaterThan(0);
      expect(res.body.next_actions.map((action: { action: string }) => action.action)).toContain(
        'submit_purchase_order',
      );
    });

    it('submit, receive (partial), invoice, match, approve advance the statuses', async () => {
      const created = await call('create_purchase_order', {
        vendor_id: 'ven_acme',
        line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
      });
      const poId: string = created.body.data.id;
      const lineId: string = created.body.data.line_items[0].id;

      const submitted = await call('submit_purchase_order', { purchase_order_id: poId });
      expect(submitted.body.data.status).toBe('SUBMITTED');

      const received = await call('receive_goods', {
        purchase_order_id: poId,
        received_by: 'dock-1',
        line_items: [{ line_item_id: lineId, qty: 30 }],
      });
      expect(received.body.data.status).toBe('PARTIALLY_RECEIVED');

      const invoice = await call('create_invoice', {
        vendor_id: 'ven_acme',
        po_id: poId,
        invoice_number: 'INV-MCP-1',
        amount: '375.00',
      });
      expect(invoice.body.data.status).toBe('PENDING');
      const invoiceId: string = invoice.body.data.id;

      const matched = await call('match_invoice', { invoice_id: invoiceId });
      expect(matched.body.data.status).toBe('MATCHED');
      expect(matched.body.warnings[0].code).toBe('PARTIAL_RECEIPT_PENDING');

      const approved = await call('approve_invoice', { invoice_id: invoiceId });
      expect(approved.body.data.status).toBe('APPROVED');
      const entries: Array<{ account_code: string; debit: string; credit: string }> =
        approved.body.data.gl_entries;
      expect(entries).toHaveLength(2);
      expect(entries.find((entry) => entry.account_code === '2000-AP-CONTROL')?.credit).toBe('375.00');
      expect(entries.find((entry) => entry.debit !== '0.00')?.debit).toBe('375.00');
    });

    it('get_purchase_order and get_invoice agree with the approved state', async () => {
      const { poId, invoiceId } = await runFullFlow();

      const po = await call('get_purchase_order', { purchase_order_id: poId });
      expect(po.isError).toBe(false);
      expect(po.body.data.id).toBe(poId);
      expect(po.body.data.status).toBe('PARTIALLY_RECEIVED');
      expect(po.body.data.totals.received).toBe('375.00');
      expect(po.body.data.totals.matched).toBe('375.00');
      expect(po.body.data.invoices.map((inv: { id: string }) => inv.id)).toContain(invoiceId);

      const invoice = await call('get_invoice', { invoice_id: invoiceId });
      expect(invoice.isError).toBe(false);
      expect(invoice.body.data.id).toBe(invoiceId);
      expect(invoice.body.data.status).toBe('APPROVED');
      expect(invoice.body.data.amount).toBe('375.00');
      expect(invoice.body.data.gl_entries).toHaveLength(2);
    });

    it('stamps the server correlation id on GL entries', async () => {
      const { approved } = await runFullFlow();
      const entries: Array<{ correlation_id: string }> = approved.body.data.gl_entries;
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.correlation_id).toBe(CORRELATION_ID);
    });

    it('debug_get_state reports a balanced GL after the full flow', async () => {
      await runFullFlow();
      const state = await call('debug_get_state');
      expect(state.isError).toBe(false);
      expect(state.body.data.gl_summary.balanced).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('two create_purchase_order calls with the same key return the same PO', async () => {
      const args = {
        vendor_id: 'ven_acme',
        line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
        idempotency_key: 'po-key-fixed-1',
      };
      const first = await call('create_purchase_order', args);
      const second = await call('create_purchase_order', args);
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(first.body.idempotency_key).toBe('po-key-fixed-1');
      expect(second.body.idempotency_key).toBe('po-key-fixed-1');
    });
  });

  describe('errors surfaced to the agent', () => {
    it('match_invoice over the received value returns INVOICE_EXCEEDS_RECEIVED_VALUE', async () => {
      const created = await call('create_purchase_order', {
        vendor_id: 'ven_acme',
        line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
      });
      const poId: string = created.body.data.id;
      const lineId: string = created.body.data.line_items[0].id;
      await call('submit_purchase_order', { purchase_order_id: poId });
      await call('receive_goods', {
        purchase_order_id: poId,
        received_by: 'dock-1',
        line_items: [{ line_item_id: lineId, qty: 10 }],
      });
      const invoice = await call('create_invoice', {
        vendor_id: 'ven_acme',
        po_id: poId,
        invoice_number: 'INV-MCP-OVER',
        amount: '375.00',
      });

      const res = await call('match_invoice', { invoice_id: invoice.body.data.id });
      expect(res.isError).toBe(true);
      expect(res.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');
      expect(res.body.error.next_steps).toBeTruthy();
      expect(typeof res.body.error.details.available_to_match).toBe('string');
      expect(res.body.error.details.available_to_match).toBe('125.00');
    });

    it('get_invoice for an unknown id returns NOT_FOUND', async () => {
      const res = await call('get_invoice', { invoice_id: 'inv_nope' });
      expect(res.isError).toBe(true);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('create_purchase_order for an inactive vendor returns VENDOR_INACTIVE', async () => {
      const res = await call('create_purchase_order', {
        vendor_id: 'ven_defunct',
        line_items: [{ sku: 'SKU-9234', qty: 1, unit_cost: '12.50' }],
      });
      expect(res.isError).toBe(true);
      expect(res.body.error.code).toBe('VENDOR_INACTIVE');
    });
  });

  describe('money', () => {
    it('passes unit_cost through as a two-decimal string', async () => {
      const res = await call('create_purchase_order', {
        vendor_id: 'ven_acme',
        line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
      });
      expect(res.body.data.line_items[0].unit_cost).toBe('12.50');
      expect(res.body.data.line_items[0].line_total).toBe('625.00');
    });
  });
});

describe('MCP tool server when the API is unreachable', () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  it('list_vendors returns SERVER_ERROR with next_steps naming the apiUrl', async () => {
    const unreachableUrl = 'http://127.0.0.1:1';
    const connected = await connectMcp(unreachableUrl);
    server = connected.server;
    client = connected.client;

    const result = await client.callTool({ name: 'list_vendors', arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    const body = JSON.parse(content[0]?.text ?? 'null');

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe('SERVER_ERROR');
    expect(body.error.next_steps).toContain(unreachableUrl);
  });
});
