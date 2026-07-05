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
import { safeRandomUUID } from '../utils';
import { updateAiCacheAfterUsage, removeAccountFromAiCache } from '../services/accountRouter';
import { estimateNeurons } from '../services/pricing';

const router = Router();

/** Maximum retries per account before skipping it permanently in this request. */
const MAX_RETRY_PER_ACCOUNT = 1; // 每个账户最多重试 1 次，失败立即换账户

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
  // 优先解析 JSON 精确匹配 CF 错误码 4006，避免字符串 "4006" 误匹配时间戳/请求ID等
  try {
    const json = JSON.parse(text);
    const errors = json?.errors || json?.result?.errors || (Array.isArray(json) ? json : []);
    if (Array.isArray(errors) && errors.some((e: any) => e?.code === 4006)) {
      return true;
    }
  } catch { /* 非 JSON，回退到关键词匹配 */ }
  // 兜底：CF 错误格式变化时通过特异关键词识别
  return text.includes('daily free allocation') || text.includes('neuron limit');
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

/** Delay before first heartbeat (ms) — only send heartbeat if upstream TTFB exceeds this. */
const HEARTBEAT_DELAY_MS = 15_000;

/** SSE heartbeat interval (ms) — repeat interval after first heartbeat. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Start DELAYED SSE heartbeat to prevent client TTFB timeout.
 *
 * Does NOT send anything immediately. Only starts sending `: heartbeat\n\n`
 * comments after HEARTBEAT_DELAY_MS (15s) of silence, then every 10s.
 *
 * This avoids interfering with fast responses — most requests get a response
 * from CF within a few seconds and never need a heartbeat. Only genuinely
 * slow responses (30s+ TTFB) trigger the heartbeat.
 *
 * ONLY sends SSE comment (`: heartbeat\n\n`) — spec-compliant, all SSE
 * parsers ignore comments, zero risk of corrupting the stream.
 *
 * Returns a stop function.
 */
function startSseHeartbeat(res: Response): () => void {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  let intervalId: ReturnType<typeof setInterval> | null = null;

  // Delay first heartbeat — most responses arrive before this.
  const delayId = setTimeout(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
    intervalId = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': heartbeat\n\n');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_DELAY_MS);

  return () => {
    clearTimeout(delayId);
    if (intervalId) clearInterval(intervalId);
  };
}

