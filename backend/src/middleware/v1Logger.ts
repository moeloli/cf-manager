import { Request, Response, NextFunction } from 'express';
import { v1Logger as logger } from '../services/logger';

export function v1RequestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, originalUrl } = req;

  // 打印完整请求体（增加到2000字符）
  const fullBody = req.body ? JSON.stringify(req.body, null, 2) : '';

  let logged = false;

  function log(suffix?: string) {
    if (logged) return;
    logged = true;
    const duration = Date.now() - start;
    const tag = suffix ? ` [${suffix}]` : '';
    const rid = req.requestId || '-';
    
    // 分两行打印：第一行基本信息，第二行完整请求体
    logger.info(`[${rid}] ${method} ${originalUrl} ${res.statusCode} ${duration}ms${tag}`);
    if (fullBody) {
      logger.info(`[${rid}] Request body: ${fullBody.slice(0, 2000)}${fullBody.length > 2000 ? '... (truncated)' : ''}`);
    }
  }

  res.on('finish', () => log());
  res.on('close', () => {
    if (!res.writableFinished) log('client_disconnected');
  });

  next();
}
