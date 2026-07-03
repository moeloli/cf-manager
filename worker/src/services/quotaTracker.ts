import { getActiveAccounts, getActiveAccountsByFeature, hasFeature, getAllQuotaToday, setQuota, incrementQuota, getQuotaByAccount, getQuotaTodayByResource, getAccountById, clearExhausted, setExhausted, type Account, type AccountFeature } from '../db/models';
import type { Env } from '../types';
import { cfGraphQL } from './cfApi';

export type ResourceType = 'workers_requests' | 'ai_neurons' | 'browser_render_seconds';

export const LIMITS: Record<string, number> = {
  workers_requests: 100000,
  ai_neurons: 10000,
  browser_render_seconds: 600,
};

const KV_KEY = 'ai_neuron_snapshot';
const KV_TTL = 60; // seconds

interface AiKvEntry {
  id: number;
  account_id: string;
  name: string;
  used: number;
}

const RESOURCE_FEATURE: Record<ResourceType, AccountFeature> = {
  workers_requests: 'workers',
  ai_neurons: 'ai',
  browser_render_seconds: 'browser_render',
};

export async function trackUsage(db: D1Database, accountId: number, resource: ResourceType, amount = 1): Promise<void> {
  await incrementQuota(db, accountId, resource, amount);
}

export async function syncUsageFromCloudflare(db: D1Database, encryptionKey: string): Promise<void> {
  const accounts = await getActiveAccounts(db);

  await Promise.all(accounts.map(async (account) => {
    if (hasFeature(account, 'ai')) {
      try {
        const usage = await getAiUsageToday(account, encryptionKey);
        await setQuota(db, account.id, 'ai_neurons', Math.round(usage.totalNeurons));
        await clearExhausted(db, account.id, 'ai_neurons');
      } catch (e) {
        console.error(`[Sync] AI usage failed for ${account.name}: ${e}`);
      }
    }
    if (hasFeature(account, 'workers')) {
      try {
        const usage = await getWorkersUsageToday(account, encryptionKey);
        await setQuota(db, account.id, 'workers_requests', usage.requests);
      } catch (e) {
        console.error(`[Sync] Workers usage failed for ${account.name}: ${e}`);
      }
    }
  }));
}

export async function getQuotaSummary(db: D1Database, encryptionKey: string) {
  const accounts = await getActiveAccounts(db);
  const usage = await getAllQuotaToday(db);
  const resourceTypes = Object.keys(LIMITS) as ResourceType[];

  return accounts.map(account => {
    const resources = resourceTypes
      .filter(r => hasFeature(account, RESOURCE_FEATURE[r]))
      .map(resource => {
        const row = usage.find(u => u.account_id === account.id && u.resource === resource);
        const count = row?.count || 0;
        const limit = LIMITS[resource];
        const exhausted = row?.exhausted === 1;
        return { resource, count, limit, remaining: Math.max(0, limit - count), exhausted };
      });
    return { accountId: account.id, accountName: account.name, resources };
  });
}

export async function getAccountQuota(db: D1Database, accountId: number, resource: ResourceType): Promise<{ used: number; remaining: number }> {
  const usage = await getQuotaByAccount(db, accountId, resource);
  const used = usage?.count || 0;
  const limit = LIMITS[resource] || 0;
  return { used, remaining: Math.max(0, limit - used) };
}

async function getAiSnapshot(env: Env): Promise<Array<AiKvEntry & { _account?: Account }>> {
  if (env.KV) {
    const cached = await env.KV.get<AiKvEntry[]>(KV_KEY, 'json');
    if (cached) return cached as Array<AiKvEntry & { _account?: Account }>;
  }
  const accounts = await getActiveAccountsByFeature(env.DB, 'ai');
  const usageRows = await getQuotaTodayByResource(env.DB, 'ai_neurons');
  const usageMap = new Map(usageRows.map(r => [r.account_id, r]));
  const ranked = accounts
    .map(account => ({
      id: account.id,
      account_id: account.account_id || '',
      name: account.name,
      used: usageMap.get(account.id)?.count || 0,
      _exhausted: usageMap.get(account.id)?.exhausted === 1,
      _account: account,
    }))
    .filter(r => !r._exhausted)
    .sort((a, b) => a.used - b.used);

  if (env.KV) {
    const kvData = ranked.map(r => ({ id: r.id, account_id: r.account_id, name: r.name, used: r.used }));
    await env.KV.put(KV_KEY, JSON.stringify(kvData), { expirationTtl: KV_TTL });
  }
  return ranked;
}

export async function invalidateAiCache(env: Env): Promise<void> {
  if (env.KV) await env.KV.delete(KV_KEY);
}

