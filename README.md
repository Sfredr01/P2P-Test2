# P2P API

Agent-first Purchase-to-Pay API: vendors, purchase orders, goods receipts, invoices with cumulative 3-way match, and GL posting. Includes an MCP server so an agent can drive the flow directly.

```bash
npm install && npm run dev
```

Requires Node >= 22.13. Uses the built-in `node:sqlite`, so there are no native dependencies.

API spec: [docs/api-contract.md](docs/api-contract.md) (source of truth for request and response shapes).

## Scripts

| Script                    | What it does                                                     |
| ------------------------- | ---------------------------------------------------------------- |
| `npm run dev`             | Start the API with file watch. Seeds a fresh DB on every start.  |
| `npm start`               | Start the API without watch.                                     |
| `npm test`                | Run the Vitest suites.                                           |
| `npm run test:watch`      | Vitest in watch mode.                                            |
| `npm run typecheck`       | `tsc --noEmit`.                                                  |
| `npm run db:seed`         | Reset the DB file to the seed data (drops and recreates tables). |
| `npm run db:view [table]` | Print DB tables and GL balance. Exit 2 if the GL is unbalanced.  |
| `npm run mcp`             | Run the MCP server on stdio.                                     |

### Environment

| Variable             | Default                 | Used by                                     |
| -------------------- | ----------------------- | ------------------------------------------- |
| `PORT`               | `3000`                  | API                                         |
| `DB_PATH`            | `./data/p2p.db`         | API, `db:seed`, `db:view`                   |
| `SEED_ON_START`      | on (`false` disables)   | API: reset and seed DB on start             |
| `LOG_LEVEL`          | `info`                  | API, MCP                                    |
| `NODE_ENV`           | unset                   | `production` disables `/debug/*` routes     |
| `P2P_API_URL`        | `http://localhost:3000` | MCP server: API it calls                    |
| `P2P_CORRELATION_ID` | generated UUID          | MCP server: correlation id for its requests |

## Seed data

Loaded by `src/db/seed.ts`. Fixed ids so tests and agents can reference them directly.

Vendors:

| id               | name                | terms | category | active                                     |
| ---------------- | ------------------- | ----- | -------- | ------------------------------------------ |
| `ven_acme`       | ACME Lumber Co.     | NET30 | LUMBER   | yes                                        |
| `ven_buildright` | BuildRight Hardware | NET60 | HARDWARE | yes                                        |
| `ven_defunct`    | Defunct Supply LLC  | NET30 | GENERAL  | **no** (rejected for new POs and invoices) |

SKUs: `SKU-9234` 2x4x8 SPF Stud (4.25), `SKU-3300` Pressure-Treated 4x4x8 Post (12.50), `SKU-4410` 3/4in Plywood Sheet (54.00), `SKU-1001` 1/2in Drywall Sheet (13.75), `SKU-2040` 3in Deck Screws 5lb (29.99), `SKU-5120` Galvanized Joist Hanger 2x6 (1.85), `SKU-6001` Construction Adhesive 28oz (7.40), `SKU-7700` 16d Framing Nails 50lb (89.00). Default unit costs are in USD.

## Endpoints

| Method & path                       | Success | Notes                                        |
| ----------------------------------- | ------- | -------------------------------------------- |
| `GET /health`                       | 200     |                                              |
| `GET /vendors`, `GET /vendors/:id`  | 200     |                                              |
| `GET /skus`                         | 200     |                                              |
| `POST /purchase-orders`             | 201     | Creates a `DRAFT` PO.                        |
| `GET /purchase-orders/:id`          | 200     |                                              |
| `POST /purchase-orders/:id/submit`  | 200     | `DRAFT` to `SUBMITTED`.                      |
| `POST /purchase-orders/:id/receive` | 201     | Appends a goods receipt.                     |
| `POST /invoices`                    | 201     | Creates a `PENDING` invoice.                 |
| `GET /invoices/:id`                 | 200     |                                              |
| `POST /invoices/:id/match`          | 200     | `PENDING` to `MATCHED`, or 422.              |
| `POST /invoices/:id/approve`        | 200     | `MATCHED` to `APPROVED`, posts 2 GL entries. |
| `GET /debug/state`                  | 200     | Dev only.                                    |
| `POST /debug/reset`                 | 200     | Dev only. No `Idempotency-Key` needed.       |

Every `POST` except `/debug/reset` requires an `Idempotency-Key` header.

Quick walk-through:

```bash
KEY=$(uuidgen)
curl -s -X POST localhost:3000/purchase-orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -H "Correlation-ID: demo-001" \
  -d '{"vendor_id":"ven_acme","line_items":[{"sku":"SKU-9234","qty":50,"unit_cost":"12.50"}]}'
```

