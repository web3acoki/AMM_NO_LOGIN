import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const mocks = vi.hoisted(() => {
  const client = () => ({
    readContract: vi.fn(),
    multicall: vi.fn(),
    getTransactionCount: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getChainId: vi.fn(async () => 56),
  });
  return {
    buyClient: client(),
    sellClient: client(),
    readClient: client(),
    walletClient: { sendTransaction: vi.fn() },
    http: vi.fn((url: string) => ({ url })),
  };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    http: mocks.http,
    createPublicClient: vi.fn(({ transport }: { transport: { url: string } }) => {
      if (transport.url === 'http://buy.test') return mocks.buyClient;
      if (transport.url === 'http://sell.test') return mocks.sellClient;
      return mocks.readClient;
    }),
    createWalletClient: vi.fn(({ account, chain }) => ({
      ...mocks.walletClient,
      account,
      chain,
    })),
  };
});

import { FourMemeService, resetNonceForAddress } from '../fourMemeService';

const TOKEN = '0x000000000000000000000000000000000000beef' as Address;
const ASTER = '0x000000000000000000000000000000000000a57e' as Address;
const PRIVATE_KEY = `0x${'6'.padStart(64, '0')}` as Hex;
const WALLET = privateKeyToAccount(PRIVATE_KEY).address;
const HASH = `0x${'cd'.repeat(32)}` as Hash;

function params(poolBaseToken?: Address) {
  return {
    chainId: 56,
    rpcUrl: 'http://buy.test',
    privateKey: PRIVATE_KEY,
    walletAddress: WALLET,
    tokenAddress: TOKEN,
    amount: 1,
    mode: 'buy' as const,
    slippage: 0,
    poolBaseToken,
  };
}

function timeoutError(): Error {
  const error = new Error('peer receipt timeout');
  error.name = 'WaitForTransactionReceiptTimeoutError';
  return error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetNonceForAddress(WALLET);
  mocks.buyClient.getTransactionCount.mockResolvedValue(7);
  mocks.sellClient.getTransactionCount.mockResolvedValue(7);
  mocks.buyClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
  mocks.sellClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
  mocks.walletClient.sendTransaction.mockResolvedValue(HASH);
});

describe('FourMeme cross-RPC finality barrier', () => {
  it('does not return confirmed until the other execution RPC observes the same trade receipt', async () => {
    const peerReceipt = deferred<{ status: 'success'; transactionHash: Hash }>();
    mocks.sellClient.waitForTransactionReceipt.mockReturnValueOnce(peerReceipt.promise);
    const service = new FourMemeService(56, 'http://buy.test', 'http://sell.test');

    let settled = false;
    const execution = service.executeTradeFast(params()).then(result => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(mocks.sellClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: HASH,
      timeout: 120000,
    }));
    expect(settled).toBe(false);

    peerReceipt.resolve({ status: 'success', transactionHash: HASH });
    await expect(execution).resolves.toMatchObject({ success: true, status: 'confirmed', txHash: HASH });
  });

  it('returns pending with the exact lagging peer RPC and requires its receipt after timeout', async () => {
    mocks.sellClient.waitForTransactionReceipt.mockRejectedValueOnce(timeoutError());
    const service = new FourMemeService(56, 'http://buy.test', 'http://sell.test');

    const result = await service.executeTradeFast(params());

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'trade',
      reconciliationRpcUrl: 'http://sell.test',
      receiptRequired: true,
      txHash: HASH,
    });
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps primary-node confirmation timeout distinct from peer synchronization timeout', async () => {
    mocks.buyClient.waitForTransactionReceipt.mockRejectedValueOnce(timeoutError());
    const service = new FourMemeService(56, 'http://buy.test', 'http://sell.test');

    const result = await service.executeTradeFast(params());

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'trade',
      reconciliationRpcUrl: 'http://buy.test',
      txHash: HASH,
    });
    expect(result.receiptRequired).toBeUndefined();
    expect(mocks.sellClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('applies the same peer barrier to inline approvals and never sends the trade after peer timeout', async () => {
    mocks.buyClient.readContract.mockResolvedValueOnce(0n);
    mocks.sellClient.waitForTransactionReceipt.mockRejectedValueOnce(timeoutError());
    const service = new FourMemeService(56, 'http://buy.test', 'http://sell.test');

    const result = await service.executeTrade(params(ASTER));

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'approval',
      reconciliationRpcUrl: 'http://sell.test',
      receiptRequired: true,
      txHash: HASH,
    });
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('uses the buy RPC as the reconciliation peer when a direct sell is confirmed only on the sell RPC', async () => {
    mocks.buyClient.waitForTransactionReceipt.mockRejectedValueOnce(timeoutError());
    const service = new FourMemeService(56, 'http://buy.test', 'http://sell.test');
    const sellParams = { ...params(), mode: 'sell' as const, sellPercent: 100 };

    const result = await service.executeSellDirect(sellParams, 500n);

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'trade',
      reconciliationRpcUrl: 'http://buy.test',
      receiptRequired: true,
      txHash: HASH,
    });
    expect(mocks.sellClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.buyClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('skips the extra receipt request when both execution URLs are the same', async () => {
    const service = new FourMemeService(56, 'http://buy.test', 'http://buy.test');

    const result = await service.executeTradeFast(params());

    expect(result).toMatchObject({ success: true, status: 'confirmed', txHash: HASH });
    expect(mocks.sellClient.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(mocks.buyClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });
});
