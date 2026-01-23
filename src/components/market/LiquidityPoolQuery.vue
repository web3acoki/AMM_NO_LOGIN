<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h2 class="h6 mb-0">网络与代币设置</h2>
    </div>

    <div class="row g-3">
      <!-- 第一行：链 + RPC + 交易所 -->
      <div class="col-12 col-md-4">
        <label class="form-label small">公链</label>
        <select class="form-select form-select-sm" v-model="selectedChainId" @change="onChainChange">
          <option v-for="c in chains" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="col-12 col-md-4">
        <label class="form-label small d-flex justify-content-between align-items-center">
          <span>RPC节点</span>
          <button
            class="btn btn-link btn-sm p-0 text-decoration-none"
            @click="useCustomRpc = !useCustomRpc"
          >
            {{ useCustomRpc ? '选择预设' : '自定义' }}
          </button>
        </label>
        <div v-if="useCustomRpc" class="input-group input-group-sm">
          <input
            type="text"
            class="form-control form-control-sm"
            v-model="customRpcUrl"
            placeholder="https://..."
            @change="onCustomRpcChange"
          />
          <button class="btn btn-outline-secondary" type="button" @click="testRpcConnection" :disabled="!customRpcUrl || isTestingRpc">
            <i class="bi me-1" :class="isTestingRpc ? 'bi-hourglass-split' : 'bi-lightning'"></i>
            {{ isTestingRpc ? '测试中' : '连接' }}
          </button>
        </div>
        <select v-else class="form-select form-select-sm" v-model="selectedRpcUrl" @change="onRpcChange">
          <option v-for="opt in currentRpcOptions" :key="opt.url" :value="opt.url">
            {{ opt.name }} ({{ formatRpcUrl(opt.url) }})
          </option>
        </select>
        <div v-if="rpcTestResult" class="small mt-1" :class="rpcTestResult.success ? 'text-success' : 'text-danger'">
          {{ rpcTestResult.message }}
        </div>
      </div>
      <div class="col-12 col-md-4">
        <label class="form-label small">交易所</label>
        <select class="form-select form-select-sm" v-model="selectedDexIdLocal" @change="onDexChange">
          <option v-for="dex in availableDexs" :key="dex.id" :value="dex.id">{{ dex.name }}</option>
        </select>
      </div>

      <!-- 第二行：报价代币 + 代币地址 -->
      <div class="col-12 col-md-6">
        <label class="form-label small">报价代币</label>
        <select class="form-select form-select-sm" v-model="selectedQuoteToken" @change="onQuoteTokenChange">
          <option value="">请选择报价代币</option>
          <option v-for="token in quoteTokenOptions" :key="token.address" :value="token.address">
            {{ token.display }}
          </option>
        </select>
      </div>
      <div class="col-12 col-md-6">
        <label class="form-label small">目标代币地址</label>
        <input
          class="form-control form-control-sm"
          v-model="tokenAddress"
          placeholder="0x..."
          @input="onTokenAddressChange"
        />
      </div>

      <!-- 第三行：查询按钮 + 钱包操作 -->
      <div class="col-12">
        <div class="d-flex gap-2 flex-wrap">
          <button
            class="btn btn-primary btn-sm"
            @click="queryPool"
            :disabled="!canQuery || isQuerying"
          >
            <i class="bi bi-search me-1"></i>
            {{ isQuerying ? '查询中...' : '查询价格' }}
          </button>
        </div>
      </div>

      <!-- 价格显示 -->
      <div v-if="currentPrice !== null" class="col-12">
        <div class="card border-success">
          <div class="card-body py-2">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <div class="small text-muted">当前价格 ({{ priceDisplay }})</div>
                <div class="h5 mb-0 text-success font-monospace">{{ currentPrice !== null ? formatPriceFull(currentPrice) : '-' }}</div>
                <div v-if="marketCap !== null" class="mt-1">
                  <span class="small text-muted">市值: </span>
                  <span class="text-primary fw-bold">{{ formatMarketCap(marketCap) }} {{ quoteTokenSymbol }}</span>
                </div>
                <div class="mt-1">
                  <small class="text-muted">{{ lastUpdateTime }}</small>
                  <span v-if="isRoutedPrice" class="badge bg-info ms-2">路由</span>
                </div>
              </div>
              <div class="d-flex gap-2">
                <button
                  class="btn btn-outline-danger btn-sm"
                  @click="handleStopUpdate"
                  v-if="isUpdating"
                >
                  <i class="bi bi-stop-circle me-1"></i>停止
                </button>
                <button
                  class="btn btn-sm"
                  :class="isTargetToken ? 'btn-success' : 'btn-outline-primary'"
                  @click="setAsTargetToken"
                  :disabled="!tokenSymbol"
                >
                  <i class="bi me-1" :class="isTargetToken ? 'bi-check-circle' : 'bi-crosshair'"></i>
                  {{ isTargetToken ? '已设为目标' : '设为目标' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 目标代币显示（始终显示，不受查询状态影响） -->
      <div v-if="targetToken" class="col-12">
        <div class="alert alert-success py-2 mb-0 small d-flex justify-content-between align-items-center">
          <span>
            <i class="bi bi-crosshair me-1"></i>
            当前目标代币: <strong>{{ targetToken.symbol }}</strong> ({{ targetToken.name }})
            <code class="ms-2 text-muted">{{ formatAddress(targetToken.address) }}</code>
          </span>
          <button class="btn btn-outline-danger btn-sm" @click="clearTargetToken">
            <i class="bi bi-x-lg me-1"></i>清除
          </button>
        </div>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMessage" class="col-12">
        <div class="alert alert-warning alert-dismissible fade show py-2 mb-0 small" role="alert">
          <i class="bi bi-exclamation-triangle me-1"></i>
          {{ errorMessage }}
          <button type="button" class="btn-close" style="padding: 0.5rem;" @click="errorMessage = ''" aria-label="Close"></button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useChainStore } from '../../stores/chainStore';
import { useDexStore } from '../../stores/dexStore';
import { useWalletStore } from '../../stores/walletStore';
import { PriceCalculator, type TokenPair } from '../../utils/priceCalculator';
import { createPublicClient, http, keccak256, encodePacked, getAddress } from 'viem';
import { erc20Abi } from '../../viem/abis/erc20';
import { factoryAbi } from '../../viem/abis/factory';
import { pairAbi } from '../../viem/abis/pair';
import { bscTestnet, bsc, okc } from 'viem/chains';

const chainStore = useChainStore();
const dexStore = useDexStore();
const walletStore = useWalletStore();

const { chains, rpcUrl } = storeToRefs(chainStore);
const { localWallets, targetToken, poolQueryState } = storeToRefs(walletStore);
const {
  currentDex,
  currentDexName,
  currentFactoryAddress,
  currentRouterAddress,
  currentBaseTokens,
  selectedDexId,
  allDexConfigs
} = storeToRefs(dexStore);

// 状态 - 链和DEX相关（本地状态）
const selectedChainId = ref<number>(chainStore.selectedChainId);
const selectedRpcUrl = ref<string>(rpcUrl.value);
const selectedDexIdLocal = ref<string>(selectedDexId.value);

// 使用全局状态的计算属性
const currentPrice = computed({
  get: () => poolQueryState.value.currentPrice,
  set: (val) => walletStore.updatePoolQueryState({ currentPrice: val })
});
const marketCap = computed({
  get: () => poolQueryState.value.marketCap,
  set: (val) => walletStore.updatePoolQueryState({ marketCap: val })
});
const priceDisplay = computed({
  get: () => poolQueryState.value.priceDisplay,
  set: (val) => walletStore.updatePoolQueryState({ priceDisplay: val })
});
const isUpdating = computed({
  get: () => poolQueryState.value.isUpdating,
  set: (val) => walletStore.updatePoolQueryState({ isUpdating: val })
});
const lastUpdateTime = computed({
  get: () => poolQueryState.value.lastUpdateTime,
  set: (val) => walletStore.updatePoolQueryState({ lastUpdateTime: val })
});
const isRoutedPrice = computed({
  get: () => poolQueryState.value.isRoutedPrice,
  set: (val) => walletStore.updatePoolQueryState({ isRoutedPrice: val })
});
const quoteTokenSymbol = computed({
  get: () => poolQueryState.value.quoteTokenSymbol,
  set: (val) => walletStore.updatePoolQueryState({ quoteTokenSymbol: val })
});
const selectedQuoteToken = computed({
  get: () => poolQueryState.value.selectedQuoteToken,
  set: (val) => walletStore.updatePoolQueryState({ selectedQuoteToken: val })
});
const tokenAddress = computed({
  get: () => poolQueryState.value.tokenAddress,
  set: (val) => walletStore.updatePoolQueryState({ tokenAddress: val })
});
const tokenSymbol = computed({
  get: () => poolQueryState.value.tokenSymbol,
  set: (val) => walletStore.updatePoolQueryState({ tokenSymbol: val })
});
const tokenName = computed({
  get: () => poolQueryState.value.tokenName,
  set: (val) => walletStore.updatePoolQueryState({ tokenName: val })
});
const tokenDecimals = computed({
  get: () => poolQueryState.value.tokenDecimals,
  set: (val) => walletStore.updatePoolQueryState({ tokenDecimals: val })
});

// 本地状态（不需要跨页面共享）
const isQuerying = ref<boolean>(false);
const errorMessage = ref<string>('');
const routePathDisplay = ref<string[]>([]);
const updateInterval = ref<number | null>(null);

// 自定义RPC相关
const useCustomRpc = ref<boolean>(false);
const customRpcUrl = ref<string>('');
const isTestingRpc = ref<boolean>(false);
const rpcTestResult = ref<{ success: boolean; message: string } | null>(null);

// 获取当前链的RPC选项
const currentRpcOptions = computed(() => {
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  return chain?.rpcOptions || [];
});

// 格式化RPC URL显示（只显示域名部分）
function formatRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url;
  }
}