`Correlation-ID` is echoed on every response and stored on goods receipts and GL entries. Reuse the same key to retry safely.

## Agent-first design

**Success envelope**

```json
{
  "data": {},
  "warnings": [
    {
      "code": "PARTIAL_RECEIPT_PENDING",
      "description": "...",
      "next_steps": "..."
    }
  ],
  "next_actions": [
    {
      "action": "approve_invoice",
      "method": "POST",
      "path": "/invoices/inv_1/approve",
      "description": "..."
    }
  ]
}
```

`warnings` appears only when non-empty. `next_actions` tells the caller what it can do next from the current state.

**Error envelope**

```json
{
  "error": {
    "code": "INVOICE_EXCEEDS_RECEIVED_VALUE",
    "status": 422,
    "description": "...",
    "next_steps": "...",
    "details": {},
    "correlation_id": "..."
  }
}
```

Codes (status):

| Code                             | Status | Meaning                                                   |
| -------------------------------- | ------ | --------------------------------------------------------- |
| `VALIDATION_ERROR`               | 400    | Bad body or malformed JSON. `details.issues` lists paths. |
| `IDEMPOTENCY_KEY_REQUIRED`       | 400    | POST without `Idempotency-Key`.                           |
| `NOT_FOUND`                      | 404    | Unknown id or unknown route.                              |
| `INVALID_STATE_TRANSITION`       | 409    | Action not allowed from current status.                   |
| `IDEMPOTENCY_KEY_REUSED`         | 422    | Same key, different body.                                 |
| `VENDOR_INACTIVE`                | 422    | New PO or invoice for an inactive vendor.                 |
| `UNKNOWN_SKU`                    | 422    | SKU not in catalog.                                       |
| `OVER_RECEIPT`                   | 422    | Receipt exceeds outstanding qty. Nothing written.         |
| `VENDOR_MISMATCH`                | 422    | Invoice vendor differs from PO vendor.                    |
| `DUPLICATE_INVOICE`              | 422    | Same vendor and invoice number.                           |
| `NOTHING_RECEIVED`               | 422    | Match attempted before any goods received.                |
| `INVOICE_EXCEEDS_RECEIVED_VALUE` | 422    | Cumulative match failed.                                  |
| `SERVER_ERROR`                   | 500    | Unexpected. No stack or SQL in the response.              |

**Idempotency**

