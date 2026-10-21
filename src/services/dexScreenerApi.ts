import { apiBinaryRequest, apiRequest } from '../api';

export interface DexScreenerChain {
  slug: string;
  label: string;
}

export interface DexScreenerSession {
  sessionId: string;
  chain: string;
  tokenAddress: string;
  targetUrl: string;
  currentUrl: string;
  title: string;
  responseStatus: number | null;
  serverIp: string | null;
  proxyIp: string;
  egressVerified: boolean;
  countryCode: string;
  ttlMinutes: 30 | 60;
  viewport: { width: number; height: number };
  createdAt: string;
  expiresAt: string;
}

export type DexScreenerAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; deltaY: number; x?: number; y?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'reload' }
  | { type: 'back' };

export async function getDexScreenerChains(): Promise<DexScreenerChain[]> {
  const response = await apiRequest<DexScreenerChain[]>('/api/integrations/dexscreener/chains');
  return response.data || [];
}

export async function createDexScreenerSession(input: {
  chain: string;
  tokenAddress: string;
  countryCode: string;
  ttlMinutes: 30 | 60;
}): Promise<DexScreenerSession> {
  const response = await apiRequest<DexScreenerSession>('/api/integrations/dexscreener/sessions', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return response.data!;
}

export async function getDexScreenerSession(sessionId: string): Promise<DexScreenerSession> {
  const response = await apiRequest<DexScreenerSession>(
    `/api/integrations/dexscreener/sessions/${encodeURIComponent(sessionId)}`
  );
  return response.data!;
}

export async function getDexScreenerScreenshot(sessionId: string): Promise<Blob> {
  const response = await apiBinaryRequest(
    `/api/integrations/dexscreener/sessions/${encodeURIComponent(sessionId)}/screenshot?ts=${Date.now()}`
  );
  return response.blob();
}

export async function performDexScreenerAction(
  sessionId: string,
  action: DexScreenerAction
): Promise<DexScreenerSession> {
  const response = await apiRequest<DexScreenerSession>(
    `/api/integrations/dexscreener/sessions/${encodeURIComponent(sessionId)}/actions`,
    { method: 'POST', body: JSON.stringify(action) }
  );
  return response.data!;
}

export async function closeDexScreenerSession(sessionId: string): Promise<void> {
  await apiRequest(`/api/integrations/dexscreener/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  });
}