// 格式化价格，显示完整小数位（不截断）
function formatPriceFull(price: number): string {
  if (price === 0) return '0';
  if (price >= 1) {
    return price.toFixed(8).replace(/\.?0+$/, '');
  }
  // 对于小数，转为字符串避免科学计数法
  const str = price.toFixed(30);
  // 去除末尾的0，但保留有效数字
  return str.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

// 格式化市值显示（直接显示BNB数值）
function formatMarketCap(value: number): string {
  if (value >= 1000) {
    return value.toFixed(2);
  } else if (value >= 1) {
    return value.toFixed(4);
  } else {
    return value.toFixed(6);
  }
}

// 格式化总供应量显示（大数用简写）
function formatSupply(value: number): string {
  if (value >= 1e12) {
    return (value / 1e12).toFixed(2) + 'T';
  } else if (value >= 1e9) {
    return (value / 1e9).toFixed(2) + 'B';
  } else if (value >= 1e6) {
    return (value / 1e6).toFixed(2) + 'M';
  } else if (value >= 1e3) {
    return (value / 1e3).toFixed(2) + 'K';
  } else {
    return value.toFixed(2);
  }
}

// 停止更新处理函数
function handleStopUpdate() {
  stopUpdate();
  currentPrice.value = null;
  marketCap.value = null;
}

// 多个 DEX 的 Factory 配置
const DEX_CONFIGS = [
  {
    name: 'PancakeSwap V2',
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    initCodeHash: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5'
  },
  {
    name: 'PancakeSwap V2 (alt)',
    factory: '0xcA143Ce0Fe65960E6Aa4D42C8D3cE161c2B6604f',
    initCodeHash: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5'
  },
  {
    name: 'BiSwap',
    factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
    initCodeHash: '0xfea293c909d87cd4153593f077b76bb7e94340200f4ee84211ae8e4f9bd7ffdf'
  },
  {
    name: 'ApeSwap',
    factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
    initCodeHash: '0xf4ccce374816856d11f00e4069e7cada164065686fbef53c6167a63ec2fd8c5b'
  },
  {
    name: 'BabySwap',
    factory: '0x86407bEa2078ea5f5EB5A52B2caA963bC1F889Da',
    initCodeHash: '0x48c8bec5512d397a5d512fbb7d83d515e7b6d91e9838730e97ab59429f581697'
  },
  {
    name: 'MDEX',
    factory: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
    initCodeHash: '0x0d994d996174b05cfc7bed897dc1b20b4c458fc8d64fe98bc78b3c64a6b4d093'
  },
];

// 计算池子地址
function computePairAddress(factoryAddr: string, tokenA: string, tokenB: string, initCodeHash: string): string {
  const factory = getAddress(factoryAddr);
  const addrA = getAddress(tokenA);
  const addrB = getAddress(tokenB);

  const [token0, token1] = addrA.toLowerCase() < addrB.toLowerCase()
    ? [addrA, addrB]
    : [addrB, addrA];

  const salt = keccak256(encodePacked(['address', 'address'], [token0 as `0x${string}`, token1 as `0x${string}`]));

  const addr = keccak256(
    encodePacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factory as `0x${string}`, salt, initCodeHash as `0x${string}`]
    )
  );

  return getAddress('0x' + addr.slice(-40));
}