export async function selectBestAccount(
  env: Env,
  resource: ResourceType,
  excludeIds?: Set<number>
): Promise<Account | null> {
  if (resource === 'ai_neurons') {
    if (env.KV) {
      const cached = await env.KV.get<AiKvEntry[]>(KV_KEY, 'json');
      if (cached) {
        const best = cached.find(r => !excludeIds?.has(r.id));
        if (!best) return null;
        return await getAccountById(env.DB, best.id);
      }
    }
    const snapshot = await getAiSnapshot(env);
    const best = snapshot.find(r => !excludeIds?.has(r.id));
    return best?._account || null;
  }

  // Non-ai_neurons branch keeps original logic
  const featureMap: Record<ResourceType, AccountFeature> = { workers_requests: 'workers', ai_neurons: 'ai', browser_render_seconds: 'browser_render' };
  const accounts = (await getActiveAccounts(env.DB)).filter(a => hasFeature(a, featureMap[resource]));
  if (accounts.length === 0) return null;

  let best: Account | null = null;
  let bestRemaining = -1;
  for (const account of accounts) {
    const { remaining } = await getAccountQuota(env.DB, account.id, resource);
    if (remaining > bestRemaining) { bestRemaining = remaining; best = account; }
  }
  return best;
}

interface AiUsage { totalNeurons: number; models: { modelId: string; neurons: number; requests: number }[] }

async function getAiUsageToday(account: Account, encryptionKey: string): Promise<AiUsage> {
  if (!account.account_id) throw new Error(`AI usage: account "${account.name}" missing account_id`);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = now.toISOString();

  const query = `query($accountTag:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$accountTag}){total:aiInferenceAdaptiveGroups(filter:{datetime_geq:$start,datetime_leq:$end},limit:1){sum{totalNeurons}}byModel:aiInferenceAdaptiveGroups(filter:{datetime_geq:$start,datetime_leq:$end},limit:100,orderBy:[sum_totalNeurons_DESC]){count,sum{totalNeurons},dimensions{modelId}}}}}`;

  try {
    const json = await cfGraphQL(account, query, { accountTag: account.account_id, start, end }, encryptionKey);
    const acct = json?.data?.viewer?.accounts?.[0];
    const totalNeurons = acct?.total?.[0]?.sum?.totalNeurons || 0;
    const models = (acct?.byModel || [])
      .filter((r: any) => r.dimensions?.modelId)
      .map((r: any) => ({ modelId: r.dimensions.modelId, neurons: r.sum?.totalNeurons || 0, requests: r.count || 0 }));
    return { totalNeurons: Math.round(totalNeurons), models };
  } catch (e) {
    console.error(`[AI Usage] Failed for ${account.name}: ${e}`);
    throw new Error(`AI usage failed for ${account.name}: ${e}`);
  }
}

interface WorkersUsage { requests: number; errors: number; subrequests: number; cpuTimeMs: number }

async function getWorkersUsageToday(account: Account, encryptionKey: string): Promise<WorkersUsage> {
  if (!account.account_id) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const datetimeEnd = now.toISOString();

  const query = `query($accountTag:string!,$datetimeStart:Time!,$datetimeEnd:Time!,$todayDate:Date!){viewer{accounts(filter:{accountTag:$accountTag}){workers:workersInvocationsAdaptive(filter:{datetime_geq:$datetimeStart,datetime_leq:$datetimeEnd},limit:10000){sum{requests,errors,subrequests,cpuTimeUs}}pages:pagesFunctionsInvocationsAdaptiveGroups(filter:{date:$todayDate},limit:1){sum{requests,errors}}}}}`;

  try {
    const json = await cfGraphQL(account, query, { accountTag: account.account_id, datetimeStart, datetimeEnd, todayDate }, encryptionKey);
    const acct = json?.data?.viewer?.accounts?.[0];
    const workerRecs = acct?.workers || [];
    const pagesRecs = acct?.pages || [];
    let requests = 0, errors = 0, subrequests = 0, cpuTimeUs = 0;
    for (const r of workerRecs) { requests += r.sum?.requests || 0; errors += r.sum?.errors || 0; subrequests += r.sum?.subrequests || 0; cpuTimeUs += r.sum?.cpuTimeUs || 0; }
    for (const r of pagesRecs) { requests += r.sum?.requests || 0; errors += r.sum?.errors || 0; }
    return { requests, errors, subrequests, cpuTimeMs: Math.round(cpuTimeUs / 1000) };
  } catch (e) {
    console.error(`[Workers Usage] Failed for ${account.name}: ${e}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }
}

export { getWorkersUsageToday };
