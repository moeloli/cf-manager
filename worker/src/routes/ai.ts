import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Env } from '../types';
import { getAccountById, getActiveAccountsByFeature, setQuota } from '../db/models';
import { cfFetchRaw, getAuthHeaders } from '../services/cfApi';
import { selectBestAccount, getAiUsageToday } from '../services/quotaTracker';

const app = new Hono<{ Bindings: Env }>();

app.get('/models', async (c) => {
  const accountId = c.req.query('accountId') ? Number(c.req.query('accountId')) : undefined;
  const account = accountId
    ? await getAccountById(c.env.DB, accountId)
    : await selectBestAccount(c.env.DB, c.env.ENCRYPTION_KEY, 'ai_neurons');
  if (!account) return c.json([]);
  const taskFilter = c.req.query('task');

  try {
    const data = await cfFetchRaw(account, `/accounts/${account.account_id}/ai/models/search`, c.env.ENCRYPTION_KEY);
    const json = await data.json() as any;
    let models = json.result || [];
    if (taskFilter) {
      models = models.filter((m: any) => (m.task?.name || '').toLowerCase().includes(taskFilter.toLowerCase()));
    }
    return c.json(models);
  } catch (err: any) {
    console.error(`[AI Models] Failed: ${err.message}`);
    return c.json({ error: { code: 'API_ERROR', message: err.message } }, 502);
  }
});

app.post('/inference', async (c) => {
  const { model, prompt, messages: historyMessages, accountId } = await c.req.json();

  const accounts = accountId
    ? [await getAccountById(c.env.DB, accountId)].filter(Boolean)
    : await getActiveAccountsByFeature(c.env.DB, 'ai');
  if (accounts.length === 0) throw Object.assign(new Error('No active accounts'), { statusCode: 503 });

  const msgs = historyMessages?.length
    ? historyMessages
    : [{ role: 'user', content: prompt }];

  return stream(c, async (s) => {
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]!;
      const headers = await getAuthHeaders(account, c.env.ENCRYPTION_KEY);
      const url = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ messages: msgs, stream: true }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          const is4006 = text.includes('4006') || text.includes('daily free allocation');
          if (is4006 && i + 1 < accounts.length) {
            await setQuota(c.env.DB, account.id, 'ai_neurons', 10000);
            console.warn(`[AI] Account ${account.name} exhausted, switching...`);
            continue;
          }
          await s.write(`data: ${JSON.stringify({ error: is4006 ? 'ALL_ACCOUNTS_EXHAUSTED' : text })}\n\n`);
          return;
        }

        const reader = resp.body?.getReader();
        if (!reader) { await s.write('data: [DONE]\n\n'); return; }
        const decoder = new TextDecoder();
        let sseBuffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') { await s.write('data: [DONE]\n\n'); continue; }
            try {
              const obj = JSON.parse(payload);
              const delta = obj.choices?.[0]?.delta;
              if (delta?.reasoning_content) {
                await s.write(`data: ${JSON.stringify({ type: 'reasoning', chunk: delta.reasoning_content })}\n\n`);
              } else if (delta?.content) {
                await s.write(`data: ${JSON.stringify({ type: 'content', chunk: delta.content })}\n\n`);
              } else if (obj.response) {
                await s.write(`data: ${JSON.stringify({ type: 'content', chunk: obj.response })}\n\n`);
              }
            } catch { /* skip unparseable lines */ }
          }
        }
        if (sseBuffer.trim()) {
          const line = sseBuffer.trim();
          if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
            try {
              const obj = JSON.parse(line.slice(6));
              const delta = obj.choices?.[0]?.delta;
              if (delta?.content) await s.write(`data: ${JSON.stringify({ type: 'content', chunk: delta.content })}\n\n`);
              else if (obj.response) await s.write(`data: ${JSON.stringify({ type: 'content', chunk: obj.response })}\n\n`);
            } catch {}
          }
        }
        return;
      } catch (err: any) {
        if (i + 1 < accounts.length) { console.warn(`[AI] ${account.name} failed, trying next...`); continue; }
        await s.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
    }
  }, async (err) => { console.error('[AI Stream] Error:', err); });
});

app.get('/usage', async (c) => {
  const accounts = await getActiveAccountsByFeature(c.env.DB, 'ai');
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const usage = await getAiUsageToday(account, c.env.ENCRYPTION_KEY);
      return { accountId: account.id, accountName: account.name, ...usage };
    } catch (err) {
      console.error(`[AI Usage] Failed for ${account.name}: ${err}`);
      return { accountId: account.id, accountName: account.name, totalNeurons: 0, models: [] };
    }
  }));
  return c.json(results);
});

export default app;
