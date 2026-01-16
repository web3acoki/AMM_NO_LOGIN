<template>
  <form @submit.prevent>
    <!-- 代币合约和池子信息 -->
    <div class="mb-3">
      <h6 class="fw-semibold mb-2">代币合约和池子信息</h6>
      <div class="row g-2">
        <div class="col-12">
          <label class="form-label">代币合约地址</label>
          <input type="text" class="form-control" v-model="tokenContract" placeholder="0x..." />
        </div>
        <div class="col-6">
          <label class="form-label">池子类型</label>
          <select class="form-select" v-model="poolType">
            <option :value="currentGovernanceToken">{{ currentGovernanceToken }}</option>
            <option value="USDT">USDT</option>
            <option value="USDC">USDC</option>
          </select>
        </div>
        <div class="col-6">
          <label class="form-label">花费代币</label>
          <select class="form-select" v-model="spendToken">
            <option :value="currentGovernanceToken">{{ currentGovernanceToken }}</option>
            <option value="USDT">USDT</option>
            <option value="USDC">USDC</option>
          </select>
        </div>
        <div class="col-6">
          <label class="form-label">当前价格</label>
          <div class="input-group">
            <input type="number" class="form-control" v-model.number="currentPrice" :disabled="priceLoading" />
            <button class="btn btn-outline-secondary" type="button" @click="refreshPrice" :disabled="priceLoading">
              <i v-if="!priceLoading" class="bi bi-arrow-clockwise"></i>
              <span v-else class="spinner-border spinner-border-sm" role="status"></span>
            </button>
            <button class="btn btn-outline-info" type="button" @click="copyPrice">
              <i class="bi bi-clipboard"></i>
            </button>
          </div>
          <div v-if="pairInfo" class="form-text">
            <small class="text-success">
              <i class="bi bi-check-circle me-1"></i>
              交易对: {{ pairInfo.pairAddress.slice(0, 10) }}... | 基准币: {{ pairInfo.baseToken.slice(0, 10) }}...
            </small>
          </div>
        </div>
        <div class="col-6">
          <label class="form-label">目标价格</label>
          <div class="input-group">
            <input type="number" class="form-control" v-model.number="targetPrice" placeholder="请输入目标价格" />
            <button class="btn btn-outline-success" type="button">
              <i class="bi bi-check"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 买入计算方式 -->
    <div class="mb-3">
      <h6 class="fw-semibold mb-2">买入计算方式</h6>
      <div class="mb-2">
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="amountMode" value="amount" v-model="calculationMode" />
          <label class="form-check-label" for="amountMode">金额</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="quantityMode" value="quantity" v-model="calculationMode" />
          <label class="form-check-label" for="quantityMode">数量</label>
        </div>
      </div>
      <div class="small text-muted mb-2">
        例如填写100-100,每次交易钱包花费100 {{ currentGovernanceToken }} 买入代币
      </div>
      <div class="row g-2">
        <div class="col-6">
          <label class="form-label">买入金额</label>
          <input type="number" class="form-control" v-model.number="buyAmount" />
        </div>
        <div class="col-6">
          <label class="form-label">交易频率(秒)</label>
          <input type="number" class="form-control" v-model.number="frequencySec" />
        </div>
      </div>
    </div>

    <!-- 其他设置 -->
    <div class="mb-3">
      <h6 class="fw-semibold mb-2">下面其他设置(可不填,使用默认就好)</h6>
      <div class="row g-2">
        <div class="col-4">
          <label class="form-label">卖出代币最小阀值</label>
          <input type="number" step="0.001" class="form-control" v-model.number="minSellThreshold" />
        </div>
        <div class="col-4">
          <label class="form-label">单次转入{{ currentGovernanceToken }}数量</label>
          <input type="number" step="0.001" class="form-control" v-model.number="transferAmount" />
        </div>
        <div class="col-4">
          <label class="form-label">滑点(%)</label>
          <input type="number" class="form-control" v-model.number="slippage" />
        </div>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="d-flex gap-2">
      <button class="btn btn-primary" type="button" @click="startTrading">开始交易</button>
      <button class="btn btn-warning" type="button" @click="pauseTrading">暂停</button>
      <button class="btn btn-outline-secondary" type="button" @click="clearLogs">清空日志</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useChainStore } from '../../../stores/chainStore';
import { useDexStore } from '../../../stores/dexStore';
import { storeToRefs } from 'pinia';
import { PriceCalculator } from '../../../utils/priceCalculator';

const chainStore = useChainStore();
const dexStore = useDexStore();
const { currentGovernanceToken, selectedChainId, rpcUrl } = storeToRefs(chainStore);
const { currentFactoryAddress, currentBaseTokens } = storeToRefs(dexStore);

// 代币合约和池子信息
const tokenContract = ref<string>('');
const poolType = ref<string>('');
const spendToken = ref<string>('');

// 监听治理代币变化，自动更新默认值
watch(currentGovernanceToken, (newToken) => {
  poolType.value = newToken;
  spendToken.value = newToken;
}, { immediate: true });
const currentPrice = ref<number>(0);
const targetPrice = ref<number>(0);
const priceLoading = ref<boolean>(false);
const pairInfo = ref<any>(null);

// 买入计算方式
const calculationMode = ref<'amount' | 'quantity'>('amount');
const buyAmount = ref<number>(100);
const frequencySec = ref<number>(1);

// 其他设置
const minSellThreshold = ref<number>(0.001);
const transferAmount = ref<number>(0.05);
const slippage = ref<number>(30);

// 价格计算器实例
const priceCalculator = computed(() => {
  if (!rpcUrl.value || !currentFactoryAddress.value || !currentBaseTokens.value.length) {
    return null;
  }
  return new PriceCalculator(rpcUrl.value, currentFactoryAddress.value, currentBaseTokens.value);
});

async function refreshPrice() {
  if (!tokenContract.value || !priceCalculator.value) {
    alert('请先输入代币合约地址');
    return;
  }

  priceLoading.value = true;
  try {
    console.log('开始查找代币价格...');
    const pair = await priceCalculator.value.findTokenPair(tokenContract.value);
    
    if (pair) {
      pairInfo.value = pair;
      currentPrice.value = pair.price;
      console.log('找到交易对:', pair);
      console.log('当前价格:', pair.price);
    } else {
      alert('未找到该代币的交易对，请检查代币地址是否正确');
    }
  } catch (error) {
    console.error('获取价格失败:', error);
    alert('获取价格失败，请检查网络连接');
  } finally {
    priceLoading.value = false;
  }
}

function copyPrice() {
  if (currentPrice.value) {
    navigator.clipboard.writeText(currentPrice.value.toString());
    alert('价格已复制到剪贴板');
  }
}

function startTrading() {
  console.log('开始拉盘交易', {
    tokenContract: tokenContract.value,
    poolType: poolType.value,
    spendToken: spendToken.value,
    currentPrice: currentPrice.value,
    targetPrice: targetPrice.value,
    calculationMode: calculationMode.value,
    buyAmount: buyAmount.value,
    frequencySec: frequencySec.value,
    minSellThreshold: minSellThreshold.value,
    transferAmount: transferAmount.value,
    slippage: slippage.value,
    pairInfo: pairInfo.value,
  });
}

function pauseTrading() {
  console.log('暂停交易');
}

function clearLogs() {
  console.log('清空日志');
}
</script>

