#!/usr/bin/env bash
# End-to-end smoke test against a running API. Resets the DB, then walks the P2P happy
# path plus the two main rejections and idempotency behaviour. Exits non-zero on the
# first unexpected result.
# Usage: BASE=http://localhost:3000 scripts/smoke.sh

set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
CID="smoke-$(date +%s)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HDR="$WORK/headers.txt"
BODY="$WORK/body.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: smoke.sh needs jq on PATH (macOS: brew install jq)" >&2
  exit 1
fi

pass() { printf '  ✔ %s\n' "$1"; }
die() {
  printf '  ✘ %s\n' "$1" >&2
  exit 1
}
section() { printf '\n== %s\n' "$1"; }

# api METHOD PATH IDEMPOTENCY_KEY BODY -> sets STATUS; response body in $BODY, headers in $HDR
STATUS=""
api() {
  local method="$1" path="$2" key="$3" body="$4"
  local args=(-sS -X "$method" -H "Correlation-ID: $CID" -D "$HDR" -o "$BODY" -w '%{http_code}')
  if [[ -n "$body" ]]; then args+=(-H "Content-Type: application/json" --data "$body"); fi
  if [[ -n "$key" ]]; then args+=(-H "Idempotency-Key: $key"); fi
  STATUS=$(curl "${args[@]}" "$BASE$path") ||
    die "cannot reach $BASE$path. Is the API running? (npm run dev)"
}

# header NAME -> value of a response header, empty if absent
header() {
  tr -d '\r' <"$HDR" | awk -F': ' -v h="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" \
    'tolower($1) == h { print $2 }' | tail -1
}

# field JQ_EXPR -> raw value from the last response body
field() { jq -r "$1" "$BODY"; }

expect_status() {
  local want="$1" label="$2"
  if [[ "$STATUS" != "$want" ]]; then
    die "$label: expected HTTP $want, got $STATUS: $(jq -c . "$BODY" 2>/dev/null || cat "$BODY")"
  fi
  pass "$label (HTTP $STATUS)"
}

expect_eq() {
  local actual="$1" want="$2" label="$3"
  if [[ "$actual" != "$want" ]]; then die "$label: expected '$want', got '$actual'"; fi
  pass "$label ($actual)"
}

section "Reset database ($CID)"
api POST /debug/reset "" '{}'
expect_status 200 "POST /debug/reset"
expect_eq "$(header Correlation-ID)" "$CID" "Correlation-ID echoed"

section "Create and submit purchase order"
po_body=$(jq -nc '{vendor_id: "ven_acme", line_items: [{sku: "SKU-9234", qty: 50, unit_cost: "12.50"}]}')
api POST /purchase-orders "$CID-po" "$po_body"
expect_status 201 "create PO"
PO_ID=$(field '.data.id')
LINE_ID=$(field '.data.line_items[0].id')
expect_eq "$(field '.data.status')" "DRAFT" "PO status after create"
expect_eq "$(field '.data.totals.ordered')" "625.00" "PO ordered value"

api POST "/purchase-orders/$PO_ID/submit" "$CID-submit" '{}'
expect_status 200 "submit PO"
expect_eq "$(field '.data.status')" "SUBMITTED" "PO status after submit"

section "Receive 30 of 50 units"
receive_body=$(jq -nc --arg line "$LINE_ID" '{received_by: "smoke", line_items: [{line_item_id: $line, qty: 30}]}')
api POST "/purchase-orders/$PO_ID/receive" "$CID-receive" "$receive_body"
expect_status 201 "receive goods"
expect_eq "$(field '.data.status')" "PARTIALLY_RECEIVED" "PO status after partial receipt"
expect_eq "$(field '.data.totals.received')" "375.00" "received value"

section "Invoice A (375.00) matches against received goods"
inv_a_body=$(jq -nc --arg v ven_acme --arg p "$PO_ID" '{vendor_id: $v, po_id: $p, invoice_number: "SMOKE-A", amount: "375.00"}')
api POST /invoices "$CID-inv-a" "$inv_a_body"
expect_status 201 "create invoice A"
INV_A=$(field '.data.id')

api POST "/invoices/$INV_A/match" "$CID-match-a" '{}'
expect_status 200 "match invoice A"
expect_eq "$(field '.data.status')" "MATCHED" "invoice A status"
warning_codes=$(field '[.warnings[]?.code] | join(",")')
jq -r '.warnings[]? | "  warning \(.code): \(.description)"' "$BODY"
if [[ "$warning_codes" != *PARTIAL_RECEIPT_PENDING* ]]; then
  die "match invoice A: expected PARTIAL_RECEIPT_PENDING warning, got '${warning_codes:-none}'"
fi
pass "PARTIAL_RECEIPT_PENDING warning present"

section "Invoice B (300.00) exceeds remaining receivable value"
inv_b_body=$(jq -nc --arg v ven_acme --arg p "$PO_ID" '{vendor_id: $v, po_id: $p, invoice_number: "SMOKE-B", amount: "300.00"}')
api POST /invoices "$CID-inv-b" "$inv_b_body"
expect_status 201 "create invoice B"
INV_B=$(field '.data.id')

api POST "/invoices/$INV_B/match" "$CID-match-b" '{}'
expect_status 422 "match invoice B"
expect_eq "$(field '.error.code')" "INVOICE_EXCEEDS_RECEIVED_VALUE" "error code"
printf '  next_steps: %s\n' "$(field '.error.next_steps')"

section "Approve invoice A and post GL"
api POST "/invoices/$INV_A/approve" "$CID-approve" '{}'
expect_status 200 "approve invoice A"
expect_eq "$(field '.data.status')" "APPROVED" "invoice A status"
jq -r '.data.gl_entries[] | "  GL \(.account_code)  debit \(.debit)  credit \(.credit)"' "$BODY"

section "Idempotency"
api POST "/invoices/$INV_A/approve" "$CID-approve" '{}'
expect_status 200 "replay approve with same key"
expect_eq "$(header Idempotent-Replayed)" "true" "Idempotent-Replayed header"

api POST "/invoices/$INV_A/approve" "$CID-approve" '{"note": "different body"}'
expect_status 422 "reuse key with different body"
expect_eq "$(field '.error.code')" "IDEMPOTENCY_KEY_REUSED" "error code"

section "Debug state"
api GET /debug/state "" ""
expect_status 200 "GET /debug/state"
expect_eq "$(field '.data.gl_summary.balanced')" "true" "GL balanced"
printf '  totals: debit %s, credit %s\n' "$(field '.data.gl_summary.total_debit')" "$(field '.data.gl_summary.total_credit')"

printf '\nAll smoke checks passed (correlation %s).\n' "$CID"