// 尝试多个 DEX 找到有效的池子地址
async function findValidPairAddress(
  client: any,
  tokenA: string,
  tokenB: string
): Promise<{ pairAddress: string; dexName: string } | null> {
  for (const dex of DEX_CONFIGS) {
    const pairAddress = computePairAddress(dex.factory, tokenA, tokenB, dex.initCodeHash);

    try {
      const reserves = await client.readContract({
        address: pairAddress as `0x${string}`,
        abi: pairAbi,
        functionName: 'getReserves'
      });

      if (reserves && (reserves[0] > 0n || reserves[1] > 0n)) {
        console.log(`找到有效池子 [${dex.name}]: ${pairAddress}`);
        return { pairAddress, dexName: dex.name };
      }
    } catch {
      // 继续尝试下一个
    }
  }
  console.log('所有 DEX 都未找到有效池子');
  return null;
}

// 格式化价格，避免科学计数法
function formatPrice(price: number): string {
  if (price === 0) return '0';
  const str = price.toFixed(20);
  const trimmed = str.replace(/\.?0+$/, '');
  if (price < 0.000001) {
    const match = str.match(/0\.(0*)([1-9])/);
    if (match) {
      const zeros = match[1].length;
      return price.toFixed(zeros + 6).replace(/0+$/, '');
    }
  }
  return trimmed;
}

