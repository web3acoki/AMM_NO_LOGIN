<template>
  <div class="task-config-form">
    <h6 class="fw-semibold mb-3">
      <i class="bi bi-plus-circle me-1"></i>新建任务
    </h6>

    <form @submit.prevent="handleCreateTask">
      <!-- 任务名称和模式 -->
      <div class="row g-2 mb-3">
        <div class="col-6">
          <label class="form-label small">任务名称</label>
          <input type="text" class="form-control form-control-sm" v-model="taskName" placeholder="任务1">
        </div>
        <div class="col-6">
          <label class="form-label small">模式</label>
          <select class="form-select form-select-sm" v-model="mode">
            <option value="pump">拉盘（买入）</option>
            <option value="dump">砸盘（卖出）</option>
          </select>
        </div>
      </div>

      <!-- 代币合约地址 -->
      <div class="mb-3">
        <label class="form-label small">
          代币合约地址
          <span v-if="targetToken" class="badge bg-success ms-1">已自动填入</span>
        </label>
        <input
          type="text"
          class="form-control form-control-sm"
          :value="tokenContract"
          @input="tokenContract = ($event.target as HTMLInputElement).value"
          :disabled="!!targetToken"
          :placeholder="targetToken ? '' : '请先在资金池查询中设置目标代币'"
        >
        <div v-if="targetToken" class="form-text small text-success">
          <i class="bi bi-check-circle me-1"></i>{{ targetToken.symbol }} ({{ targetToken.name }})
        </div>
        <div v-else class="form-text small text-warning">
          <i class="bi bi-exclamation-triangle me-1"></i>请先在资金池查询中设置目标代币
        </div>
      </div>

      <!-- 池子类型和交易代币 -->
      <div class="row g-2 mb-3">
        <div class="col-6">
          <label class="form-label small">池子类型</label>
          <select class="form-select form-select-sm" v-model="poolType" disabled>
            <option :value="currentGovernanceToken">{{ currentGovernanceToken }}</option>
          </select>
        </div>
        <div class="col-6">
          <label class="form-label small">{{ mode === 'pump' ? '花费代币' : '换成代币' }}</label>
          <select class="form-select form-select-sm" v-model="spendToken" disabled>
            <option :value="currentGovernanceToken">{{ currentGovernanceToken }}</option>
          </select>
        </div>
      </div>

      <!-- 目标价格 -->
      <div class="mb-3">
        <label class="form-label small">目标价格（可选）</label>
        <div class="input-group input-group-sm">
          <input type="number" class="form-control" v-model.number="targetPrice" step="0.000001" placeholder="0.001">
          <span class="input-group-text">{{ currentGovernanceToken }}</span>
        </div>
        <div class="form-text small">仅在停止条件选择"达到目标价格"时生效</div>
      </div>

      <!-- 金额类型和金额 -->
      <div class="row g-2 mb-3">
        <div class="col-4" v-if="mode === 'pump'">
          <label class="form-label small">金额类型</label>
          <select class="form-select form-select-sm" v-model="amountType">
            <option value="amount">金额</option>
            <option value="quantity">数量</option>
          </select>
        </div>
        <div :class="mode === 'pump' ? 'col-8' : 'col-12'">
          <label class="form-label small">{{ amountLabel }}</label>
          <div class="input-group input-group-sm">
            <input type="number" class="form-control" v-model.number="amount" step="0.001" placeholder="100">
            <span class="input-group-text">{{ amountUnit }}</span>
          </div>
          <div v-if="mode === 'dump'" class="form-text small text-warning">
            <i class="bi bi-info-circle me-1"></i>卖出代币数量（将换成 {{ spendToken }}）
          </div>
        </div>
      </div>

      <!-- 停止条件 -->
      <div class="row g-2 mb-3">
        <div class="col-5">
          <label class="form-label small">停止条件</label>
          <select class="form-select form-select-sm" v-model="stopType">
            <option value="count">按次数</option>
            <option value="amount">按花费金额</option>
            <option value="time">按时间(秒)</option>
            <option value="price">达到目标价格</option>
            <option value="marketcap">达到目标市值</option>
          </select>
        </div>
        <div class="col-7">
          <label class="form-label small">{{ stopTypeLabel }}</label>
          <div class="input-group input-group-sm">
            <input type="number" class="form-control" v-model.number="stopValue" :placeholder="stopTypePlaceholder" step="any">
            <span class="input-group-text">{{ stopTypeUnit }}</span>
          </div>
        </div>
      </div>

      <!-- 交易间隔 -->
      <div class="mb-3">
        <label class="form-label small">交易间隔</label>
        <div class="input-group input-group-sm">
          <input type="number" class="form-control" v-model.number="interval" min="1" placeholder="1">
          <span class="input-group-text">秒</span>
        </div>
      </div>

      <!-- Gas 设置 -->
      <div class="row g-2 mb-3">
        <div class="col-6">
          <label class="form-label small">Gas Price (可选)</label>
          <div class="input-group input-group-sm">
            <input type="number" class="form-control" v-model.number="gasPrice" placeholder="自动">
            <span class="input-group-text">Gwei</span>
          </div>
        </div>
        <div class="col-6">
          <label class="form-label small">Gas Limit (可选)</label>
          <input type="number" class="form-control form-control-sm" v-model.number="gasLimit" placeholder="自动">
        </div>
      </div>

      <!-- 卖出阈值 -->
      <div class="mb-3">
        <label class="form-label small">卖出阈值</label>
        <div class="input-group input-group-sm">
          <input type="number" class="form-control" v-model.number="sellThreshold" step="0.001" placeholder="0.001">
          <span class="input-group-text">Token</span>
        </div>
        <div class="form-text small">累积超过此数量后触发卖出</div>
      </div>

      <!-- 钱包执行方式 -->
      <div class="mb-3">
        <label class="form-label small">钱包执行方式</label>
        <div>
          <div class="form-check form-check-inline">
            <input class="form-check-input" type="radio" id="walletSequential" value="sequential" v-model="walletMode">
            <label class="form-check-label small" for="walletSequential">顺序执行</label>
          </div>
          <div class="form-check form-check-inline">
            <input class="form-check-input" type="radio" id="walletParallel" value="parallel" v-model="walletMode">
            <label class="form-check-label small" for="walletParallel">同时执行</label>
          </div>
        </div>
        <div class="form-text small">
          {{ walletMode === 'sequential' ? '钱包逐个执行交易' : '所有钱包同时发起交易' }}
        </div>
      </div>

      <!-- 余额使用百分比 -->
      <div class="mb-3">
        <label class="form-label small">
          余额使用百分比
          <i class="bi bi-question-circle ms-1" title="每个钱包用余额的X%进行交易"></i>
        </label>
        <div class="input-group input-group-sm">
          <input type="number" class="form-control" v-model.number="balancePercent" min="1" max="100" step="1" placeholder="100">
          <span class="input-group-text">%</span>
        </div>
        <div class="form-text small">
          {{ mode === 'pump' 
            ? `每个钱包使用 ${balancePercent || 100}% 的 ${spendToken} 余额进行买入` 
            : `每个钱包使用 ${balancePercent || 100}% 的代币余额进行卖出` 
          }}
        </div>
      </div>

      <!-- 选中的钱包 -->
      <div class="mb-3">
        <label class="form-label small">
          参与钱包
          <span class="badge bg-primary ms-1">{{ totalWalletCount }} 个</span>
        </label>

        <!-- 钱包来源选择 -->
        <div class="mb-2">
          <div class="form-check form-check-inline">
            <input class="form-check-input" type="checkbox" id="useLocalWallets" v-model="useLocalWallets">
            <label class="form-check-label small" for="useLocalWallets">
              本地钱包列表 ({{ selectedCount }})
            </label>
          </div>
          <div class="form-check form-check-inline">
            <input class="form-check-input" type="checkbox" id="useBatchWallets" v-model="useBatchWallets">
            <label class="form-check-label small" for="useBatchWallets">
              钱包批次
            </label>
          </div>
        </div>

        <!-- 批次选择下拉框 -->
        <div v-if="useBatchWallets" class="mb-2">
          <select class="form-select form-select-sm" v-model="selectedBatchIds" multiple style="height: 80px;">
            <option v-for="batch in walletBatches" :key="batch.id" :value="batch.id">
              {{ batch.remark }} ({{ batch.wallets.length }}个 - {{ batch.walletType === 'main' ? '主钱包' : '普通钱包' }})
            </option>
          </select>
          <div class="form-text small">按住Ctrl可多选批次</div>
        </div>

        <!-- 钱包预览 -->
        <div v-if="totalWalletCount === 0" class="alert alert-warning small py-2 mb-0">
          <i class="bi bi-exclamation-triangle me-1"></i>
          请选择钱包来源：勾选本地钱包列表或选择钱包批次
        </div>
        <div v-else class="small text-muted">
          <div v-if="useLocalWallets && selectedCount > 0" class="mb-1">
            <span class="badge bg-secondary me-1">本地</span>
            <span v-for="(addr, idx) in selectedAddressesPreview" :key="addr" class="me-1">
              {{ formatAddress(addr) }}
            </span>
            <span v-if="selectedCount > 3">... 共 {{ selectedCount }} 个</span>
          </div>
          <div v-if="useBatchWallets && batchWalletCount > 0">
            <span class="badge bg-info me-1">批次</span>
            <span v-for="batch in selectedBatchesPreview" :key="batch.id" class="me-1">
              {{ batch.remark }}({{ batch.wallets.length }})
            </span>
            <span v-if="selectedBatchIds.length > 2">... 共 {{ batchWalletCount }} 个</span>
          </div>
        </div>
      </div>

      <!-- 创建按钮 -->
      <div class="d-grid">
        <button 
          type="submit" 
          class="btn btn-primary btn-sm"
          :disabled="!canCreate"
        >
          <i class="bi bi-plus-lg me-1"></i>创建任务
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useTaskStore } from '../../stores/taskStore';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';
import { storeToRefs } from 'pinia';

