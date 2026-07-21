import { describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import {
  executeManualBatchSell,
  type ExecuteManualBatchSellOptions,
  type ManualBatchSellResult,
} from '../manualBatchSellService';

const TOKEN = '0x000000000000000000000000000000000000beef';
const ROUTER = '0x000000000000000000000000000000000000cafe';
const WALLET_A = '0x0000000000000000000000000000000000000001';
const WALLET_B = '0x0000000000000000000000000000000000000002';
const HASH_A = `0x${'aa'.repeat(32)}` as Hash;
const HASH_B = `0x${'bb'.repeat(32)}` as Hash;

function makePublicClient(nonces: Record<string, { latest: number; pending: number }> = {}) {
  return {
    getTransactionCount: vi.fn(async ({ address, blockTag }: { address: Address; blockTag: string }) => {
      const value = nonces[address.toLowerCase()] ?? { latest: 7, pending: 7 };
      return blockTag === 'latest' ? value.latest : value.pending;
    }),
  };
}

function baseOptions(overrides: Partial<ExecuteManualBatchSellOptions> = {}): ExecuteManualBatchSellOptions {
  return {
    chainId: 4663,
    rpcUrl: 'http://rpc.test',
    routerAddress: ROUTER,
    tokenAddress: TOKEN,
    spendToken: 'ETH',
    slippage: 30,
    wallets: [
      { address: WALLET_A, privateKey: `0x${'11'.repeat(32)}`, percent: 37.25 },
      { address: WALLET_B, privateKey: `0x${'22'.repeat(32)}`, percent: 62.75 },
    ],
    ...overrides,
  };
}

describe('manual batch-sell pipeline', () => {
  it('publishes preflight immediately and never starts wallet two before wallet one confirms', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const executeTrade = vi.fn(async (params: any) => {
      const isFirst = params.walletAddress.toLowerCase() === WALLET_A.toLowerCase();
      const hash = isFirst ? HASH_A : HASH_B;
      params.onTransactionHash(hash, 'trade');
      if (isFirst) await firstGate;
      return { success: true, status: 'confirmed' as const, txHash: hash };
    });
    const progress: ManualBatchSellResult[][] = [];
    const execution = executeManualBatchSell(baseOptions({
      onProgress: results => progress.push(results),
      dependencies: {
        loginEnabled: false,
        publicClient: makePublicClient() as any,
        tradingService: { executeTrade },
        checkUnresolved: vi.fn(async () => ({ blocked: false, reason: 'none' as const })),
      },
    }));

    expect(progress[0].every(result => result.status === 'preflight')).toBe(true);
    await vi.waitFor(() => expect(executeTrade).toHaveBeenCalledTimes(1));
    expect(progress.some(snapshot => snapshot[0].status === 'broadcast' && snapshot[0].hash === HASH_A)).toBe(true);
    expect(executeTrade.mock.calls[0][0].balancePercent).toBe(37.25);

    releaseFirst();
    const results = await execution;
    expect(executeTrade).toHaveBeenCalledTimes(2);
    expect(results.map(result => result.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('fails the whole batch closed when any later wallet already has a pending nonce', async () => {
    const publicClient = makePublicClient({
      [WALLET_B.toLowerCase()]: { latest: 4, pending: 5 },
    });
    const executeTrade = vi.fn();

    const results = await executeManualBatchSell(baseOptions({
      dependencies: {
        loginEnabled: false,
        publicClient: publicClient as any,
        tradingService: { executeTrade },
        checkUnresolved: vi.fn(async () => ({ blocked: false, reason: 'none' as const })),
      },
    }));

    expect(executeTrade).not.toHaveBeenCalled();
    expect(results.every(result => result.status === 'not_sent')).toBe(true);
    expect(results[0].error).toContain('整批 0 笔发送');
  });

  it('stops later wallets after an unresolved sell and keeps its hash', async () => {
    const executeTrade = vi.fn(async (params: any) => {
      params.onTransactionHash(HASH_A, 'trade');
      return {
        success: false,
        status: 'pending' as const,
        transactionKind: 'trade' as const,
        txHash: HASH_A,
        error: '等待确认超时',
      };
    });
    const markUnresolved = vi.fn();

    const results = await executeManualBatchSell(baseOptions({
      dependencies: {
        loginEnabled: false,
        publicClient: makePublicClient() as any,
        tradingService: { executeTrade },
        checkUnresolved: vi.fn(async () => ({ blocked: false, reason: 'none' as const })),
        markUnresolved: markUnresolved as any,
        monitorUnresolved: vi.fn(async () => undefined),
      },
    }));

    expect(executeTrade).toHaveBeenCalledTimes(1);
    expect(markUnresolved).toHaveBeenCalledWith(expect.objectContaining({ txHash: HASH_A }));
    expect(results[0]).toMatchObject({ status: 'pending', hash: HASH_A });
    expect(results[1].status).toBe('not_sent');
    expect(results[1].error).toContain('前一笔卖出仍在待确认');
  });
});
