import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseEther, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const mocks = vi.hoisted(() => ({
  publicClient: {
    readContract: vi.fn(),
    multicall: vi.fn(),
    getTransactionCount: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  walletClient: {
    sendTransaction: vi.fn(),
  },
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mocks.publicClient),
    createWalletClient: vi.fn(({ account, chain }) => ({
      ...mocks.walletClient,
      account,
      chain,
    })),
    http: vi.fn(() => ({})),
  };
});

import { FourMemeService, resetNonceForAddress } from '../fourMemeService';
import { WALLET_PENDING_PREDECESSOR_CODE } from '../pendingNonceGuard';

const FOURMEME_TRADE_ABI = [
  {
    name: 'buyTokenAMAP',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'origin', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'funds', type: 'uint256' },
      { name: 'minAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'sellToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'minEthAmount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const TOKEN = '0x000000000000000000000000000000000000beef' as Address;
const ASTER = '0x000000000000000000000000000000000000a57e' as Address;
const PRIVATE_KEY = `0x${'5'.padStart(64, '0')}` as Hex;
const WALLET = privateKeyToAccount(PRIVATE_KEY).address;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hash;

function fastParams(mode: 'buy' | 'sell', slippage: number) {
  return {
    chainId: 56,
    rpcUrl: 'http://bsc.test',
    privateKey: PRIVATE_KEY,
    walletAddress: WALLET,
    tokenAddress: TOKEN,
    amount: 1,
    mode,
    sellPercent: mode === 'sell' ? 50 : undefined,
    slippage,
    poolBaseToken: ASTER,
  };
}

function decodeSentCall() {
  const request = mocks.walletClient.sendTransaction.mock.calls[0][0];
  return decodeFunctionData({
    abi: FOURMEME_TRADE_ABI,
    data: request.data,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetNonceForAddress(WALLET);
  mocks.publicClient.getTransactionCount.mockResolvedValue(7);
  mocks.publicClient.waitForTransactionReceipt.mockResolvedValue({
    status: 'success',
    transactionHash: TX_HASH,
  });
  mocks.walletClient.sendTransaction.mockResolvedValue(TX_HASH);
});

describe('FourMeme ASTER fast-path slippage protection', () => {
  it('quotes fast buys and encodes the configured non-zero minAmount', async () => {
    mocks.publicClient.readContract.mockResolvedValue(10_000n);
    const service = new FourMemeService(56, 'http://bsc.test');

    const result = await service.executeTradeFast(fastParams('buy', 10));

    expect(result).toMatchObject({ success: true, status: 'confirmed', txHash: TX_HASH });
    expect(mocks.publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAmountOut',
      args: [TOKEN, parseEther('1'), true],
    }));
    const decoded = decodeSentCall();
    expect(decoded.functionName).toBe('buyTokenAMAP');
    expect(decoded.args?.[0]).toBe(0n);
    expect(String(decoded.args?.[1]).toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(decoded.args?.[2]).toBe(parseEther('1'));
    expect(decoded.args?.[3]).toBe(9_000n);
  });

  it('re-reads the balance and quotes the actual fast-sell amount under the lock', async () => {
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'balanceOf') return 1_000n;
      if (functionName === 'getAmountOut') return 2_000n;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    const service = new FourMemeService(56, 'http://bsc.test', 'http://bsc-sell.test');

    // The stale prefetched value must not determine the amount eventually sent.
    const result = await service.executeTradeFast(fastParams('sell', 20), 9_999n);

    expect(result).toMatchObject({ success: true, status: 'confirmed', txHash: TX_HASH });
    expect(mocks.publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAmountOut',
      args: [TOKEN, 500n, false],
    }));
    const decoded = decodeSentCall();
    expect(decoded.functionName).toBe('sellToken');
    expect(String(decoded.args?.[0]).toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(decoded.args?.[1]).toBe(500n);
    expect(decoded.args?.[2]).toBe(1_600n);
  });

  it('fails closed before nonce reservation or broadcast when the quote RPC fails', async () => {
    mocks.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'balanceOf') return 1_000n;
      if (functionName === 'getAmountOut') throw new Error('quote RPC unavailable');
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    const service = new FourMemeService(56, 'http://bsc.test');

    const result = await service.executeTradeFast(fastParams('sell', 15), 1_000n);

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.error).toContain('FourMeme 报价失败');
    expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when the quote is zero instead of silently broadcasting minOut zero', async () => {
    mocks.publicClient.readContract.mockResolvedValue(0n);
    const service = new FourMemeService(56, 'http://bsc.test');

    const result = await service.executeTradeFast(fastParams('buy', 10));

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.error).toContain('预期输出为 0');
    expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('preserves the existing task meaning of zero slippage as no limit', async () => {
    const service = new FourMemeService(56, 'http://bsc.test');

    const result = await service.executeTradeFast(fastParams('buy', 0));

    expect(result.success).toBe(true);
    expect(mocks.publicClient.readContract).not.toHaveBeenCalled();
    const decoded = decodeSentCall();
    expect(decoded.functionName).toBe('buyTokenAMAP');
    expect(String(decoded.args?.[1]).toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(decoded.args?.[3]).toBe(0n);
  });
});

