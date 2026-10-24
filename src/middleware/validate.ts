import type { z } from 'zod';
import { AppError } from '../errors';

/**
 * Parses a request body against a zod schema. A missing body (undefined or null) is treated as {}.
 * On failure throws VALIDATION_ERROR with details.issues as [{ path, message }], path dot-joined.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
  const [first] = issues;
  const description =
    issues.length === 1
      ? `Request body is invalid: "${first?.path}" ${first?.message}.`
      : `Request body is invalid: ${issues.length} problems, first at "${first?.path}": ${first?.message}.`;

  throw new AppError('VALIDATION_ERROR', description, { details: { issues } });
}
