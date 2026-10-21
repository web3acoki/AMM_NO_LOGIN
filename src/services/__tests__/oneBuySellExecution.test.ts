import { describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import {
  estimateOneBuySellSafeMax,
  randomAmountAtMostSixDecimals,
} from '../oneBuySellExecution';

describe('one-buy-one-sell execution helpers', () => {
  it('keeps a fixed random range exact and at no more than six decimals', () => {
    expect(randomAmountAtMostSixDecimals(0.012345, 0.012345)).toBe('0.012345');
    expect(randomAmountAtMostSixDecimals(0.01, 0.01)).toBe('0.01');
  });

  it('samples uniformly from integer micro-ETH units inside the effective range', () => {
    const spy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999999999);
    expect(randomAmountAtMostSixDecimals(0.01, 0.010002)).toBe('0.01');
    expect(randomAmountAtMostSixDecimals(0.01, 0.010002)).toBe('0.010002');
    spy.mockRestore();
  });

  it('rejects ranges that cannot be represented with six decimals', () => {
    expect(() => randomAmountAtMostSixDecimals(0.0000001, 0.0000002))
      .toThrow('最多 6 位小数');
  });

  it('reserves buy, approval, sell, sweep gas and a fixed rollup buffer', async () => {
    const balance = parseEther('1');
    const feeCap = 200n;
    const client = {
      getBalance: vi.fn(async () => balance),
      estimateFeesPerGas: vi.fn(async () => ({
        maxFeePerGas: feeCap,
        maxPriorityFeePerGas: 1n,
      })),
      getGasPrice: vi.fn(async () => 100n),
    };

    const result = await estimateOneBuySellSafeMax(
      client as any,
      '0x0000000000000000000000000000000000000001',
      false,
    );
    const expectedReserve = (900_000n * feeCap * 13_000n) / 10_000n
      + parseEther('0.0001');
    expect(result.reserveWei).toBe(expectedReserve);
    expect(result.safeMaxWei).toBe(balance - expectedReserve);
    expect(client.getGasPrice).not.toHaveBeenCalled();
  });
});
