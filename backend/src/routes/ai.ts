import { Router, Request, Response, NextFunction } from 'express';
import { Account } from '../models/account';
import { getActiveAccounts } from '../models/account';
import { getAiUsageToday } from '../services/aiService';
import { setQuota, getQuotaByAccount } from '../models/quotaUsage';
import { invalidateAiCache } from '../services/accountRouter';

const router = Router();

/**
 * GET /api/ai/usage
 * 获取所有活跃账户的 AI 使用量统计（同步路径，CF 权威校准）
 *
 * - 并发 getAiUsageToday(每个活跃账户)
 * - 成功的账户：setQuota(CF 权威值) + invalidateAiCache（不清除 exhausted 标记）
 * - 失败的账户：跳过（不更新，保留本地估算）
 */
router.get('/usage', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const accounts = getActiveAccounts().filter(a => a.account_id) as Account[];

    const promises = accounts.map(async (account) => {
      try {
        const usage = await getAiUsageToday(account as Account);
        
        // 当 CF 返回非零值：使用 CF 数据更新本地计数
        if (usage.totalNeurons > 0) {
          setQuota(account.id, 'ai_neurons', usage.totalNeurons);
          // 不清除 exhausted 标记：exhausted 是 CF 返回 4006 时设置的，
          // 表示当天免费额度已用完。使用量 > 0 只代表今天用了多少 neurons，
          // 不代表额度没用完。标记只应通过日期变化或手动清除。
          return {
            accountId: account.account_id,
            accountName: account.name,
            totalNeurons: usage.totalNeurons,
            models: usage.models,
          };
        } else {
          // CF 返回 0 或负数：回退到本地数据库的值
          console.warn(`[AI Usage] CF returned 0 for ${account.name}, using local estimate`);
          const localQuota = getQuotaByAccount(account.id, 'ai_neurons', today);
          return {
            accountId: account.account_id,
            accountName: account.name,
            totalNeurons: localQuota?.count || 0,
            models: [],
            warning: 'CF returned 0, using local estimate'
          };
        }
      } catch (err: any) {
        console.error(`[AI Usage] Failed for ${account.name}:`, err.message);
        // CF 调用失败：返回本地数据库的值
        const localQuota = getQuotaByAccount(account.id, 'ai_neurons', today);
        return {
          accountId: account.account_id,
          accountName: account.name,
          totalNeurons: localQuota?.count || 0,
          models: [],
          warning: 'Failed to fetch from CF, using local estimate'
        };
      }
    });

    const results = await Promise.allSettled(promises);

    // 提取成功的结果，过滤掉失败的
    const result = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    // 同步完成后全量刷新内存缓存
    invalidateAiCache();

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