const taskStore = useTaskStore();
const walletStore = useWalletStore();
const chainStore = useChainStore();

const { currentGovernanceToken } = storeToRefs(chainStore);
const { selectedWalletAddresses, selectedCount, targetToken, walletBatches } = storeToRefs(walletStore);

// 表单数据
const taskName = ref('');
const mode = ref<'pump' | 'dump'>('pump');
const tokenContract = ref('');
const poolType = ref('');
const spendToken = ref('');
const targetPrice = ref<number>(0);
const amountType = ref<'amount' | 'quantity'>('amount');
const amount = ref<number>(100);
const stopType = ref<'count' | 'amount' | 'time' | 'price' | 'marketcap'>('count');
const stopValue = ref<number>(10);
const interval = ref<number>(1);
const gasPrice = ref<number | undefined>(undefined);
const gasLimit = ref<number | undefined>(undefined);
const sellThreshold = ref<number>(0);
const walletMode = ref<'sequential' | 'parallel'>('sequential');
const balancePercent = ref<number>(100);

// 钱包来源选择
const useLocalWallets = ref(true);
const useBatchWallets = ref(false);
const selectedBatchIds = ref<string[]>([]);

// 监听治理代币变化，更新默认值
watch(currentGovernanceToken, (newToken) => {
  poolType.value = newToken;
  spendToken.value = newToken;
}, { immediate: true });

