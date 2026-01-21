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
          { name: '公共节点1', url: 'https://bsc-testnet.publicnode.com' },
          { name: '公共节点2', url: 'https://data-seed-prebsc-1-s1.binance.org:8545' },
        ]
      },
      {
        id: 56,
        name: 'BSC Mainnet',
        rpc: 'https://bsc-dataseed.binance.org',
        governanceToken: 'BNB',
        rpcOptions: [
          { name: 'Binance官方1', url: 'https://bsc-dataseed.binance.org' },
          { name: 'Binance官方2', url: 'https://bsc-dataseed1.binance.org' },
          { name: 'Binance官方3', url: 'https://bsc-dataseed2.binance.org' },
          { name: 'Binance官方4', url: 'https://bsc-dataseed3.binance.org' },
          { name: 'Binance官方5', url: 'https://bsc-dataseed4.binance.org' },
          { name: 'PublicNode', url: 'https://bsc.publicnode.com' },
          { name: 'NodeReal', url: 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3' },
          { name: '防夹节点', url: 'https://meme.bsc.blockrazor.xyz' },
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
    customRpcUrl: '' as string, // 自定义RPC节点
  }),
  getters: {
    selectedChain: (state) => state.chains.find(c => c.id === state.selectedChainId),
    currentGovernanceToken: (state) => {
      const chain = state.chains.find(c => c.id === state.selectedChainId);
      return chain?.governanceToken || 'BNB';
    },
    // 实际使用的RPC URL（优先使用自定义节点）
    effectiveRpcUrl: (state) => {
      return state.customRpcUrl || state.rpcUrl;
    },
  },
  actions: {
    setCustomRpc(url: string) {
      this.customRpcUrl = url;
      console.log('自定义RPC已设置:', url || '(已清除，使用默认节点)');
    },
    clearCustomRpc() {
      this.customRpcUrl = '';
      console.log('自定义RPC已清除，使用默认节点:', this.rpcUrl);
    },
  },
});