/** Send an error as an SSE event (for stream mode when headers already sent). */
function sendSseError(res: Response, errorObj: Record<string, any>): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ error: errorObj })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
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
  // Declare before try so catch block can access it for cleanup.
  let stopHeartbeat: (() => void) | null = null;
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const isStream = req.body.stream === true;

    // 流式请求强制要求 CF 返回 usage，否则无法记账
    if (isStream && !req.body.stream_options?.include_usage) {
      req.body.stream_options = { ...(req.body.stream_options || {}), include_usage: true };
    }

    const rid = req.requestId || '-';

    // For streaming: send SSE headers + heartbeat IMMEDIATELY to prevent
    // client TTFB timeout. CF AI can take 30+ seconds before first byte;
    // without this, clients like Cursor disconnect after ~30s of silence.
    stopHeartbeat = isStream ? startSseHeartbeat(res) : null;

    // --- X-Account-ID specified: use that account directly, no rotation ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        if (isStream) {
          sendSseError(res, { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' });
        } else {
          res.status(404).json({
            error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
          });
        }
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
          if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
          if (isStream) {
            sendSseError(res, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
          } else {
            res.status(cfResp.status).json({
              error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
            });
          }
          return;
        }

        await processAccount(account, req, res, rid, isStream, cfResp, stopHeartbeat);
        stopHeartbeat = null;
      } catch (netErr: any) {
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.error(`[AI][${rid}] Specified account ${account.name} ${errMsg}`);
        createAuditLog(account.id, 'ai_chat_completion', req.body.model, `[${rid}] ${errMsg}`, 'error');
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        if (isStream) {
          sendSseError(res, { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' });
        } else {
          res.status(502).json({
            error: { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' },
          });
        }
      }
      return;
    }

    // --- while + selectBestAccount rotation loop ---
    const skipped = new Set<number>();
    const retryCount = new Map<number, number>();
    let lastError = '';

    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, req.body.model);
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
        createAuditLog(account.id, 'ai_chat_completion', req.body.model, `[${rid}] ${errMsg}`, 'error');

        const retries = (retryCount.get(account.id) || 0) + 1;
        retryCount.set(account.id, retries);
        if (retries >= MAX_RETRY_PER_ACCOUNT) {
          skipped.add(account.id);
          appLogger.warn(`[AI][${rid}] Account ${account.name} exceeded max retries, skipping`);
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      if (!cfResp.ok) {
        const errorText = await cfResp.text();
        lastError = errorText;

        if (isRetryableError(cfResp.status, errorText)) {
          if (isNeuronLimitError(errorText)) {
            // 4006 — mark exhausted, remove from cache, skip in this request loop, rotate
            appLogger.warn(`[AI][${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
            skipped.add(account.id);
            createAuditLog(account.id, 'ai_chat_completion', req.body.model, `[${rid}] 4006 neuron limit, switching`, 'error');
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
            createAuditLog(account.id, 'ai_chat_completion', req.body.model,
              `[${rid}] upstream ${cfResp.status}, switching`, 'error');
          }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Non-retryable (400, 401, 403, 404, etc.) — return immediately
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        if (isStream) {
          sendSseError(res, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
        } else {
          res.status(cfResp.status).json({
            error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
        }
        return;
      }

      // Success — process response (handles both stream and non-stream)
      await processAccount(account, req, res, rid, isStream, cfResp, stopHeartbeat);
      stopHeartbeat = null;
      return;
    }

    // All accounts exhausted
    appLogger.error(`[AI][${rid}] All accounts exhausted. Last error: ${lastError}`);
    if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
    if (isStream) {
      sendSseError(res, {
        message: 'All accounts have reached daily neuron limit',
        type: 'quota_exceeded',
        code: 'ALL_ACCOUNTS_EXHAUSTED',
        last_error: lastError || 'Unknown error',
      });
    } else {
      res.status(429).json({
        error: {
          message: 'All accounts have reached daily neuron limit',
          type: 'quota_exceeded',
          code: 'ALL_ACCOUNTS_EXHAUSTED',
          last_error: lastError || 'Unknown error',
        },
      });
    }
  } catch (err) {
    if (stopHeartbeat) stopHeartbeat();
    next(err);
  }
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
  stopHeartbeat?: (() => void) | null,
): Promise<void> {
  if (isStream) {
    // SSE headers (skip if already sent by heartbeat)
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }

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
            let lineBuffer = '';
            nodeStream.on('data', (chunk: Buffer) => {
              if (res.writableEnded) { streamStatus = 'client_disconnected'; nodeStream.destroy(); return; }
              lineBuffer += chunk.toString();
              const lines = lineBuffer.split('\n');
              lineBuffer = lines.pop() || '';
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const payload = line.slice(6).trim();
                  if (payload === '[DONE]') {
                    seenDone = true;
                  } else if (payload) {
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
            nodeStream.on('end', () => {
              if (lineBuffer) {
                if (lineBuffer.startsWith('data: ') && lineBuffer.slice(6).trim() === '[DONE]') seenDone = true;
                if (!res.write(lineBuffer)) { /* flush remaining */ }
              }
              resolve();
            });
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
      if (stopHeartbeat) stopHeartbeat();
      if (!seenDone && !res.writableEnded) {
        writeSseDone(res);
      }
      if (!res.writableEnded) res.end();

      // Local neuron estimation from finalUsage
      if (finalUsage) {
        const cachedTokens = finalUsage.prompt_tokens_details?.cached_tokens || 0;
        const neurons = estimateNeurons(
          req.body.model,
          finalUsage.prompt_tokens || 0,
          finalUsage.completion_tokens || 0,
          cachedTokens
        );
        incrementQuota(account.id, 'ai_neurons', neurons);
        updateAiCacheAfterUsage(account.id, neurons);
        appLogger.debug(`[AI][${rid}] estimated ${neurons} neurons for account ${account.name} (cached=${cachedTokens})`);
        createAuditLog(account.id, 'ai_chat_completion', req.body.model,
          `[${rid}] stream tokens: in=${finalUsage.prompt_tokens || 0} out=${finalUsage.completion_tokens || 0} total=${finalUsage.total_tokens || 0} cached=${cachedTokens} neurons=${neurons}`,
          streamStatus === 'success' ? 'success' : 'error');
      } else {
        appLogger.warn(`[AI][${rid}] stream ended without usage, skipping local estimate`);
        createAuditLog(account.id, 'ai_chat_completion', req.body.model,
          `[${rid}] stream ${streamStatus} tokens: none (no usage in SSE)`,
          streamStatus === 'success' ? 'success' : 'error');
      }
    }
  } else {
    // Non-stream
    const data = await cfResp!.json() as any;

    // Normalize response to match OpenAI format
    if (!data.id) data.id = `chatcmpl-${safeRandomUUID()}`;
    if (!data.object) data.object = 'chat.completion';
    if (!data.model && req.body.model) data.model = req.body.model;
    if (!data.usage) data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Local neuron estimation
    let neurons = 0;
    if (data.usage) {
      const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens || 0;
      neurons = estimateNeurons(
        req.body.model,
        data.usage.prompt_tokens || 0,
        data.usage.completion_tokens || 0,
        cachedTokens
      );
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      appLogger.debug(`[AI][${rid}] estimated ${neurons} neurons for account ${account.name} (cached=${cachedTokens})`);
    }

    res.json(data);
    createAuditLog(account.id, 'ai_chat_completion', req.body.model,
      `[${rid}] non-stream tokens: in=${data?.usage?.prompt_tokens || 0} out=${data?.usage?.completion_tokens || 0} total=${data?.usage?.total_tokens || 0} cached=${data?.usage?.prompt_tokens_details?.cached_tokens || 0} neurons=${neurons}`,
      'success');
  }
}

function isRetryableError(status: number, errorText: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return isNeuronLimitError(errorText);
}

export default router;