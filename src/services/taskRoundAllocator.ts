export type TaskDirectionAllocation = {
  buyCount: number;
  sellCount: number;
  nextOffset: number;
  constrained: boolean;
};

function normalizeThreadCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Build one smooth weighted cycle.  A cycle contains exactly buyRequested buy
 * slots and sellRequested sell slots, but spreads the minority direction across
 * the cycle instead of placing every buy before every sell.
 */
function buildDirectionCycle(
  buyRequested: number,
  sellRequested: number,
): Array<'buy' | 'sell'> {
  const total = buyRequested + sellRequested;
  const cycle: Array<'buy' | 'sell'> = [];
  let buyWeight = 0;
  let sellWeight = 0;

  for (let index = 0; index < total; index++) {
    buyWeight += buyRequested;
    sellWeight += sellRequested;
    if (buyWeight >= sellWeight) {
      cycle.push('buy');
      buyWeight -= total;
    } else {
      cycle.push('sell');
      sellWeight -= total;
    }
  }

  return cycle;
}

/**
 * Allocate the unique wallets available to one Robinhood round.
 *
 * A wallet cannot safely buy and sell in the same round because both writes
 * would compete for its nonce.  When there are enough free wallets, every
 * configured thread is preserved.  When capacity is short, a persistent offset
 * walks a smooth weighted cycle so neither direction can be permanently
 * starved by the other.
 */
export function allocateRobinhoodTaskDirections(
  buyRequestedValue: number,
  sellRequestedValue: number,
  availableWalletCountValue: number,
  startOffsetValue = 0,
): TaskDirectionAllocation {
  const buyRequested = normalizeThreadCount(buyRequestedValue);
  const sellRequested = normalizeThreadCount(sellRequestedValue);
  const availableWalletCount = normalizeThreadCount(availableWalletCountValue);
  const totalRequested = buyRequested + sellRequested;

  if (totalRequested === 0) {
    return {
      buyCount: 0,
      sellCount: 0,
      nextOffset: 0,
      constrained: availableWalletCount < totalRequested,
    };
  }

  if (availableWalletCount === 0) {
    return {
      buyCount: 0,
      sellCount: 0,
      // A zero-capacity tick did not consume a direction slot. Preserve the
      // weighted cursor so a temporary all-busy wave cannot restart at "buy"
      // and permanently starve the minority direction.
      nextOffset: (
        buyRequested > 0 && sellRequested > 0
          ? normalizeThreadCount(startOffsetValue) % totalRequested
          : 0
      ),
      constrained: true,
    };
  }

  if (availableWalletCount >= totalRequested) {
    return {
      buyCount: buyRequested,
      sellCount: sellRequested,
      nextOffset: 0,
      constrained: false,
    };
  }

  if (buyRequested === 0) {
    return {
      buyCount: 0,
      sellCount: Math.min(sellRequested, availableWalletCount),
      nextOffset: 0,
      constrained: true,
    };
  }
  if (sellRequested === 0) {
    return {
      buyCount: Math.min(buyRequested, availableWalletCount),
      sellCount: 0,
      nextOffset: 0,
      constrained: true,
    };
  }

  const cycle = buildDirectionCycle(buyRequested, sellRequested);
  const startOffset = (
    (normalizeThreadCount(startOffsetValue) % cycle.length) + cycle.length
  ) % cycle.length;
  const slots = Math.min(availableWalletCount, totalRequested);
  let buyCount = 0;
  let sellCount = 0;

  for (let index = 0; index < slots; index++) {
    const direction = cycle[(startOffset + index) % cycle.length];
    if (direction === 'buy') buyCount++;
    else sellCount++;
  }

  return {
    buyCount,
    sellCount,
    nextOffset: (startOffset + slots) % cycle.length,
    constrained: true,
  };
}
