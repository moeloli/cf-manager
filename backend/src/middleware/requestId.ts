import { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

/**
 * Generates (or propagates) a request ID for tracing.
 * Sets `req.requestId` and the `X-Request-ID` response header so that
 * logs, audit entries, and client responses can be correlated.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}
