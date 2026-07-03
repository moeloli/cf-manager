export interface Env {
  DB: D1Database;
  API_SECRET: string;
  ENCRYPTION_KEY: string;
  DEMO_ACCOUNT_IDS: string;
  ASSETS: Fetcher;
  KV?: KVNamespace;
}
