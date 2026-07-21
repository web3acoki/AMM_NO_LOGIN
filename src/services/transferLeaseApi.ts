import { apiRequest } from '../api';

type AcquireLeaseData = {
  leaseId: string;
  leaseToken: string;
  expiresAt: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
};

type RenewLeaseData = {
  expiresAt: string;
  leaseDurationMs: number;
};

const LEASE_SAFETY_WINDOW_MS = 5_000;
const LEASE_REQUEST_TIMEOUT_MS = 10_000;

export type TransferLeaseGuard = {
  assertActive: () => void;
  /**
   * Keep the server lease and heartbeat alive after the transaction callback
   * returns. Used when a broadcast is pending/unknown so another task cannot
   * enter the same wallet or market before read-only reconciliation settles it.
   * This registers background retention; callers must not await the returned
   * cleanup promise from inside the lease callback.
   */
  retainUntil?: (settlement: Promise<unknown>) => Promise<void>;
};

async function leaseApiRequest<T>(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), LEASE_REQUEST_TIMEOUT_MS);
  try {
    return await apiRequest<T>(path, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('全局锁请求超时，已停止后续交易');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function validateAcquireLease(data: AcquireLeaseData, label: string): AcquireLeaseData {
  if (!/^[0-9a-f-]{36}$/i.test(String(data.leaseId || ''))) {
    throw new Error(`后端返回的${label} ID 无效`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(data.leaseToken || ''))) {
    throw new Error(`后端返回的${label}令牌无效`);
  }
  if (!Number.isFinite(Date.parse(data.expiresAt))) {
    throw new Error(`后端返回的${label}过期时间无效`);
  }
  if (
    !Number.isFinite(data.leaseDurationMs)
    || data.leaseDurationMs <= LEASE_SAFETY_WINDOW_MS
    || !Number.isFinite(data.heartbeatIntervalMs)
    || data.heartbeatIntervalMs <= 0
    || data.heartbeatIntervalMs >= data.leaseDurationMs - LEASE_SAFETY_WINDOW_MS
  ) {
    throw new Error(`后端返回的${label}租约周期无效`);
  }
  return data;
}

async function acquireTransferLease(chainId: number, address: string): Promise<AcquireLeaseData> {
  const response = await leaseApiRequest<AcquireLeaseData>('/api/transfer-leases/acquire', {
    method: 'POST',
    body: JSON.stringify({ chainId, address }),
  });
  if (!response.data) throw new Error('后端未返回转账全局锁');
  return validateAcquireLease(response.data, '源钱包全局锁');
}

async function acquireMarketLease(chainId: number, tokenAddress: string): Promise<AcquireLeaseData> {
  const response = await leaseApiRequest<AcquireLeaseData>('/api/market-leases/acquire', {
    method: 'POST',
    body: JSON.stringify({ chainId, tokenAddress }),
  });
  if (!response.data) throw new Error('后端未返回市场全局锁');
  return validateAcquireLease(response.data, '代币市场全局锁');
}

async function renewLease(
  basePath: string,
  tokenHeader: string,
  leaseId: string,
  leaseToken: string,
): Promise<RenewLeaseData> {
  const response = await leaseApiRequest<RenewLeaseData>(`${basePath}/${leaseId}/renew`, {
    method: 'POST',
    headers: { [tokenHeader]: leaseToken },
  });
  if (!response.data) throw new Error('后端未返回全局锁续租结果');
  if (!Number.isFinite(Date.parse(response.data.expiresAt))) {
    throw new Error('后端返回的全局锁续租过期时间无效');
  }
  return response.data;
}

async function releaseLease(
  basePath: string,
  tokenHeader: string,
  leaseId: string,
  leaseToken: string,
): Promise<void> {
  await leaseApiRequest(`${basePath}/${leaseId}`, {
    method: 'DELETE',
    headers: { [tokenHeader]: leaseToken },
  });
}

async function withLease<T>(
  basePath: string,
  label: string,
  tokenHeader: string,
  acquire: () => Promise<AcquireLeaseData>,
  callback: (guard: TransferLeaseGuard) => Promise<T>,
): Promise<T> {
  const acquisitionStartedAt = Date.now();
  const lease = await acquire();
  if (!Number.isFinite(lease.leaseDurationMs) || lease.leaseDurationMs <= LEASE_SAFETY_WINDOW_MS) {
    throw new Error(`后端返回的${label}有效期无效`);
  }
  // Use a duration measured from the local request start. This is deliberately
  // conservative and remains correct even when browser/server clocks differ.
  let expiresAtMs = acquisitionStartedAt + lease.leaseDurationMs;
  let lostError: Error | null = null;
  let renewInFlight = false;
  let retainedUntil: Promise<unknown> | null = null;
  let resolveReleaseCompleted!: () => void;
  const releaseCompleted = new Promise<void>(resolve => {
    resolveReleaseCompleted = resolve;
  });

  const guard: TransferLeaseGuard = {
    assertActive() {
      if (lostError) throw lostError;
      if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs - LEASE_SAFETY_WINDOW_MS) {
        lostError = new Error(`${label}已过期，后续交易已停止`);
        throw lostError;
      }
    },
    retainUntil(settlement) {
      const safeSettlement = Promise.resolve(settlement).catch(() => undefined);
      retainedUntil = retainedUntil
        ? Promise.allSettled([retainedUntil, safeSettlement])
        : safeSettlement;
      // Callers that also hold an in-page gate use this promise to keep that
      // gate closed until the server DELETE has completed (or timed out), not
      // merely until the on-chain reconciliation promise settles.
      return releaseCompleted;
    },
  };

  const heartbeat = window.setInterval(async () => {
    if (renewInFlight || lostError) return;
    renewInFlight = true;
    try {
      const renewalStartedAt = Date.now();
      const renewed = await renewLease(basePath, tokenHeader, lease.leaseId, lease.leaseToken);
      if (!Number.isFinite(renewed.leaseDurationMs) || renewed.leaseDurationMs <= LEASE_SAFETY_WINDOW_MS) {
        throw new Error(`${label}续租有效期无效`);
      }
      expiresAtMs = renewalStartedAt + renewed.leaseDurationMs;
    } catch (error: any) {
      lostError = new Error(error?.message || `${label}续租失败，后续交易已停止`);
    } finally {
      renewInFlight = false;
    }
  }, lease.heartbeatIntervalMs);

  let finalized = false;
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    window.clearInterval(heartbeat);
    try {
      await releaseLease(basePath, tokenHeader, lease.leaseId, lease.leaseToken).catch(() => undefined);
    } finally {
      resolveReleaseCompleted();
    }
  };

  try {
    guard.assertActive();
    return await callback(guard);
  } finally {
    const retention = retainedUntil as Promise<unknown> | null;
    if (retention) {
      // Do not block the caller/UI, but continue heartbeats in the background.
      // The lease is released only after the read-only reconciliation promise
      // settles; a browser crash still fails closed until the server TTL expires.
      void retention.finally(finalize);
    } else {
      await finalize();
    }
  }
}

export async function withTransferLease<T>(
  chainId: number,
  address: string,
  callback: (guard: TransferLeaseGuard) => Promise<T>,
): Promise<T> {
  return withLease(
    '/api/transfer-leases',
    '源钱包全局锁',
    'X-Transfer-Lease-Token',
    () => acquireTransferLease(chainId, address),
    callback,
  );
}

export async function withMarketLease<T>(
  chainId: number,
  tokenAddress: string,
  callback: (guard: TransferLeaseGuard) => Promise<T>,
): Promise<T> {
  return withLease(
    '/api/market-leases',
    '代币市场全局锁',
    'X-Market-Lease-Token',
    () => acquireMarketLease(chainId, tokenAddress),
    callback,
  );
}
