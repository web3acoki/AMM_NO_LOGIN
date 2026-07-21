<template>
  <div class="card mb-3 border-warning">
    <div class="card-header bg-warning text-dark d-flex justify-content-between align-items-center">
      <span><i class="bi bi-cart-dash me-1"></i>一键批量卖出</span>
      <button type="button" class="btn-close" @click="$emit('close')"></button>
    </div>
    <div class="card-body">
      <!-- 代币地址输入 -->
      <div class="mb-3">
        <label class="form-label">代币合约地址</label>
        <input
          type="text"
          class="form-control"
          v-model.trim="tokenAddress"
          placeholder="输入代币合约地址 0x..."
        >
      </div>

      <!-- 卖出模式选择 -->
      <div class="mb-3">
        <label class="form-label">卖出模式</label>
        <div class="btn-group w-100" role="group">
          <input type="radio" class="btn-check" name="sellMode" id="sellModeFixed" value="fixed" v-model="sellMode">
          <label class="btn btn-outline-primary" for="sellModeFixed">
            <i class="bi bi-percent me-1"></i>固定百分比
          </label>
          <input type="radio" class="btn-check" name="sellMode" id="sellModeRange" value="range" v-model="sellMode">
          <label class="btn btn-outline-primary" for="sellModeRange">
            <i class="bi bi-shuffle me-1"></i>区间随机
          </label>
        </div>
      </div>

      <!-- 固定百分比 -->
      <div v-if="sellMode === 'fixed'" class="mb-3">
        <label class="form-label">卖出百分比</label>
        <div class="input-group">
          <input
            type="number"
            class="form-control"
            v-model.number="fixedPercent"
            min="1"
            max="100"
            placeholder="50"
          >
          <span class="input-group-text">%</span>
        </div>
        <div class="form-text">所有选中钱包将卖出相同比例的代币</div>
      </div>

      <!-- 区间随机 -->
      <div v-if="sellMode === 'range'" class="mb-3">
        <label class="form-label">随机区间</label>
        <div class="row g-2">
          <div class="col">
            <div class="input-group">
              <input
                type="number"
                class="form-control"
                v-model.number="minPercent"
                min="1"
                max="99"
                placeholder="10"
              >
              <span class="input-group-text">%</span>
            </div>
          </div>
          <div class="col-auto d-flex align-items-center">
            <span class="text-muted">~</span>
          </div>
          <div class="col">
            <div class="input-group">
              <input
                type="number"
                class="form-control"
                v-model.number="maxPercent"
                min="2"
                max="100"
                placeholder="100"
              >
              <span class="input-group-text">%</span>
            </div>
          </div>
        </div>
        <div class="form-text">每个钱包将在此区间内随机选择卖出比例</div>
      </div>

      <!-- 底池类型选择 -->
      <div class="mb-3">
        <label class="form-label">底池类型</label>
        <div class="btn-group w-100" role="group">
          <input type="radio" class="btn-check" name="batchSellPoolType" id="batchSellPoolBNB" value="BNB" v-model="poolType">
          <label class="btn btn-outline-primary" for="batchSellPoolBNB">{{ currentGovernanceToken }}底池</label>
          <template v-if="isBscChain">
            <input type="radio" class="btn-check" name="batchSellPoolType" id="batchSellPoolASTER" value="ASTER" v-model="poolType">
            <label class="btn btn-outline-primary" for="batchSellPoolASTER">ASTER底池</label>
          </template>
        </div>
        <div class="form-text">{{ poolType === 'BNB' ? `直接路径 Token→W${currentGovernanceToken}` : 'ASTER底池：多跳路由 Token→ASTER→WBNB' }}</div>
      </div>

      <!-- 安全执行控制 -->
      <div class="mb-3">
        <label class="form-label">钱包间隔</label>
        <div class="input-group input-group-sm">
          <input
            type="number"
            class="form-control"
            v-model.number="walletInterval"
            min="0"
            max="10000"
            step="100"
            placeholder="0"
          >
          <span class="input-group-text">ms</span>
        </div>
        <div class="form-text">
          卖出按钱包逐笔动态报价；上一笔确认后立即处理下一笔。默认不额外等待。
        </div>
        <div class="alert alert-light border small mt-2 mb-0 py-2">
          点击后会立即显示安全预检进度；系统不会再等待全部钱包授权完成后才发送第一笔，也不会并发使用同一份旧池价。
        </div>
      </div>

      <!-- 选中钱包信息 -->
      <div class="alert alert-info mb-3">
        <div class="d-flex justify-content-between align-items-center">
          <span>
            <i class="bi bi-wallet2 me-1"></i>
            选中钱包：<strong>{{ selectedCount }}</strong> 个
          </span>
          <button
            class="btn btn-sm btn-outline-info"
            @click="refreshTokenBalances"
            :disabled="!tokenAddress || !tokenAddress.startsWith('0x') || isRefreshing"
          >
            <i class="bi bi-arrow-clockwise me-1" :class="{ 'spin': isRefreshing }"></i>
            {{ isRefreshing ? '刷新中' : '刷新余额' }}
          </button>
        </div>
      </div>

      <!-- 执行按钮 -->
      <div class="d-grid gap-2">
        <button
          class="btn btn-warning btn-lg"
          @click="executeBatchSell"
          :disabled="!canExecute || isSelling"
        >
          <span v-if="isSelling">
            <span class="spinner-border spinner-border-sm me-1" role="status"></span>
            卖出中...
          </span>
          <span v-else>
            <i class="bi bi-cart-dash me-1"></i>
            一键卖出
          </span>
        </button>
      </div>

      <!-- 卖出结果 -->
      <div v-if="sellResults.length > 0" class="mt-3">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="small mb-0">
            <i class="bi bi-list-check me-1"></i>卖出结果
            <span class="badge bg-secondary ms-1">{{ sellResults.length }}</span>
            <span class="badge bg-success ms-1">{{ sellResults.filter(r => r.status === 'confirmed').length }} 已确认</span>
            <span v-if="sellResults.filter(r => ['preflight', 'processing', 'broadcast', 'pending', 'unknown'].includes(r.status)).length > 0" class="badge bg-warning text-dark ms-1">
              {{ sellResults.filter(r => ['preflight', 'processing', 'broadcast', 'pending', 'unknown'].includes(r.status)).length }} 处理中
            </span>
            <span v-if="sellResults.filter(r => ['failed', 'not_sent'].includes(r.status)).length > 0" class="badge bg-danger ms-1">
              {{ sellResults.filter(r => ['failed', 'not_sent'].includes(r.status)).length }} 未完成
            </span>
          </h6>
          <button class="btn btn-outline-secondary btn-sm" @click="sellResults = []">
            <i class="bi bi-x-lg"></i> 清除
          </button>
        </div>
        <div class="results-list border rounded" style="max-height: 200px; overflow-y: auto;">
          <table class="table table-sm table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>#</th>
                <th>状态</th>
                <th>钱包</th>
                <th>比例</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(result, idx) in sellResults" :key="result.wallet" :class="rowClass(result.status)">
                <td class="small text-muted">{{ idx + 1 }}</td>
                <td>
                  <i class="bi" :class="statusIcon(result.status)" :title="statusLabel(result.status)"></i>
                </td>
                <td class="small">
                  <code class="text-primary">{{ formatAddress(result.wallet) }}</code>
                </td>
                <td class="small">
                  <span class="badge bg-info">{{ result.percent?.toFixed(1) }}%</span>
                </td>
                <td class="small">
                  <a v-if="result.hash" :href="getExplorerTxUrl(result.hash)" target="_blank" class="text-decoration-none">
                    <i class="bi bi-box-arrow-up-right me-1"></i>{{ formatAddress(result.hash) }}
                  </a>
                  <span
                    v-else-if="result.error"
                    :class="['failed', 'not_sent'].includes(result.status) ? 'text-danger' : 'text-muted'"
                    :title="result.error"
                  >
                    <i class="bi me-1" :class="['failed', 'not_sent'].includes(result.status) ? 'bi-exclamation-triangle' : 'bi-hourglass-split'"></i>{{ truncateError(result.error) }}
                  </span>
                  <span v-else class="text-muted">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useDexStore } from '../../stores/dexStore';
