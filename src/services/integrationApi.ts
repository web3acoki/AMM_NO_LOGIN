import { apiRequest } from '../api';

export type IpFoxyRotation = 'sticky' | 'per_request';
export type IpFoxyProxyHost =
  | 'gate.ipfoxy.io'
  | 'gate-sg.ipfoxy.io'
  | 'gate-us.ipfoxy.io';

export interface IntegrationStatus {
  ipFoxy: {
    provider: 'ipfoxy';
    enabled: boolean;
    apiConfigured: boolean;
    proxyConfigured: boolean;
    mode: 'rotating-residential';
    gateway: { host: string; port: number; protocol: string };
    defaults: { countryCode: string; ttlMinutes: number };
  };
  captchaRun: {
    provider: 'captcharun';
    enabled: boolean;
    configured: boolean;
    taskCreationEnabled: boolean;
    allowedRefererHosts: string[];
    supportedCaptchaTypes: string[];
  };
  targetPolicy: {
    preferredDexScreenerAccess: 'official-api';
    targetOrigin: 'https://dexscreener.com';
    targetLocked: true;
    captchaRefererAllowlist: string[];
  };
}

export interface MaskedCredential {
  configured: boolean;
  masked: string;
}

export interface IntegrationSettings {
  source: 'database' | 'environment';
  targetPlatform: {
    name: 'DEX Screener';
    origin: 'https://dexscreener.com';
    locked: true;
  };
  ipFoxy: {
    enabled: boolean;
    proxyHost: IpFoxyProxyHost;
    proxyPort: 58688;
    proxyProtocol: 'http';
    defaultCountry: string;
    defaultTtlMinutes: 30 | 60;
    apiId: MaskedCredential;
    apiToken: MaskedCredential;
    proxyUsername: MaskedCredential;
    proxyPassword: MaskedCredential;
  };
  captchaRun: {
    enabled: boolean;
    allowTaskCreation: boolean;
    apiToken: MaskedCredential;
    allowedRefererHosts: ['dexscreener.com'];
  };
  updatedAt: string | null;
}

export interface IntegrationSettingsUpdate {
  ipFoxy?: {
    enabled?: boolean;
    proxyHost?: IpFoxyProxyHost;
    defaultCountry?: string;
    defaultTtlMinutes?: 30 | 60;
    apiId?: string;
    apiToken?: string;
    proxyUsername?: string;
    proxyPassword?: string;
    clearApiId?: boolean;
    clearApiToken?: boolean;
    clearProxyUsername?: boolean;
    clearProxyPassword?: boolean;
  };
  captchaRun?: {
    enabled?: boolean;
    allowTaskCreation?: boolean;
    apiToken?: string;
    clearApiToken?: boolean;
  };
}

export interface IpFoxySessionOptions {
  rotation?: IpFoxyRotation;
  countryCode?: string;
  randomRegion?: boolean;
  state?: string;
  city?: string;
  sessionId?: string;
  ttlMinutes?: 30 | 60;
}

export interface IpFoxySessionPreview {
  host: string;
  port: number;
  protocol: string;
  username: string;
  credentialsPresent: boolean;
  rotation: IpFoxyRotation;
  countryCode: string | null;
  sessionId: string | null;
  ttlMinutes: number | null;
}

export interface CaptchaRunTaskInput {
  captchaType: 'ReCaptchaV2' | 'ReCaptchaV3' | 'ReCaptchaV2Enterprise' | 'HCaptcha' | 'Turnstile';
  siteKey: string;
  siteReferer: string;
  siteAction?: string;
  useCache?: boolean;
  isInvisible?: boolean;
  payload?: string | Record<string, unknown>;
  domain?: string;
  anchor?: string;
  reload?: string;
  data?: string;
  userAgent?: string;
  fallbackToActualUA?: boolean;
  cookies?: string;
}

export interface CaptchaRunTaskResult {
  taskId?: string;
  status: 'Working' | 'Success' | 'Fail' | string;
  captchaType?: string;
  price?: string;
  deducted?: boolean;
  response?: Record<string, unknown>;
  reason?: string;
  createdAt?: string;
  finishedAt?: string;
  fromCache?: boolean;
}

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  const response = await apiRequest<IntegrationStatus>('/api/integrations/status');
  return response.data!;
}

export async function getIntegrationSettings(): Promise<IntegrationSettings> {
  const response = await apiRequest<IntegrationSettings>('/api/integrations/settings');
  return response.data!;
}

export async function updateIntegrationSettings(
  input: IntegrationSettingsUpdate
): Promise<IntegrationSettings> {
  const response = await apiRequest<IntegrationSettings>('/api/integrations/settings', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return response.data!;
}

export async function getIpFoxyTraffic(account?: string): Promise<Record<string, unknown>> {
  const query = account ? `?account=${encodeURIComponent(account)}` : '';
  const response = await apiRequest<Record<string, unknown>>(`/api/integrations/ipfoxy/traffic${query}`);
  return response.data || {};
}

export async function getIpFoxyRegions(): Promise<unknown> {
  const response = await apiRequest('/api/integrations/ipfoxy/regions');
  return response.data;
}

export async function previewIpFoxySession(options: IpFoxySessionOptions): Promise<IpFoxySessionPreview> {
  const response = await apiRequest<IpFoxySessionPreview>('/api/integrations/ipfoxy/sessions/preview', {
    method: 'POST',
    body: JSON.stringify(options)
  });
  return response.data!;
}

export async function checkIpFoxyEgress(options: IpFoxySessionOptions): Promise<Record<string, unknown>> {
  const response = await apiRequest<Record<string, unknown>>('/api/integrations/ipfoxy/egress-check', {
    method: 'POST',
    body: JSON.stringify(options)
  });
  return response.data || {};
}

export async function createCaptchaRunTask(input: CaptchaRunTaskInput): Promise<{ taskId: string }> {
  const response = await apiRequest<{ taskId: string }>('/api/integrations/captcharun/tasks', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return response.data!;
}

export async function getCaptchaRunTask(taskId: string): Promise<CaptchaRunTaskResult> {
  const response = await apiRequest<CaptchaRunTaskResult>(
    `/api/integrations/captcharun/tasks/${encodeURIComponent(taskId)}`
  );
  return response.data!;
}