// 设置为目标代币
function setAsTargetToken() {
  if (!tokenAddress.value || !tokenSymbol.value) {
    alert('请先查询代币信息');
    return;
  }
  walletStore.setTargetToken({
    address: tokenAddress.value,
    symbol: tokenSymbol.value,
    name: tokenName.value || tokenSymbol.value,
    decimals: tokenDecimals.value
  });
  alert(`已将 ${tokenSymbol.value} 设置为目标代币`);
}

// 清除目标代币
function clearTargetToken() {
  walletStore.clearTargetToken();
}

// 是否已设置为目标代币
const isTargetToken = computed(() => {
  return walletStore.targetToken?.address?.toLowerCase() === tokenAddress.value?.toLowerCase();
});

// 代币信息缓存
const tokenInfoCache = new Map<string, { name: string; symbol: string }>();
const cacheUpdateTrigger = ref(0);

const tokenNameMapping: Record<string, { name: string; symbol: string }> = {
  '0x8516fc284aeeaa0374e66037bd2309349ff728ea': { name: 'BUSD Token', symbol: 'BUSD' },
  '0x4be45c88db35383f713abc1adfa816200e0b8b56': { name: 'Tether USD', symbol: 'USDT' }
};

// 可用的DEX列表
const availableDexs = computed(() => {
  const currentChainId = selectedChainId.value;
  const mapping = dexStore.chainDexMappings.find(m => m.chainId === currentChainId);
  if (mapping) {
    const dex = allDexConfigs.value.find(d => d.id === mapping.dexId);
    return dex ? [dex] : [];
  }
  return allDexConfigs.value;
});

// 报价代币选项
const quoteTokenOptions = computed(() => {
  cacheUpdateTrigger.value;
  const baseTokens = currentBaseTokens.value || [];
  return baseTokens.map(address => {
    const cached = tokenInfoCache.get(address.toLowerCase());
    if (cached) {
      return { address, display: `${cached.symbol} (${cached.name})` };
    }
    return { address, display: `${formatAddress(address)} (加载中...)` };
  });
});

const canQuery = computed(() => {
  return selectedQuoteToken.value && tokenAddress.value && !isQuerying.value;
});

