# P2P API Contract

Source of truth for request/response shapes. Tests and implementation both follow this file.

## Conventions

- JSON in and out. Field names are `snake_case`.
- **Money** is always a decimal string with exactly 2 decimals in responses (`"625.00"`), and a decimal string with 0–2 decimals in requests (`"12.5"`, `"12.50"`, `"12"`). Same field names in requests and responses (`unit_cost`, `amount`, `debit`, `credit`, `line_total`, ...). No `_cents` fields appear in the API. Internally everything is integer cents; conversion happens only in `src/domain/schemas.ts` (input) and route response mappers using `fromCents` (output).
- **Quantities** are JSON integers.
- **Timestamps** are ISO-8601 UTC strings (`new Date().toISOString()`).
- **IDs** are opaque strings with a prefix: `po_`, `pol_` (PO line), `gr_` (goods receipt), `grl_`, `inv_`, `gl_`. Seed vendors use fixed ids: `ven_acme`, `ven_buildright`, `ven_defunct` (inactive). Generate new ids as `${prefix}${randomUUID()}`.

## Headers

| Header | Direction | Rule |
|---|---|---|
| `Correlation-ID` | request (optional) | If absent, `X-Correlation-ID` is used; if both absent the server generates a UUID. |
| `Correlation-ID` | response (always) | Echo of the effective correlation id, on every response including errors and 404s. |
| `Idempotency-Key` | request | **Required on every POST** except `POST /debug/reset`. 1–255 chars. Missing/empty → 400 `IDEMPOTENCY_KEY_REQUIRED`. |
| `Idempotent-Replayed` | response | `true` when the response is a stored replay. Absent otherwise. |

## Success envelope

```json
{
  "data": { },
  "warnings": [ { "code": "PARTIAL_RECEIPT_PENDING", "description": "...", "next_steps": "..." } ],
  "next_actions": [ { "action": "approve_invoice", "method": "POST", "path": "/invoices/inv_1/approve", "description": "..." } ]
}
```

- `data`: resource (object) or list (array).
- `warnings`: present **only** when non-empty.
- `next_actions`: always present on single-resource responses (may be `[]`); omitted on list responses. `action` names equal the MCP tool names. They list the actions valid from the resource's current state:
  - PO `DRAFT` → `submit_purchase_order`
  - PO `SUBMITTED` → `receive_goods`, `create_invoice`
  - PO `PARTIALLY_RECEIVED` → `receive_goods`, `create_invoice`
  - PO `RECEIVED` → `create_invoice`
  - Invoice `PENDING` → `match_invoice`
  - Invoice `MATCHED` → `approve_invoice`
  - Invoice `APPROVED` / `PAID` → `[]`
  - `create_invoice` uses `"path": "/invoices"`; others use the resource's action path.

## Error envelope

```json
{
  "error": {
    "code": "INVOICE_EXCEEDS_RECEIVED_VALUE",
    "status": 422,
    "description": "Human-readable explanation with the concrete values.",
    "next_steps": "What the caller/agent should do next.",
    "details": { },
    "correlation_id": "uuid"
  }
}
```

`details` is optional. HTTP status equals `error.status`. Codes and statuses: see `src/errors.ts` (`ERROR_CATALOG`). Money values inside `details` are decimal strings.

| code | status | used for |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body fails schema, malformed JSON. `details.issues: [{ path: string, message: string }]` (path is dot-joined, e.g. `line_items.0.qty`). |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | POST without `Idempotency-Key`. |
| `NOT_FOUND` | 404 | Unknown id (`details: { entity, id }`) or unknown route (`details: { method, path }`). Entity names: `vendor`, `purchase_order`, `invoice`, `line_item`. |
| `INVALID_STATE_TRANSITION` | 409 | Action not allowed from current status. `details: { entity, id, action, current_status, allowed_from }`. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key + method + path, different body. |
| `VENDOR_INACTIVE` | 422 | New PO or invoice for an inactive vendor. `details: { vendor_id }`. |
| `UNKNOWN_SKU` | 422 | PO line SKU not in catalog. `details: { skus: string[] }` (all unknown ones). |
| `OVER_RECEIPT` | 422 | Receipt qty > outstanding on any line. `details: { lines: [{ line_item_id, sku, qty_requested, qty_outstanding }] }` (all offending lines). Whole receipt rejected, nothing written. |
| `VENDOR_MISMATCH` | 422 | Invoice `vendor_id` ≠ PO `vendor_id`. `details: { invoice_vendor_id, po_vendor_id }`. |
| `DUPLICATE_INVOICE` | 422 | Same `(vendor_id, invoice_number)` exists. `details: { existing_invoice_id }`. |
| `NOTHING_RECEIVED` | 422 | Match attempted when the PO has zero received quantity. `details` = match details (below). |
| `INVOICE_EXCEEDS_RECEIVED_VALUE` | 422 | Cumulative 3-way match failure. `details` = match details. |
| `SERVER_ERROR` | 500 | Anything unexpected. Generic description, no stack/SQL. |

