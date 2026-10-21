const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5177';

export interface ApiResponse<T = any> {
  status?: string;
  code?: string;
  message?: string;
  data?: T;
  error?: string;
}

export async function apiRequest<T = any>(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('amm_token');
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Every transaction-coordination request is fenced by this protocol
  // version. After a deployment, an older open page can no longer renew
  // wallet/market/runtime leases and continue writing with stale semantics.
  headers.set('X-AMM-Coordination-Version', '3');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include'
  });

  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T>;

  if (!response.ok) {
    const message = payload.message || payload.error || '请求失败';
    const error = new Error(message) as Error & {
      code?: string;
      status?: number;
      data?: unknown;
    };
    error.code = payload.code;
    error.status = response.status;
    error.data = payload.data;
    throw error;
  }

  return payload;
}

export async function apiBinaryRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('amm_token');
  const headers = new Headers(options.headers || {});
  headers.set('X-AMM-Coordination-Version', '3');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include'
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : { message: await response.text().catch(() => '') };
    const error = new Error(payload.message || payload.error || '请求失败') as Error & {
      code?: string;
      status?: number;
      data?: unknown;
    };
    error.code = payload.code;
    error.status = response.status;
    error.data = payload.data;
    throw error;
  }
  return response;
}