function getChainConfig() {
  if (selectedChainId.value === 97) return bscTestnet;
  if (selectedChainId.value === 56) return bsc;
  if (selectedChainId.value === 66) return okc;
  return bsc;
}

function formatAddress(address: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function getTokenInfo(address: string, publicClient: any): Promise<{ name: string; symbol: string } | null> {
  const cacheKey = address.toLowerCase();
  if (tokenInfoCache.has(cacheKey)) {
    return tokenInfoCache.get(cacheKey)!;
  }
  try {
    const [nameResult, symbolResult] = await Promise.allSettled([
      publicClient.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'name' }),
      publicClient.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'symbol' })
    ]);
    const name = nameResult.status === 'fulfilled' ? nameResult.value : '';
    const symbol = symbolResult.status === 'fulfilled' ? symbolResult.value : '';
    if (!name && !symbol) {
      const defaultInfo = { name: 'Unknown Token', symbol: formatAddress(address).toUpperCase() };
      tokenInfoCache.set(cacheKey, defaultInfo);
      cacheUpdateTrigger.value++;
      return defaultInfo;
    }
    let info = { name: name || 'Unknown Token', symbol: symbol || formatAddress(address).toUpperCase() };
    const mapping = tokenNameMapping[cacheKey];
    if (mapping) info = { name: mapping.name, symbol: mapping.symbol };
    tokenInfoCache.set(cacheKey, info);
    cacheUpdateTrigger.value++;
    return info;
  } catch (error) {
    const defaultInfo = { name: 'Unknown Token', symbol: formatAddress(address).toUpperCase() };
    tokenInfoCache.set(cacheKey, defaultInfo);
    cacheUpdateTrigger.value++;
    return defaultInfo;
  }
}

async function loadBaseTokenInfos() {
  const baseTokens = currentBaseTokens.value || [];
  if (baseTokens.length === 0) return;
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  if (!chain) return;
  const publicClient = createPublicClient({ chain: getChainConfig(), transport: http(chain.rpc) });
  await Promise.allSettled(baseTokens.map(address => {
    const cacheKey = address.toLowerCase();
    if (!tokenInfoCache.has(cacheKey)) return getTokenInfo(address, publicClient);
    return Promise.resolve(tokenInfoCache.get(cacheKey)!);
  }));
  cacheUpdateTrigger.value++;
}

async function onChainChange() {
  stopUpdate();
  chainStore.selectedChainId = selectedChainId.value;
  // 同步更新 walletStore 的链ID
  walletStore.setCurrentChainId(selectedChainId.value);
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  if (chain) {
    // 设置第一个RPC选项
    if (chain.rpcOptions && chain.rpcOptions.length > 0) {
      selectedRpcUrl.value = chain.rpcOptions[0].url;
      chainStore.rpcUrl = chain.rpcOptions[0].url;
    } else {
      selectedRpcUrl.value = chain.rpc;
      chainStore.rpcUrl = chain.rpc;
    }
  }
  dexStore.setDexByChainId(selectedChainId.value);
  selectedDexIdLocal.value = selectedDexId.value;
  tokenAddress.value = '';
  currentPrice.value = null;
  marketCap.value = null;
  errorMessage.value = '';
  tokenInfoCache.clear();
  cacheUpdateTrigger.value++;
  await loadBaseTokenInfos();
  // 默认选择第一个报价代币（WBNB）
  if (currentBaseTokens.value && currentBaseTokens.value.length > 0) {
    selectedQuoteToken.value = currentBaseTokens.value[0];
  } else {
    selectedQuoteToken.value = '';
  }
}

function onRpcChange() {
  chainStore.rpcUrl = selectedRpcUrl.value;
  rpcTestResult.value = null;
  console.log('RPC切换到:', selectedRpcUrl.value);
}

// 自定义RPC变更
function onCustomRpcChange() {
  if (customRpcUrl.value) {
    chainStore.rpcUrl = customRpcUrl.value;
    selectedRpcUrl.value = customRpcUrl.value;
    rpcTestResult.value = null;
    console.log('使用自定义RPC:', customRpcUrl.value);
  }
}