// 监听目标代币变化，自动填入代币合约地址
watch(targetToken, (token) => {
  if (token) {
    tokenContract.value = token.address;
  }
}, { immediate: true });

// 自动生成任务名称
watch(() => taskStore.taskCount, (count) => {
  if (!taskName.value) {
    taskName.value = `任务${count + 1}`;
  }
}, { immediate: true });

// 计算属性
const selectedAddressesPreview = computed(() => {
  return selectedWalletAddresses.value.slice(0, 3);
});

// 选中的批次
const selectedBatches = computed(() => {
  return walletBatches.value.filter(b => selectedBatchIds.value.includes(b.id));
});

// 选中批次预览
const selectedBatchesPreview = computed(() => {
  return selectedBatches.value.slice(0, 2);
});

// 批次钱包数量
const batchWalletCount = computed(() => {
  return selectedBatches.value.reduce((sum, batch) => sum + batch.wallets.length, 0);
});

// 总钱包数量
const totalWalletCount = computed(() => {
  let count = 0;
  if (useLocalWallets.value) {
    count += selectedCount.value;
  }
  if (useBatchWallets.value) {
    count += batchWalletCount.value;
  }
  return count;
});

// 最终的钱包地址列表（去重）
const finalWalletAddresses = computed(() => {
  const addressSet = new Set<string>();

  // 添加本地钱包
  if (useLocalWallets.value) {
    selectedWalletAddresses.value.forEach(addr => addressSet.add(addr.toLowerCase()));
  }

  // 添加批次钱包
  if (useBatchWallets.value) {
    selectedBatches.value.forEach(batch => {
      batch.wallets.forEach(w => addressSet.add(w.address.toLowerCase()));
    });
  }

  return Array.from(addressSet);
});

