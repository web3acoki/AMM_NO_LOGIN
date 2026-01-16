const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5177';

export interface ApiResponse<T = any> {
  status?: string;
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
    throw new Error(message);
  }

  return payload;
}
