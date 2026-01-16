import { defineStore } from 'pinia';

export type ChainItem = {
  id: number;
  name: string;
  rpc: string;
  governanceToken: string;
};

export const useChainStore = defineStore('chain', {
  state: () => ({
    chains: [
      { id: 97, name: 'BSC Testnet', rpc: 'https://bsc-testnet.publicnode.com', governanceToken: 'BNB' },
      { id: 56, name: 'BSC Mainnet', rpc: 'https://bsc-dataseed.binance.org', governanceToken: 'BNB' },
      { id: 66, name: 'OKX Chain', rpc: 'https://exchainrpc.okex.org', governanceToken: 'OKB' },
    ] as ChainItem[],
    selectedChainId: 56 as number, // 默认选择 BSC 主网
    selectedDex: 'pancake-v2' as 'pancake-v2',
    rpcUrl: 'https://bsc-dataseed.binance.org' as string,
  }),
  getters: {
    selectedChain: (state) => state.chains.find(c => c.id === state.selectedChainId),
    currentGovernanceToken: (state) => {
      const chain = state.chains.find(c => c.id === state.selectedChainId);
      return chain?.governanceToken || 'BNB';
    },
  },
});


