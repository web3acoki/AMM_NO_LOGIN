import { defineStore } from 'pinia';
import {
  PONS_V3_POOL_FEE,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_WETH_ADDRESS,
  UNISWAP_V3_ROBINHOOD_ADDRESSES,
} from '../constants';

export type DexProtocol = 'pancake-v2' | 'uniswap-v3' | 'okx-swap';

export type DexConfig = {
  id: string;
  name: string;
  chainId: number;
  protocol: DexProtocol;
  factoryAddress: string;
  routerAddress: string;
  baseTokens: string[];
  quoterAddress?: string;
  positionManagerAddress?: string;
  multicallAddress?: string;
  permit2Address?: string;
  universalRouterAddress?: string;
  poolFees?: number[];
};

export type ChainDexMapping = {
  chainId: number;
  dexId: string;
};

export const useDexStore = defineStore('dex', {
  state: () => ({
    // DEX 配置
    dexConfigs: [
      {
        id: 'pancake-v2-testnet',
        name: 'PancakeSwap V2 Testnet',
        chainId: 97,
        protocol: 'pancake-v2',
        factoryAddress: '0x6725F303b657a9451d8BA641348b6761A6CC7a17', // BSC Testnet PancakeSwap V2 Factory (官方)
        routerAddress: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1', // BSC Testnet PancakeSwap V2 Router
        baseTokens: [
          '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd', // WBNB (BSC Testnet)
        ]
      },
      {
        id: 'pancake-v2-mainnet',
        name: 'PancakeSwap V2 Mainnet',
        chainId: 56,
        protocol: 'pancake-v2',
        factoryAddress: '0xcA143Ce0Fe65960E6Aa4D42C8D3cE161c2B6604f', // BSC Mainnet PancakeSwap V2 Factory
        routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E', // BSC Mainnet PancakeSwap V2 Router
        baseTokens: [
          '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB (BSC Mainnet)
          '0x000ae314e2a2172a039b26378814c252734f556a', // ASTER (BSC Mainnet)
        ]
      },
      {
        id: 'okx-swap',
        name: 'OKX Swap',
        chainId: 66,
        protocol: 'okx-swap',
        factoryAddress: '0x0000000000000000000000000000000000000000', // OKX Chain Factory (待更新)
        routerAddress: '0x0000000000000000000000000000000000000000', // OKX Chain Router (待更新)
        baseTokens: [
          '0x8F8526dbfd6E38E3D8307702cA8469Bae6C56C15', // WOKT (OKX Chain)
        ]
      },
      {
        id: 'uniswap-v3',
        name: 'Uniswap V3 (Robinhood Chain)',
        chainId: ROBINHOOD_CHAIN_ID,
        protocol: 'uniswap-v3',
        factoryAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.factory,
        routerAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
        quoterAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.quoterV2,
        positionManagerAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.positionManager,
        multicallAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.multicall,
        permit2Address: UNISWAP_V3_ROBINHOOD_ADDRESSES.permit2,
        universalRouterAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.universalRouter,
        poolFees: [PONS_V3_POOL_FEE],
        baseTokens: [ROBINHOOD_WETH_ADDRESS],
      }
    ] as DexConfig[],
    
    // 公链与DEX映射关系
    chainDexMappings: [
      { chainId: 97, dexId: 'pancake-v2-testnet' },  // BSC Testnet -> PancakeSwap V2 Testnet
      { chainId: 56, dexId: 'pancake-v2-mainnet' },  // BSC Mainnet -> PancakeSwap V2 Mainnet
      { chainId: 66, dexId: 'okx-swap' },            // OKX Chain -> OKX Swap
      { chainId: ROBINHOOD_CHAIN_ID, dexId: 'uniswap-v3' }, // Robinhood -> Uniswap V3
    ] as ChainDexMapping[],
    
    selectedDexId: 'uniswap-v3' as string,
  }),
  
  getters: {
    // 根据公链ID获取对应的DEX配置
    getDexByChainId: (state) => (chainId: number) => {
      const mapping = state.chainDexMappings.find(m => m.chainId === chainId);
      if (!mapping) return null;
      return state.dexConfigs.find(d => d.id === mapping.dexId);
    },
    
    // 当前选中的DEX配置
    currentDex: (state) => {
      return state.dexConfigs.find(d => d.id === state.selectedDexId);
    },
    
    // 当前DEX ID
    currentDexId: (state) => {
      return state.selectedDexId;
    },
    
    // 当前DEX名称
    currentDexName: (state) => {
      const dex = state.dexConfigs.find(d => d.id === state.selectedDexId);
      return dex?.name || '';
    },
    
    // 当前DEX的Factory地址
    currentFactoryAddress: (state) => {
      const dex = state.dexConfigs.find(d => d.id === state.selectedDexId);
      return dex?.factoryAddress || '';
    },
    
    // 当前DEX的Router地址
    currentRouterAddress: (state) => {
      const dex = state.dexConfigs.find(d => d.id === state.selectedDexId);
      return dex?.routerAddress || '';
    },
    
    // 当前DEX的基准币列表
    currentBaseTokens: (state) => {
      const dex = state.dexConfigs.find(d => d.id === state.selectedDexId);
      return dex?.baseTokens || [];
    },
    
    // 所有DEX配置
    allDexConfigs: (state) => {
      return state.dexConfigs;
    },
  },
  
  actions: {
    // 根据公链ID设置DEX
    setDexByChainId(chainId: number) {
      const mapping = this.chainDexMappings.find(m => m.chainId === chainId);
      if (mapping) {
        this.selectedDexId = mapping.dexId;
        console.log(`公链 ${chainId} 自动切换到 DEX: ${mapping.dexId}`);
        return true;
      }
      // Never leave a previous-chain DEX selected for an unsupported chain.
      this.selectedDexId = '';
      console.warn(`公链 ${chainId} 没有可用的 DEX 配置`);
      return false;
    },
    
    // 手动设置DEX
    setDex(dexId: string) {
      if (!this.dexConfigs.some(dex => dex.id === dexId)) {
        throw new Error(`Unsupported DEX ID: ${dexId}`);
      }
      this.selectedDexId = dexId;
    },
  },
});
