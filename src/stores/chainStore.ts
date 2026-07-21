import { defineStore } from 'pinia';
import {
  ROBINHOOD_ARROW_RPC_URL,
  ROBINHOOD_ARROW_WS_URL,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_OFFICIAL_RPC_URL,
} from '../constants';

export type RpcOption = {
  name: string;
  url: string;
  webSocketUrl?: string;
};

export type ChainItem = {
  id: number;
  name: string;
  rpc: string;
  governanceToken: string;
  rpcOptions: RpcOption[];
  explorerUrl?: string;
};

export type SupportedDexProtocol = 'pancake-v2' | 'uniswap-v3' | 'okx-swap';

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
      {
        id: ROBINHOOD_CHAIN_ID,
        name: 'Robinhood Chain',
        rpc: ROBINHOOD_OFFICIAL_RPC_URL,
        governanceToken: 'ETH',
        explorerUrl: ROBINHOOD_EXPLORER_URL,
        rpcOptions: [
          { name: 'Robinhood 官方节点', url: ROBINHOOD_OFFICIAL_RPC_URL },
          {
            name: 'ArrowRPC 免费节点',
            url: ROBINHOOD_ARROW_RPC_URL,
            webSocketUrl: ROBINHOOD_ARROW_WS_URL,
          },
        ],
      },
    ] as ChainItem[],
    selectedChainId: 56 as number, // 默认选择 BSC 主网
    selectedDex: 'pancake-v2' as SupportedDexProtocol,
    rpcUrl: 'https://bsc-dataseed.binance.org' as string,
    customRpcUrl: '' as string, // 自定义RPC节点
  }),
  getters: {
    selectedChain: (state) => state.chains.find(c => c.id === state.selectedChainId),
    currentGovernanceToken: (state) => {
      const chain = state.chains.find(c => c.id === state.selectedChainId);
      return chain?.governanceToken || '';
    },
    // 实际使用的RPC URL（优先使用自定义节点）
    effectiveRpcUrl: (state) => {
      const isSupported = state.chains.some(c => c.id === state.selectedChainId);
      return isSupported ? (state.customRpcUrl || state.rpcUrl) : '';
    },
    isSupportedChain: (state) => (chainId: number) => {
      return state.chains.some(chain => chain.id === chainId);
    },
  },
  actions: {
    setSelectedChain(chainId: number) {
      const chain = this.chains.find(item => item.id === chainId);
      if (!chain) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
      }
      this.selectedChainId = chain.id;
      this.rpcUrl = chain.rpc;
      this.customRpcUrl = '';
    },
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