Match details (both 422 match errors):
```json
{ "invoice_id": "inv_..", "po_id": "po_..", "invoice_amount": "400.00", "ordered_value": "625.00",
  "received_value": "375.00", "already_matched": "0.00", "available_to_match": "375.00" }
```

## Idempotency

- Scope: `(Idempotency-Key, method, path)`; path excludes query string.
- Request hash: sha256 of canonical JSON of the body (keys sorted recursively; missing body ≡ `{}`).
- First request: runs normally; the response (status + body) is stored **only for status < 500**.
- Replay (same key/method/path/hash): returns the stored status and body byte-for-byte equivalent, header `Idempotent-Replayed: true`, and performs **no writes**.
- Same key/method/path, different hash → 422 `IDEMPOTENCY_KEY_REUSED`.
- The same key on a different path is a different scope (no conflict).
- 5xx responses are not stored and their writes are rolled back, so the client may retry with the same key.
- Implementation: the middleware wraps the request in a single `BEGIN IMMEDIATE` transaction and stores the response in the same transaction (commit for < 500, rollback for ≥ 500). Services use `transaction()` from `src/db/connection.ts`, which nests via SAVEPOINT. All handlers and services are synchronous.

## Resources

### Vendor
```json
{ "id": "ven_acme", "name": "ACME Lumber Co.", "payment_terms": "NET30", "category": "LUMBER", "is_active": true }
```

### SKU
```json
{ "sku": "SKU-9234", "description": "2x4x8 SPF Stud", "category": "LUMBER", "default_unit_cost": "4.25" }
```

### PurchaseOrder (detail — returned by every PO endpoint)
```json
{
  "id": "po_..", "vendor_id": "ven_acme", "vendor_name": "ACME Lumber Co.",
  "status": "PARTIALLY_RECEIVED", "created_at": "..", "submitted_at": "..",
  "line_items": [
    { "id": "pol_..", "sku": "SKU-9234", "description": "2x4x8 SPF Stud",
      "qty_ordered": 50, "qty_received": 30, "qty_outstanding": 20,
      "unit_cost": "12.50", "line_total": "625.00", "received_value": "375.00",
      "receipt_status": "PARTIAL" }
  ],
  "totals": { "ordered": "625.00", "received": "375.00", "matched": "0.00", "available_to_match": "375.00" },
  "receipts": [
    { "id": "gr_..", "received_by": "dock-1", "received_at": "..",
      "line_items": [ { "line_item_id": "pol_..", "sku": "SKU-9234", "qty": 30 } ] }
  ],
  "invoices": [ { "id": "inv_..", "invoice_number": "INV-1", "amount": "375.00", "status": "PENDING" } ]
}
```
- `receipt_status`: `NOT_RECEIVED` (0), `PARTIAL` (0 < received < ordered), `FULL`.
- `totals.matched` = Σ amount of invoices on this PO in `MATCHED|APPROVED|PAID`. `available_to_match` = `received − matched`.
- `receipts` oldest first; `invoices` oldest first.
- `description` defaults to the catalog description when omitted on create.

