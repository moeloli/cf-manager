import { Request, Response, NextFunction } from 'express';
import { appLogger } from '../services/logger';
import { AppError } from './errorHandler';

/**
 * Error handler for OpenAI-compatible routes (/v1, /api/v1).
 * Returns errors in OpenAI format: { error: { message, type, code } }
 * instead of the internal { success: false, error: { code, message } } format.
 */
export function v1ErrorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  appLogger.error(`[V1 ${code}] ${req.method} ${req.originalUrl} - ${err.message}`);
  if (res.headersSent) return;
  res.status(statusCode).json({
    error: {
      message: err.message,
      type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      code,
    },
  });
}
