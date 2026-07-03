import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch, buildCurlCommand } from './proxyService';
import { appLogger } from './logger';

export async function getAvailableModels(account: Account, taskFilter?: string): Promise<any[]> {
  if (!account.account_id) {
    throw new Error(`账户 "${account.name}" 缺少 Cloudflare Account ID，请点击"测试连接"以获取`);
  }
  const cfAny = getCfClient(account) as any;
  const models: any[] = [];
  let count = 0;
  for await (const model of cfAny.ai.models.list({ account_id: account.account_id })) {
    const m = model as any;
    // Log first model structure for debugging
    if (count === 0) {
      appLogger.debug(`[AI Models] Sample model structure: ${JSON.stringify(m, null, 2).slice(0, 500)}`);
    }
    count++;
    // 如果指定了任务过滤，只返回匹配的模型
    if (taskFilter) {
      const taskName = m.task?.name || m.task || '';
      // Normalize: convert both to lowercase and replace hyphens with spaces for matching
      // e.g., "text-generation" matches "Text Generation"
      const normalizedTaskName = taskName.toLowerCase().replace(/-/g, ' ');
      const normalizedFilter = taskFilter.toLowerCase().replace(/-/g, ' ');
      if (!normalizedTaskName.includes(normalizedFilter)) continue;
    }
    models.push(m);
  }
  appLogger.debug(`[AI Models] Total: ${count}, Filtered (${taskFilter}): ${models.length}`);
  return models;
}

export interface AiUsage {
  totalNeurons: number;
  models: Array<{ modelId: string; neurons: number; requests: number }>;
}

export async function getAiUsageToday(account: Account): Promise<AiUsage> {
  const accountId = account.account_id;
  if (!accountId) throw new Error(`AI usage: account "${account.name}" missing account_id`);

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const todayEnd = now.toISOString();

  const query = `
    query CfAiUsage($accountTag: string!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          total: aiInferenceAdaptiveGroups(
            filter: { datetime_geq: $start, datetime_leq: $end }
            limit: 1
          ) {
            sum { totalNeurons }
          }
          byModel: aiInferenceAdaptiveGroups(
            filter: { datetime_geq: $start, datetime_leq: $end }
            limit: 100
            orderBy: [sum_totalNeurons_DESC]
          ) {
            count
            sum { totalNeurons }
            dimensions { modelId }
          }
        }
      }
    }
  `;

  const headers = getAuthHeaders(account);
  const fetchUrl = 'https://api.cloudflare.com/client/v4/graphql';
  const fetchInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, start: todayStart, end: todayEnd },
    }),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let resp;
  try {
    resp = await proxyFetch(fetchUrl, { ...fetchInit, signal: controller.signal });
  } catch (e) {
    appLogger.error(`[AI Usage] Fetch failed for ${account.name}: ${e}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    throw new Error(`AI usage fetch failed for ${account.name}: ${e}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) throw new Error(`AI usage HTTP ${resp.status} for ${account.name}`);

  const json = await resp.json() as any;
  if (json.errors) {
    appLogger.error(`[GraphQL] AI usage errors: ${JSON.stringify(json.errors)}`);
    throw new Error(`GraphQL errors for ${account.name}: ${JSON.stringify(json.errors)}`);
  }

  const acct = json?.data?.viewer?.accounts?.[0];
  const totalRecs = acct?.total || [];
  const modelRecs = acct?.byModel || [];

  const totalNeurons = totalRecs[0]?.sum?.totalNeurons || 0;
  const models = modelRecs
    .filter((r: any) => r.dimensions?.modelId)
    .map((r: any) => ({
      modelId: r.dimensions.modelId,
      neurons: r.sum?.totalNeurons || 0,
      requests: r.count || 0,
    }));

  return { totalNeurons: Math.round(totalNeurons), models };
}
