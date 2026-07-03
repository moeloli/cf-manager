import { Router, Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import { selectBestAccount } from '../services/accountRouter';
import { getActiveAccountsByFeature } from '../models/account';
import { getAvailableModels } from '../services/aiService';
import { getAuthHeaders } from '../services/cfFactory';
import { createAuditLog } from '../models/auditLog';
import { proxyFetch } from '../services/proxyService';
import { appLogger } from '../services/logger';
import { setExhausted, incrementQuota } from '../models/quotaUsage';
import { updateAiCacheAfterUsage, removeAccountFromAiCache } from '../services/accountRouter';
import { estimateNeurons } from '../services/pricing';

const router = Router();

/** Maximum retries per account before skipping it permanently in this request. */
const MAX_RETRY_PER_ACCOUNT = 3;

/** Upstream status codes that should trigger account rotation instead of immediate error. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Map upstream HTTP status to an OpenAI-style semantic error code string. */
function upstreamStatusToCode(status: number): string {
  const map: Record<number, string> = {
    400: 'bad_request',
    401: 'authentication_error',
    403: 'permission_denied',
    404: 'not_found',
    413: 'request_too_large',
    429: 'rate_limit_exceeded',
  };
  return map[status] || 'upstream_error';
}

function isNeuronLimitError(text: string): boolean {
  return text.includes('4006') || text.includes('daily free allocation') || text.includes('neuron limit');
}

function writeSseDone(res: Response): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }
  res.write('data: [DONE]\n\n');
}

router.get('/models', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await selectBestAccount('ai_neurons');
    if (!account) {
      res.status(503).json({
        error: { message: 'No active AI accounts available', type: 'service_error', code: 'NO_ACCOUNTS' },
      });
      return;
    }
    const taskFilter = req.query.task as string | undefined;
    const models = await getAvailableModels(account, taskFilter);

    const data = models.map((m: any) => ({
      id: m.name || m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'cloudflare',
      task: m.task?.name || m.task || undefined,
    }));
    res.json({ object: 'list', data });
  } catch (err) { next(err); }
});

router.post('/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const isStream = req.body.stream === true;
    const rid = req.requestId || '-';

    // --- X-Account-ID specified: use that account directly, no rotation ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        res.status(404).json({
          error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
        });
        return;
      }

      // Make the CF request directly (no retry for specified account)
      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      try {
        const timeoutMs = isStream ? 600000 : 300000;
        const cfResp = await proxyFetch(cfUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body),
        }, timeoutMs);

        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          if (isNeuronLimitError(errorText)) {
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          res.status(cfResp.status).json({
            error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
          return;
        }

        await processAccount(account, req, res, rid, isStream, cfResp);
      } catch (netErr: any) {
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.error(`[AI][${rid}] Specified account ${account.name} ${errMsg}`);
        createAuditLog(account.id, 'ai_inference', req.body.model, `[${rid}] ${errMsg}`, 'error');
        res.status(502).json({
          error: { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' },
        });
      }
      return;
    }

    // --- while + selectBestAccount rotation loop ---
    const skipped = new Set<number>();
    const retryCount = new Map<number, number>();
    let lastError = '';

    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped);
      if (!account) break; // no available account

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };

      let cfResp: any;
      try {
        const timeoutMs = isStream ? 600000 : 300000;
        cfResp = await proxyFetch(cfUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body),
        }, timeoutMs);
      } catch (netErr: any) {
        // Network error — retryable, increment retry count
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.warn(`[AI][${rid}] Account ${account.name} ${errMsg}`);
        lastError = errMsg;
        createAuditLog(account.id, 'ai_inference', req.body.model, `[${rid}] ${errMsg}`, 'error');

        const retries = (retryCount.get(account.id) || 0) + 1;
        retryCount.set(account.id, retries);
        if (retries >= MAX_RETRY_PER_ACCOUNT) {
          skipped.add(account.id);
          appLogger.warn(`[AI][${rid}] Account ${account.name} exceeded max retries, skipping`);
        }
        continue;
      }

      if (!cfResp.ok) {
        const errorText = await cfResp.text();
        lastError = errorText;

        if (isRetryableError(cfResp.status, errorText)) {
          if (isNeuronLimitError(errorText)) {
            // 4006 — mark exhausted, remove from cache, rotate
            appLogger.warn(`[AI][${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
            createAuditLog(account.id, 'ai_inference', req.body.model, `[${rid}] 4006 neuron limit, switching`, 'error');
          } else {
            // Other retryable error — increment retry count
            const retries = (retryCount.get(account.id) || 0) + 1;
            retryCount.set(account.id, retries);
            if (retries >= MAX_RETRY_PER_ACCOUNT) {
              skipped.add(account.id);
              appLogger.warn(`[AI][${rid}] Account ${account.name} upstream ${cfResp.status} exceeded max retries, skipping`);
            } else {
              appLogger.warn(`[AI][${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
            }
            createAuditLog(account.id, 'ai_inference', req.body.model,
              `[${rid}] upstream ${cfResp.status}, switching`, 'error');
          }
          continue;
        }

        // Non-retryable (400, 401, 403, 404, etc.) — return immediately
        res.status(cfResp.status).json({
          error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
        });
        return;
      }

      // Success — process response (handles both stream and non-stream)
      await processAccount(account, req, res, rid, isStream, cfResp);
      return;
    }

    // All accounts exhausted
    appLogger.error(`[AI][${rid}] All accounts exhausted. Last error: ${lastError}`);
    res.status(429).json({
      error: {
        message: 'All accounts have reached daily neuron limit',
        type: 'quota_exceeded',
        code: 'ALL_ACCOUNTS_EXHAUSTED',
        last_error: lastError || 'Unknown error',
      },
    });
  } catch (err) { next(err); }
});