import { useChainStore } from '../../stores/chainStore';
import {
  executeManualBatchSell,
  type ManualBatchSellStatus,
} from '../../services/manualBatchSellService';
import { ASTER_TOKEN_ADDRESS } from '../../constants';

const emit = defineEmits(['close']);

const walletStore = useWalletStore();
const dexStore = useDexStore();
const chainStore = useChainStore();

const { selectedCount, selectedWalletAddresses } = storeToRefs(walletStore);
const { selectedChainId, currentGovernanceToken } = storeToRefs(chainStore);
const isBscChain = computed(() => selectedChainId.value === 56 || selectedChainId.value === 97);

// 状态
const tokenAddress = ref('');
const sellMode = ref<'fixed' | 'range'>('fixed');
const fixedPercent = ref(100);
const minPercent = ref(10);
const maxPercent = ref(100);
const isSelling = ref(false);
const isRefreshing = ref(false);
const sellResults = ref<any[]>([]);
const walletInterval = ref(0);
const poolType = ref<'BNB' | 'ASTER'>('BNB');

watch(selectedChainId, () => {
  // 组件由 keep-alive 保留，切链时必须清掉旧链地址和结果。
  tokenAddress.value = '';
  sellResults.value = [];
  poolType.value = 'BNB';
});

// 是否可以执行
const canExecute = computed(() => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress.value)) return false;
  if (selectedCount.value === 0) return false;

  if (sellMode.value === 'fixed') {
    return fixedPercent.value > 0 && fixedPercent.value <= 100;
  } else {
    return minPercent.value > 0 &&
           maxPercent.value > 0 &&
           minPercent.value < maxPercent.value &&
           maxPercent.value <= 100;
  }
});

