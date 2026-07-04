import { incrementQuota, getAllQuotaToday, getQuotaByAccount, setQuota } from '../models/quotaUsage';
import { getActiveAccounts, hasFeature, AccountFeature } from '../models/account';
import { getAiUsageToday } from './aiService';
import { getWorkersUsageToday } from './workerService';
import { appLogger } from './logger';

export type ResourceType = 'workers_requests' | 'ai_neurons' | 'browser_render_seconds';

const LIMITS: Record<string, number> = {
  workers_requests: 100000,
  ai_neurons: 10000,
  browser_render_seconds: 600,
};

export function trackUsage(accountId: number, resource: ResourceType, amount: number = 1): void {
  incrementQuota(accountId, resource, amount);
}

const RESOURCE_FEATURE: Record<ResourceType, AccountFeature> = {
  workers_requests: 'workers',
  ai_neurons: 'ai',
  browser_render_seconds: 'browser_render',
};

export async function syncUsageFromCloudflare(): Promise<void> {
  const accounts = getActiveAccounts();

  await Promise.all(accounts.map(async (account) => {
    if (hasFeature(account, 'ai')) {
      try {
        const aiUsage = await getAiUsageToday(account);
        // 只有当 CF 返回非零值才更新（避免覆盖本地估算数据）
        if (aiUsage.totalNeurons > 0) {
          setQuota(account.id, 'ai_neurons', Math.round(aiUsage.totalNeurons));
          // 不清除 exhausted 标记：exhausted 是 CF 返回 4006 时设置的，
          // 表示当天免费额度已用完。即使 CF 使用量查询返回了 > 0 的值
          // （今天用了多少 neurons），也不代表额度没用完。
          // exhausted 标记只应通过日期变化（第二天自动消失）或手动清除。
        } else {
          appLogger.warn(`[Sync] AI usage returned 0 for ${account.name}, keeping local estimate`);
        }
      } catch (e) {
        appLogger.error(`[Sync] AI usage failed for ${account.name}: ${e}`);
      }
    }

    if (hasFeature(account, 'workers')) {
      try {
        const workersUsage = await getWorkersUsageToday(account);
        // 只有当 CF 返回非零值才更新
        if (workersUsage.requests > 0) {
          setQuota(account.id, 'workers_requests', workersUsage.requests);
        } else {
          appLogger.warn(`[Sync] Workers usage returned 0 for ${account.name}, keeping local estimate`);
        }
      } catch (e) {
        appLogger.error(`[Sync] Workers usage failed for ${account.name}: ${e}`);
      }
    }
  }));
}

export function getQuotaSummary() {
  const accounts = getActiveAccounts();
  const usage = getAllQuotaToday();
  const resourceTypes = Object.keys(LIMITS) as ResourceType[];

  return accounts.map(account => {
    const resources = resourceTypes
      .filter(resource => hasFeature(account, RESOURCE_FEATURE[resource]))
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

export function getAccountQuota(accountId: number, resource: ResourceType): { used: number; remaining: number } {
  const today = new Date().toISOString().split('T')[0];
  const usage = getQuotaByAccount(accountId, resource, today);
  const used = usage?.count || 0;
  const limit = LIMITS[resource] || 0;
  return { used, remaining: Math.max(0, limit - used) };
}
