export interface ApiResult {
  /** HTTP status, or 0 when the API could not be reached. */
  status: number;
  body: unknown;
}

export interface ApiClient {
  get(path: string): Promise<ApiResult>;
  post(path: string, body: unknown, idempotencyKey: string): Promise<ApiResult>;
}

export interface ApiClientOptions {
  apiUrl: string;
  correlationId: string;
  fetch: typeof fetch;
}

export function createApiClient({ apiUrl, correlationId, fetch: fetchFn }: ApiClientOptions): ApiClient {
  const base = apiUrl.replace(/\/+$/, '');

  async function send(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<ApiResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Correlation-ID': correlationId,
    };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;

    try {
      const response = await fetchFn(`${base}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      return { status: 0, body: unreachableEnvelope(base, correlationId, error) };
    }
  }

  return {
    get: (path) => send('GET', path),
    post: (path, body, idempotencyKey) => send('POST', path, body, idempotencyKey),
  };
}

/** Same shape as the API error envelope, so agents handle it like any other error. */
function unreachableEnvelope(apiUrl: string, correlationId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      code: 'SERVER_ERROR',
      status: 503,
      description: `Could not reach the P2P API at ${apiUrl}: ${message}`,
      next_steps: `Check that the P2P API is running at ${apiUrl} (npm run dev) and retry with the same idempotency_key.`,
      correlation_id: correlationId,
    },
  };
}