describe('FourMeme ASTER round allowance prefetch', () => {
  const maxUint128 = BigInt('0xffffffffffffffffffffffffffffffff');

  it('keeps buy and sell allowance results separate when one wallet trades both directions', async () => {
    mocks.publicClient.multicall.mockResolvedValue([
      { status: 'success', result: 500n },
      { status: 'success', result: maxUint128 },
      { status: 'success', result: 0n },
    ]);
    const service = new FourMemeService(56, 'http://bsc.test');

    const result = await service.batchPrepareRound({
      tokenAddress: TOKEN,
      baseTokenAddress: ASTER,
      buyWalletAddresses: [WALLET],
      sellWalletAddresses: [WALLET],
    });

    expect(result.get(WALLET.toLowerCase())).toEqual({
      tokenBalance: 500n,
      buyAllowanceSufficient: true,
      sellAllowanceSufficient: false,
    });
  });

  it.each([
    {
      label: 'buy allowance',
      multicallResult: [
        { status: 'success', result: 500n },
        { status: 'failure', error: new Error('base allowance failed') },
        { status: 'success', result: maxUint128 },
      ],
      expected: {
        tokenBalance: 500n,
        buyAllowanceSufficient: false,
        sellAllowanceSufficient: true,
      },
    },
    {
      label: 'sell allowance',
      multicallResult: [
        { status: 'success', result: 500n },
        { status: 'success', result: maxUint128 },
        { status: 'failure', error: new Error('target allowance failed') },
      ],
      expected: {
        tokenBalance: 500n,
        buyAllowanceSufficient: true,
        sellAllowanceSufficient: false,
      },
    },
  ])('fails closed only for the affected direction when $label lookup fails', async ({ multicallResult, expected }) => {
    mocks.publicClient.multicall.mockResolvedValue(multicallResult);
    const service = new FourMemeService(56, 'http://bsc.test');

    const result = await service.batchPrepareRound({
      tokenAddress: TOKEN,
      baseTokenAddress: ASTER,
      buyWalletAddresses: [WALLET],
      sellWalletAddresses: [WALLET],
    });

    expect(result.get(WALLET.toLowerCase())).toEqual(expected);
  });
});

describe('FourMeme manual batch-sell slippage protection', () => {
  it('quotes the prepared amount and encodes a protected minEthAmount', async () => {
    mocks.publicClient.readContract.mockResolvedValue(2_000n);
    const service = new FourMemeService(56, 'http://bsc.test', 'http://bsc-sell.test');

    const result = await service.executeSellDirect(fastParams('sell', 20), 500n);

    expect(result).toMatchObject({ success: true, status: 'confirmed', txHash: TX_HASH });
    expect(mocks.publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAmountOut',
      args: [TOKEN, 500n, false],
    }));
    const decoded = decodeSentCall();
    expect(decoded.functionName).toBe('sellToken');
    expect(decoded.args?.[1]).toBe(500n);
    expect(decoded.args?.[2]).toBe(1_600n);
  });

  it('fails closed before nonce reservation or broadcast when its quote fails', async () => {
    mocks.publicClient.readContract.mockRejectedValue(new Error('quote RPC unavailable'));
    const service = new FourMemeService(56, 'http://bsc.test', 'http://bsc-sell.test');

    const result = await service.executeSellDirect(fastParams('sell', 20), 500n);

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.error).toContain('FourMeme 报价失败');
    expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps a hashless direct-sell submit failure tied to the trade stage', async () => {
    mocks.publicClient.readContract.mockResolvedValue(2_000n);
    mocks.walletClient.sendTransaction.mockRejectedValueOnce(new Error('submit response lost'));
    const service = new FourMemeService(56, 'http://bsc.test', 'http://bsc-sell.test');

    const result = await service.executeSellDirect(fastParams('sell', 20), 500n);

    expect(result).toMatchObject({
      success: false,
      status: 'unknown',
      transactionKind: 'trade',
    });
    expect(result.txHash).toBeUndefined();
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns a conservative pending trade with no hash for an existing pending predecessor', async () => {
    mocks.publicClient.readContract.mockResolvedValue(2_000n);
    mocks.publicClient.getTransactionCount.mockImplementation(async ({ blockTag }: { blockTag: string }) => (
      blockTag === 'pending' ? 8 : 7
    ));
    const service = new FourMemeService(56, 'http://bsc.test', 'http://bsc-sell.test');

    const result = await service.executeSellDirect(fastParams('sell', 20), 500n);

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      code: WALLET_PENDING_PREDECESSOR_CODE,
      transactionKind: 'trade',
    });
    expect(result.txHash).toBeUndefined();
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });
});
