import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}));

vi.mock('../../api', () => ({
  apiRequest: mocks.apiRequest,
}));

import { withMarketLease } from '../transferLeaseApi';

const LEASE_ID = '12345678-1234-1234-1234-123456789abc';
const LEASE_TOKEN = 'ab'.repeat(32);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 2),
    clearInterval: vi.fn(),
  });
});

describe('server lease retention lifecycle', () => {
  it('keeps retention completion pending until the server DELETE finishes', async () => {
    const settlement = deferred<void>();
    const release = deferred<{ data: undefined }>();
    let retentionCompleted!: Promise<void>;

    mocks.apiRequest.mockImplementation(async (path: string, options: RequestInit = {}) => {
      if (path.endsWith('/acquire')) {
        return {
          data: {
            leaseId: LEASE_ID,
            leaseToken: LEASE_TOKEN,
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
            leaseDurationMs: 90_000,
            heartbeatIntervalMs: 20_000,
          },
        };
      }
      if (options.method === 'DELETE') return release.promise;
      throw new Error(`unexpected lease request: ${options.method} ${path}`);
    });

    const result = await withMarketLease(
      4663,
      '0x000000000000000000000000000000000000beef',
      async (guard) => {
        retentionCompleted = guard.retainUntil!(settlement.promise);
        return 'callback-finished';
      },
    );

    expect(result).toBe('callback-finished');
    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);

    settlement.resolve();
    await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));
    let completed = false;
    void retentionCompleted.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    release.resolve({ data: undefined });
    await retentionCompleted;
    expect(completed).toBe(true);
    expect(mocks.apiRequest).toHaveBeenLastCalledWith(
      `/api/market-leases/${LEASE_ID}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Market-Lease-Token': LEASE_TOKEN },
      }),
    );
  });
});