// 测试RPC连接
async function testRpcConnection() {
  if (!customRpcUrl.value) return;

  isTestingRpc.value = true;
  rpcTestResult.value = null;

  try {
    const testClient = createPublicClient({
      transport: http(customRpcUrl.value)
    });

    const blockNumber = await testClient.getBlockNumber();
    rpcTestResult.value = {
      success: true,
      message: `连接成功，区块高度: ${blockNumber}`
    };
    // 测试成功后应用这个RPC
    chainStore.rpcUrl = customRpcUrl.value;
    selectedRpcUrl.value = customRpcUrl.value;
  } catch (error: any) {
    rpcTestResult.value = {
      success: false,
      message: `连接失败: ${error.message?.slice(0, 50) || '未知错误'}`
    };
  } finally {
    isTestingRpc.value = false;
  }
}

async function onDexChange() {
  stopUpdate();
  dexStore.setDex(selectedDexIdLocal.value);
  currentPrice.value = null;
  marketCap.value = null;
  errorMessage.value = '';
  await loadBaseTokenInfos();
  // 默认选择第一个报价代币（WBNB）
  if (currentBaseTokens.value && currentBaseTokens.value.length > 0) {
    selectedQuoteToken.value = currentBaseTokens.value[0];
  } else {
    selectedQuoteToken.value = '';
  }
}

function onQuoteTokenChange() {
  stopUpdate();
  currentPrice.value = null;
  marketCap.value = null;
  errorMessage.value = '';
}

function onTokenAddressChange() {
  stopUpdate();
  currentPrice.value = null;
  marketCap.value = null;
  errorMessage.value = '';
}

async function queryPool() {
  if (!canQuery.value) return;
  stopUpdate();
  isQuerying.value = true;
  errorMessage.value = '';
  try {
    const chain = chains.value.find(c => c.id === selectedChainId.value);
    if (!chain) throw new Error('未找到选中的公链');
    const publicClient = createPublicClient({ chain: getChainConfig(), transport: http(selectedRpcUrl.value || chain.rpc) });
    const tokenInfo = await getTokenInfo(tokenAddress.value, publicClient);
    const quoteTokenInfo = await getTokenInfo(selectedQuoteToken.value, publicClient);
    if (tokenInfo) {
      tokenSymbol.value = tokenInfo.symbol;
      tokenName.value = tokenInfo.name;
    } else {
      tokenSymbol.value = 'TOKEN';
      tokenName.value = 'Unknown Token';
    }
    try {
      const decimals = await publicClient.readContract({
        address: tokenAddress.value as `0x${string}`,
        abi: erc20Abi,
        functionName: 'decimals'
      });
      tokenDecimals.value = Number(decimals);
    } catch { tokenDecimals.value = 18; }
    if (quoteTokenInfo) quoteTokenSymbol.value = quoteTokenInfo.symbol;
    else quoteTokenSymbol.value = 'QUOTE';
    const calculator = new PriceCalculator(
      selectedRpcUrl.value || chain.rpc,
      currentFactoryAddress.value,
      currentBaseTokens.value,
      currentRouterAddress.value,
      selectedChainId.value
    );
    const pairInfo = await calculator.findTokenPair(tokenAddress.value, selectedQuoteToken.value);
    if (!pairInfo) throw new Error('未找到交易对，请确认代币地址和报价代币是否正确');
    if (pairInfo.isRouted && pairInfo.routePath) {
      isRoutedPrice.value = true;
      routePathDisplay.value = pairInfo.routePath;
    } else {
      isRoutedPrice.value = false;
      routePathDisplay.value = [];
    }

    // 计算市值：池子中报价代币（BNB）储备量 × 2
    try {
      let quoteReserve = BigInt(0);
      let token0Addr = pairInfo.token0.toLowerCase();

      // 如果 pairInfo 中储备量为 0，直接查询池子
      if (pairInfo.reserve0 === BigInt(0) && pairInfo.reserve1 === BigInt(0)) {
        console.log('pairInfo 储备量为 0，直接查询池子...');
        // 尝试多个 DEX 找到有效的池子地址
        const result = await findValidPairAddress(
          publicClient,
          tokenAddress.value,
          selectedQuoteToken.value
        );

        if (result) {
          console.log('找到有效池子地址:', result.pairAddress, '来自:', result.dexName);
          // 获取储备量
          const reserves = await publicClient.readContract({
            address: result.pairAddress as `0x${string}`,
            abi: pairAbi,
            functionName: 'getReserves'
          }) as [bigint, bigint, number];

          console.log('reserve0:', reserves[0].toString());
          console.log('reserve1:', reserves[1].toString());

          // 获取 token0 地址
          const t0 = await publicClient.readContract({
            address: result.pairAddress as `0x${string}`,
            abi: pairAbi,
            functionName: 'token0'
          }) as string;

          console.log('token0:', t0);
          token0Addr = t0.toLowerCase();
          const quoteTokenAddr = selectedQuoteToken.value.toLowerCase();

          if (token0Addr === quoteTokenAddr) {
            quoteReserve = reserves[0];
            console.log('quoteReserve = reserve0:', quoteReserve.toString());
          } else {
            quoteReserve = reserves[1];
            console.log('quoteReserve = reserve1:', quoteReserve.toString());
          }
        } else {
          console.log('未找到有效的池子地址');
        }
      } else {
        // 使用 pairInfo 中的储备量
        const quoteTokenAddr = selectedQuoteToken.value.toLowerCase();
        if (token0Addr === quoteTokenAddr) {
          quoteReserve = pairInfo.reserve0;
        } else {
          quoteReserve = pairInfo.reserve1;
        }
      }

      // 报价代币通常是18位小数
      const quoteDecimals = 18;
      const divisor = 10n ** BigInt(quoteDecimals);
      const quoteAmount = Number(quoteReserve) / Number(divisor);
      marketCap.value = quoteAmount;  // 市值 = 池子中 BNB 数量
      console.log('池子中 BNB 数量:', quoteAmount, quoteTokenSymbol.value);
    } catch (e) {
      console.error('计算市值失败:', e);
      marketCap.value = null;
    }

    updatePriceDisplay(pairInfo.price);
    startRealTimeUpdate(calculator, tokenAddress.value);
  } catch (error: any) {
    errorMessage.value = error.message || '查询失败，请重试';
    currentPrice.value = null;
    priceDisplay.value = '';
  } finally {
    isQuerying.value = false;
  }
}