const canCreate = computed(() => {
  return (
    taskName.value &&
    tokenContract.value &&
    poolType.value &&
    spendToken.value &&
    amount.value > 0 &&
    stopValue.value > 0 &&
    interval.value > 0 &&
    totalWalletCount.value > 0
  );
});

const stopTypeLabel = computed(() => {
  switch (stopType.value) {
    case 'count': return '执行次数';
    case 'amount': return '花费金额上限';
    case 'time': return '运行时间';
    case 'price': return '目标价格';
    case 'marketcap': return '目标市值';
    default: return '条件值';
  }
});

const stopTypePlaceholder = computed(() => {
  switch (stopType.value) {
    case 'count': return '10';
    case 'amount': return '1';
    case 'time': return '60';
    case 'price': return '0.001';
    case 'marketcap': return '100';
    default: return '';
  }
});

const stopTypeUnit = computed(() => {
  switch (stopType.value) {
    case 'count': return '次';
    case 'amount': return spendToken.value;
    case 'time': return '秒';
    case 'price': return currentGovernanceToken.value;
    case 'marketcap': return currentGovernanceToken.value;
    default: return '';
  }
});

// 金额标签（根据模式和金额类型）
const amountLabel = computed(() => {
  if (mode.value === 'pump') {
    // 拉盘（买入）
    return amountType.value === 'amount' ? '买入金额' : '买入数量';
  } else {
    // 砸盘（卖出）
    return amountType.value === 'amount' ? '卖出数量' : '卖出数量';
  }
});

// 金额单位（根据模式和金额类型）
const amountUnit = computed(() => {
  if (mode.value === 'pump') {
    // 拉盘：花费的代币
    return amountType.value === 'amount' ? spendToken.value : 'Token';
  } else {
    // 砸盘：卖出的代币数量
    return 'Token';
  }
});

// 格式化地址
function formatAddress(address: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 创建任务
function handleCreateTask() {
  if (!canCreate.value) return;

  const config = {
    tokenContract: tokenContract.value,
    poolType: poolType.value,
    spendToken: spendToken.value,
    targetPrice: targetPrice.value,
    targetMarketCap: stopType.value === 'marketcap' ? stopValue.value : undefined,
    amountType: amountType.value,
    amount: amount.value,
    stopType: stopType.value,
    stopValue: stopValue.value,
    interval: interval.value,
    gasPrice: gasPrice.value,
    gasLimit: gasLimit.value,
    sellThreshold: sellThreshold.value,
    walletMode: walletMode.value,
    balancePercent: balancePercent.value,
  };

  // 使用合并后的钱包地址列表（包含本地钱包和批次钱包）
  const task = taskStore.createTask(
    taskName.value,
    mode.value,
    config,
    [...finalWalletAddresses.value]
  );

  // 重置表单（保留部分设置）
  taskName.value = `任务${taskStore.taskCount + 1}`;
  selectedBatchIds.value = [];

  // 显示成功提示
  alert(`任务 "${task.name}" 创建成功！\n\n钱包数量: ${finalWalletAddresses.value.length}\n点击任务卡片上的"开始"按钮启动任务。`);
}
</script>

<style scoped>
.task-config-form {
  font-size: 0.875rem;
}
</style>

