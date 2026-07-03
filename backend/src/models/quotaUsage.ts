import { getDb } from '../db';

export interface QuotaUsage {
  id: number;
  account_id: number;
  resource: string;
  date: string;
  count: number;
  exhausted: number;
}

export function getQuotaByAccount(
  accountId: number,
  resource: string,
  date: string
): QuotaUsage | undefined {
  return getDb()
    .prepare('SELECT * FROM quota_usage WHERE account_id = ? AND resource = ? AND date = ?')
    .get(accountId, resource, date) as QuotaUsage | undefined;
}

export function incrementQuota(accountId: number, resource: string, amount: number): void {
  const today = new Date().toISOString().split('T')[0];
  getDb()
    .prepare(
      `INSERT INTO quota_usage (account_id, resource, date, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, resource, date) DO UPDATE SET count = count + ?`
    )
    .run(accountId, resource, today, amount, amount);
}

export function setQuota(accountId: number, resource: string, count: number): void {
  const today = new Date().toISOString().split('T')[0];
  getDb()
    .prepare(
      `INSERT INTO quota_usage (account_id, resource, date, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, resource, date) DO UPDATE SET count = ?`
    )
    .run(accountId, resource, today, count, count);
}

export function getAllQuotaToday(): QuotaUsage[] {
  const today = new Date().toISOString().split('T')[0];
  return getDb().prepare('SELECT * FROM quota_usage WHERE date = ?').all(today) as QuotaUsage[];
}

export function setExhausted(accountId: number, resource: string): void {
  const today = new Date().toISOString().split('T')[0];
  getDb()
    .prepare(`INSERT INTO quota_usage (account_id, resource, date, count, exhausted) VALUES (?, ?, ?, 0, 1)
              ON CONFLICT(account_id, resource, date) DO UPDATE SET exhausted = 1`)
    .run(accountId, resource, today);
}

export function clearExhausted(accountId: number, resource: string): void {
  const today = new Date().toISOString().split('T')[0];
  getDb()
    .prepare(`UPDATE quota_usage SET exhausted = 0 WHERE account_id = ? AND resource = ? AND date = ?`)
    .run(accountId, resource, today);
}

export function getQuotaTodayByResource(resource: string): QuotaUsage[] {
  const today = new Date().toISOString().split('T')[0];
  return getDb()
    .prepare('SELECT * FROM quota_usage WHERE resource = ? AND date = ?')
    .all(resource, today) as QuotaUsage[];
}
