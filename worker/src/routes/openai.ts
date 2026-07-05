import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Env } from '../types';
import { setExhausted, incrementQuota, addAuditLog, getActiveAccountsByFeature } from '../db/models';
import { getAuthHeaders, cfFetchRaw } from '../services/cfApi';
import { selectBestAccount, invalidateAiCache, clearOptimistic } from '../services/quotaTracker';
import { estimateNeurons } from '../services/pricing';
import { getRequestId } from '../middleware/requestId';
import { logger } from '../services/logger';

/** Upstream status codes that should trigger account rotation. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const MAX_RETRY_PER_ACCOUNT = 1; // 每个账户最多重试 1 次，失败立即换账户

/** Delay before first heartbeat (ms) — only send heartbeat if upstream TTFB exceeds this. */
const HEARTBEAT_DELAY_MS = 15_000;

/** SSE heartbeat interval (ms) — repeat interval after first heartbeat. */
const HEARTBEAT_INTERVAL_MS = 10_000;

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

function isRetryableError(status: number, errorText: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return isNeuronLimitError(errorText);
}

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

const app = new Hono<{ Bindings: Env }>();

// Helper: write [DONE] to guarantee OpenAI SDK can return
function writeSseDone(s: any): void {
  s.write('data: [DONE]\n\n');
}

/** Send an error as an SSE event (for stream mode when headers already sent). */
function writeSseError(s: any, errorObj: Record<string, any>): void {
  s.write(`data: ${JSON.stringify({ error: errorObj })}\n\n`);
  s.write('data: [DONE]\n\n');
}

/**
 * Pipe CF stream response to an existing Hono stream.
 * Extracts usage, updates quota, writes audit log.
 */
async function pipeCfStream(
  s: any, body: any, account: any, cfResp: Response, env: Env, rid: string,
): Promise<void> {
  let streamStatus: 'success' | 'upstream_error' = 'success';
  let seenDone = false;
  let finalUsage: any = null;

  try {
    const reader = cfResp.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 写入原始 chunk（保持边界）
      const chunk = decoder.decode(value, { stream: true });
      await s.write(chunk);

      // 同时解析 usage（从累积的 buffer 中提取）
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            seenDone = true;
          } else {
            try {
              const json = JSON.parse(payload);
              if (json.usage) finalUsage = json.usage;
            } catch { /* not JSON */ }
          }
        }
      }
    }
    // 处理剩余 buffer
    if (buffer) {
      if (buffer.startsWith('data: ') && buffer.slice(6).trim() === '[DONE]') seenDone = true;
    }
  } catch (err: any) {
    streamStatus = 'upstream_error';
    logger.error('openai', `[${rid}] Stream error: ${err.message}`);
  } finally {
    if (!seenDone) writeSseDone(s);

    // 估算递增 + audit log
    if (finalUsage) {
      const cachedTokens = finalUsage.prompt_tokens_details?.cached_tokens || 0;
      const neurons = estimateNeurons(body.model, finalUsage.prompt_tokens || 0, finalUsage.completion_tokens || 0, cachedTokens);
      await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
      await clearOptimistic(env, account.id);  // 清除乐观预估
      await invalidateAiCache(env);
      try {
        await addAuditLog(env.DB, {
          account_id: account.id, action: 'ai_chat_completion', target: body.model,
          detail: `[${rid}] stream tokens: in=${finalUsage.prompt_tokens || 0} out=${finalUsage.completion_tokens || 0} total=${finalUsage.total_tokens || 0} cached=${cachedTokens} neurons=${neurons}`,
          status: streamStatus === 'success' ? 'success' : 'error',
        });
      } catch {}
    } else {
      try {
        await addAuditLog(env.DB, {
          account_id: account.id, action: 'ai_chat_completion', target: body.model,
          detail: `[${rid}] stream ${streamStatus} tokens: none (no usage in SSE)`,
          status: streamStatus === 'success' ? 'success' : 'error',
        });
      } catch {}
    }
  }
}

