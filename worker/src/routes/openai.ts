import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Env } from '../types';
import { setExhausted, incrementQuota, addAuditLog, getActiveAccountsByFeature } from '../db/models';
import { getAuthHeaders, cfFetchRaw } from '../services/cfApi';
import { selectBestAccount, invalidateAiCache } from '../services/quotaTracker';
import { estimateNeurons } from '../services/pricing';
import { getRequestId } from '../middleware/requestId';

/** Upstream status codes that should trigger account rotation. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const MAX_RETRY_PER_ACCOUNT = 3;

function isNeuronLimitError(text: string): boolean {
  return text.includes('4006') || text.includes('daily free allocation') || text.includes('neuron limit');
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

async function processWorkerSuccess(
  c: any, body: any, account: any, cfResp: Response, isStream: boolean, rid: string
): Promise<Response> {
  const env: Env = c.env;

  if (isStream) {
    let streamStatus: 'success' | 'upstream_error' = 'success';
    let seenDone = false;
    let finalUsage: any = null;

    return stream(c, async (s) => {
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
        console.error(`[AI][${rid}] Stream error: ${err.message}`);
      } finally {
        if (!seenDone) writeSseDone(s);

        // 估算递增 + audit log
        if (finalUsage) {
          const neurons = estimateNeurons(body.model, finalUsage.prompt_tokens || 0, finalUsage.completion_tokens || 0);
          await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
          await invalidateAiCache(env);
          try {
            await addAuditLog(env.DB, {
              account_id: account.id, action: 'ai_inference', target: body.model,
              detail: `[${rid}] stream tokens: in=${finalUsage.prompt_tokens || 0} out=${finalUsage.completion_tokens || 0} total=${finalUsage.total_tokens || 0} neurons=${neurons}`,
              status: streamStatus === 'success' ? 'success' : 'error',
            });
          } catch {}
        } else {
          try {
            await addAuditLog(env.DB, {
              account_id: account.id, action: 'ai_inference', target: body.model,
              detail: `[${rid}] stream ${streamStatus} tokens: none (no usage in SSE)`,
              status: streamStatus === 'success' ? 'success' : 'error',
            });
          } catch {}
        }
      }
    });
  }

  // 非流式
  const data = await cfResp.json() as any;
  if (!data.id) data.id = `chatcmpl-${crypto.randomUUID()}`;
  if (!data.object) data.object = 'chat.completion';
  if (!data.model && body.model) data.model = body.model;
  if (!data.usage) data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let neurons = 0;
  if (data.usage) {
    neurons = estimateNeurons(body.model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await invalidateAiCache(env);
  }
  try {
    await addAuditLog(env.DB, {
      account_id: account.id, action: 'ai_inference', target: body.model,
      detail: `[${rid}] non-stream tokens: in=${data.usage?.prompt_tokens || 0} out=${data.usage?.completion_tokens || 0} total=${data.usage?.total_tokens || 0} neurons=${neurons}`,
      status: 'success',
    });
  } catch {}
  return c.json(data);
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

// Helper: write [DONE] to guarantee OpenAI SDK can return
function writeSseDone(s: any): void {
  s.write('data: [DONE]\n\n');
}

app.post('/chat/completions', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const body = await c.req.json();
  const isStream = body.stream === true;
  const rid = getRequestId(c);
  let lastError = '';

  // X-Account-ID 指定账户：直接查该账户，不走循环
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(c.env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }
    // 直接请求 CF（单次，不重试）
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${specified.account_id}/ai/v1/chat/completions`;
    const headers = await getAuthHeaders(specified, c.env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), isStream ? 600000 : 300000);
      cfResp = await fetch(cfUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }
    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      return c.json({ error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await processWorkerSuccess(c, body, specified, cfResp, isStream, rid);
  }

  // while 循环路由
  const skipped = new Set<number>();
  const retryCount = new Map<number, number>();

  while (true) {
    const account = await selectBestAccount(c.env, 'ai_neurons', skipped);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
    const headers = await getAuthHeaders(account, c.env.ENCRYPTION_KEY);

    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), isStream ? 600000 : 300000);
      try {
        cfResp = await fetch(cfUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') throw new Error(`Request timeout after ${isStream ? 600000 : 300000}ms`);
        throw fetchErr;
      }
    } catch (netErr: any) {
      const errMsg = `Network error: ${netErr.message || netErr}`;
      console.warn(`[AI][${rid}] Account ${account.name} ${errMsg}`);
      lastError = errMsg;
      try { await addAuditLog(c.env.DB, { account_id: account.id, action: 'ai_inference', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
      const count = (retryCount.get(account.id) || 0) + 1;
      retryCount.set(account.id, count);
      if (count >= MAX_RETRY_PER_ACCOUNT) skipped.add(account.id);
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = errorText;

      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          console.warn(`[AI][${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
          await setExhausted(c.env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(c.env);
          try { await addAuditLog(c.env.DB, { account_id: account.id, action: 'ai_inference', target: body.model, detail: `[${rid}] 4006 switching`, status: 'error' }); } catch {}
        } else {
          console.warn(`[AI][${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
          try { await addAuditLog(c.env.DB, { account_id: account.id, action: 'ai_inference', target: body.model, detail: `[${rid}] upstream ${cfResp.status}, switching`, status: 'error' }); } catch {}
        }
        continue;
      }

      return c.json({ error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    // 成功
    return await processWorkerSuccess(c, body, account, cfResp, isStream, rid);
  }

  // 无账户可用
  console.error(`[AI][${rid}] All accounts exhausted. Last error: ${lastError}`);
  return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
});

export default app;
