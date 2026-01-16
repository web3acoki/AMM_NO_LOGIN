<template>
  <form @submit.prevent>
    <!-- 代币合约和池子信息 -->
    <div class="mb-3">
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
          <label class="form-label">买入花费 (卖出得到) 代币</label>
          <select class="form-select" v-model="spendToken">
            <option :value="currentGovernanceToken">{{ currentGovernanceToken }}</option>
            <option value="USDT">USDT</option>
            <option value="USDC">USDC</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 买入概率 -->
    <div class="mb-3">
      <label class="form-label">买入概率</label>
      <input type="number" min="0" max="100" class="form-control" v-model.number="buyProb" />
      <div class="small text-muted mt-1">
        例如填写80,钱包有80%概率执行买入交易,20%概率执行卖出交易
      </div>
    </div>

    <!-- 买入计算方式 -->
    <div class="mb-3">
      <h6 class="fw-semibold mb-2">买入计算方式</h6>
      <div class="mb-2">
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="amountMode" value="amount" v-model="buyCalculationMode" />
          <label class="form-check-label" for="amountMode">金额</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="quantityMode" value="quantity" v-model="buyCalculationMode" />
          <label class="form-check-label" for="quantityMode">数量</label>
        </div>
      </div>
      <div class="small text-muted mb-2">
        例如填写100-100,每次交易钱包花费100 {{ currentGovernanceToken }}买入代币
      </div>
      <div class="row g-2">
        <div class="col-6">
          <label class="form-label">买入金额</label>
          <input type="number" class="form-control" v-model.number="buyAmount" />
        </div>
      </div>
    </div>

    <!-- 卖出计算方式 -->
    <div class="mb-3">
      <h6 class="fw-semibold mb-2">卖出计算方式</h6>
      <div class="mb-2">
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="sellAmountMode" value="amount" v-model="sellCalculationMode" />
          <label class="form-check-label" for="sellAmountMode">金额</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="sellQuantityMode" value="quantity" v-model="sellCalculationMode" />
          <label class="form-check-label" for="sellQuantityMode">数量</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="sellPercentMode" value="percent" v-model="sellCalculationMode" />
          <label class="form-check-label" for="sellPercentMode">百分比</label>
        </div>
      </div>
      <div class="small text-muted mb-2">
        例如填写100-100,每次交易钱包得到100{{ currentGovernanceToken }}
      </div>
      <div class="row g-2">
        <div class="col-6">
          <label class="form-label">卖出金额</label>
          <input type="number" class="form-control" v-model.number="sellAmount" />
        </div>
      </div>
    </div>

    <!-- 交易频率 -->
    <div class="mb-3">
      <label class="form-label">交易频率(秒)</label>
      <input type="number" class="form-control" v-model.number="frequencySec" />
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
import { ref, watch } from 'vue';
import { useChainStore } from '../../../stores/chainStore';
import { storeToRefs } from 'pinia';

const chainStore = useChainStore();
const { currentGovernanceToken } = storeToRefs(chainStore);

// 代币合约和池子信息
const tokenContract = ref<string>('');
const poolType = ref<string>('');
const spendToken = ref<string>('');

// 监听治理代币变化，自动更新默认值
watch(currentGovernanceToken, (newToken) => {
  poolType.value = newToken;
  spendToken.value = newToken;
}, { immediate: true });

// 买入概率
const buyProb = ref<number>(80);

// 买入计算方式
const buyCalculationMode = ref<'amount' | 'quantity'>('amount');
const buyAmount = ref<number>(100);

// 卖出计算方式
const sellCalculationMode = ref<'amount' | 'quantity' | 'percent'>('amount');
const sellAmount = ref<number>(100);

// 交易频率
const frequencySec = ref<number>(1);

function startTrading() {
  console.log('开始刷量交易', {
    tokenContract: tokenContract.value,
    poolType: poolType.value,
    spendToken: spendToken.value,
    buyProb: buyProb.value,
    buyCalculationMode: buyCalculationMode.value,
    buyAmountMin: buyAmountMin.value,
    buyAmountMax: buyAmountMax.value,
    sellCalculationMode: sellCalculationMode.value,
    sellAmountMin: sellAmountMin.value,
    sellAmountMax: sellAmountMax.value,
    frequencyMin: frequencyMin.value,
    frequencyMax: frequencyMax.value,
  });
}

function pauseTrading() {
  console.log('暂停交易');
}

function clearLogs() {
  console.log('清空日志');
}
</script>

