<template>
  <div class="snipe-panel">
    <!-- 标题 -->
    <div class="panel-header">
      <h5 class="mb-0">
        <i class="bi bi-crosshair me-2"></i>
        代币狙击
      </h5>
      <span class="badge bg-secondary">FourMeme 内盘</span>
    </div>

    <div class="panel-body">
      <!-- 创建任务表单 -->
      <div class="task-form card mb-3">
        <div class="card-header">
          <h6 class="mb-0">创建狙击任务</h6>
        </div>
        <div class="card-body">
          <!-- 目标钱包地址 -->
          <div class="mb-3">
            <label class="form-label">目标钱包地址</label>
            <input
              type="text"
              class="form-control form-control-sm"
              v-model="formData.targetWallet"
              placeholder="输入要监听的钱包地址 (0x...)"
            />
            <small class="text-muted">监听此钱包创建的代币</small>
          </div>

          <!-- 买入金额 -->
          <div class="mb-3">
            <label class="form-label">买入金额 (BNB)</label>
            <input
              type="number"
              class="form-control form-control-sm"
              v-model.number="formData.buyAmount"
              placeholder="0.1"
              step="0.01"
              min="0.001"
            />
            <small class="text-muted">每个钱包的买入金额</small>
          </div>

          <!-- Gas 设置 -->
          <div class="row mb-3">
            <div class="col-6">
              <label class="form-label">Gas Price (Gwei)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="formData.gasPrice"
                placeholder="0 = 自动"
                step="1"
                min="0"
              />
              <small class="text-muted">0 表示自动估算</small>
            </div>
            <div class="col-6">
              <label class="form-label">Gas Limit</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="formData.gasLimit"
                placeholder="0 = 自动"
                step="10000"
                min="0"
              />
              <small class="text-muted">0 表示自动估算</small>
            </div>
          </div>

          <!-- 执行钱包选择 -->
          <div class="mb-3">
            <label class="form-label">执行钱包</label>
            <div class="wallet-select">
              <!-- 选择方式 -->
              <div class="btn-group btn-group-sm w-100 mb-2">
                <button
                  type="button"
                  class="btn"
                  :class="walletSelectMode === 'selected' ? 'btn-primary' : 'btn-outline-primary'"
                  @click="walletSelectMode = 'selected'"
                >
                  已勾选钱包 ({{ walletStore.selectedWalletAddresses.length }})
                </button>
                <button
                  type="button"
                  class="btn"
                  :class="walletSelectMode === 'batch' ? 'btn-primary' : 'btn-outline-primary'"
                  @click="walletSelectMode = 'batch'"
                >
                  钱包批次
                </button>
              </div>

              <!-- 批次选择 -->
              <div v-if="walletSelectMode === 'batch'" class="batch-select">
                <select class="form-select form-select-sm" v-model="formData.batchId">
                  <option value="">选择批次...</option>
                  <option
                    v-for="batch in walletStore.walletBatches"
                    :key="batch.id"
                    :value="batch.id"
                  >
                    {{ batch.remark }} ({{ batch.wallets.length }} 个钱包)
                  </option>
                </select>
              </div>

              <!-- 已选钱包预览 -->
              <div v-else class="selected-preview">
                <div v-if="walletStore.selectedWalletAddresses.length === 0" class="text-muted small">
                  请在钱包管理中勾选要使用的钱包
                </div>
                <div v-else class="small text-muted">
                  已选择 {{ walletStore.selectedWalletAddresses.length }} 个钱包
                </div>
              </div>
            </div>
          </div>

          <!-- 创建按钮 -->
          <button
            class="btn btn-primary w-100"
            @click="createTask"
            :disabled="!canCreateTask"
          >
            <i class="bi bi-plus-circle me-1"></i>
            创建任务
          </button>
        </div>
      </div>

      <!-- 任务列表 -->
      <div class="task-list card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">任务列表</h6>
          <span class="badge bg-info">{{ snipeStore.tasks.length }}</span>
        </div>
        <div class="card-body p-0">
          <div v-if="snipeStore.tasks.length === 0" class="text-center text-muted py-4">
            暂无任务
          </div>
          <div v-else class="list-group list-group-flush">
            <div
              v-for="task in snipeStore.tasks"
              :key="task.id"
              class="list-group-item task-item"
              :class="{ active: snipeStore.currentTaskId === task.id }"
              @click="snipeStore.selectTask(task.id)"
            >
              <div class="d-flex justify-content-between align-items-start">
                <div class="task-info">
                  <div class="task-target text-truncate" style="max-width: 180px;">
                    <i class="bi bi-crosshair me-1"></i>
                    {{ task.targetWallet.slice(0, 10) }}...{{ task.targetWallet.slice(-6) }}
                  </div>
                  <div class="task-meta small text-muted">
                    {{ task.buyAmount }} BNB · {{ task.wallets.length }} 钱包
                  </div>
                </div>
                <div class="task-actions">
                  <!-- 状态徽章 -->
                  <span
                    class="badge me-1"
                    :class="getStatusBadgeClass(task.status)"
                  >
                    {{ getStatusText(task.status) }}
                  </span>
                  <!-- 操作按钮 -->
                  <div class="btn-group btn-group-sm">
                    <button
                      v-if="task.status === 'pending' || task.status === 'stopped'"
                      class="btn btn-success btn-sm"
                      @click.stop="startTask(task.id)"
                      title="启动"
                    >
                      <i class="bi bi-play-fill"></i>
                    </button>
                    <button
                      v-if="task.status === 'running'"
                      class="btn btn-warning btn-sm"
                      @click.stop="stopTask(task.id)"
                      title="停止"
                    >
                      <i class="bi bi-stop-fill"></i>
                    </button>
                    <button
                      class="btn btn-danger btn-sm"
                      @click.stop="deleteTask(task.id)"
                      title="删除"
                    >
                      <i class="bi bi-trash"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 日志面板 -->
      <div class="log-panel card">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-terminal me-1"></i>
            运行日志
          </h6>
          <button
            v-if="currentLogs.length > 0"
            class="btn btn-sm btn-outline-secondary"
            @click="clearLogs"
          >
            清空
          </button>
        </div>
        <div class="card-body log-body" ref="logContainer">
          <div v-if="currentLogs.length === 0" class="text-center text-muted py-3">
            暂无日志
          </div>
          <div v-else class="log-entries">
            <div
              v-for="(log, index) in currentLogs"
              :key="index"
              class="log-entry"
              :class="'log-' + log.type"
            >
              <span class="log-time">{{ formatTime(log.timestamp) }}</span>
              <span class="log-type">[{{ log.type.toUpperCase() }}]</span>
              <span class="log-message">{{ log.message }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useSnipeStore } from '../../stores/snipeStore';
