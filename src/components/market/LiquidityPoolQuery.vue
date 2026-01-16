<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h2 class="h6 mb-0">资金池查询</h2>
    </div>
    
    <div class="row g-3">
      <!-- 选择链 -->
      <div class="col-12 col-md-6">
        <label class="form-label">选择链</label>
        <select class="form-select" v-model="selectedChainId" @change="onChainChange">
          <option v-for="c in chains" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      
      <!-- 交易所 -->
      <div class="col-12 col-md-6">
        <label class="form-label">交易所</label>
        <select class="form-select" v-model="selectedDexId" @change="onDexChange">
          <option v-for="dex in availableDexs" :key="dex.id" :value="dex.id">{{ dex.name }}</option>
        </select>
      </div>
      
      <!-- 报价代币 -->
      <div class="col-12 col-md-6">
        <label class="form-label">
          报价代币
          <i class="bi bi-question-circle ms-1" :title="'从当前交易所的基准币中选择'"></i>
        </label>
        <select class="form-select" v-model="selectedQuoteToken" @change="onQuoteTokenChange">
          <option value="">请选择报价代币</option>
          <option v-for="token in quoteTokenOptions" :key="token.address" :value="token.address">
            {{ token.display }}
          </option>
        </select>
      </div>
      
      <!-- 代币地址 -->
      <div class="col-12 col-md-6">
        <label class="form-label">
          代币地址
          <i class="bi bi-question-circle ms-1" :title="'输入要查询的代币合约地址'"></i>
        </label>
        <input 
          class="form-control" 
          v-model="tokenAddress" 
          placeholder="0x..." 
          @input="onTokenAddressChange"
        />
      </div>
      
      <!-- 查询按钮 -->
      <div class="col-12">
        <button 
          class="btn btn-primary w-100" 
          @click="queryPool" 
          :disabled="!canQuery || isQuerying"
        >
          <i class="bi bi-search me-1"></i>
          {{ isQuerying ? '查询中...' : '查询资金池' }}
        </button>
      </div>
      
      <!-- 价格显示 -->
      <div v-if="currentPrice !== null" class="col-12">
        <div class="card">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <h6 class="mb-1">当前价格</h6>
                <div class="h4 mb-0">{{ priceDisplay }}</div>
                <div class="h5 mb-0 text-primary">{{ currentPrice !== null ? currentPrice.toString() : '-' }}</div>
                <small class="text-muted">更新时间: {{ lastUpdateTime }}</small>
                <div v-if="isRoutedPrice" class="mt-1">
                  <span class="badge bg-info">路由价格</span>
                  <small class="text-muted ms-1">通过 BNB 换算</small>
                </div>
              </div>
              <button 
                class="btn btn-outline-danger" 
                @click="stopUpdate"
                :disabled="!isUpdating"
              >
                <i class="bi bi-stop-circle me-1"></i>停止
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 错误提示 -->
      <div v-if="errorMessage" class="col-12">
        <div class="alert alert-warning alert-dismissible fade show" role="alert">
          <i class="bi bi-exclamation-triangle me-1"></i>
          {{ errorMessage }}
          <button type="button" class="btn-close" @click="errorMessage = ''" aria-label="Close"></button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useChainStore } from '../../stores/chainStore';
import { useDexStore } from '../../stores/dexStore';
import { PriceCalculator, type TokenPair } from '../../utils/priceCalculator';
import { createPublicClient, http } from 'viem';
import { erc20Abi } from '../../viem/abis/erc20';
import { bscTestnet, bsc, okc } from 'viem/chains';

const chainStore = useChainStore();
const dexStore = useDexStore();

const { chains, rpcUrl } = storeToRefs(chainStore);
const {
  currentDex,
  currentDexName,
  currentFactoryAddress,
  currentRouterAddress,
  currentBaseTokens,
  selectedDexId,
  allDexConfigs
} = storeToRefs(dexStore);

// 状态
const selectedChainId = ref<number>(chainStore.selectedChainId);
const selectedDexIdLocal = ref<string>(selectedDexId.value);
const selectedQuoteToken = ref<string>('');
const tokenAddress = ref<string>('');
const currentPrice = ref<number | null>(null);
const priceDisplay = ref<string>('');
const isQuerying = ref<boolean>(false);
const isUpdating = ref<boolean>(false);
const errorMessage = ref<string>('');
const lastUpdateTime = ref<string>('');
const isRoutedPrice = ref<boolean>(false);  // 是否是路由计算的价格
const routePathDisplay = ref<string[]>([]);  // 路由路径显示
const updateInterval = ref<number | null>(null);
const tokenSymbol = ref<string>('');
const quoteTokenSymbol = ref<string>('');