/** Process non-stream success: normalize response, estimate neurons, audit log. */
async function processNonStreamSuccess(
  c: any, body: any, account: any, cfResp: Response, rid: string
): Promise<Response> {
  const env: Env = c.env;
  const data = await cfResp.json() as any;
  if (!data.id) data.id = `chatcmpl-${crypto.randomUUID()}`;
  if (!data.object) data.object = 'chat.completion';
  if (!data.model && body.model) data.model = body.model;
  if (!data.usage) data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let neurons = 0;
  if (data.usage) {
    const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens || 0;
    neurons = estimateNeurons(body.model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, cachedTokens);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);  // 清除乐观预估
    await invalidateAiCache(env);
  }
  try {
    await addAuditLog(env.DB, {
      account_id: account.id, action: 'ai_chat_completion', target: body.model,
      detail: `[${rid}] non-stream tokens: in=${data.usage?.prompt_tokens || 0} out=${data.usage?.completion_tokens || 0} total=${data.usage?.total_tokens || 0} cached=${data.usage?.prompt_tokens_details?.cached_tokens || 0} neurons=${neurons}`,
      status: 'success',
    });
  } catch {}
  return c.json(data);
}

/** Helper: fetch from CF AI with abort timeout. */
async function fetchCf(account: any, body: any, env: Env, timeoutMs: number): Promise<Response> {
  const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
  const headers = await getAuthHeaders(account, env.ENCRYPTION_KEY);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return resp;
  } catch (fetchErr: any) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') throw new Error(`Request timeout after ${timeoutMs}ms`);
    throw fetchErr;
  }
}

