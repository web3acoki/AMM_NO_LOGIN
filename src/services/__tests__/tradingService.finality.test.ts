import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WALLET_PENDING_PREDECESSOR_CODE } from '../pendingNonceGuard';

const mocks = vi.hoisted(() => ({
  publicClient: {
    readContract: vi.fn(),
    getBalance: vi.fn(),
    getTransactionCount: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  walletClient: {
    sendTransaction: vi.fn(),
    writeContract: vi.fn(),
  },
  getPool: vi.fn(),
  quoteExactInputSingle: vi.fn(),
  quoteExactOutputSingle: vi.fn(),
  buildTokenToNativeSellTransaction: vi.fn(),
  buildNativeBuyTransaction: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mocks.publicClient),
    createWalletClient: vi.fn(() => mocks.walletClient),
    http: vi.fn(() => ({})),
  };
});

vi.mock('../uniswapV3Service', () => ({
  applySlippageBps: (amount: bigint, slippageBps: number) => (
    (amount * BigInt(10_000 - slippageBps)) / 10_000n
  ),
  UniswapV3Service: class UniswapV3Service {
    getPool = mocks.getPool;
    quoteExactInputSingle = mocks.quoteExactInputSingle;
    quoteExactOutputSingle = mocks.quoteExactOutputSingle;
    buildTokenToNativeSellTransaction = mocks.buildTokenToNativeSellTransaction;
    buildNativeBuyTransaction = mocks.buildNativeBuyTransaction;
  },
}));

import { createTradingService, resetNonceForAddress } from '../tradingService';
import { UNISWAP_V3_ROBINHOOD_ADDRESSES } from '../../constants';

const TOKEN = '0x000000000000000000000000000000000000beef' as Address;
const PRIVATE_KEY_A = `0x${'1'.padStart(64, '0')}` as Hex;
const PRIVATE_KEY_B = `0x${'2'.padStart(64, '0')}` as Hex;
const PRIVATE_KEY_C = `0x${'3'.padStart(64, '0')}` as Hex;
const HASH_A = `0x${'aa'.repeat(32)}` as Hash;
const HASH_C = `0x${'cc'.repeat(32)}` as Hash;

function installReadContractDefaults() {
  mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'decimals':
        return 18;
      case 'balanceOf':
        return 10n ** 18n;
      case 'allowance':
        return (1n << 256n) - 1n;
      case 'getAmountsOut':
        return [10n ** 18n, 10n ** 15n];
      default:
        throw new Error(`unexpected readContract call: ${functionName}`);
    }
  });
}

function robinhoodSellParams(privateKey: Hex, onTransactionHash?: (hash: string, kind: string) => void) {
  return {
    chainId: 4663,
    rpcUrl: 'http://robinhood.test',
    routerAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    privateKey,
    walletAddress: privateKeyToAccount(privateKey).address,
    tokenAddress: TOKEN,
    spendToken: 'ETH',
    amount: 0,
    amountType: 'amount' as const,
    mode: 'dump' as const,
    slippage: 12,
    balancePercent: 100,
    v3FeeTier: 10_000,
    onTransactionHash,
  };
}

function bscSellParams(privateKey: Hex) {
  return {
    chainId: 56,
    rpcUrl: 'http://bsc.test',
    routerAddress: '0x0000000000000000000000000000000000002000',
    privateKey,
    walletAddress: privateKeyToAccount(privateKey).address,
    tokenAddress: TOKEN,
    spendToken: 'BNB',
    amount: 0,
    amountType: 'amount' as const,
    mode: 'dump' as const,
    slippage: 30,
    balancePercent: 100,
  };
}

function bscBuyParams(privateKey: Hex, onTransactionHash?: (hash: string, kind: string) => void) {
  return {
    ...bscSellParams(privateKey),
    amount: 0.01,
    mode: 'pump' as const,
    onTransactionHash,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installReadContractDefaults();
  mocks.publicClient.getTransactionCount.mockResolvedValue(7);
  mocks.publicClient.getBalance.mockResolvedValue(10n ** 18n);
  mocks.publicClient.waitForTransactionReceipt.mockResolvedValue({
    status: 'success',
    transactionHash: HASH_A,
  });
  mocks.walletClient.sendTransaction.mockResolvedValue(HASH_A);
  mocks.walletClient.writeContract.mockResolvedValue(HASH_A);
  mocks.getPool.mockResolvedValue({ liquidity: 1n });
  mocks.quoteExactInputSingle.mockResolvedValue({ amountOut: 10n ** 15n });
  mocks.quoteExactOutputSingle.mockResolvedValue({ amountIn: 10n ** 18n });
  mocks.buildTokenToNativeSellTransaction.mockReturnValue({
    to: UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    data: '0x1234',
  });
  mocks.buildNativeBuyTransaction.mockReturnValue({
    to: UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    data: '0x1234',
    value: 1n,
  });

  for (const privateKey of [PRIVATE_KEY_A, PRIVATE_KEY_B, PRIVATE_KEY_C]) {
    const address = privateKeyToAccount(privateKey).address;
    resetNonceForAddress(address, 4663);
    resetNonceForAddress(address, 56);
  }
});

