import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  resolvePresetRpcUrl,
  useChainStore,
} from '../chainStore';
import {
  ROBINHOOD_ARROW_RPC_URL,
  ROBINHOOD_OFFICIAL_RPC_URL,
} from '../../constants';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('chainStore RPC selection', () => {
  it('falls back to the selected chain RPC when v-model left the previous chain RPC behind', () => {
    const store = useChainStore();
    store.selectedChainId = 4663;
    store.rpcUrl = 'https://bsc-dataseed.binance.org';

    expect(store.effectiveRpcUrl).toBe(ROBINHOOD_OFFICIAL_RPC_URL);
  });

  it('preserves a valid Robinhood preset RPC', () => {
    const store = useChainStore();
    const chain = store.chains.find(item => item.id === 4663)!;

    expect(resolvePresetRpcUrl(chain, ROBINHOOD_ARROW_RPC_URL)).toBe(ROBINHOOD_ARROW_RPC_URL);
  });

  it('switches chain and RPC together while clearing the previous custom RPC', () => {
    const store = useChainStore();
    store.setCustomRpc('https://old-chain.example');

    store.setSelectedChain(4663);

    expect(store.selectedChainId).toBe(4663);
    expect(store.rpcUrl).toBe(ROBINHOOD_OFFICIAL_RPC_URL);
    expect(store.customRpcUrl).toBe('');
    expect(store.effectiveRpcUrl).toBe(ROBINHOOD_OFFICIAL_RPC_URL);
  });

  it('installs a server-provided runtime RPC as the active Robinhood default', () => {
    const store = useChainStore();
    store.setSelectedChain(4663);
    store.setCustomRpc('https://old-custom.example');

    store.setRuntimeRpc(4663, 'https://paid-rpc.example/key', 'Robinhood 高速节点');

    const robinhood = store.chains.find(item => item.id === 4663)!;
    expect(robinhood.rpc).toBe('https://paid-rpc.example/key');
    expect(robinhood.rpcOptions[0]).toEqual({
      name: 'Robinhood 高速节点',
      url: 'https://paid-rpc.example/key',
    });
    expect(store.rpcUrl).toBe('https://paid-rpc.example/key');
    expect(store.customRpcUrl).toBe('');
    expect(store.effectiveRpcUrl).toBe('https://paid-rpc.example/key');
  });
});
