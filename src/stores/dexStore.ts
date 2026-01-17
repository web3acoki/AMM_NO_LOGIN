import { defineStore } from 'pinia';

export type DexConfig = {
  id: string;
  name: string;
  factoryAddress: string;
  routerAddress: string;
  baseTokens: string[];
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
        factoryAddress: '0x6725F303b657a9451d8BA641348b6761A6CC7a17', // BSC Testnet PancakeSwap V2 Factory (官方)
        routerAddress: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1', // BSC Testnet PancakeSwap V2 Router
        baseTokens: [
          '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd', // WBNB (BSC Testnet)
        ]
      },
      {
        id: 'pancake-v2-mainnet',
        name: 'PancakeSwap V2 Mainnet',
        factoryAddress: '0xcA143Ce0Fe65960E6Aa4D42C8D3cE161c2B6604f', // BSC Mainnet PancakeSwap V2 Factory
        routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E', // BSC Mainnet PancakeSwap V2 Router
        baseTokens: [
          '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB (BSC Mainnet)
        ]
      },
      {
        id: 'okx-swap',
        name: 'OKX Swap',
        factoryAddress: '0x0000000000000000000000000000000000000000', // OKX Chain Factory (待更新)
        routerAddress: '0x0000000000000000000000000000000000000000', // OKX Chain Router (待更新)
        baseTokens: [
          '0x8F8526dbfd6E38E3D8307702cA8469Bae6C56C15', // WOKT (OKX Chain)
        ]
      }
    ] as DexConfig[],
    
    // 公链与DEX映射关系
    chainDexMappings: [
      { chainId: 97, dexId: 'pancake-v2-testnet' },  // BSC Testnet -> PancakeSwap V2 Testnet
      { chainId: 56, dexId: 'pancake-v2-mainnet' },  // BSC Mainnet -> PancakeSwap V2 Mainnet
      { chainId: 66, dexId: 'okx-swap' },            // OKX Chain -> OKX Swap
    ] as ChainDexMapping[],
    
    selectedDexId: 'pancake-v2-mainnet' as string,
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
      }
    },
    
    // 手动设置DEX
    setDex(dexId: string) {
      this.selectedDexId = dexId;
    },
  },
});