describe('TradingService broadcast finality', () => {
  it('returns pending with the original Robinhood hash and callback after receipt timeout', async () => {
    const timeout = new Error('Timed out while waiting for transaction receipt');
    timeout.name = 'WaitForTransactionReceiptTimeoutError';
    mocks.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(timeout);
    const onTransactionHash = vi.fn();
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade(robinhoodSellParams(PRIVATE_KEY_A, onTransactionHash));

    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledWith(HASH_A, 'trade');
    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'trade',
      txHash: HASH_A,
    });
    expect(result.error).toContain('禁止自动重发');
  });

  it('fails closed when the BSC pending nonce query fails and never broadcasts nonce zero', async () => {
    mocks.publicClient.getTransactionCount.mockRejectedValueOnce(new Error('RPC pending nonce unavailable'));
    const service = createTradingService(
      56,
      'http://bsc.test',
      '0x0000000000000000000000000000000000002000',
    );

    const result = await service.executeTrade(bscSellParams(PRIVATE_KEY_B));

    expect(mocks.publicClient.getTransactionCount).toHaveBeenCalledWith(expect.objectContaining({
      blockTag: 'pending',
    }));
    expect(mocks.walletClient.writeContract).not.toHaveBeenCalled();
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.txHash).toBeUndefined();
  });

  it('supports fractional percentages in BSC range-mode sells', async () => {
    const service = createTradingService(
      56,
      'http://bsc.test',
      '0x0000000000000000000000000000000000002000',
    );
    const params = { ...bscSellParams(PRIVATE_KEY_B), balancePercent: 37.25 };

    const result = await service.executeTrade(params);

    expect(result.status).toBe('confirmed');
    expect(mocks.walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(mocks.walletClient.writeContract.mock.calls[0][0].args[0]).toBe(372_500_000_000_000_000n);
  });

  it('preserves the BSC native-buy hash and pending state after receipt timeout', async () => {
    const timeout = new Error('Timed out while waiting for transaction receipt');
    timeout.name = 'WaitForTransactionReceiptTimeoutError';
    mocks.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(timeout);
    const onTransactionHash = vi.fn();
    const service = createTradingService(
      56,
      'http://bsc.test',
      '0x0000000000000000000000000000000000002000',
    );

    const result = await service.executeTrade(bscBuyParams(PRIVATE_KEY_A, onTransactionHash));

    expect(mocks.walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledWith(HASH_A, 'trade');
    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'trade',
      txHash: HASH_A,
    });
    expect(result.error).toContain('禁止自动重发');
  });

  it('keeps an unknown receipt hash and performs no second send or hidden retry', async () => {
    mocks.walletClient.sendTransaction.mockResolvedValueOnce(HASH_C);
    mocks.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error('receipt RPC disconnected'));
    const onTransactionHash = vi.fn();
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade(robinhoodSellParams(PRIVATE_KEY_C, onTransactionHash));

    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      transactionKind: 'trade',
      txHash: HASH_C,
    });
    expect(result.error).toContain('禁止自动重发');
  });

  it('labels a hashless trade submit failure as trade after a confirmed approval', async () => {
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return 18;
      if (functionName === 'balanceOf') return 10n ** 18n;
      if (functionName === 'allowance') return 0n;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    mocks.publicClient.getTransactionCount
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(8);
    mocks.walletClient.writeContract.mockResolvedValueOnce(HASH_A);
    mocks.walletClient.sendTransaction.mockRejectedValueOnce(new Error('submit response lost'));
    const onTransactionHash = vi.fn();
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade(robinhoodSellParams(PRIVATE_KEY_C, onTransactionHash));

    expect(onTransactionHash).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledWith(HASH_A, 'approval');
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      transactionKind: 'trade',
    });
    expect(result.txHash).toBeUndefined();
  });

  it('refuses to stack a new trade behind an existing pending nonce', async () => {
    mocks.publicClient.getTransactionCount.mockImplementation(async ({ blockTag }: { blockTag: string }) => (
      blockTag === 'pending' ? 8 : 7
    ));
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade(robinhoodSellParams(PRIVATE_KEY_A));

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      code: WALLET_PENDING_PREDECESSOR_CODE,
      transactionKind: 'trade',
    });
    expect(result.txHash).toBeUndefined();
    expect(result.error).toContain('待确认前序交易');
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });
});
