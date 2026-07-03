import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'http';
import nodeFetch from 'node-fetch';
import { config } from '../config';
import { getSetting, setSetting } from '../db';

let cachedAgent: Agent | undefined;
let cachedUrl = '';

function isSocks(url: string): boolean {
  return /^socks[45h]?:\/\//i.test(url);
}

export function getProxyUrl(): string {
  const dbVal = getSetting('proxy_url');
  if (dbVal !== undefined) return dbVal;
  return config.proxyUrl;
}

export function setProxyUrl(url: string): void {
  setSetting('proxy_url', url);
  cachedAgent = undefined;
  cachedUrl = '';
}

export function getHttpAgent(): Agent | undefined {
  const url = getProxyUrl();
  if (!url) return undefined;
  if (url === cachedUrl && cachedAgent) return cachedAgent;

  cachedAgent = isSocks(url)
    ? new SocksProxyAgent(url, { timeout: 30000 })
    : new HttpsProxyAgent(url, { timeout: 30000 });
  cachedUrl = url;
  return cachedAgent;
}

export async function proxyFetch(input: string | URL, init?: any): Promise<Response> {
  const agent = getHttpAgent();
  if (!agent) return fetch(input, init);

  const doFetch = () => nodeFetch(input.toString(), { ...init, agent });
  try {
    const resp = await doFetch();
    return resp as unknown as Response;
  } catch (err: any) {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      cachedAgent = undefined;
      cachedUrl = '';
      const newAgent = getHttpAgent();
      const resp = await nodeFetch(input.toString(), { ...init, agent: newAgent });
      return resp as unknown as Response;
    }
    throw err;
  }
}

export async function testProxyConnection(proxyUrl: string): Promise<{ latency_ms: number; status: number }> {
  const agent = isSocks(proxyUrl)
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);

  const start = Date.now();
  const resp = await nodeFetch('https://api.cloudflare.com/client/v4/ips', {
    agent,
    timeout: 10000,
  });
  const latency = Date.now() - start;

  if (!resp.ok) {
    throw new Error(`Upstream returned HTTP ${resp.status}`);
  }
  return { latency_ms: latency, status: resp.status };
}
