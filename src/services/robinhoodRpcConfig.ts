import { ROBINHOOD_OFFICIAL_RPC_URL } from '../constants';

let runtimeRobinhoodRpcUrl = ROBINHOOD_OFFICIAL_RPC_URL;

function normalizeRpcUrl(url: string): string {
  const trimmed = url.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Robinhood RPC 必须使用 HTTP 或 HTTPS 地址');
  }
  return trimmed;
}

/**
 * Install the authenticated server-provided Robinhood RPC for this browser
 * session. The paid URL stays out of the public JavaScript bundle and is only
 * returned by /api/config after login.
 */
export function setRuntimeRobinhoodRpcUrl(url: string): void {
  runtimeRobinhoodRpcUrl = normalizeRpcUrl(url);
}

export function getRuntimeRobinhoodRpcUrl(): string {
  return runtimeRobinhoodRpcUrl;
}