// 代币信息缓存（使用响应式对象）
const tokenInfoCache = new Map<string, { name: string; symbol: string }>();
const cacheUpdateTrigger = ref(0); // 用于触发响应式更新

// 代币名称映射（用于覆盖链上显示的名称）
const tokenNameMapping: Record<string, { name: string; symbol: string }> = {
  '0x8516fc284aeeaa0374e66037bd2309349ff728ea': { // BSC Testnet BUSD -> 显示为 BUSD
    name: 'BUSD Token',
    symbol: 'BUSD'
  },
  '0x4be45c88db35383f713abc1adfa816200e0b8b56': { // BSC Testnet USDT - 真正的测试网 USDT
    name: 'Tether USD',
    symbol: 'USDT'
  }
};

// 可用的DEX列表
const availableDexs = computed(() => {
  const currentChainId = selectedChainId.value;
  const mapping = dexStore.chainDexMappings.find(m => m.chainId === currentChainId);
  
  if (mapping) {
    const dex = allDexConfigs.value.find(d => d.id === mapping.dexId);
    return dex ? [dex] : [];
  } else {
    return allDexConfigs.value;
  }
});

// 报价代币选项
const quoteTokenOptions = computed(() => {
  // 依赖 cacheUpdateTrigger 来触发更新
  cacheUpdateTrigger.value; // 读取以建立依赖关系
  
  const baseTokens = currentBaseTokens.value || [];
  return baseTokens.map(address => {
    const cached = tokenInfoCache.get(address.toLowerCase());
    if (cached) {
      return {
        address,
        display: `${cached.symbol} (${cached.name})`
      };
    }
    return {
      address,
      display: `${formatAddress(address)} (加载中...)`
    };
  });
});

// 是否可以查询
const canQuery = computed(() => {
  return selectedQuoteToken.value && tokenAddress.value && !isQuerying.value;
});

// 获取链配置
function getChainConfig() {
  if (selectedChainId.value === 97) return bscTestnet;
  if (selectedChainId.value === 56) return bsc;
  if (selectedChainId.value === 66) return okc;
  return bsc;
}