### Invoice (returned by every invoice endpoint)
```json
{
  "id": "inv_..", "vendor_id": "ven_acme", "po_id": "po_..", "invoice_number": "INV-1001",
  "amount": "375.00", "status": "MATCHED",
  "created_at": "..", "matched_at": "..", "approved_at": null,
  "last_match_result": {
    "outcome": "MATCHED", "reason": "OK",
    "invoice_amount": "375.00", "ordered_value": "625.00", "received_value": "375.00",
    "already_matched": "0.00", "available_to_match": "375.00",
    "partial_receipt_pending": true, "evaluated_at": ".."
  },
  "gl_entries": [
    { "id": "gl_..", "account_code": "5100-EXPENSE-LUMBER", "debit": "375.00", "credit": "0.00", "posted_at": "..", "correlation_id": ".." },
    { "id": "gl_..", "account_code": "2000-AP-CONTROL", "debit": "0.00", "credit": "375.00", "posted_at": "..", "correlation_id": ".." }
  ]
}
```
`last_match_result` is `null` before the first match attempt. `gl_entries` is `[]` until approved.

## Endpoints

| Method & path | Body | Success |
|---|---|---|
| `GET /health` | – | 200 `{ "data": { "status": "ok" } }` |
| `GET /vendors` | – | 200 list of Vendor |
| `GET /vendors/:id` | – | 200 Vendor (`next_actions: []`) · 404 |
| `GET /skus` | – | 200 list of SKU |
| `POST /purchase-orders` | `{ vendor_id, line_items: [{ sku, qty, unit_cost, description? }] }` | **201** PO (status `DRAFT`) |
| `POST /purchase-orders/:id/submit` | `{}` or none | 200 PO (`SUBMITTED`, `submitted_at` set) |
| `GET /purchase-orders/:id` | – | 200 PO |
| `POST /purchase-orders/:id/receive` | `{ received_by, line_items: [{ line_item_id, qty }] }` | **201** PO (new receipt appended; status `PARTIALLY_RECEIVED` or `RECEIVED`) |
| `POST /invoices` | `{ vendor_id, po_id, invoice_number, amount }` | **201** Invoice (`PENDING`) |
| `POST /invoices/:id/match` | `{}` or none | 200 Invoice (`MATCHED`) |
| `GET /invoices/:id` | – | 200 Invoice |
| `POST /invoices/:id/approve` | `{}` or none | 200 Invoice (`APPROVED`, 2 GL entries) |
| `GET /debug/state` | – | 200 `{ data: { vendors, skus, purchase_orders: PO[], invoices: Invoice[], gl_summary: { total_debit, total_credit, balanced } } }` |
| `POST /debug/reset` | – | 200 `{ data: { reset: true } }`; no Idempotency-Key needed |

`/debug/*` routes exist only when `NODE_ENV !== 'production'`.

## Business rules

**Create PO**: vendor must exist (404 `NOT_FOUND` entity `vendor`) and be active (`VENDOR_INACTIVE`). All SKUs must exist (`UNKNOWN_SKU`). ≥ 1 line, unique SKUs, qty > 0 integer, unit_cost ≥ 0 (schema, `VALIDATION_ERROR`). Check order: schema → vendor exists → vendor active → SKUs.

**Submit**: only from `DRAFT`, else `INVALID_STATE_TRANSITION` (`allowed_from: ["DRAFT"]`, `action: "submit"`). Inactive vendor does not block submit.

**Receive**: only from `SUBMITTED` or `PARTIALLY_RECEIVED`, else `INVALID_STATE_TRANSITION` (`action: "receive"`). Every `line_item_id` must belong to this PO (404 entity `line_item`). For each line `qty ≤ qty_ordered − qty_received`, else `OVER_RECEIPT` (all-or-nothing). Writes one goods receipt (+ lines, stamped with the correlation id), increments `qty_received`, then status = `RECEIVED` if every line is fully received, else `PARTIALLY_RECEIVED`. Multiple receipts per PO are allowed.

**Create invoice**: vendor exists (404) and active (`VENDOR_INACTIVE`); PO exists (404 entity `purchase_order`); `vendor_id` equals PO vendor (`VENDOR_MISMATCH`); `(vendor_id, invoice_number)` unique (`DUPLICATE_INVOICE`). PO in any status except `CLOSED` (`INVALID_STATE_TRANSITION`, `action: "invoice"`). Status `PENDING`.

