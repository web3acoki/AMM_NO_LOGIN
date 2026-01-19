<template>
  <div class="card mb-3 border-warning">
    <div class="card-header bg-warning text-dark d-flex justify-content-between align-items-center">
      <span><i class="bi bi-cart-dash me-1"></i>一键批量卖出</span>
      <button type="button" class="btn-close" @click="$emit('close')"></button>
    </div>
    <div class="card-body">
      <!-- 目标代币信息 -->
      <div class="alert mb-3" :class="targetToken ? 'alert-success' : 'alert-warning'">
        <div class="d-flex align-items-center">
          <i class="bi me-2" :class="targetToken ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill'"></i>
          <div v-if="targetToken">
            <strong>目标代币：</strong>{{ targetToken.symbol }} ({{ targetToken.name }})
            <br>
            <small class="text-muted">{{ targetToken.address }}</small>
          </div>
          <div v-else>
            <strong>未设置目标代币</strong>
            <br>
            <small>请先在资金池查询中设置目标代币</small>
          </div>
        </div>
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

      <!-- 并发控制 -->
      <div class="mb-3">
        <label class="form-label">并发控制</label>
        <div class="row g-2">
          <div class="col">
            <div class="input-group input-group-sm">
              <span class="input-group-text">线程数</span>
              <input
                type="number"
                class="form-control"
                v-model.number="concurrency"
                min="1"
                max="20"
                placeholder="5"
              >
            </div>
          </div>
          <div class="col">
            <div class="input-group input-group-sm">
              <span class="input-group-text">间隔</span>
              <input
                type="number"
                class="form-control"
                v-model.number="batchInterval"
                min="100"
                max="10000"
                step="100"
                placeholder="1000"
              >
              <span class="input-group-text">ms</span>
            </div>
          </div>
        </div>
        <div class="form-text">
          每批 {{ concurrency }} 个钱包并发执行，批次间隔 {{ batchInterval }}ms，预估完成时间：<strong>{{ estimatedTime }}</strong>
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
            :disabled="!targetToken || isRefreshing"
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
            <span class="badge bg-success ms-1">{{ sellResults.filter(r => r.success).length }} 成功</span>
            <span v-if="sellResults.filter(r => !r.success).length > 0" class="badge bg-danger ms-1">
              {{ sellResults.filter(r => !r.success).length }} 失败
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
              <tr v-for="(result, idx) in sellResults" :key="idx" :class="result.success ? '' : 'table-danger'">
                <td class="small text-muted">{{ idx + 1 }}</td>
                <td>
                  <i class="bi" :class="result.success ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'"></i>
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
                  <span v-else-if="result.error" class="text-danger" :title="result.error">
                    <i class="bi bi-exclamation-triangle me-1"></i>{{ truncateError(result.error) }}
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
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useTaskStore } from '../../stores/taskStore';
import { useDexStore } from '../../stores/dexStore';
import { useChainStore } from '../../stores/chainStore';

const emit = defineEmits(['close']);

const walletStore = useWalletStore();
const taskStore = useTaskStore();
const dexStore = useDexStore();
const chainStore = useChainStore();

const { targetToken, selectedCount, selectedWalletAddresses } = storeToRefs(walletStore);

// 状态
const sellMode = ref<'fixed' | 'range'>('fixed');
const fixedPercent = ref(100);
const minPercent = ref(10);
const maxPercent = ref(100);
const isSelling = ref(false);
const isRefreshing = ref(false);
const sellResults = ref<any[]>([]);
// 并发控制参数
const concurrency = ref(5);
const batchInterval = ref(1000);

// 预估完成时间
const estimatedTime = computed(() => {
  if (selectedCount.value === 0) return '0秒';
  const batches = Math.ceil(selectedCount.value / concurrency.value);
  const totalMs = (batches - 1) * batchInterval.value; // 最后一批不需要等待
  const totalSeconds = Math.ceil(totalMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds}秒`;
});

// 是否可以执行
const canExecute = computed(() => {
  if (!targetToken.value) return false;
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
  if (!targetToken.value) return;

  isRefreshing.value = true;
  try {
    await walletStore.refreshTargetTokenBalance();
  } finally {
    isRefreshing.value = false;
  }
}

// 执行批量卖出
async function executeBatchSell() {
  if (!canExecute.value) return;

  isSelling.value = true;
  sellResults.value = [];

  try {
    const walletAddresses = selectedWalletAddresses.value;
    const tokenAddress = targetToken.value!.address;

    // 将钱包分成多个批次
    const batches: string[][] = [];
    for (let i = 0; i < walletAddresses.length; i += concurrency.value) {
      batches.push(walletAddresses.slice(i, i + concurrency.value));
    }

    console.log(`批量卖出：共 ${walletAddresses.length} 个钱包，分 ${batches.length} 批执行，每批 ${concurrency.value} 个`);

    // 按批次执行
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`执行第 ${batchIndex + 1}/${batches.length} 批，包含 ${batch.length} 个钱包`);

      // 并发执行当前批次的所有钱包
      const batchPromises = batch.map(async (walletAddr) => {
        let percent: number;
        if (sellMode.value === 'fixed') {
          percent = fixedPercent.value;
        } else {
          percent = Math.random() * (maxPercent.value - minPercent.value) + minPercent.value;
        }

        try {
          // 创建砸盘任务
          const task = taskStore.createTask(
            `批量卖出 ${targetToken.value!.symbol}`,
            'dump',
            {
              tokenContract: tokenAddress,
              poolType: chainStore.currentGovernanceToken,
              spendToken: chainStore.currentGovernanceToken,
              targetPrice: 0,
              amountType: 'quantity',
              amount: 0,
              stopType: 'count',
              stopValue: 1,
              interval: 1,
              sellThreshold: percent,
              walletMode: 'sequential',
            },
            [walletAddr]
          );

          // 启动任务
          taskStore.startTask(task.id);

          return {
            wallet: walletAddr,
            percent,
            success: true,
            error: null
          };
        } catch (error: any) {
          return {
            wallet: walletAddr,
            percent,
            success: false,
            error: error.message || '创建任务失败'
          };
        }
      });

      // 等待当前批次完成
      const batchResults = await Promise.all(batchPromises);
      sellResults.value.push(...batchResults);

      // 如果不是最后一批，等待间隔时间
      if (batchIndex < batches.length - 1) {
        console.log(`等待 ${batchInterval.value}ms 后执行下一批...`);
        await new Promise(resolve => setTimeout(resolve, batchInterval.value));
      }
    }

    alert(`已为 ${walletAddresses.length} 个钱包创建卖出任务，请在任务列表中查看执行情况`);

  } catch (error: any) {
    console.error('批量卖出失败:', error);
    sellResults.value.push({
      wallet: '-',
      percent: 0,
      success: false,
      error: error.message || '批量卖出失败'
    });
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
    66: 'https://www.oklink.com/okc/tx/'
  };
  return (explorers[chainId] || 'https://bscscan.com/tx/') + hash;
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