- Scope is `(Idempotency-Key, method, path)`. The query string is excluded.
- The request hash is the SHA-256 of the canonical JSON body (keys sorted).
- A replay returns the stored status and body with `Idempotent-Replayed: true` and writes nothing.
- The same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`.
- Responses with status < 500 are stored. A 5xx rolls back all writes, so the client can retry with the same key.
- Each POST runs in one `BEGIN IMMEDIATE` transaction. The idempotency check runs before routing, so a POST to an unknown route without a key returns 400 `IDEMPOTENCY_KEY_REQUIRED`.

**Correlation**

Header `Correlation-ID` (or `X-Correlation-ID`) is used if present, otherwise a UUID is generated. The id goes into request logs (pino, via `AsyncLocalStorage`), `goods_receipts.correlation_id`, `gl_entries.correlation_id`, and `error.correlation_id`.

## Business rules

**Purchase orders.** Vendor must exist and be active. All SKUs must be in the catalog. At least one line, unique SKUs, integer qty > 0, unit cost >= 0. Submit only from `DRAFT`.

**Receipts.** Only from `SUBMITTED` or `PARTIALLY_RECEIVED`. Each line `qty <= qty_ordered - qty_received`, otherwise the whole receipt fails with `OVER_RECEIPT`. Status becomes `RECEIVED` when every line is complete, else `PARTIALLY_RECEIVED`.

**Invoices.** Vendor must match the PO vendor. `(vendor_id, invoice_number)` is unique. A PO in any status except `CLOSED` can be invoiced.

**Cumulative 3-way match.** Runs in one transaction with the status write.

```
received_value     = Σ over PO lines (qty_received × unit_cost)
already_matched    = Σ amount of OTHER invoices on the same PO with status MATCHED | APPROVED | PAID
available_to_match = received_value − already_matched
```

1. `received_value == 0` gives 422 `NOTHING_RECEIVED`.
2. `invoice.amount > available_to_match` gives 422 `INVOICE_EXCEEDS_RECEIVED_VALUE`. The invoice stays `PENDING`.
3. Otherwise the invoice becomes `MATCHED`.

Tolerance is exact: any over-amount fails, under-amount is allowed. `PENDING` invoices do not reserve value. Every match attempt, including rejections, is saved as `last_match_result` on the invoice. A rejected invoice can be re-matched after more goods arrive.

**Partial receipt.** If any line is not fully received, a match that succeeds still returns `MATCHED` with warning `PARTIAL_RECEIPT_PENDING`. More receipts may follow.

**Approve.** Only from `MATCHED`. Re-checks the cumulative invariant, then in one transaction sets `APPROVED` and posts two GL entries:

| Entry      | Account                                                                                                        | Direction |
| ---------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| Expense    | `EXPENSE_ACCOUNT_BY_CATEGORY[vendor.category]` (see `src/domain/accounts.ts`), fallback `6000-GENERAL-EXPENSE` | Debit     |
| AP control | `2000-AP-CONTROL`                                                                                              | Credit    |

Debits equal credits for every invoice.

**Money.** The API takes and returns decimal strings with 2 decimals (`"12.50"`). Storage and domain math use integer cents. Conversion happens only in `src/domain/schemas.ts` (input) and the route presenters (output). Inputs with more than 2 decimals are rejected.

## Decisions and deviations from the challenge spec

- **GL direction corrected.** The spec posts Debit AP / Credit Expense. On invoice approval (an accrual), the correct entry is Debit Expense / Credit AP Control: expense and liability both rise. The spec version reduces a liability that was never booked.
- **`vendor.category` added.** The spec maps expense accounts by vendor category, but vendors had no category. Mapping lives in one config map in `src/domain/accounts.ts`.
- **`PARTIALLY_RECEIVED` status added.** `RECEIVED` now means every line is fully received.
- **Failed match keeps the invoice `PENDING`.** No `REJECTED` state. The result is stored on the invoice as `last_match_result`.
- **Cumulative match, not per invoice.** Per-invoice checks let two invoices each fit under the received value and double-pay.
- **No pay or close endpoints.** Out of scope for the core. `PAID` and `CLOSED` exist as statuses but nothing in the API moves an invoice or PO into them.
- **Idempotency key required on every POST.** Except `/debug/reset`.
- **Stretch goals replaced.** Exposure, credit-limit job and natural-language wrapper are out of scope. In their place: the MCP server and debug tooling below.

## MCP server

Thin HTTP client over the API. It holds no business logic.

| Tool                    | Calls                               |
| ----------------------- | ----------------------------------- |
| `list_vendors`          | `GET /vendors`                      |
| `list_skus`             | `GET /skus`                         |
| `create_purchase_order` | `POST /purchase-orders`             |
| `submit_purchase_order` | `POST /purchase-orders/:id/submit`  |
| `receive_goods`         | `POST /purchase-orders/:id/receive` |
| `get_purchase_order`    | `GET /purchase-orders/:id`          |
| `create_invoice`        | `POST /invoices`                    |
| `match_invoice`         | `POST /invoices/:id/match`          |
| `approve_invoice`       | `POST /invoices/:id/approve`        |
| `get_invoice`           | `GET /invoices/:id`                 |
| `debug_get_state`       | `GET /debug/state`                  |

Mutating tools generate an `idempotency_key` if none is given. The key is returned in the result.

Register with Claude Code (the API must be running for the tools to work):

```bash
scripts/install-mcp.sh                  # user scope; MCP_SCOPE=project|local to change
P2P_API_URL=http://localhost:3000 scripts/install-mcp.sh
claude mcp list
```

Inspect the tools in the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp/stdio.ts
```

## Debugging

- `npm run db:view` shows all tables and whether the GL balances. Use `npm run db:view invoices` for one table. Set `DB_PATH` to read another file.
- `GET /debug/state` returns vendors, SKUs, POs, invoices and `gl_summary` (`total_debit`, `total_credit`, `balanced`).
- `POST /debug/reset` drops and reseeds the database while the server runs.
- `sqlite3 data/p2p.db` for ad-hoc SQL.

## Smoke test

With the API running:

```bash
BASE=http://localhost:3000 scripts/smoke.sh
```

Needs `jq`. It resets the DB, then runs the happy path, the cumulative-match rejection, approval, idempotent replay, key reuse, and the GL balance check. Exits non-zero on the first unexpected result.

## Testing

```bash
npm test
```

Vitest with supertest, against in-memory SQLite (`openDb(':memory:')`). Suites:

| File                  | Covers                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `po.test.ts`          | PO create, submit, receive, state transitions, vendor and SKU checks            |
| `match.test.ts`       | Cumulative 3-way match, boundaries, partial receipt warning, `NOTHING_RECEIVED` |
| `approve.test.ts`     | Approval, re-check of invariant, GL entries and balance                         |
| `idempotency.test.ts` | Replay, key reuse, scope, 5xx rollback                                          |
| `correlation.test.ts` | Header handling and propagation to logs and rows                                |
| `errors.test.ts`      | Error envelope shape and codes                                                  |
| `money.test.ts`       | Decimal string conversion                                                       |
| `mcp.test.ts`         | MCP tool registry and agent flow, in-process against the app                    |