**Match (cumulative 3-way match)** — only from `PENDING` (`INVALID_STATE_TRANSITION`, `action: "match"`, `allowed_from: ["PENDING"]`).
```
received_value     = Σ over PO lines (qty_received × unit_cost)
ordered_value      = Σ over PO lines (qty_ordered × unit_cost)
already_matched    = Σ amount of OTHER invoices on the same PO with status MATCHED|APPROVED|PAID
available_to_match = received_value − already_matched
```
1. `received_value == 0` → 422 `NOTHING_RECEIVED`.
2. `invoice.amount > available_to_match` → 422 `INVOICE_EXCEEDS_RECEIVED_VALUE`. Invoice stays `PENDING`.
3. Otherwise → `MATCHED`, `matched_at` set. If any PO line has `qty_received < qty_ordered`, add warning `PARTIAL_RECEIPT_PENDING` (`next_steps` says the invoice is matched only against goods received so far, more receipts may follow, and approving is allowed).

PENDING invoices never consume capacity. On every outcome (including both rejections) the attempt is persisted as `last_match_result` on the invoice (the rejection write is committed, then the 422 is returned). A rejected invoice may be re-matched later (e.g. after more goods are received).

**Approve** — only from `MATCHED` (`INVALID_STATE_TRANSITION`, `action: "approve"`, `allowed_from: ["MATCHED"]`). Re-checks the cumulative invariant (`amount + Σ other MATCHED|APPROVED|PAID ≤ received_value`) and fails with `INVOICE_EXCEEDS_RECEIVED_VALUE` if violated (defense in depth). Then, in one transaction: status `APPROVED`, `approved_at`, and exactly two GL entries:
- **Debit** expense account `EXPENSE_ACCOUNT_BY_CATEGORY[vendor.category]` (`src/domain/accounts.ts`) for `amount`.
- **Credit** `AP_CONTROL_ACCOUNT` (`2000-AP-CONTROL`) for `amount`.

Σ debits = Σ credits per invoice. (The challenge text lists debit AP / credit Expense; that is reversed for an AP accrual — documented deviation.)

## Correlation

The effective correlation id is: put in `AsyncLocalStorage` (`src/context.ts`), echoed in the `Correlation-ID` response header, included as `error.correlation_id`, written to `goods_receipts.correlation_id` and `gl_entries.correlation_id`, and bound to request logs.

## MCP server

`createMcpServer({ apiUrl, correlationId?, fetch? })` in `src/mcp/server.ts` returns an `McpServer` (from `@modelcontextprotocol/sdk/server/mcp.js`). `src/mcp/stdio.ts` connects it to stdio using `P2P_API_URL` (default `http://localhost:3000`). It is a thin HTTP client over the API — no business logic.

Tools (names = `next_actions[].action`):

| tool | input | calls |
|---|---|---|
| `list_vendors` | `{}` | `GET /vendors` |
| `list_skus` | `{}` | `GET /skus` |
| `create_purchase_order` | `{ vendor_id, line_items: [{ sku, qty, unit_cost, description? }], idempotency_key? }` | `POST /purchase-orders` |
| `submit_purchase_order` | `{ purchase_order_id, idempotency_key? }` | `POST /purchase-orders/:id/submit` |
| `receive_goods` | `{ purchase_order_id, received_by, line_items: [{ line_item_id, qty }], idempotency_key? }` | `POST /purchase-orders/:id/receive` |
| `get_purchase_order` | `{ purchase_order_id }` | `GET /purchase-orders/:id` |
| `create_invoice` | `{ vendor_id, po_id, invoice_number, amount, idempotency_key? }` | `POST /invoices` |
| `match_invoice` | `{ invoice_id, idempotency_key? }` | `POST /invoices/:id/match` |
| `approve_invoice` | `{ invoice_id, idempotency_key? }` | `POST /invoices/:id/approve` |
| `get_invoice` | `{ invoice_id }` | `GET /invoices/:id` |
| `debug_get_state` | `{}` | `GET /debug/state` |

- Money inputs are decimal strings, passed through unchanged.
- Mutating tools: if `idempotency_key` is omitted, generate a UUID.
- Every request sends `Correlation-ID`: the per-server-instance id (from options, else a UUID generated once at creation).
- Tool result: one `text` content item containing `JSON.stringify(result, null, 2)` where `result` is the API response body, plus for mutating tools an extra top-level field `idempotency_key` (the key used) merged into that object. If the HTTP status is ≥ 400 set `isError: true` (the text is still the full error envelope, so the agent sees `next_steps`). Network failure → `isError: true` with an error-envelope-shaped object, code `SERVER_ERROR`, `next_steps` telling the agent to check that the API is running at `apiUrl`.
