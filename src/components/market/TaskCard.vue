<template>
  <div class="task-card border rounded px-2 py-2 mb-2" :class="[statusClass, { 'border-info border-2': selected }]">
    <!-- 任务头部 -->
    <div class="d-flex justify-content-between align-items-center mb-1">
      <div class="d-flex align-items-center gap-2">
        <input
          type="checkbox"
          class="form-check-input"
          :checked="selected"
          @change="$emit('toggle-select')"
        >
        <span class="badge" :class="threadBadgeClass">
          买{{ task.config.buyThreadCount || 0 }}/卖{{ task.config.sellThreadCount || 0 }}
        </span>
        <span class="badge bg-dark">{{ chainLabel }}</span>
        <span v-if="task.config.marketType === 'inner'" class="badge bg-info">{{ task.config.chainId === 4663 ? 'Pons' : '内盘' }}</span>
        <span v-if="task.config.poolBaseToken" class="badge bg-warning text-dark">ASTER底池</span>
        <strong class="small">{{ task.name }}</strong>
      </div>
      <span class="badge" :class="statusBadgeClass">
        <i class="bi me-1" :class="statusIcon"></i>
        {{ statusText }}
      </span>
    </div>

    <!-- 代币地址 -->
    <div class="small mb-1 token-address-wrap">
      <code class="token-address" @mouseenter="showFullAddress = true" @mouseleave="showFullAddress = false">
        <i class="bi bi-coin me-1"></i>{{ showFullAddress ? tokenAddress : formatTokenAddress(tokenAddress) }}
      </code>
      <button
        class="btn btn-link btn-sm p-0 ms-1 copy-btn"
        @click="copyTokenAddress"
        title="复制地址"
      >
        <i class="bi bi-clipboard"></i>
      </button>
    </div>

    <!-- 任务信息（单行紧凑） -->
    <div class="small text-muted mb-1">
      <div class="d-flex flex-wrap gap-2">
        <span><i class="bi bi-wallet2 me-1"></i>{{ task.walletAddresses.length }}钱包</span>
        <span><i class="bi bi-clock me-1"></i>{{ task.config.interval }}s</span>
        <span>
          <i class="bi bi-stop-circle me-1"></i>{{ stopConditionText }}
        </span>
        <span>买:{{ task.stats.buyCount }}次</span>
        <span>卖:{{ task.stats.sellCount }}次</span>
        <span>花费:{{ task.stats.spentAmount.toFixed(4) }} {{ task.config.poolBaseToken ? 'ASTER' : nativeSymbol }}</span>
        <span>{{ formatTime(task.stats.elapsedTime) }}</span>
      </div>
    </div>

    <!-- 进度条（非价格停止条件时显示，且不是none类型） -->
    <div v-if="task.config.stopType !== 'price' && task.config.stopType !== 'none'" class="progress mb-1" style="height: 3px;">
      <div
        class="progress-bar"
        :class="task.status === 'running' ? 'progress-bar-striped progress-bar-animated' : ''"
        :style="{ width: progressPercent + '%' }"
      ></div>
    </div>

    <!-- 操作按钮 -->
    <div class="d-flex gap-1 flex-wrap align-items-center">
      <!-- 主操作按钮 -->
      <button
        v-if="task.status === 'stopped' || task.status === 'paused'"
        class="btn btn-success btn-sm"
        @click="handleStart"
        :disabled="isBatchSelling"
      >
        <i class="bi bi-play-fill me-1"></i>{{ task.status === 'paused' ? '继续' : '开始' }}
      </button>

      <button
        v-if="task.status === 'running'"
        class="btn btn-warning btn-sm"
        @click="handlePause"
      >
        <i class="bi bi-pause-fill me-1"></i>暂停
      </button>

      <button
        v-if="task.status === 'running' || task.status === 'paused' || task.remoteRuntimeActive"
        class="btn btn-danger btn-sm"
        @click="handleStop"
        :title="task.remoteRuntimeActive && task.status === 'stopped' ? '撤销服务端仍在运行的任务实例' : '停止任务'"
      >
        <i class="bi bi-stop-fill me-1"></i>{{ task.remoteRuntimeActive && task.status === 'stopped' ? '强制停止' : '停止' }}
      </button>

      <div class="flex-grow-1"></div>

      <!-- 辅助操作按钮 -->
      <button
        class="btn btn-outline-info btn-sm"
        @click="handleQueryBalances"
        :disabled="isQuerying"
        title="查询代币余额"
      >
        <i class="bi bi-search me-1"></i>余额
      </button>

      <button
        class="btn btn-outline-danger btn-sm"
        @click="handleBatchSell"
        :disabled="isBatchSelling"
        title="批量卖出所有钱包的代币；其他任务只跳过共用源钱包，其余钱包继续运行"
      >
        <i class="bi bi-cash-stack me-1"></i>{{ isBatchSelling ? '卖出中' : '批量卖' }}
      </button>

      <button
        class="btn btn-outline-secondary btn-sm"
        @click="handleViewLogs"
        title="查看日志"
        :class="{ 'active': isActiveLog }"
      >
        <i class="bi bi-journal-text me-1"></i>日志
      </button>

      <button
        v-if="task.status === 'paused' || task.status === 'stopped'"
        class="btn btn-outline-primary btn-sm"
        @click="handleEdit"
        title="编辑任务"
      >
        <i class="bi bi-pencil me-1"></i>编辑
      </button>

      <button
        v-if="task.status === 'stopped'"
        class="btn btn-outline-danger btn-sm"
        @click="handleDelete"
        title="删除任务"
      >
        <i class="bi bi-trash me-1"></i>删除
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTaskStore, type Task } from '../../stores/taskStore';
import { storeToRefs } from 'pinia';

