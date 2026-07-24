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

function normalizeRpcUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve a preset RPC that actually belongs to the selected chain. Vue may
 * publish a v-model chain change before the accompanying change handler has
 * updated rpcUrl; falling back here prevents that short-lived mixed state from
 * sending Robinhood contract reads to the previous chain's RPC.
 */
export function resolvePresetRpcUrl(chain: ChainItem, requestedRpcUrl: string): string {
  const requested = normalizeRpcUrl(requestedRpcUrl);
  const matchingOption = chain.rpcOptions.find(
    option => normalizeRpcUrl(option.url) === requested,
  );
  return matchingOption?.url || chain.rpcOptions[0]?.url || chain.rpc;
}

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
    selectedChainId: ROBINHOOD_CHAIN_ID as number,
    selectedDex: 'uniswap-v3' as SupportedDexProtocol,
    rpcUrl: ROBINHOOD_OFFICIAL_RPC_URL as string,
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
      const chain = state.chains.find(c => c.id === state.selectedChainId);
      if (!chain) return '';
      return state.customRpcUrl || resolvePresetRpcUrl(chain, state.rpcUrl);
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
      this.rpcUrl = resolvePresetRpcUrl(chain, chain.rpc);
      this.customRpcUrl = '';
    },
    ensureSelectedChainRpc() {
      const chain = this.chains.find(item => item.id === this.selectedChainId);
      if (!chain) {
        throw new Error(`Unsupported chain ID: ${this.selectedChainId}`);
      }
      this.rpcUrl = resolvePresetRpcUrl(chain, this.rpcUrl);
      return this.customRpcUrl || this.rpcUrl;
    },
    setCustomRpc(url: string) {
      this.customRpcUrl = url;
      console.log('自定义RPC已设置:', url || '(已清除，使用默认节点)');
    },
    setRuntimeRpc(chainId: number, url: string, name = '高速节点') {
      const chain = this.chains.find(item => item.id === chainId);
      if (!chain) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
      }
      const normalized = normalizeRpcUrl(url);
      const remainingOptions = chain.rpcOptions.filter(
        option => normalizeRpcUrl(option.url) !== normalized,
      );
      chain.rpc = url;
      chain.rpcOptions = [{ name, url }, ...remainingOptions];
      if (this.selectedChainId === chainId) {
        this.rpcUrl = url;
        this.customRpcUrl = '';
      }
    },
    clearCustomRpc() {
      this.customRpcUrl = '';
      console.log('自定义RPC已清除，使用默认节点:', this.rpcUrl);
    },
  },
});