// 格式化地址
function formatAddress(address: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 获取代币信息
async function getTokenInfo(address: string, publicClient: any): Promise<{ name: string; symbol: string } | null> {
  const cacheKey = address.toLowerCase();
  if (tokenInfoCache.has(cacheKey)) {
    return tokenInfoCache.get(cacheKey)!;
  }

  try {
    const [nameResult, symbolResult] = await Promise.allSettled([
      publicClient.readContract({
        address: address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'name'
      }),
      publicClient.readContract({
        address: address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'symbol'
      })
    ]);

    const name = nameResult.status === 'fulfilled' ? nameResult.value : '';
    const symbol = symbolResult.status === 'fulfilled' ? symbolResult.value : '';

    // 如果两个都失败，返回 null
    if (!name && !symbol) {
      console.warn(`无法获取代币信息 ${address}: name 和 symbol 都失败`);
      // 即使失败也缓存一个默认值，避免重复查询
      const defaultInfo = {
        name: 'Unknown Token',
        symbol: formatAddress(address).toUpperCase()
      };
      tokenInfoCache.set(cacheKey, defaultInfo);
      cacheUpdateTrigger.value++; // 触发响应式更新
      return defaultInfo;
    }

    let info = {
      name: name || 'Unknown Token',
      symbol: symbol || formatAddress(address).toUpperCase()
    };
    
    // 检查是否有名称映射，如果有则覆盖
    const mapping = tokenNameMapping[cacheKey];
    if (mapping) {
      info = {
        name: mapping.name,
        symbol: mapping.symbol
      };
      console.log(`应用代币名称映射: ${address} -> ${info.symbol} (${info.name})`);
    }
    
    tokenInfoCache.set(cacheKey, info);
    cacheUpdateTrigger.value++; // 触发响应式更新
    console.log(`成功加载代币信息: ${address} -> ${info.symbol} (${info.name})`);
    return info;
  } catch (error) {
    console.error(`获取代币信息失败 ${address}:`, error);
    // 即使失败也缓存一个默认值
    const defaultInfo = {
      name: 'Unknown Token',
      symbol: formatAddress(address).toUpperCase()
    };
    tokenInfoCache.set(cacheKey, defaultInfo);
    cacheUpdateTrigger.value++; // 触发响应式更新
    console.log(`设置默认代币信息: ${address} -> ${defaultInfo.symbol} (${defaultInfo.name})`);
    return defaultInfo;
  }
}

// 加载所有基准币信息
async function loadBaseTokenInfos() {
  const baseTokens = currentBaseTokens.value || [];
  if (baseTokens.length === 0) {
    console.log('基准币列表为空，跳过加载');
    return;
  }

  const chain = chains.value.find(c => c.id === selectedChainId.value);
  if (!chain) {
    console.log('未找到选中的公链，跳过加载');
    return;
  }

  console.log(`开始加载 ${baseTokens.length} 个基准币信息...`);

  const publicClient = createPublicClient({
    chain: getChainConfig(),
    transport: http(chain.rpc)
  });

  // 并行加载所有基准币信息
  const results = await Promise.allSettled(
    baseTokens.map(address => {
      const cacheKey = address.toLowerCase();
      if (!tokenInfoCache.has(cacheKey)) {
        return getTokenInfo(address, publicClient);
      }
      return Promise.resolve(tokenInfoCache.get(cacheKey)!);
    })
  );

  // 检查加载结果并触发最终更新
  const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
  console.log(`基准币信息加载完成: ${successCount}/${baseTokens.length} 成功`);
  
  // 确保所有更新都完成后触发一次响应式更新
  cacheUpdateTrigger.value++;
}

// 公链变化
async function onChainChange() {
  stopUpdate();
  chainStore.selectedChainId = selectedChainId.value;
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  if (chain) {
    chainStore.rpcUrl = chain.rpc;
  }
  dexStore.setDexByChainId(selectedChainId.value);
  selectedDexIdLocal.value = selectedDexId.value;
  selectedQuoteToken.value = '';
  tokenAddress.value = '';
  currentPrice.value = null;
  errorMessage.value = '';
  tokenInfoCache.clear();
  cacheUpdateTrigger.value++; // 触发响应式更新
  
  // 加载新的基准币信息
  await loadBaseTokenInfos();
}

// DEX变化
async function onDexChange() {
  stopUpdate();
  dexStore.setDex(selectedDexIdLocal.value);
  selectedQuoteToken.value = '';
  currentPrice.value = null;
  errorMessage.value = '';
  
  // 加载新的基准币信息
  await loadBaseTokenInfos();
}

// 报价代币变化
function onQuoteTokenChange() {
  stopUpdate();
  currentPrice.value = null;
  errorMessage.value = '';
}

// 代币地址变化
function onTokenAddressChange() {
  stopUpdate();
  currentPrice.value = null;
  errorMessage.value = '';
}

// 查询资金池
async function queryPool() {
  if (!canQuery.value) return;

  stopUpdate();
  isQuerying.value = true;
  errorMessage.value = '';

  try {
    const chain = chains.value.find(c => c.id === selectedChainId.value);
    if (!chain) {
      throw new Error('未找到选中的公链');
    }

    const publicClient = createPublicClient({
      chain: getChainConfig(),
      transport: http(chain.rpc)
    });

    // 获取代币信息
    const tokenInfo = await getTokenInfo(tokenAddress.value, publicClient);
    const quoteTokenInfo = await getTokenInfo(selectedQuoteToken.value, publicClient);
    
    if (tokenInfo) {
      tokenSymbol.value = tokenInfo.symbol;
    } else {
      tokenSymbol.value = 'TOKEN';
    }
    
    if (quoteTokenInfo) {
      quoteTokenSymbol.value = quoteTokenInfo.symbol;
    } else {
      quoteTokenSymbol.value = 'QUOTE';
    }

    // 创建价格计算器
    const calculator = new PriceCalculator(
      chain.rpc,
      currentFactoryAddress.value,
      currentBaseTokens.value,
      currentRouterAddress.value,
      selectedChainId.value
    );

    // 查找交易对（直接使用用户选择的报价代币）
    const pairInfo = await calculator.findTokenPair(tokenAddress.value, selectedQuoteToken.value);

    if (!pairInfo) {
      throw new Error('未找到交易对，请确认代币地址和报价代币是否正确');
    }

    // 如果是路由价格，显示路由信息
    if (pairInfo.isRouted && pairInfo.routePath) {
      console.log(`价格通过路由计算: ${pairInfo.routePath.map(addr => addr.slice(0, 6)).join(' → ')}`);
      isRoutedPrice.value = true;
      routePathDisplay.value = pairInfo.routePath;
    } else {
      isRoutedPrice.value = false;
      routePathDisplay.value = [];
    }

    // 计算并显示价格
    updatePriceDisplay(pairInfo.price);

    // 开始实时更新
    startRealTimeUpdate(calculator, tokenAddress.value);

  } catch (error: any) {
    console.error('查询资金池失败:', error);
    errorMessage.value = error.message || '查询失败，请重试';
    currentPrice.value = null;
    priceDisplay.value = '';
  } finally {
    isQuerying.value = false;
  }
}

// 更新价格显示
function updatePriceDisplay(price: number) {
  currentPrice.value = price;
  priceDisplay.value = `${quoteTokenSymbol.value}/${tokenSymbol.value}`;
  lastUpdateTime.value = new Date().toLocaleTimeString();
}

// 开始实时更新
function startRealTimeUpdate(calculator: PriceCalculator, tokenAddr: string) {
  stopUpdate();
  isUpdating.value = true;
  errorMessage.value = '';

  // 立即执行一次
  updatePrice(calculator, tokenAddr);

  // 每3秒更新一次
  updateInterval.value = window.setInterval(async () => {
    // 每次更新时重新创建calculator，确保使用最新的链配置
    const chain = chains.value.find(c => c.id === selectedChainId.value);
    if (!chain) {
      errorMessage.value = '未找到选中的公链';
      stopUpdate();
      return;
    }

    const freshCalculator = new PriceCalculator(
      chain.rpc,
      currentFactoryAddress.value,
      currentBaseTokens.value,
      currentRouterAddress.value,
      selectedChainId.value
    );
    
    await updatePrice(freshCalculator, tokenAddr);
  }, 3000);
}

// 更新价格
async function updatePrice(calculator: PriceCalculator, tokenAddr: string) {
  try {
    // 使用用户选择的报价代币查找交易对
    const pairInfo = await calculator.findTokenPair(tokenAddr, selectedQuoteToken.value);

    if (!pairInfo) {
      errorMessage.value = '未找到交易对，继续重试...';
      return;
    }

    // 更新路由状态
    if (pairInfo.isRouted && pairInfo.routePath) {
      isRoutedPrice.value = true;
      routePathDisplay.value = pairInfo.routePath;
    } else {
      isRoutedPrice.value = false;
      routePathDisplay.value = [];
    }

    updatePriceDisplay(pairInfo.price);
    errorMessage.value = '';
  } catch (error: any) {
    console.error('更新价格失败:', error);
    errorMessage.value = `更新失败: ${error.message || '未知错误'}，继续重试...`;
  }
}

// 停止更新
function stopUpdate() {
  if (updateInterval.value !== null) {
    clearInterval(updateInterval.value);
    updateInterval.value = null;
  }
  isUpdating.value = false;
}

// 监听公链和DEX变化
watch([selectedChainId, selectedDexIdLocal, selectedQuoteToken, () => tokenAddress.value], () => {
  stopUpdate();
});

// 组件卸载时清理
onUnmounted(() => {
  stopUpdate();
});

// 初始化
onMounted(async () => {
  selectedChainId.value = chainStore.selectedChainId;
  selectedDexIdLocal.value = selectedDexId.value;
  
  // 等待下一个 tick，确保 DEX 已经初始化
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // 加载基准币信息
  await loadBaseTokenInfos();
});

// 监听基准币列表变化，自动加载信息
watch(currentBaseTokens, async (newTokens, oldTokens) => {
  // 只有当列表变化且不为空时才加载
  if (newTokens && newTokens.length > 0 && newTokens !== oldTokens) {
    await loadBaseTokenInfos();
  }
}, { immediate: false });

// 监听 DEX 变化，自动加载信息
watch(selectedDexIdLocal, async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  await loadBaseTokenInfos();
});
</script>

