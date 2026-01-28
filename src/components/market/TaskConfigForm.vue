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

      <!-- 盘口选择 -->
      <div class="mb-3">
        <label class="form-label small">盘口选择</label>
        <div class="btn-group btn-group-sm w-100">
          <button
            type="button"
            class="btn"
            :class="marketType === 'outer' ? 'btn-primary' : 'btn-outline-primary'"
            @click="marketType = 'outer'"
          >
            外盘 (DEX)
          </button>
          <button
            type="button"
            class="btn"
            :class="marketType === 'inner' ? 'btn-primary' : 'btn-outline-primary'"
            @click="marketType = 'inner'"
          >
            内盘 (FourMeme)
          </button>
        </div>
        <div class="form-text small">
          <i class="bi bi-info-circle me-1"></i>
          {{ marketType === 'outer' ? '外盘通过 PancakeSwap DEX 进行交易' : '内盘通过 FourMeme 主合约直接交易' }}
        </div>
      </div>

      <!-- 内盘目标代币地址（仅内盘模式显示） -->
      <div class="mb-3" v-if="marketType === 'inner'">
        <label class="form-label small">
          内盘目标代币地址
          <span v-if="innerTokenAddress" class="badge bg-success ms-1">已设置</span>
        </label>
        <input
          type="text"
          class="form-control form-control-sm"
          v-model="innerTokenAddress"
          placeholder="0x... 或从狙击检测自动设置"
        >
        <div class="form-text small text-muted">
          <i class="bi bi-crosshair me-1"></i>可在代币狙击中检测到代币后点击按钮自动设置
        </div>
      </div>

      <!-- 代币合约地址（仅外盘模式显示） -->
      <div class="mb-3" v-if="marketType === 'outer'">
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

      <!-- 金额区间 -->
      <div class="mb-3">
        <label class="form-label small">
          {{ mode === 'pump' ? '买入金额区间' : '卖出金额区间' }}
          <span class="text-muted">({{ currentGovernanceToken }})</span>
        </label>
        <div class="row g-2">
          <div class="col-6">
            <div class="input-group input-group-sm">
              <span class="input-group-text">最小</span>
              <input type="number" class="form-control" v-model.number="amountMin" step="any" placeholder="0.01" :disabled="mode === 'dump' && sellAll">
            </div>
          </div>
          <div class="col-6">
            <div class="input-group input-group-sm">
              <span class="input-group-text">最大</span>
              <input type="number" class="form-control" v-model.number="amountMax" step="any" placeholder="0.05" :disabled="mode === 'dump' && sellAll">
            </div>
          </div>
        </div>
        <div class="form-text small">
          <i class="bi bi-info-circle me-1"></i>
          {{ mode === 'pump'
            ? `每个钱包随机花费 ${amountMin || 0} ~ ${amountMax || 0} ${currentGovernanceToken} 买入代币`
            : `每个钱包随机卖出价值 ${amountMin || 0} ~ ${amountMax || 0} ${currentGovernanceToken} 的代币`
          }}
        </div>
      </div>

      <!-- 砸盘模式：卖出全部选项 -->
      <div class="mb-3" v-if="mode === 'dump'">
        <div class="form-check">
          <input class="form-check-input" type="checkbox" id="sellAllCheck" v-model="sellAll">
          <label class="form-check-label small" for="sellAllCheck">
            <i class="bi bi-lightning-charge me-1"></i>卖出全部代币
          </label>
        </div>
        <div class="form-text small text-muted">
          勾选后将卖出钱包中100%的代币余额
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

      <!-- 交易间隔和线程数 -->
      <div class="row g-2 mb-3">
        <div class="col-6">
          <label class="form-label small">交易间隔</label>
          <div class="input-group input-group-sm">
            <input type="number" class="form-control" v-model.number="interval" min="1" placeholder="5">
            <span class="input-group-text">秒</span>
          </div>
        </div>
        <div class="col-6">
          <label class="form-label small">线程数</label>
          <div class="input-group input-group-sm">
            <input type="number" class="form-control" v-model.number="threadCount" min="1" placeholder="1">
            <span class="input-group-text">个</span>
          </div>
        </div>
      </div>
      <div class="form-text small mb-3">
        <i class="bi bi-info-circle me-1"></i>
        每 {{ interval || 5 }} 秒同时执行 {{ threadCount || 1 }} 个钱包的交易
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
import { useSnipeStore } from '../../stores/snipeStore';
import { storeToRefs } from 'pinia';