const props = defineProps<{
  task: Task;
  selected?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-select'): void;
  (e: 'edit', task: Task): void;
}>();

const taskStore = useTaskStore();
const { activeLogTaskId } = storeToRefs(taskStore);

const isQuerying = ref(false);
const isBatchSelling = ref(false);
const showFullAddress = ref(false);

// 计算属性
const isActiveLog = computed(() => activeLogTaskId.value === props.task.id);
const nativeSymbol = computed(() => props.task.config.chainId === 4663 ? 'ETH' : props.task.config.chainId === 66 ? 'OKB' : 'BNB');
const chainLabel = computed(() => props.task.config.chainId === 4663 ? 'Robinhood 4663' : props.task.config.chainId === 97 ? 'BSC Testnet' : props.task.config.chainId === 66 ? 'OKX 66' : 'BSC 56');

// 获取代币地址（内盘优先用 innerTokenAddress，外盘用 tokenContract）
const tokenAddress = computed(() => {
  if (props.task.config.marketType === 'inner') {
    return props.task.config.innerTokenAddress || props.task.config.tokenContract || '';
  }
  return props.task.config.tokenContract || '';
});

// 格式化代币地址显示
function formatTokenAddress(address: string): string {
  if (!address) return '未设置';
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

// 复制代币地址
function copyTokenAddress() {
  if (!tokenAddress.value) return;
  navigator.clipboard.writeText(tokenAddress.value).then(() => {
    alert('代币地址已复制');
  }).catch(() => {
    // 降级方案
    const input = document.createElement('input');
    input.value = tokenAddress.value;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    alert('代币地址已复制');
  });
}

const statusClass = computed(() => {
  switch (props.task.status) {
    case 'running': return 'border-success bg-success bg-opacity-10';
    case 'paused': return 'border-warning bg-warning bg-opacity-10';
    case 'stopped': return 'border-secondary';
    default: return '';
  }
});

const statusBadgeClass = computed(() => {
  switch (props.task.status) {
    case 'running': return 'bg-success';
    case 'paused': return 'bg-warning';
    case 'stopped': return 'bg-secondary';
    default: return 'bg-secondary';
  }
});

const statusIcon = computed(() => {
  switch (props.task.status) {
    case 'running': return 'bi-play-circle-fill';
    case 'paused': return 'bi-pause-circle-fill';
    case 'stopped': return 'bi-stop-circle-fill';
    default: return 'bi-circle';
  }
});

const statusText = computed(() => {
  switch (props.task.status) {
    case 'running': return '运行中';
    case 'paused': return '已暂停';
    case 'stopped': return '已停止';
    default: return '未知';
  }
});

// 根据买卖线程数显示不同颜色
const threadBadgeClass = computed(() => {
  const buy = props.task.config.buyThreadCount || 0;
  const sell = props.task.config.sellThreadCount || 0;
  if (buy > 0 && sell > 0) return 'bg-primary';  // 混合买卖
  if (buy > 0) return 'bg-success';               // 纯买入
  return 'bg-danger';                              // 纯卖出
});

const stopConditionText = computed(() => {
  return taskStore.getStopConditionText(props.task);
});

const progressPercent = computed(() => {
  return taskStore.getTaskProgress(props.task);
});

// 格式化时间
function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// 操作方法
function handleStart() {
  if (props.task.status === 'paused') {
    taskStore.resumeTask(props.task.id);
  } else {
    taskStore.startTask(props.task.id);
  }
}

function handlePause() {
  taskStore.pauseTask(props.task.id);
}

function handleStop() {
  if (confirm(`确定要停止任务 "${props.task.name}" 吗？`)) {
    taskStore.stopTask(props.task.id, undefined, { forceServer: true });
  }
}

async function handleDelete() {
  if (confirm(`确定要删除任务 "${props.task.name}" 吗？\n\n删除后无法恢复。`)) {
    await taskStore.deleteTask(props.task.id);
  }
}

function handleViewLogs() {
  taskStore.setActiveLogTask(props.task.id);
}

function handleEdit() {
  emit('edit', props.task);
}

async function handleQueryBalances() {
  isQuerying.value = true;
  taskStore.setActiveLogTask(props.task.id);
  try {
    const results = await taskStore.queryTaskTokenBalances(props.task.id);
    // 显示查询结果弹窗
    const walletsWithBalance = results.filter(r => r.rawBalance > 0n);
    const totalBalance = results.reduce((sum, r) => {
      const val = parseFloat(r.balance) || 0;
      return sum + val;
    }, 0);

    let msg = `代币余额查询完成\n\n`;
    msg += `总钱包数: ${results.length}\n`;
    msg += `有余额钱包: ${walletsWithBalance.length}\n`;
    msg += `总余额: ${totalBalance.toFixed(6)}\n\n`;

    if (walletsWithBalance.length > 0 && walletsWithBalance.length <= 10) {
      msg += `有余额的钱包:\n`;
      for (const w of walletsWithBalance) {
        msg += `${w.address.slice(0, 10)}... : ${parseFloat(w.balance).toFixed(6)}\n`;
      }
    } else if (walletsWithBalance.length > 10) {
      msg += `(详细列表请查看日志面板)`;
    }

    alert(msg);
  } finally {
    isQuerying.value = false;
  }
}

async function handleBatchSell() {
  const runningNotice = props.task.status === 'running'
    ? '\n\n当前任务会先暂停并在卖出后保持暂停。其他任务不会整项暂停：只会暂时跳过本批占用的源钱包，并继续使用各自其余钱包；同代币但钱包不同的任务完全不受影响。'
    : '\n\n其他运行中任务不会整项暂停：只会暂时跳过本批占用的源钱包，并继续使用各自其余钱包。';
  if (!confirm(
    `确定要批量卖出任务 "${props.task.name}" 所有钱包的全部代币吗？`
    + `${runningNotice}\n\n系统只获取相关源钱包锁，并逐笔使用最新链上状态报价、动态滑点保护和最终确认；不会锁住整个代币市场。待确认/未知时持续只读对账，不会盲目重发。`,
  )) return;
  isBatchSelling.value = true;
  taskStore.setActiveLogTask(props.task.id);
  try {
    await taskStore.batchSellForTask(props.task.id);
  } catch (error: any) {
    console.error('批量卖出异常:', error);
    alert(`批量卖出失败: ${error.message || '未知错误'}`);
  } finally {
    isBatchSelling.value = false;
  }
}
</script>

<style scoped>
.task-card {
  transition: all 0.2s ease;
}

.task-card:hover {
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}

.btn-sm {
  padding: 0.2rem 0.4rem;
  font-size: 0.75rem;
}

.token-address-wrap {
  display: flex;
  align-items: center;
}

.token-address {
  font-size: 0.75rem;
  color: #ccc;
  background: #2a2a2a;
  border: 1px solid #444;
  padding: 0.2rem 0.5rem;
  border-radius: 0.25rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.token-address:hover {
  color: #fff;
  background: #333;
  border-color: #555;
}

.copy-btn {
  color: #888;
  font-size: 0.7rem;
}

.copy-btn:hover {
  color: #aaa;
}
</style>