app.get('/models', async (c) => {
  const account = await selectBestAccount(c.env, 'ai_neurons');
  if (!account) return c.json({ object: 'list', data: [] });

  const taskFilter = c.req.query('task');
  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/ai/models/search`, c.env.ENCRYPTION_KEY);
  const json = await resp.json() as any;

  let models = (json.result || []);

  // Filter by task if specified (normalize both to handle "text-generation" vs "Text Generation")
  if (taskFilter) {
    const normalizedFilter = taskFilter.toLowerCase().replace(/-/g, ' ');
    models = models.filter((m: any) => {
      const taskName = m.task?.name || m.task || '';
      const normalizedTaskName = taskName.toLowerCase().replace(/-/g, ' ');
      return normalizedTaskName.includes(normalizedFilter);
    });
  }

  const data = models.map((m: any) => ({
    id: m.name || m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cloudflare',
    task: m.task?.name || m.task || undefined,
  }));
  return c.json({ object: 'list', data });
});

app.post('/chat/completions', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const body = await c.req.json();
  const isStream = body.stream === true;

  // 流式请求强制要求 CF 返回 usage，否则无法记账
  if (isStream && !body.stream_options?.include_usage) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  }

  const rid = getRequestId(c);
  const env = c.env;

  // ================================================================
  // STREAM MODE — start stream immediately with heartbeat to prevent
  // client TTFB timeout (CF AI can take 30+ seconds before first byte)
  // ================================================================
  if (isStream) {
    return stream(c, async (s) => {
      let intervalId: ReturnType<typeof setInterval> | null = null;

      // Delay first heartbeat — most responses arrive before this.
      const delayId = setTimeout(() => {
        s.write(': heartbeat\n\n');
        intervalId = setInterval(() => {
          s.write(': heartbeat\n\n');
        }, HEARTBEAT_INTERVAL_MS);
      }, HEARTBEAT_DELAY_MS);

      const stopHeartbeat = () => {
        clearTimeout(delayId);
        if (intervalId) clearInterval(intervalId);
      };

      try {
        let lastError = '';

        // --- X-Account-ID specified: use that account directly, no rotation ---
        if (specifiedAccountId && specifiedAccountId !== 'auto') {
          const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
          const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
          if (!specified) {
            stopHeartbeat();
            writeSseError(s, { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' });
            return;
          }

          let cfResp: Response;
          try {
            cfResp = await fetchCf(specified, body, env, 600000);
          } catch (netErr: any) {
            stopHeartbeat();
            const errMsg = `Network error: ${netErr.message}`;
            logger.error('openai', `[${rid}] ${errMsg}`);
            try { await addAuditLog(env.DB, { account_id: specified.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
            writeSseError(s, { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' });
            return;
          }

          if (!cfResp.ok) {
            const errorText = await cfResp.text();
            stopHeartbeat();
            if (isNeuronLimitError(errorText)) {
              await setExhausted(env.DB, specified.id, 'ai_neurons');
              await invalidateAiCache(env);
            }
            writeSseError(s, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
            return;
          }

          stopHeartbeat();
          await pipeCfStream(s, body, specified, cfResp, env, rid);
          return;
        }

        // --- while + selectBestAccount rotation loop ---
        const skipped = new Set<number>();
        const retryCount = new Map<number, number>();

        while (true) {
          const account = await selectBestAccount(env, 'ai_neurons', skipped, body.model);
          if (!account) break;
          if (!account.account_id) { skipped.add(account.id); continue; }

          let cfResp: Response;
          try {
            cfResp = await fetchCf(account, body, env, 600000);
          } catch (netErr: any) {
            const errMsg = `Network error: ${netErr.message || netErr}`;
            logger.warn('openai', `[${rid}] Account ${account.name} ${errMsg}`);
            lastError = errMsg;
            try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
            const count = (retryCount.get(account.id) || 0) + 1;
            retryCount.set(account.id, count);
            if (count >= MAX_RETRY_PER_ACCOUNT) skipped.add(account.id);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          if (!cfResp.ok) {
            const errorText = await cfResp.text();
            lastError = errorText;

            if (isRetryableError(cfResp.status, errorText)) {
              if (isNeuronLimitError(errorText)) {
                logger.warn('openai', `[${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
                await setExhausted(env.DB, account.id, 'ai_neurons');
                await invalidateAiCache(env);
                skipped.add(account.id);
                try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] 4006 switching`, status: 'error' }); } catch {}
              } else {
                logger.warn('openai', `[${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
                try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] upstream ${cfResp.status}, switching`, status: 'error' }); } catch {}
              }
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }

            // Non-retryable — send error as SSE
            stopHeartbeat();
            writeSseError(s, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
            return;
          }

          // Success — pipe stream
          stopHeartbeat();
          await pipeCfStream(s, body, account, cfResp, env, rid);
          return;
        }

        // All accounts exhausted
        stopHeartbeat();
        logger.error('openai', `[${rid}] All accounts exhausted. Last error: ${lastError}`);
        writeSseError(s, { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' });
      } finally {
        stopHeartbeat();
      }
    });
  }

  // ================================================================
  // NON-STREAM MODE — original logic (no heartbeat needed)
  // ================================================================
  let lastError = '';

  // X-Account-ID 指定账户：直接查该账户，不走循环
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }
    let cfResp: Response;
    try {
      cfResp = await fetchCf(specified, body, env, 300000);
    } catch (netErr: any) {
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }
    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await processNonStreamSuccess(c, body, specified, cfResp, rid);
  }

  // while 循环路由
  const skipped = new Set<number>();
  const retryCount = new Map<number, number>();

  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, body.model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    let cfResp: Response;
    try {
      cfResp = await fetchCf(account, body, env, 300000);
    } catch (netErr: any) {
      const errMsg = `Network error: ${netErr.message || netErr}`;
      logger.warn('openai', `[${rid}] Account ${account.name} ${errMsg}`);
      lastError = errMsg;
      try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
      const count = (retryCount.get(account.id) || 0) + 1;
      retryCount.set(account.id, count);
      if (count >= MAX_RETRY_PER_ACCOUNT) skipped.add(account.id);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = errorText;

      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          logger.warn('openai', `[${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
          skipped.add(account.id);
          try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] 4006 switching`, status: 'error' }); } catch {}
        } else {
          logger.warn('openai', `[${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
          try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] upstream ${cfResp.status}, switching`, status: 'error' }); } catch {}
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      return c.json({ error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    // 成功
    return await processNonStreamSuccess(c, body, account, cfResp, rid);
  }

  // 无账户可用
  logger.error('openai', `[${rid}] All accounts exhausted. Last error: ${lastError}`);
  return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
});

export default app;