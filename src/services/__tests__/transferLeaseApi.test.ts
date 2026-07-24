import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}));

vi.mock('../../api', () => ({
  apiRequest: mocks.apiRequest,
}));

import { withTransferLease, withTransferLeases } from '../transferLeaseApi';

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
  it('exposes and advances the server nonce floor before releasing the lease', async () => {
    const txHash = `0x${'12'.repeat(32)}`;
    mocks.apiRequest.mockImplementation(async (path: string, options: RequestInit = {}) => {
      if (path.endsWith('/acquire')) {
        return {
          data: {
            leaseId: LEASE_ID,
            leaseToken: LEASE_TOKEN,
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
            leaseDurationMs: 90_000,
            heartbeatIntervalMs: 20_000,
            nextNonceFloor: 7,
            lastTxHash: `0x${'34'.repeat(32)}`,
          },
        };
      }
      if (path.endsWith('/commit-broadcast')) {
        expect(options).toMatchObject({
          method: 'POST',
          headers: { 'X-Transfer-Lease-Token': LEASE_TOKEN },
          body: JSON.stringify({ nonce: 7, txHash }),
        });
        return {
          data: {
            nextNonceFloor: 8,
            lastTxHash: txHash,
          },
        };
      }
      if (options.method === 'DELETE') return { data: undefined };
      throw new Error(`unexpected lease request: ${options.method} ${path}`);
    });

    await withTransferLease(
      4663,
      '0x000000000000000000000000000000000000beef',
      async guard => {
        expect(guard.getNonceState?.()).toEqual({
          nextNonceFloor: 7,
          lastTxHash: `0x${'34'.repeat(32)}`,
        });
        await guard.commitBroadcast?.(7, txHash);
        expect(guard.getNonceState?.()).toEqual({
          nextNonceFloor: 8,
          lastTxHash: txHash,
        });
      },
    );

    expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
    expect(mocks.apiRequest).toHaveBeenLastCalledWith(
      `/api/transfer-leases/${LEASE_ID}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

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

    const result = await withTransferLease(
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
      `/api/transfer-leases/${LEASE_ID}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Transfer-Lease-Token': LEASE_TOKEN },
      }),
    );
  });

  it('acquires a wallet batch in one request and releases every lease in parallel', async () => {
    const addresses = [
      '0x00000000000000000000000000000000000000a1',
      '0x00000000000000000000000000000000000000b2',
    ];
    mocks.apiRequest.mockImplementation(async (path: string, options: RequestInit = {}) => {
      if (path.endsWith('/batch-acquire')) {
        return {
          data: {
            leases: addresses.map((address, index) => ({
              address,
              leaseId: index === 0 ? LEASE_ID : '87654321-4321-4321-4321-cba987654321',
              leaseToken: index === 0 ? LEASE_TOKEN : 'cd'.repeat(32),
              expiresAt: new Date(Date.now() + 90_000).toISOString(),
              leaseDurationMs: 90_000,
              heartbeatIntervalMs: 20_000,
            })),
          },
        };
      }
      if (options.method === 'DELETE') return { data: undefined };
      throw new Error(`unexpected lease request: ${options.method} ${path}`);
    });

    const result = await withTransferLeases(4663, addresses, async guards => {
      expect(guards.size).toBe(2);
      for (const address of addresses) guards.get(address.toLowerCase())!.assertActive();
      return 'batch-finished';
    });

    expect(result).toBe('batch-finished');
    expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
    expect(mocks.apiRequest).toHaveBeenNthCalledWith(
      1,
      '/api/transfer-leases/batch-acquire',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chainId: 4663, addresses }),
      }),
    );
    expect(mocks.apiRequest.mock.calls.slice(1).every(([, options]) => options.method === 'DELETE')).toBe(true);
  });
});