const taskStore = useTaskStore();
const walletStore = useWalletStore();
const chainStore = useChainStore();
const snipeStore = useSnipeStore();

const { currentGovernanceToken } = storeToRefs(chainStore);
const { selectedWalletAddresses, selectedCount, targetToken, walletBatches } = storeToRefs(walletStore);
const { detectedInnerToken } = storeToRefs(snipeStore);

// 表单数据
const taskName = ref('');
const mode = ref<'pump' | 'dump'>('pump');
const marketType = ref<'inner' | 'outer'>('outer');  // 盘口类型
const innerTokenAddress = ref('');  // 内盘目标代币地址
const tokenContract = ref('');
const amountMin = ref<number>(0.01);
const amountMax = ref<number>(0.05);
const stopType = ref<'count' | 'amount' | 'time' | 'price' | 'marketcap'>('count');
const stopValue = ref<number>(10);
const interval = ref<number>(5);
const threadCount = ref<number>(1); // 线程数：每个间隔内同时执行的钱包数量
const gasPrice = ref<number | undefined>(undefined);
const gasLimit = ref<number | undefined>(undefined);
const sellAll = ref<boolean>(true); // 砸盘模式默认卖出全部

// 钱包来源选择
const useLocalWallets = ref(true);
const useBatchWallets = ref(false);
const selectedBatchIds = ref<string[]>([]);

// 监听目标代币变化，自动填入代币合约地址
watch(targetToken, (token) => {
  if (token) {
    tokenContract.value = token.address;
  }
}, { immediate: true });

// 监听狙击检测到的内盘代币，自动填入内盘代币地址
watch(detectedInnerToken, (token) => {
  if (token) {
    innerTokenAddress.value = token;
    // 自动切换到内盘模式
    marketType.value = 'inner';
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
  // 砸盘卖出全部时不需要金额区间
  const amountValid = (mode.value === 'dump' && sellAll.value) ||
    (amountMin.value >= 0 && amountMax.value >= amountMin.value);

  // 内盘模式需要内盘代币地址，外盘模式需要代币合约地址
  const tokenValid = marketType.value === 'inner'
    ? innerTokenAddress.value.match(/^0x[a-fA-F0-9]{40}$/)
    : tokenContract.value;

  return (
    taskName.value &&
    tokenValid &&
    amountValid &&
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
    case 'amount': return currentGovernanceToken.value;
    case 'time': return '秒';
    case 'price': return currentGovernanceToken.value;
    case 'marketcap': return currentGovernanceToken.value;
    default: return '';
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
    tokenContract: marketType.value === 'inner' ? innerTokenAddress.value : tokenContract.value,
    targetPrice: stopType.value === 'price' ? stopValue.value : 0, // 只有停止条件是价格时才使用
    targetMarketCap: stopType.value === 'marketcap' ? stopValue.value : undefined,
    amountMin: amountMin.value,
    amountMax: amountMax.value,
    stopType: stopType.value,
    stopValue: stopValue.value,
    interval: interval.value,
    threadCount: threadCount.value, // 线程数
    gasPrice: gasPrice.value,
    gasLimit: gasLimit.value,
    sellAll: sellAll.value, // 砸盘时是否卖出全部
    marketType: marketType.value, // 盘口类型
    innerTokenAddress: marketType.value === 'inner' ? innerTokenAddress.value : undefined, // 内盘代币地址
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
  const marketTypeText = marketType.value === 'inner' ? '内盘' : '外盘';
  alert(`任务 "${task.name}" 创建成功！\n\n盘口: ${marketTypeText}\n钱包数量: ${finalWalletAddresses.value.length}\n点击任务卡片上的"开始"按钮启动任务。`);
}
</script>

<style scoped>
.task-config-form {
  font-size: 0.875rem;
}
</style>