function updatePriceDisplay(price: number) {
  currentPrice.value = price;
  priceDisplay.value = `${quoteTokenSymbol.value}/${tokenSymbol.value}`;
  lastUpdateTime.value = new Date().toLocaleTimeString();
}

function startRealTimeUpdate(calculator: PriceCalculator, tokenAddr: string) {
  stopUpdate();
  isUpdating.value = true;
  errorMessage.value = '';
  updatePrice(calculator, tokenAddr);
  updateInterval.value = window.setInterval(async () => {
    const chain = chains.value.find(c => c.id === selectedChainId.value);
    if (!chain) { stopUpdate(); return; }
    const freshCalculator = new PriceCalculator(
      selectedRpcUrl.value || chain.rpc,
      currentFactoryAddress.value,
      currentBaseTokens.value,
      currentRouterAddress.value,
      selectedChainId.value
    );
    await updatePrice(freshCalculator, tokenAddr);
  }, 3000);
}

async function updatePrice(calculator: PriceCalculator, tokenAddr: string) {
  try {
    const pairInfo = await calculator.findTokenPair(tokenAddr, selectedQuoteToken.value);
    if (!pairInfo) { errorMessage.value = '未找到交易对，继续重试...'; return; }
    if (pairInfo.isRouted && pairInfo.routePath) {
      isRoutedPrice.value = true;
      routePathDisplay.value = pairInfo.routePath;
    } else {
      isRoutedPrice.value = false;
      routePathDisplay.value = [];
    }

    // 更新市值
    try {
      let quoteReserve = BigInt(0);
      let token0Addr = pairInfo.token0.toLowerCase();

      // 如果 pairInfo 中储备量为 0，直接查询池子
      if (pairInfo.reserve0 === BigInt(0) && pairInfo.reserve1 === BigInt(0)) {
        const chain = chains.value.find(c => c.id === selectedChainId.value);
        if (chain) {
          const client = createPublicClient({ chain: getChainConfig(), transport: http(selectedRpcUrl.value || chain.rpc) });
          // 尝试多个 DEX 找到有效的池子地址
          const result = await findValidPairAddress(
            client,
            tokenAddr,
            selectedQuoteToken.value
          );

          if (result) {
            const reserves = await client.readContract({
              address: result.pairAddress as `0x${string}`,
              abi: pairAbi,
              functionName: 'getReserves'
            }) as [bigint, bigint, number];

            const t0 = await client.readContract({
              address: result.pairAddress as `0x${string}`,
              abi: pairAbi,
              functionName: 'token0'
            }) as string;

            token0Addr = t0.toLowerCase();
            const quoteTokenAddr = selectedQuoteToken.value.toLowerCase();
            if (token0Addr === quoteTokenAddr) {
              quoteReserve = reserves[0];
            } else {
              quoteReserve = reserves[1];
            }
          }
        }
      } else {
        const quoteTokenAddr = selectedQuoteToken.value.toLowerCase();
        if (token0Addr === quoteTokenAddr) {
          quoteReserve = pairInfo.reserve0;
        } else {
          quoteReserve = pairInfo.reserve1;
        }
      }

      const quoteDecimals = 18;
      const divisor = 10n ** BigInt(quoteDecimals);
      const quoteAmount = Number(quoteReserve) / Number(divisor);
      marketCap.value = quoteAmount;  // 市值 = 池子中 BNB 数量
    } catch {
      // 忽略市值计算错误
    }

    updatePriceDisplay(pairInfo.price);
    errorMessage.value = '';
  } catch (error: any) {
    errorMessage.value = `更新失败: ${error.message || '未知错误'}`;
  }
}

