import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
} from 'viem';

const mocks = vi.hoisted(() => ({
  publicClient: {
    getTransactionReceipt: vi.fn(),
    getTransactionCount: vi.fn(),
  },
  createPublicClient: vi.fn(),
  http: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: mocks.createPublicClient,
    http: mocks.http,
  };
});

import {
  checkUnresolvedTransaction,
  clearUnresolvedTransaction,
  getUnresolvedTransaction,
  markUnresolvedTransaction,
} from '../unresolvedTransactionGuard';

const WALLET_A = '0x00000000000000000000000000000000000000a1' as Address;
const WALLET_B = '0x00000000000000000000000000000000000000b2' as Address;
const HASH_A = `0x${'aa'.repeat(32)}` as Hash;
const RPC_URL = 'https://rpc.example.test/';
const START_TIME = new Date('2026-07-20T08:00:00.000Z');

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  for (const chainId of [56, 66, 97, 4663]) {
    clearUnresolvedTransaction(chainId, WALLET_A);
    clearUnresolvedTransaction(chainId, WALLET_B);
  }

  vi.clearAllMocks();
  mocks.createPublicClient.mockReturnValue(mocks.publicClient);
  mocks.http.mockReturnValue({});
  mocks.publicClient.getTransactionReceipt.mockRejectedValue(
    new TransactionReceiptNotFoundError({ hash: HASH_A }),
  );
  mocks.publicClient.getTransactionCount.mockImplementation(
    async ({ blockTag }: { blockTag: 'pending' | 'latest' }) => (
      blockTag === 'pending' ? 10 : 10
    ),
  );
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('unresolved transaction guard', () => {
  it('persists only public metadata and reconciles a known receipt immediately', async () => {
    const record = markUnresolvedTransaction({
      chainId: 4663,
      walletAddress: WALLET_A.toUpperCase().replace('0X', '0x'),
      status: 'pending',
      txHash: HASH_A,
      rpcUrl: RPC_URL,
      privateKey: 'must-not-be-persisted',
    } as Parameters<typeof markUnresolvedTransaction>[0] & { privateKey: string });

    mocks.publicClient.getTransactionReceipt.mockResolvedValueOnce({ status: 'success' });
    const check = await checkUnresolvedTransaction({ chainId: 4663, walletAddress: WALLET_A });

    expect(check).toMatchObject({ blocked: false, reason: 'receipt-settled', record });
    expect(mocks.createPublicClient).toHaveBeenCalledTimes(1);
    const persisted = sessionStorage.getItem(`amm:unresolved-transaction:v1:4663:${WALLET_A}`);
    expect(persisted).toBeNull();
    expect(JSON.stringify(record)).not.toContain('privateKey');
  });

  it.each(['success', 'reverted'] as const)(
    'clears a known hash when its receipt is %s',
    async (status) => {
      markUnresolvedTransaction({
        chainId: 56,
        walletAddress: WALLET_A,
        status: 'unknown',
        txHash: HASH_A,
        rpcUrl: RPC_URL,
      });
      mocks.publicClient.getTransactionReceipt.mockResolvedValueOnce({ status });

      const check = await checkUnresolvedTransaction({ chainId: 56, walletAddress: WALLET_A });

      expect(check).toMatchObject({ blocked: false, reason: 'receipt-settled' });
      expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
      expect(getUnresolvedTransaction(56, WALLET_A)).toBeUndefined();
    },
  );

  it('keeps blocking when the receipt is absent and pending nonce is ahead', async () => {
    markUnresolvedTransaction({
      chainId: 97,
      walletAddress: WALLET_A,
      status: 'pending',
      txHash: HASH_A,
      rpcUrl: RPC_URL,
    });
    mocks.publicClient.getTransactionCount.mockImplementation(
      async ({ blockTag }: { blockTag: 'pending' | 'latest' }) => (
        blockTag === 'pending' ? 11 : 10
      ),
    );

    const check = await checkUnresolvedTransaction({ chainId: 97, walletAddress: WALLET_A });

    expect(check).toMatchObject({ blocked: true, reason: 'pending-nonce' });
    expect(getUnresolvedTransaction(97, WALLET_A)).toBeDefined();
  });

  it('requires the lagging peer to observe the exact receipt and never clears from nonce equality', async () => {
    markUnresolvedTransaction({
      chainId: 56,
      walletAddress: WALLET_A,
      status: 'pending',
      txHash: HASH_A,
      rpcUrl: RPC_URL,
      receiptRequired: true,
    });
    const check = await checkUnresolvedTransaction({
      chainId: 56,
      walletAddress: WALLET_A,
      rpcUrl: 'https://wrong-source-rpc.test/',
    });

    expect(check).toMatchObject({ blocked: true, reason: 'receipt-required' });
    expect(mocks.http).toHaveBeenCalledWith(RPC_URL);
    expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(getUnresolvedTransaction(56, WALLET_A)).toMatchObject({ receiptRequired: true });
  });

  it('clears a receipt-required peer barrier only after that peer reports success', async () => {
    markUnresolvedTransaction({
      chainId: 56,
      walletAddress: WALLET_A,
      status: 'unknown',
      txHash: HASH_A,
      rpcUrl: RPC_URL,
      receiptRequired: true,
    });
    mocks.publicClient.getTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

    const check = await checkUnresolvedTransaction({ chainId: 56, walletAddress: WALLET_A });

    expect(check).toMatchObject({ blocked: false, reason: 'receipt-settled' });
    expect(getUnresolvedTransaction(56, WALLET_A)).toBeUndefined();
  });

  it('clears a receipt-required barrier when the saved RPC reports a terminal revert', async () => {
    markUnresolvedTransaction({
      chainId: 56,
      walletAddress: WALLET_A,
      status: 'unknown',
      txHash: HASH_A,
      rpcUrl: RPC_URL,
      receiptRequired: true,
    });
    mocks.publicClient.getTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });

    const check = await checkUnresolvedTransaction({ chainId: 56, walletAddress: WALLET_A });

    expect(check).toMatchObject({ blocked: false, reason: 'receipt-settled' });
    expect(getUnresolvedTransaction(56, WALLET_A)).toBeUndefined();
  });

  it('clears a hashless unknown result only when pending and latest nonce agree', async () => {
    markUnresolvedTransaction({
      chainId: 66,
      walletAddress: WALLET_A,
      status: 'unknown',
      rpcUrl: RPC_URL,
    });
    const check = await checkUnresolvedTransaction({
      chainId: 66,
      walletAddress: WALLET_A,
      rpcUrl: 'https://new-rpc.example.test/',
    });

    expect(check).toMatchObject({ blocked: false, reason: 'nonce-settled' });
    expect(mocks.http).toHaveBeenCalledWith('https://new-rpc.example.test/');
    expect(getUnresolvedTransaction(66, WALLET_A)).toBeUndefined();
  });

  it('fails closed when querying a known transaction receipt has an RPC error', async () => {
    markUnresolvedTransaction({
      chainId: 4663,
      walletAddress: WALLET_A,
      status: 'pending',
      txHash: HASH_A,
      rpcUrl: RPC_URL,
    });
    mocks.publicClient.getTransactionReceipt.mockRejectedValueOnce(new Error('gateway timeout'));

    const check = await checkUnresolvedTransaction({ chainId: 4663, walletAddress: WALLET_A });

    expect(check).toMatchObject({ blocked: true, reason: 'rpc-unavailable' });
    expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(getUnresolvedTransaction(4663, WALLET_A)).toBeDefined();
  });

  it('fails closed when either nonce query fails', async () => {
    markUnresolvedTransaction({
      chainId: 56,
      walletAddress: WALLET_A,
      status: 'unknown',
      rpcUrl: RPC_URL,
    });
    mocks.publicClient.getTransactionCount.mockRejectedValueOnce(new Error('RPC unavailable'));

    const check = await checkUnresolvedTransaction({ chainId: 56, walletAddress: WALLET_A });

    expect(check).toMatchObject({ blocked: true, reason: 'rpc-unavailable' });
    expect(getUnresolvedTransaction(56, WALLET_A)).toBeDefined();
  });

  it('hydrates a valid sessionStorage record and rejects unsupported chains', async () => {
    const storedRecord = {
      chainId: 4663,
      walletAddress: WALLET_B,
      status: 'pending',
      rpcUrl: RPC_URL,
      recordedAt: START_TIME.getTime(),
    };
    sessionStorage.setItem(
      `amm:unresolved-transaction:v1:4663:${WALLET_B}`,
      JSON.stringify(storedRecord),
    );

    expect(getUnresolvedTransaction(4663, WALLET_B)).toEqual(storedRecord);
    await expect(checkUnresolvedTransaction({ chainId: 1, walletAddress: WALLET_A }))
      .rejects.toThrow('不支持的待确认交易守卫链 ID');
  });
});