// 刷新代币余额
async function refreshTokenBalances() {
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress.value)) return;

  isRefreshing.value = true;
  try {
    await walletStore.refreshTargetTokenBalance();
  } finally {
    isRefreshing.value = false;
  }
}

// 获取钱包私钥
function getWalletPrivateKey(walletAddress: string): string | null {
  const wallet = walletStore.localWallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  return wallet?.encrypted || null;
}

function statusLabel(status: ManualBatchSellStatus): string {
  const labels: Record<ManualBatchSellStatus, string> = {
    preflight: '安全预检中',
    processing: '正在准备当前钱包',
    broadcast: '交易已广播',
    confirmed: '链上已确认',
    pending: '等待链上确认',
    unknown: '等待节点核对',
    failed: '执行失败',
    not_sent: '未发送',
  };
  return labels[status] || status;
}

function statusIcon(status: ManualBatchSellStatus): string {
  if (status === 'confirmed') return 'bi-check-circle-fill text-success';
  if (status === 'failed' || status === 'not_sent') return 'bi-x-circle-fill text-danger';
  if (status === 'pending' || status === 'unknown') return 'bi-clock-history text-warning';
  if (status === 'broadcast') return 'bi-broadcast text-primary';
  return 'bi-arrow-repeat text-info';
}

function rowClass(status: ManualBatchSellStatus): string {
  if (status === 'failed' || status === 'not_sent') return 'table-danger';
  if (status === 'pending' || status === 'unknown') return 'table-warning';
  return '';
}

// 安全批量卖出：整批 pending nonce 预检后，逐钱包读取最新池价并等待
// 最终回执。进度会在点击后立即呈现，第一笔不再等待所有钱包预授权。
async function executeBatchSell() {
  if (!canExecute.value) return;

  const routerAddress = dexStore.currentRouterAddress;
  if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
    alert('当前DEX的Router地址未配置');
    return;
  }

  isSelling.value = true;
  sellResults.value = [];

  try {
    const chainId = chainStore.selectedChainId;
    const isRobinhood = chainId === 4663;
    const useAsterPool = !isRobinhood && poolType.value === 'ASTER';
    const walletAddresses = [...selectedWalletAddresses.value];
    const wallets = walletAddresses.map(walletAddress => ({
      address: walletAddress,
      privateKey: getWalletPrivateKey(walletAddress) || '',
      percent: sellMode.value === 'fixed'
        ? fixedPercent.value
        : Math.random() * (maxPercent.value - minPercent.value) + minPercent.value,
    }));

    sellResults.value = await executeManualBatchSell({
      chainId,
      rpcUrl: chainStore.effectiveRpcUrl,
      routerAddress,
      tokenAddress: tokenAddress.value,
      spendToken: isRobinhood ? 'ETH' : (chainId === 97 ? 'tBNB' : 'BNB'),
      intermediateToken: useAsterPool ? ASTER_TOKEN_ADDRESS : undefined,
      v3FeeTier: isRobinhood ? 10000 : undefined,
      slippage: 30,
      wallets,
      intervalMs: walletInterval.value,
      onProgress(results) {
        sellResults.value = results;
      },
    });

    const confirmed = sellResults.value.filter(result => result.status === 'confirmed').length;
    const pending = sellResults.value.filter(result => result.status === 'pending' || result.status === 'unknown').length;
    const notCompleted = sellResults.value.filter(result => result.status === 'failed' || result.status === 'not_sent').length;
    if (confirmed === sellResults.value.length) {
      alert(`批量卖出完成！已确认 ${confirmed} 笔`);
    } else if (pending > 0) {
      alert(`批量卖出已停止\n\n已确认: ${confirmed} 笔\n待确认/待核对: ${pending} 笔\n未完成: ${notCompleted} 笔\n\n已有哈希的交易不会自动重发。`);
    } else {
      const firstError = sellResults.value.find(result => result.error)?.error || '未知错误';
      alert(`批量卖出结束\n\n已确认: ${confirmed} 笔\n未完成: ${notCompleted} 笔\n\n原因: ${firstError}`);
    }
  } catch (error: any) {
    console.error('批量卖出失败:', error);
    alert(`批量卖出失败: ${error.message || '未知错误'}`);
  } finally {
    isSelling.value = false;
  }
}

// 格式化地址
function formatAddress(address: string): string {
  if (!address) return '-';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 获取区块浏览器链接
function getExplorerTxUrl(hash: string): string {
  const chainId = walletStore.currentChainId;
  const explorers: Record<number, string> = {
    56: 'https://bscscan.com/tx/',
    97: 'https://testnet.bscscan.com/tx/',
    66: 'https://www.oklink.com/okc/tx/',
    4663: 'https://robinhoodchain.blockscout.com/tx/'
  };
  const explorer = explorers[chainId];
  return explorer ? explorer + hash : '#';
}

// 截断错误信息
function truncateError(error: string): string {
  if (!error) return '';
  return error.length > 25 ? error.slice(0, 25) + '...' : error;
}
</script>

<style scoped>
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.results-list {
  font-size: 0.75rem;
}
</style>
