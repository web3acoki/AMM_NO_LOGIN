import { defineStore } from 'pinia';

export type RpcOption = {
  name: string;
  url: string;
};

export type ChainItem = {
  id: number;
  name: string;
  rpc: string;
  governanceToken: string;
  rpcOptions: RpcOption[];
};

export const useChainStore = defineStore('chain', {
  state: () => ({
    chains: [
      {
        id: 97,
        name: 'BSC Testnet',
        rpc: 'https://bsc-testnet.publicnode.com',
        governanceToken: 'BNB',
        rpcOptions: [
          { name: '普通节点', url: 'https://bsc-testnet.publicnode.com' }
        ]
      },
      {
        id: 56,
        name: 'BSC Mainnet',
        rpc: 'https://bsc-dataseed.binance.org',
        governanceToken: 'BNB',
        rpcOptions: [
          { name: '普通节点', url: 'https://bsc-dataseed.binance.org' },
          { name: '防夹节点', url: 'https://meme.bsc.blockrazor.xyz' }
        ]
      },
      {
        id: 66,
        name: 'OKX Chain',
        rpc: 'https://exchainrpc.okex.org',
        governanceToken: 'OKB',
        rpcOptions: [
          { name: '普通节点', url: 'https://exchainrpc.okex.org' }
        ]
      },
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


