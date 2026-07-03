import NodeCache from 'node-cache';
import { getActiveAccounts, getActiveAccountsByFeature, Account, AccountFeature, hasFeature } from '../models/account';
import { getCfClient } from './cfFactory';
import { getAccountQuota, ResourceType } from './quotaTracker';
import { getQuotaTodayByResource } from '../models/quotaUsage';
import { appLogger } from './logger';

const ZONES_CACHE_TTL = 300; // 5 minutes
const QUOTA_CACHE_TTL = 60;  // 1 minute
const AI_CACHE_KEY = 'ai_neuron_snapshot';
const AI_CACHE_TTL = 600; // 10 min

interface Zone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}

interface AiSnapshotEntry {
  account: Account;
  used: number;
}

const zonesCache = new NodeCache({ stdTTL: ZONES_CACHE_TTL });
const quotaCache = new NodeCache({ stdTTL: QUOTA_CACHE_TTL });

export async function getAllZones(): Promise<Array<Zone & { cfAccountId: number; accountName: string }>> {
  const cacheKey = 'all_zones';
  const cached = zonesCache.get<Array<Zone & { cfAccountId: number; accountName: string }>>(cacheKey);
  if (cached) return cached;

  const accounts = getActiveAccountsByFeature('dns');

  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const cf = getCfClient(account);
      const zones: Zone[] = [];
      for await (const zone of cf.zones.list({ per_page: 100 })) {
        zones.push(zone as any);
      }
      return zones.map(zone => ({ ...zone, cfAccountId: account.id, accountName: account.name }));
    } catch (err) {
      appLogger.error(`Failed to fetch zones for account ${account.name}: ${err}`);
      return [];
    }
  }));
  const allZones = results.flat();

  zonesCache.set(cacheKey, allZones);
  return allZones;
}

export async function findAccountByDomain(domain: string): Promise<{ account: Account; zoneId: string }> {
  const zones = await getAllZones();
  const zone = zones.find(z => z.name === domain);
  if (!zone) {
    throw Object.assign(new Error(`Domain ${domain} not found in any account`), { statusCode: 404, code: 'DOMAIN_NOT_FOUND' });
  }
  const account = getActiveAccounts().find(a => a.id === zone.cfAccountId);
  if (!account) {
    throw Object.assign(new Error('Account not found'), { statusCode: 500, code: 'ACCOUNT_NOT_FOUND' });
  }
  return { account, zoneId: zone.id };
}

const RESOURCE_FEATURE_MAP: Record<ResourceType, AccountFeature> = {
  ai_neurons: 'ai',
  workers_requests: 'workers',
  browser_render_seconds: 'browser_render',
};

function getAiAccountSnapshot(): AiSnapshotEntry[] {
  const cached = quotaCache.get<AiSnapshotEntry[]>(AI_CACHE_KEY);
  if (cached) return cached;

  const accounts = getActiveAccountsByFeature('ai');
  const usageRows = getQuotaTodayByResource('ai_neurons');
  const usageMap = new Map(usageRows.map(r => [r.account_id, r]));

  const ranked = accounts
    .map(account => {
      const usage = usageMap.get(account.id);
      const used = usage?.count || 0;
      const exhausted = usage?.exhausted === 1;
      return { account, used, exhausted };
    })
    .filter(r => !r.exhausted)
    .sort((a, b) => a.used - b.used)
    .map(r => ({ account: r.account, used: r.used }));

  quotaCache.set(AI_CACHE_KEY, ranked, AI_CACHE_TTL);
  return ranked;
}

export async function selectBestAccount(
  resource: ResourceType,
  excludeIds?: Set<number>
): Promise<Account | null> {
  if (resource === 'ai_neurons') {
    const list = getAiAccountSnapshot();
    return list.find(r => !excludeIds?.has(r.account.id))?.account || null;
  }

  // 非 ai_neurons 分支保持原逻辑
  const cacheKey = `best_account_${resource}`;
  const cached = quotaCache.get<{ account: Account }>(cacheKey);
  if (cached) return cached.account;

  const feature = RESOURCE_FEATURE_MAP[resource];
  const accounts = feature ? getActiveAccountsByFeature(feature) : getActiveAccounts();
  if (accounts.length === 0) return null;

  let best = accounts[0];
  let bestRemaining = -1;

  for (const account of accounts) {
    const { remaining } = getAccountQuota(account.id, resource);
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      best = account;
    }
  }

  quotaCache.set(cacheKey, { account: best });
  return best;
}

export function invalidateAiCache(): void {
  quotaCache.del(AI_CACHE_KEY);
}

export function updateAiCacheAfterUsage(accountId: number, neurons: number): void {
  const list = quotaCache.get<AiSnapshotEntry[]>(AI_CACHE_KEY);
  if (!list) return;
  const item = list.find(r => r.account.id === accountId);
  if (item) {
    item.used += neurons;
    list.sort((a, b) => a.used - b.used);
  }
}

export function removeAccountFromAiCache(accountId: number): void {
  const list = quotaCache.get<AiSnapshotEntry[]>(AI_CACHE_KEY);
  if (!list) return;
  const idx = list.findIndex(r => r.account.id === accountId);
  if (idx >= 0) list.splice(idx, 1);
}

export function clearCache(resource?: ResourceType): void {
  if (resource) {
    if (resource === 'ai_neurons') {
      invalidateAiCache();
    } else {
      const cacheKey = `best_account_${resource}`;
      quotaCache.del(cacheKey);
    }
  } else {
    // Clear all caches (backward compatibility)
    zonesCache.flushAll();
    quotaCache.flushAll();
  }
}