/**
 * Process a successful CF response: handle streaming vs non-streaming,
 * extract usage, do local neuron estimation, update quota/cache, write audit log.
 */
async function processAccount(
  account: any,
  req: Request,
  res: Response,
  rid: string,
  isStream: boolean,
  cfResp?: any,
): Promise<void> {
  if (isStream) {
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let seenDone = false;
    let streamStatus: 'success' | 'client_disconnected' | 'upstream_error' = 'success';
    let finalUsage: any = null;
    let chunkIndex = 0;

    const onClose = () => {
      streamStatus = 'client_disconnected';
    };
    req.on('close', onClose);

    try {
      if (cfResp!.body) {
        const body = cfResp!.body as any;

        // --- Web Streams API (getReader) ---
        if (typeof body.getReader === 'function') {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.writableEnded) { streamStatus = 'client_disconnected'; break; }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') {
                  seenDone = true;
                } else {
                  chunkIndex++;
                  try {
                    const json = JSON.parse(payload);
                    if (json.usage) {
                      finalUsage = json.usage;
                      appLogger.debug(`[AI][${rid}] stream chunk#${chunkIndex} usage: ${JSON.stringify(json.usage)}`);
                    }
                  } catch { /* not JSON, ignore */ }
                }
              }
            }

            if (!res.write(Buffer.from(value))) {
              await new Promise<void>(r => res.once('drain', r));
            }
          }
          if (buffer) {
            if (buffer.startsWith('data: ') && buffer.slice(6).trim() === '[DONE]') seenDone = true;
            if (!res.write(buffer)) {
              await new Promise<void>(r => res.once('drain', r));
            }
          }
        }
        // --- Node.js Readable stream ---
        else if (typeof body.pipe === 'function') {
          await new Promise<void>((resolve) => {
            const nodeStream = body as Readable;
            nodeStream.on('data', (chunk: Buffer) => {
              if (res.writableEnded) { streamStatus = 'client_disconnected'; nodeStream.destroy(); return; }
              const str = chunk.toString();
              if (str.includes('[DONE]')) seenDone = true;
              for (const line of str.split('\n')) {
                if (line.startsWith('data: ')) {
                  const payload = line.slice(6).trim();
                  if (payload && payload !== '[DONE]') {
                    chunkIndex++;
                    try {
                      const json = JSON.parse(payload);
                      if (json.usage) {
                        finalUsage = json.usage;
                        appLogger.debug(`[AI][${rid}] stream chunk#${chunkIndex} usage: ${JSON.stringify(json.usage)}`);
                      }
                    } catch { /* not JSON, ignore */ }
                  }
                }
              }
              if (!res.write(chunk)) {
                nodeStream.pause();
                res.once('drain', () => nodeStream.resume());
              }
            });
            nodeStream.on('end', () => resolve());
            nodeStream.on('error', (err: Error) => {
              streamStatus = 'upstream_error';
              appLogger.error(`[AI] Stream error (pipe): ${err.message}`);
              resolve();
            });
          });
        }
      }
    } catch (err: any) {
      streamStatus = 'upstream_error';
      appLogger.error(`[AI][${rid}] Stream exception: ${err.message}`);
    } finally {
      req.off('close', onClose);
      if (!seenDone && !res.writableEnded) {
        writeSseDone(res);
      }
      if (!res.writableEnded) res.end();

      // Local neuron estimation from finalUsage
      if (finalUsage) {
        const neurons = estimateNeurons(
          req.body.model,
          finalUsage.prompt_tokens || 0,
          finalUsage.completion_tokens || 0
        );
        incrementQuota(account.id, 'ai_neurons', neurons);
        updateAiCacheAfterUsage(account.id, neurons);
        appLogger.debug(`[AI][${rid}] estimated ${neurons} neurons for account ${account.name}`);
        createAuditLog(account.id, 'ai_inference', req.body.model,
          `[${rid}] stream tokens: in=${finalUsage.prompt_tokens || 0} out=${finalUsage.completion_tokens || 0} total=${finalUsage.total_tokens || 0} neurons=${neurons}`,
          streamStatus === 'success' ? 'success' : 'error');
      } else {
        appLogger.warn(`[AI][${rid}] stream ended without usage, skipping local estimate`);
        createAuditLog(account.id, 'ai_inference', req.body.model,
          `[${rid}] stream ${streamStatus} tokens: none (no usage in SSE)`,
          streamStatus === 'success' ? 'success' : 'error');
      }
    }
  } else {
    // Non-stream
    const data = await cfResp!.json() as any;

    // Normalize response to match OpenAI format
    if (!data.id) data.id = `chatcmpl-${crypto.randomUUID()}`;
    if (!data.object) data.object = 'chat.completion';
    if (!data.model && req.body.model) data.model = req.body.model;
    if (!data.usage) data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Local neuron estimation
    let neurons = 0;
    if (data.usage) {
      neurons = estimateNeurons(
        req.body.model,
        data.usage.prompt_tokens || 0,
        data.usage.completion_tokens || 0
      );
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      appLogger.debug(`[AI][${rid}] estimated ${neurons} neurons for account ${account.name}`);
    }

    res.json(data);
    createAuditLog(account.id, 'ai_inference', req.body.model,
      `[${rid}] non-stream tokens: in=${data?.usage?.prompt_tokens || 0} out=${data?.usage?.completion_tokens || 0} total=${data?.usage?.total_tokens || 0} neurons=${neurons}`,
      'success');
  }
}

function isRetryableError(status: number, errorText: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return isNeuronLimitError(errorText);
}

export default router;
