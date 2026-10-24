// Semantic error catalog. Every non-2xx response is built from an AppError and serialized
// only by middleware/errorHandler.ts into:
// { error: { code, status, description, next_steps, details?, correlation_id } }

export const ERROR_CATALOG = {
  VALIDATION_ERROR: {
    status: 400,
    next_steps: 'Fix the fields listed in details.issues and resend the request.',
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    next_steps:
      'Add an Idempotency-Key header (any unique string, e.g. a UUID) to this POST. Reuse the same key when retrying the same action.',
  },
  NOT_FOUND: {
    status: 404,
    next_steps: 'Check the id. Use the list endpoints (GET /vendors, GET /skus) to discover valid ids.',
  },
  INVALID_STATE_TRANSITION: {
    status: 409,
    next_steps:
      'Read the resource (GET) to see its current status and next_actions, then call an action allowed from that status.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    next_steps:
      'This Idempotency-Key was already used with a different request body. Use a new key for a new action, or resend the original body to get the original result.',
  },
  VENDOR_INACTIVE: {
    status: 422,
    next_steps: 'Choose an active vendor (GET /vendors, is_active=true).',
  },
  UNKNOWN_SKU: {
    status: 422,
    next_steps: 'Use a SKU from GET /skus.',
  },
  OVER_RECEIPT: {
    status: 422,
    next_steps:
      'Receive at most qty_outstanding per line. GET the purchase order to see qty_outstanding for each line item.',
  },
  VENDOR_MISMATCH: {
    status: 422,
    next_steps: "Use the purchase order's vendor_id on the invoice, or link the invoice to a PO from this vendor.",
  },
  DUPLICATE_INVOICE: {
    status: 422,
    next_steps:
      'This vendor already has an invoice with this invoice_number. GET the existing invoice instead of creating another.',
  },
  NOTHING_RECEIVED: {
    status: 422,
    next_steps:
      'Record a goods receipt (POST /purchase-orders/{id}/receive) before matching. Invoices can only be matched against received goods.',
  },
  INVOICE_EXCEEDS_RECEIVED_VALUE: {
    status: 422,
    next_steps:
      'Do not approve. Either wait for more goods to be received and retry the match, or obtain a corrected invoice for at most details.available_to_match.',
  },
  SERVER_ERROR: {
    status: 500,
    next_steps: 'Retry with the same Idempotency-Key. If it keeps failing, stop and escalate with the correlation_id.',
  },
} as const satisfies Record<string, { status: number; next_steps: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly nextSteps: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    description: string,
    options: { nextSteps?: string; details?: Record<string, unknown> } = {},
  ) {
    super(description);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.nextSteps = options.nextSteps ?? ERROR_CATALOG[code].next_steps;
    this.details = options.details;
  }
}

export function notFound(entity: string, id: string): AppError {
  return new AppError('NOT_FOUND', `No ${entity} with id "${id}".`, { details: { entity, id } });
}

export function invalidTransition(
  entity: string,
  id: string,
  action: string,
  currentStatus: string,
  allowedFrom: readonly string[],
): AppError {
  return new AppError(
    'INVALID_STATE_TRANSITION',
    `Cannot ${action} ${entity} ${id}: status is ${currentStatus}, must be one of ${allowedFrom.join(', ')}.`,
    { details: { entity, id, action, current_status: currentStatus, allowed_from: allowedFrom } },
  );
}
