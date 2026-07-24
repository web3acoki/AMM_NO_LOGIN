import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const mocks = vi.hoisted(() => ({
  httpTransport: vi.fn(),
  publicClient: {
    readContract: vi.fn(),
    getBalance: vi.fn(),
    getTransactionCount: vi.fn(),
    getTransaction: vi.fn(),
    getBlockNumber: vi.fn(),
    estimateFeesPerGas: vi.fn(),
    estimateGas: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  sequencerClient: {
    request: vi.fn(),
    sendRawTransaction: vi.fn(),
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
    createPublicClient: vi.fn(({ transport }: { transport?: { url?: string; config?: { retryCount?: number } } }) => (
      transport?.config?.retryCount === 0
        ? mocks.sequencerClient
        : mocks.publicClient
    )),
    createWalletClient: vi.fn(() => mocks.walletClient),
    http: mocks.httpTransport,
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
import { robinhood } from '../../viem/chains/robinhood';

const TOKEN = '0x000000000000000000000000000000000000beef' as Address;
const PRIVATE_KEY_A = `0x${'1'.padStart(64, '0')}` as Hex;
const PRIVATE_KEY_B = `0x${'2'.padStart(64, '0')}` as Hex;
const PRIVATE_KEY_C = `0x${'3'.padStart(64, '0')}` as Hex;
const HASH_A = `0x${'aa'.repeat(32)}` as Hash;

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

function robinhoodBuyParams(privateKey: Hex) {
  const sell = robinhoodSellParams(privateKey);
  return {
    ...sell,
    amount: 0.0001,
    mode: 'pump' as const,
    balancePercent: undefined,
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
  mocks.httpTransport.mockImplementation((url: string, config?: unknown) => ({ url, config }));
  installReadContractDefaults();
  mocks.publicClient.getTransactionCount.mockResolvedValue(7);
  mocks.publicClient.getTransaction.mockResolvedValue(undefined);
  mocks.publicClient.getBalance.mockResolvedValue(10n ** 18n);
  mocks.publicClient.getBlockNumber.mockResolvedValue(123n);
  mocks.sequencerClient.request.mockResolvedValue({ rpc: '1.0' });
  mocks.publicClient.estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 90_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  mocks.publicClient.estimateGas.mockResolvedValue(220_000n);
  mocks.sequencerClient.sendRawTransaction.mockImplementation(
    async ({ serializedTransaction }: { serializedTransaction: Hex }) => keccak256(serializedTransaction),
  );
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
  it('warms the Robinhood read and broadcast clients once without submitting a transaction', async () => {
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    await Promise.all([service.warmupConnections(), service.warmupConnections()]);

    expect(mocks.publicClient.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(mocks.sequencerClient.request).toHaveBeenCalledTimes(1);
    expect(mocks.sequencerClient.request).toHaveBeenCalledWith({ method: 'rpc_modules' });
    expect(mocks.sequencerClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('enables JSON-RPC batching for concurrent Robinhood preparation reads', () => {
    const rpcUrl = 'http://robinhood-batch.test';
    createTradingService(
      4663,
      rpcUrl,
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );
    createTradingService(
      4663,
      rpcUrl,
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    expect(mocks.httpTransport).toHaveBeenCalledWith(rpcUrl, {
      batch: { batchSize: 100, wait: 10 },
    });
    expect(mocks.httpTransport).toHaveBeenCalledWith(rpcUrl, {
      batch: { batchSize: 100, wait: 10 },
      retryCount: 0,
    });
    const broadcastTransports = mocks.httpTransport.mock.calls.filter(([, config]) => (
      config?.retryCount === 0
    ));
    expect(broadcastTransports).toHaveLength(1);
  });

  it('caches a verified maximum sell allowance so the first trade does not reread it', async () => {
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );
    const params = robinhoodSellParams(PRIVATE_KEY_A);

    await expect(service.checkV3SellApproval(TOKEN, params.walletAddress)).resolves.toEqual({ ready: true });
    const result = await service.executeTrade(params);

    expect(result.success).toBe(true);
    const allowanceReads = mocks.publicClient.readContract.mock.calls
      .filter(([request]) => request.functionName === 'allowance');
    expect(allowanceReads).toHaveLength(1);
  });

  it('reuses an in-flight sell approval read between page warmup and task start', async () => {
    let releaseAllowance!: (allowance: bigint) => void;
    const allowance = new Promise<bigint>(resolve => {
      releaseAllowance = resolve;
    });
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return allowance;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );
    const walletAddress = privateKeyToAccount(PRIVATE_KEY_A).address;

    const warmup = service.checkV3SellApproval(TOKEN, walletAddress);
    const startCheck = service.checkV3SellApproval(TOKEN, walletAddress);
    await vi.waitFor(() => {
      expect(mocks.publicClient.readContract).toHaveBeenCalledTimes(1);
    });
    releaseAllowance((1n << 256n) - 1n);

    await expect(Promise.all([warmup, startCheck])).resolves.toEqual([
      { ready: true },
      { ready: true },
    ]);
  });

  it('starts Robinhood pool, decimals and sell-balance reads in the same preparation wave', async () => {
    let releasePool!: (value: { liquidity: bigint }) => void;
    const pendingPool = new Promise<{ liquidity: bigint }>(resolve => {
      releasePool = resolve;
    });
    mocks.getPool.mockReturnValueOnce(pendingPool);

    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );
    const execution = service.executeTrade(robinhoodSellParams(PRIVATE_KEY_A));

    await vi.waitFor(() => {
      const functions = mocks.publicClient.readContract.mock.calls
        .map(([request]) => request.functionName);
      expect(functions).toContain('decimals');
      expect(functions).toContain('balanceOf');
    });

    // The pool is deliberately unresolved here. Seeing both ERC-20 reads
    // proves they no longer wait behind a separate pool-validation round trip.
    expect(mocks.getPool).toHaveBeenCalledTimes(1);
    releasePool({ liquidity: 1n });
    await expect(execution).resolves.toMatchObject({ success: true });
  });

  it('warms immutable V3 sell metadata without reading a wallet balance or submitting a write', async () => {
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    await service.warmupV3SellPreparation(TOKEN, 10_000);

    expect(mocks.getPool).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.readContract.mock.calls
      .filter(([request]) => request.functionName === 'decimals')).toHaveLength(1);
    expect(mocks.publicClient.readContract.mock.calls
      .filter(([request]) => request.functionName === 'balanceOf')).toHaveLength(0);
    expect(mocks.sequencerClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('overlaps the live quote with nonce and fee preparation before signing the sell', async () => {
    let releaseQuote!: (value: { amountOut: bigint }) => void;
    const pendingQuote = new Promise<{ amountOut: bigint }>(resolve => {
      releaseQuote = resolve;
    });
    mocks.quoteExactInputSingle.mockReturnValueOnce(pendingQuote);
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const execution = service.executeTrade(robinhoodSellParams(PRIVATE_KEY_A));
    await vi.waitFor(() => {
      expect(mocks.quoteExactInputSingle).toHaveBeenCalledTimes(1);
      expect(mocks.publicClient.getTransactionCount).toHaveBeenCalledTimes(2);
      expect(mocks.publicClient.estimateFeesPerGas).toHaveBeenCalledTimes(1);
    });
    expect(mocks.sequencerClient.sendRawTransaction).not.toHaveBeenCalled();

    releaseQuote({ amountOut: 10n ** 15n });
    await expect(execution).resolves.toMatchObject({ success: true, status: 'confirmed' });
    expect(mocks.publicClient.estimateGas).not.toHaveBeenCalled();
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('pre-approves a zero-balance wallet so a later first sell has no inline approval', async () => {
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return 0n;
      if (functionName === 'balanceOf') return 0n;
      if (functionName === 'decimals') return 18;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );
    const params = robinhoodSellParams(PRIVATE_KEY_A);

    const approvalCheck = await service.checkV3SellApproval(TOKEN, params.walletAddress);
    expect(approvalCheck).toEqual({ ready: false, allowance: 0n });
    await expect(service.ensureV3SellApproval(params, approvalCheck.allowance)).resolves.toMatchObject({
      success: true,
      status: 'confirmed',
    });

    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.walletClient.writeContract).not.toHaveBeenCalled();
    const balanceReads = mocks.publicClient.readContract.mock.calls
      .filter(([request]) => request.functionName === 'balanceOf');
    expect(balanceReads).toHaveLength(0);
    const allowanceReads = mocks.publicClient.readContract.mock.calls
      .filter(([request]) => request.functionName === 'allowance');
    expect(allowanceReads).toHaveLength(1);
  });

  it('signs and submits concurrent first-time approvals in one shared Sequencer wave', async () => {
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return 0n;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const [first, second] = await Promise.all([
      service.ensureV3SellApproval(robinhoodSellParams(PRIVATE_KEY_A)),
      service.ensureV3SellApproval(robinhoodSellParams(PRIVATE_KEY_B)),
    ]);

    expect(first).toMatchObject({ success: true, status: 'confirmed' });
    expect(second).toMatchObject({ success: true, status: 'confirmed' });
    expect(mocks.publicClient.estimateFeesPerGas).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.estimateGas).not.toHaveBeenCalled();
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.walletClient.writeContract).not.toHaveBeenCalled();
  });

  it('uses Robinhood fast block time for receipt polling', () => {
    expect(robinhood.blockTime).toBe(100);
  });

  it('uses a conservative fixed gas ceiling for Robinhood buys instead of a slow estimate wave', async () => {
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    await expect(service.executeTrade(robinhoodBuyParams(PRIVATE_KEY_A))).resolves.toMatchObject({
      success: true,
      status: 'confirmed',
    });

    expect(mocks.publicClient.estimateGas).not.toHaveBeenCalled();
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns a deterministic Robinhood hash before receipt confirmation when requested', async () => {
    let confirm!: (receipt: { status: 'success'; transactionHash: Hex }) => void;
    const receipt = new Promise<{ status: 'success'; transactionHash: Hex }>(resolve => {
      confirm = resolve;
    });
    mocks.publicClient.waitForTransactionReceipt.mockReturnValueOnce(receipt);
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
    });

    expect(result).toMatchObject({
      success: true,
      status: 'broadcast',
      transactionKind: 'trade',
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.settlement).toBeInstanceOf(Promise);
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();

    confirm({ status: 'success', transactionHash: HASH_A });
    await expect(result.settlement).resolves.toEqual({ status: 'confirmed' });
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('commits the accepted Robinhood nonce before returning a background settlement', async () => {
    const commitBroadcast = vi.fn().mockResolvedValue(undefined);
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
      leaseGuard: {
        assertActive: vi.fn(),
        getNonceState: () => ({}),
        commitBroadcast,
      },
    });

    expect(result).toMatchObject({ success: true, status: 'broadcast' });
    expect(commitBroadcast).toHaveBeenCalledTimes(1);
    expect(commitBroadcast).toHaveBeenCalledWith(7, result.txHash);
    expect(mocks.publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('uses a committed nonce floor after verifying the previous hash on a lagging RPC', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY_A);
    const previousHash = `0x${'78'.repeat(32)}` as Hash;
    mocks.publicClient.getTransaction.mockResolvedValue({
      hash: previousHash,
      nonce: 7,
      from: account.address,
    });
    const commitBroadcast = vi.fn().mockResolvedValue(undefined);
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
      leaseGuard: {
        assertActive: vi.fn(),
        getNonceState: () => ({
          nextNonceFloor: 8,
          lastTxHash: previousHash,
        }),
        commitBroadcast,
      },
    });

    expect(result).toMatchObject({ success: true, status: 'broadcast' });
    expect(mocks.publicClient.getTransaction).toHaveBeenCalledWith({ hash: previousHash });
    expect(commitBroadcast).toHaveBeenCalledWith(8, result.txHash);
  });

  it('waits instead of opening a nonce gap when a committed hash is not visible yet', async () => {
    const previousHash = `0x${'90'.repeat(32)}` as Hash;
    mocks.publicClient.getTransaction.mockRejectedValueOnce(new Error('not found'));
    const commitBroadcast = vi.fn().mockResolvedValue(undefined);
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
      leaseGuard: {
        assertActive: vi.fn(),
        getNonceState: () => ({
          nextNonceFloor: 8,
          lastTxHash: previousHash,
        }),
        commitBroadcast,
      },
    });

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.txHash).toBeUndefined();
    expect(result.error).toContain('自动重试');
    expect(commitBroadcast).not.toHaveBeenCalled();
    expect(mocks.sequencerClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('shares one fee snapshot and broadcasts concurrent wallets as raw transactions', async () => {
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const [first, second] = await Promise.all([
      service.executeTrade({
        ...robinhoodSellParams(PRIVATE_KEY_A),
        awaitConfirmation: false,
      }),
      service.executeTrade({
        ...robinhoodSellParams(PRIVATE_KEY_B),
        awaitConfirmation: false,
      }),
    ]);

    expect(first.status).toBe('broadcast');
    expect(second.status).toBe('broadcast');
    expect(first.txHash).not.toBe(second.txHash);
    expect(mocks.publicClient.estimateFeesPerGas).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.estimateGas).not.toHaveBeenCalled();
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('treats a lease loss after signing as unsent and releases the reserved nonce', async () => {
    let assertions = 0;
    const leaseGuard = {
      assertActive: vi.fn(() => {
        assertions++;
        if (assertions === 4) throw new Error('lease expired before broadcast');
      }),
    };
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const cancelled = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
      leaseGuard,
    });

    expect(cancelled).toMatchObject({ success: false, status: 'failed' });
    expect(cancelled.txHash).toBeUndefined();
    expect(mocks.sequencerClient.sendRawTransaction).not.toHaveBeenCalled();

    const retried = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
    });
    expect(retried).toMatchObject({ success: true, status: 'broadcast' });
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

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

    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledWith(result.txHash, 'trade');
    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      transactionKind: 'trade',
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
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
    mocks.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error('receipt RPC disconnected'));
    const onTransactionHash = vi.fn();
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade(robinhoodSellParams(PRIVATE_KEY_C, onTransactionHash));

    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(mocks.publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      transactionKind: 'trade',
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(onTransactionHash).toHaveBeenCalledWith(result.txHash, 'trade');
    expect(result.error).toContain('禁止自动重发');
  });

  it('preserves the locally signed trade hash when submit response is lost after approval', async () => {
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
    mocks.sequencerClient.sendRawTransaction
      .mockImplementationOnce(async ({ serializedTransaction }: { serializedTransaction: Hex }) => keccak256(serializedTransaction))
      .mockRejectedValueOnce(new Error('submit response lost'));
    const onTransactionHash = vi.fn();
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade(robinhoodSellParams(PRIVATE_KEY_C, onTransactionHash));

    expect(onTransactionHash).toHaveBeenCalledTimes(1);
    expect(onTransactionHash).toHaveBeenCalledWith(expect.stringMatching(/^0x[0-9a-f]{64}$/), 'approval');
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      transactionKind: 'trade',
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('allocates the next pending nonce for another Robinhood task on the same wallet', async () => {
    mocks.publicClient.getTransactionCount.mockImplementation(async ({ blockTag }: { blockTag: string }) => (
      blockTag === 'pending' ? 8 : 7
    ));
    const commitBroadcast = vi.fn().mockResolvedValue(undefined);
    const service = createTradingService(
      4663,
      'http://robinhood.test',
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );

    const result = await service.executeTrade({
      ...robinhoodSellParams(PRIVATE_KEY_A),
      awaitConfirmation: false,
      leaseGuard: {
        assertActive: vi.fn(),
        getNonceState: () => ({}),
        commitBroadcast,
      },
    });

    expect(result).toMatchObject({
      success: true,
      status: 'broadcast',
      transactionKind: 'trade',
    });
    expect(commitBroadcast).toHaveBeenCalledWith(8, result.txHash);
    expect(mocks.sequencerClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
