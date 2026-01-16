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
          <label class="form-label">卖出得到代币</label>
          <select class="form-select" v-model="sellToken">
            <option :value="currentGovernanceToken">{{ currentGovernanceToken }}</option>
            <option value="USDT">USDT</option>
            <option value="USDC">USDC</option>
          </select>
        </div>
        <div class="col-6">
          <label class="form-label">当前价格</label>
          <div class="input-group">
            <input type="number" class="form-control" v-model.number="currentPrice" />
            <button class="btn btn-outline-success" type="button">
              <i class="bi bi-currency-dollar"></i>
            </button>
            <button class="btn btn-outline-info" type="button">
              <i class="bi bi-clipboard"></i>
            </button>
          </div>
        </div>
        <div class="col-6">
          <label class="form-label">目标价格</label>
          <div class="input-group">
            <input type="number" class="form-control" v-model.number="targetPrice" placeholder="请输入目标价格" />
            <button class="btn btn-outline-info" type="button">
              <i class="bi bi-info-circle"></i>
            </button>
            <button class="btn btn-outline-success" type="button">
              <i class="bi bi-currency-dollar"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 卖出计算方式 -->
    <div class="mb-3">
      <h6 class="fw-semibold mb-2">卖出计算方式</h6>
      <div class="mb-2">
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="amountMode" value="amount" v-model="calculationMode" />
          <label class="form-check-label" for="amountMode">金额</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="quantityMode" value="quantity" v-model="calculationMode" />
          <label class="form-check-label" for="quantityMode">数量</label>
        </div>
        <div class="form-check form-check-inline">
          <input class="form-check-input" type="radio" id="percentMode" value="percent" v-model="calculationMode" />
          <label class="form-check-label" for="percentMode">百分比</label>
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
        <div class="col-6">
          <label class="form-label">交易频率(秒)</label>
          <input type="number" class="form-control" v-model.number="frequencySec" />
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
import { ref, watch } from 'vue';
import { useChainStore } from '../../../stores/chainStore';
import { storeToRefs } from 'pinia';

const chainStore = useChainStore();
const { currentGovernanceToken } = storeToRefs(chainStore);

// 代币合约和池子信息
const tokenContract = ref<string>('');
const poolType = ref<string>('');
const sellToken = ref<string>('');

// 监听治理代币变化，自动更新默认值
watch(currentGovernanceToken, (newToken) => {
  poolType.value = newToken;
  sellToken.value = newToken;
}, { immediate: true });
const currentPrice = ref<number>(0);
const targetPrice = ref<number>(0);

// 卖出计算方式
const calculationMode = ref<'amount' | 'quantity' | 'percent'>('amount');
const sellAmount = ref<number>(100);
const frequencySec = ref<number>(1);

function startTrading() {
  console.log('开始砸盘交易', {
    tokenContract: tokenContract.value,
    poolType: poolType.value,
    sellToken: sellToken.value,
    currentPrice: currentPrice.value,
    targetPrice: targetPrice.value,
    calculationMode: calculationMode.value,
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

