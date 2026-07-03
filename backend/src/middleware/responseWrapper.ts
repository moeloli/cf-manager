import { Request, Response, NextFunction } from 'express';

/**
 * Auto-wraps res.json() calls into { success, data } or { success, error }.
 * Only applied to /api/* routes; /v1/* external APIs are excluded.
 */
export function responseWrapper(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);

  res.json = function (body: any) {
    // Skip wrapping for all OpenAI-compatible paths (/api/v1/*), keep original format.
    // Note: middleware is mounted at app.use('/api', ...), so req.path is already stripped of /api.
    // For /api/v1/chat/completions, req.path is /v1/chat/completions.
    if (_req.path.startsWith('/v1')) {
      return originalJson(body);
    }
    // Skip wrapping for OpenAI format responses (returned by /api/v1/* routes)
    if (body && typeof body === 'object' && (body.object === 'list' || body.object === 'chat.completion' || (typeof body.id === 'string' && body.id.startsWith('chatcmpl-')))) {
      return originalJson(body);
    }
    
    if (body && typeof body === 'object' && body.success !== undefined) {
      if (body.data !== undefined || body.error !== undefined) {
        return originalJson(body);
      }
      const { success, ...rest } = body;
      if (success) {
        return originalJson({
          success: true,
          data: Object.keys(rest).length > 0 ? rest : undefined,
        });
      }
      return originalJson({
        success: false,
        error: Object.keys(rest).length > 0 ? rest : undefined,
      });
    }

    const code = res.statusCode;
    if (code >= 400) {
      if (body && typeof body === 'object' && body.error) {
        return originalJson({ success: false, error: body.error });
      }
      return originalJson({ success: false, error: body });
    }

    return originalJson({ success: true, data: body });
  } as any;

  next();
}