import { useWalletStore } from '../../stores/walletStore';

const snipeStore = useSnipeStore();
const walletStore = useWalletStore();

// 表单数据
const formData = ref({
  targetWallet: '',
  buyAmount: 0.1,
  gasPrice: 0,
  gasLimit: 0,
  batchId: ''
});

// 钱包选择模式
const walletSelectMode = ref<'selected' | 'batch'>('selected');

// 日志容器引用
const logContainer = ref<HTMLElement | null>(null);

// 当前日志
const currentLogs = computed(() => {
  if (!snipeStore.currentTaskId) return [];
  return snipeStore.getTaskLogs(snipeStore.currentTaskId);
});

// 是否可以创建任务
const canCreateTask = computed(() => {
  if (!formData.value.targetWallet || !formData.value.targetWallet.match(/^0x[a-fA-F0-9]{40}$/)) {
    return false;
  }
  if (formData.value.buyAmount <= 0) {
    return false;
  }
  if (walletSelectMode.value === 'selected' && walletStore.selectedWalletAddresses.length === 0) {
    return false;
  }
  if (walletSelectMode.value === 'batch' && !formData.value.batchId) {
    return false;
  }
  return true;
});

// 创建任务
function createTask() {
  if (!canCreateTask.value) return;

  const task = snipeStore.createTask({
    targetWallet: formData.value.targetWallet,
    buyAmount: formData.value.buyAmount,
    gasPrice: formData.value.gasPrice,
    gasLimit: formData.value.gasLimit,
    batchId: walletSelectMode.value === 'batch' ? formData.value.batchId : undefined
  });

  // 选中新创建的任务
  snipeStore.selectTask(task.id);

  // 清空表单
  formData.value.targetWallet = '';
}

// 启动任务
async function startTask(taskId: string) {
  await snipeStore.startTask(taskId);
}

// 停止任务
function stopTask(taskId: string) {
  snipeStore.stopTask(taskId);
}

// 删除任务
function deleteTask(taskId: string) {
  if (confirm('确定要删除此任务吗？')) {
    snipeStore.deleteTask(taskId);
  }
}

// 清空日志
function clearLogs() {
  if (snipeStore.currentTaskId) {
    snipeStore.clearLogs(snipeStore.currentTaskId);
  }
}

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

// 获取状态徽章样式
function getStatusBadgeClass(status: string): string {
  const classes: Record<string, string> = {
    pending: 'bg-secondary',
    running: 'bg-success',
    completed: 'bg-primary',
    failed: 'bg-danger',
    stopped: 'bg-warning'
  };
  return classes[status] || 'bg-secondary';
}

// 获取状态文本
function getStatusText(status: string): string {
  const texts: Record<string, string> = {
    pending: '待启动',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止'
  };
  return texts[status] || status;
}

// 监听日志变化，自动滚动到底部
watch(currentLogs, async () => {
  await nextTick();
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
}, { deep: true });
</script>

<style scoped>
.snipe-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-header {
  padding: 1rem;
  background: var(--bs-dark);
  border-bottom: 1px solid var(--bs-border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.task-form .card-header,
.task-list .card-header,
.log-panel .card-header {
  background: rgba(255, 255, 255, 0.05);
  padding: 0.75rem 1rem;
}

.task-item {
  cursor: pointer;
  transition: background-color 0.2s;
}

.task-item:hover {
  background-color: rgba(255, 255, 255, 0.05);
}

.task-item.active {
  background-color: rgba(var(--bs-primary-rgb), 0.15);
  border-left: 3px solid var(--bs-primary);
}

.task-info {
  flex: 1;
  min-width: 0;
}

.task-target {
  font-family: monospace;
  font-size: 0.9rem;
}

.log-body {
  height: 250px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 0.8rem;
  background: #1a1a1a;
  padding: 0.5rem;
}

.log-entry {
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.log-time {
  color: #888;
  margin-right: 0.5rem;
}

.log-type {
  margin-right: 0.5rem;
  font-weight: bold;
}

.log-info .log-type {
  color: #17a2b8;
}

.log-success .log-type {
  color: #28a745;
}

.log-error .log-type {
  color: #dc3545;
}

.log-warning .log-type {
  color: #ffc107;
}

.log-message {
  color: #e0e0e0;
}

.wallet-select {
  background: rgba(255, 255, 255, 0.03);
  padding: 0.75rem;
  border-radius: 0.25rem;
}
</style>
