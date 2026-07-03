export interface Resource {
  resource: string;
  count: number;
  limit: number;
  exhausted?: boolean; // true = 已耗尽
}

export const resourceOrder = ['workers_requests', 'ai_neurons', 'browser_render_seconds'] as const;

export const resourceLabels: Record<string, string> = {
  workers_requests: 'Workers 请求',
  ai_neurons: 'AI 神经元',
  browser_render_seconds: '浏览器渲染',
};

export function resourceLabel(resource: string): string {
  return resourceLabels[resource] || resource;
}

export function calcPercentage(r: Resource): number {
  if (!r.limit) return 0;
  return Math.min(100, Math.round(((r.count || 0) / r.limit) * 100));
}

export function formatValue(r: Resource): string {
  if (r.resource === 'browser_render_seconds') {
    const m = Math.floor(r.count / 60);
    const s = Math.round(r.count % 60);
    const lm = Math.floor(r.limit / 60);
    const ls = Math.round(r.limit % 60);
    return `${m > 0 ? m + '分' : ''}${s}秒 / ${lm}分${ls > 0 ? ls + '秒' : ''}`;
  }
  return `${(r.count || 0).toLocaleString()} / ${(r.limit || 0).toLocaleString()}`;
}