function stopUpdate() {
  if (updateInterval.value !== null) {
    clearInterval(updateInterval.value);
    updateInterval.value = null;
  }
  isUpdating.value = false;
}

watch([selectedChainId, selectedDexIdLocal, selectedQuoteToken, () => tokenAddress.value], () => {
  stopUpdate();
});

onUnmounted(() => {
  stopUpdate();
});

onMounted(async () => {
  selectedChainId.value = chainStore.selectedChainId;
  selectedRpcUrl.value = rpcUrl.value;
  selectedDexIdLocal.value = selectedDexId.value;
  // 同步 walletStore 的链ID
  walletStore.setCurrentChainId(chainStore.selectedChainId);
  await new Promise(resolve => setTimeout(resolve, 100));
  await loadBaseTokenInfos();

  // 默认选择第一个报价代币（WBNB）
  if (!selectedQuoteToken.value && currentBaseTokens.value && currentBaseTokens.value.length > 0) {
    selectedQuoteToken.value = currentBaseTokens.value[0];
  }

  // 全局状态已有数据时，不需要再初始化，直接使用
  // 如果有价格数据且没有在更新中，启动实时更新
  if (currentPrice.value !== null && tokenAddress.value && !isUpdating.value) {
    const chain = chains.value.find(c => c.id === selectedChainId.value);
    if (chain) {
      const calculator = new PriceCalculator(
        selectedRpcUrl.value || chain.rpc,
        currentFactoryAddress.value,
        currentBaseTokens.value,
        currentRouterAddress.value,
        selectedChainId.value
      );
      startRealTimeUpdate(calculator, tokenAddress.value);
    }
  }
});

// 当组件从 keep-alive 缓存中恢复时触发
onActivated(async () => {
  // 如果有价格数据且当前没有在更新中，恢复实时更新
  if (currentPrice.value !== null && tokenAddress.value && !isUpdating.value) {
    const chain = chains.value.find(c => c.id === selectedChainId.value);
    if (chain) {
      const calculator = new PriceCalculator(
        selectedRpcUrl.value || chain.rpc,
        currentFactoryAddress.value,
        currentBaseTokens.value,
        currentRouterAddress.value,
        selectedChainId.value
      );
      startRealTimeUpdate(calculator, tokenAddress.value);
    }
  }
});

watch(currentBaseTokens, async (newTokens, oldTokens) => {
  if (newTokens && newTokens.length > 0 && newTokens !== oldTokens) {
    await loadBaseTokenInfos();
  }
}, { immediate: false });

watch(selectedDexIdLocal, async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  await loadBaseTokenInfos();
});
</script>

