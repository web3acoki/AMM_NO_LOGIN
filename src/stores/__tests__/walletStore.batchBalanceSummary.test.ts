import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseEther } from 'viem';
import { ROBINHOOD_CHAIN_ID } from '../../constants';
import {
  deduplicateBatchWallets,
  useWalletStore,
} from '../walletStore';

const ADDRESS_A = '0x0000000000000000000000000000000000000001';
const ADDRESS_B = '0x0000000000000000000000000000000000000002';
const ADDRESS_C = '0x0000000000000000000000000000000000000003';

beforeEach(() => {
  vi.stubGlobal('window', {});
  setActivePinia(createPinia());
});

describe('selected wallet-batch balance summary', () => {
  it('deduplicates the same address across batches without case sensitivity', () => {
    const wallets = deduplicateBatchWallets([
      { address: ADDRESS_A, privateKey: 'first' },
      { address: ADDRESS_A.toUpperCase(), privateKey: 'duplicate' },
      { address: ADDRESS_B, privateKey: 'second' },
    ]);

    expect(wallets).toEqual([
      { address: ADDRESS_A, privateKey: 'first' },
      { address: ADDRESS_B, privateKey: 'second' },
    ]);
  });

  it('queries each unique selected wallet once and returns an exact total', async () => {
    const store = useWalletStore();
    expect(store.currentChainId).toBe(ROBINHOOD_CHAIN_ID);

    store.walletBatches = [
      {
        id: 'batch-a',
        remark: 'A',
        createdAt: new Date(0).toISOString(),
        walletType: 'normal',
        wallets: [
          { address: ADDRESS_A, privateKey: '' },
          { address: ADDRESS_B, privateKey: '' },
        ],
      },
      {
        id: 'batch-b',
        remark: 'B',
        createdAt: new Date(0).toISOString(),
        walletType: 'normal',
        wallets: [
          { address: ADDRESS_A.toUpperCase(), privateKey: '' },
          { address: ADDRESS_C, privateKey: '' },
        ],
      },
    ];

    const balances = new Map([
      [ADDRESS_A, parseEther('1')],
      [ADDRESS_B, parseEther('2')],
      [ADDRESS_C, parseEther('3')],
    ]);
    const getBalance = vi.fn(async ({ address }: { address: string }) => (
      balances.get(address.toLowerCase()) || 0n
    ));
    vi.spyOn(store, 'getPublicClient').mockReturnValue({ getBalance } as any);

    const summary = await store.refreshSelectedBatchBalances(['batch-a', 'batch-b']);

    expect(getBalance).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      totalNativeBalance: '6',
      totalTokenBalance: undefined,
      totalAsterBalance: undefined,
      walletCount: 3,
      failedCount: 0,
    });
  });
});
