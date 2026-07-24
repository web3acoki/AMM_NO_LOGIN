import { describe, expect, it } from 'vitest';
import { allocateRobinhoodTaskDirections } from '../taskRoundAllocator';

describe('allocateRobinhoodTaskDirections', () => {
  it('keeps every configured direction when enough unique wallets are free', () => {
    expect(allocateRobinhoodTaskDirections(3, 1, 4, 2)).toEqual({
      buyCount: 3,
      sellCount: 1,
      nextOffset: 0,
      constrained: false,
    });
  });

  it('does not permanently starve one sell thread behind three buy threads', () => {
    let offset = 0;
    let buyTotal = 0;
    let sellTotal = 0;
    const rounds: Array<[number, number]> = [];

    for (let round = 0; round < 4; round++) {
      const allocation = allocateRobinhoodTaskDirections(3, 1, 3, offset);
      offset = allocation.nextOffset;
      buyTotal += allocation.buyCount;
      sellTotal += allocation.sellCount;
      rounds.push([allocation.buyCount, allocation.sellCount]);
    }

    expect(rounds[0][1]).toBeGreaterThan(0);
    expect(sellTotal).toBe(3);
    expect(buyTotal).toBe(9);
  });

  it('preserves the configured long-run ratio even when only one wallet is free', () => {
    let offset = 0;
    let buyTotal = 0;
    let sellTotal = 0;

    for (let round = 0; round < 8; round++) {
      const allocation = allocateRobinhoodTaskDirections(3, 1, 1, offset);
      offset = allocation.nextOffset;
      buyTotal += allocation.buyCount;
      sellTotal += allocation.sellCount;
    }

    expect({ buyTotal, sellTotal }).toEqual({ buyTotal: 6, sellTotal: 2 });
  });

  it('caps a single active direction at the number of free wallets', () => {
    expect(allocateRobinhoodTaskDirections(0, 20, 7)).toMatchObject({
      buyCount: 0,
      sellCount: 7,
      constrained: true,
    });
  });

  it('preserves the weighted cursor across a temporary zero-capacity tick', () => {
    const first = allocateRobinhoodTaskDirections(3, 1, 2, 0);
    expect(first).toMatchObject({
      buyCount: 2,
      sellCount: 0,
      nextOffset: 2,
    });

    const allBusy = allocateRobinhoodTaskDirections(3, 1, 0, first.nextOffset);
    expect(allBusy).toMatchObject({
      buyCount: 0,
      sellCount: 0,
      nextOffset: 2,
    });

    expect(allocateRobinhoodTaskDirections(3, 1, 2, allBusy.nextOffset)).toMatchObject({
      buyCount: 1,
      sellCount: 1,
      nextOffset: 0,
    });
  });
});
