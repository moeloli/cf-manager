import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

/**
 * Generates (or propagates) a request ID for tracing.
 * Stores the ID in c.set('requestId', id) and sets the X-Request-ID response header
 * so that logs, audit entries, and client responses can be correlated.
 */
export const requestIdMiddleware = createMiddleware<{ Bindings: Env; Variables: { requestId: string } }>(async (c, next) => {
  const id = c.req.header('X-Request-ID') || crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.header('X-Request-ID', id);
});

export function getRequestId(c: any): string {
  return (c.get('requestId') as string) || '-';
}
