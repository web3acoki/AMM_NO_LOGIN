<template>
  <div class="task-log-panel">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <h6 class="fw-semibold mb-0">
        <i class="bi bi-journal-text me-1"></i>任务日志
      </h6>
      
      <!-- 任务切换标签 -->
      <div v-if="tasks.length > 0" class="btn-group btn-group-sm">
        <button 
          v-for="task in tasks" 
          :key="task.id"
          class="btn btn-outline-secondary"
          :class="{ 'active': activeLogTaskId === task.id }"
          @click="setActiveLogTask(task.id)"
          :title="task.name"
        >
          <span class="badge me-1" :class="getTaskStatusBadge(task)">
            {{ getTaskStatusIcon(task) }}
          </span>
          {{ task.name.length > 6 ? task.name.slice(0, 6) + '...' : task.name }}
        </button>
      </div>
    </div>

    <!-- 当前任务信息 -->
    <div v-if="activeLogTask" class="mb-2 d-flex justify-content-between align-items-center">
      <span class="small text-muted">
        <span class="badge" :class="getTaskModeBadge(activeLogTask)">
          {{ activeLogTask.mode === 'pump' ? '拉盘' : '砸盘' }}
        </span>
        {{ activeLogTask.name }} - {{ activeLogTask.logs.length }} 条日志
      </span>
      <button class="btn btn-outline-secondary btn-sm" @click="clearLogs" title="清空日志">
        <i class="bi bi-trash"></i>
      </button>
    </div>

    <!-- 日志内容 -->
    <div class="log-container border rounded p-2" ref="logContainer">
      <div v-if="!activeLogTask || activeLogTask.logs.length === 0" class="text-center text-muted py-4">
        <i class="bi bi-inbox fs-3 d-block mb-2"></i>
        <small>{{ !activeLogTask ? '请选择一个任务查看日志' : '暂无日志' }}</small>
      </div>
      
      <div v-else class="log-entries">
        <div 
          v-for="log in activeLogTask.logs" 
          :key="log.id"
          class="log-entry small py-1 border-bottom"
          :class="getLogClass(log.type)"
        >
          <span class="log-time text-muted me-2">{{ formatTime(log.timestamp) }}</span>
          <span class="log-icon me-1">{{ getLogIcon(log.type) }}</span>
          <span v-if="log.walletAddress" class="log-wallet me-1">
            <code class="text-primary">{{ formatAddress(log.walletAddress) }}</code>
          </span>
          <span class="log-message">{{ log.message }}</span>
          <a 
            v-if="log.txHash" 
            :href="getExplorerUrl(log.txHash)" 
            target="_blank" 
            class="ms-1 text-decoration-none"
            title="查看交易"
          >
            <i class="bi bi-box-arrow-up-right"></i>
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useTaskStore, type Task, type LogEntry } from '../../stores/taskStore';
import { useChainStore } from '../../stores/chainStore';
import { storeToRefs } from 'pinia';

const taskStore = useTaskStore();
const chainStore = useChainStore();

const { tasks, activeLogTaskId, activeLogTask } = storeToRefs(taskStore);
const { selectedChainId } = storeToRefs(chainStore);

const logContainer = ref<HTMLElement | null>(null);

// 监听日志变化，自动滚动到底部
watch(
  () => activeLogTask.value?.logs.length,
  () => {
    nextTick(() => {
      if (logContainer.value) {
        logContainer.value.scrollTop = logContainer.value.scrollHeight;
      }
    });
  }
);

// 设置当前查看的任务
function setActiveLogTask(taskId: string) {
  taskStore.setActiveLogTask(taskId);
}

// 清空日志
function clearLogs() {
  if (activeLogTaskId.value) {
    taskStore.clearTaskLogs(activeLogTaskId.value);
  }
}

// 获取任务状态徽章样式
function getTaskStatusBadge(task: Task): string {
  switch (task.status) {
    case 'running': return 'bg-success';
    case 'paused': return 'bg-warning';
    case 'stopped': return 'bg-secondary';
    default: return 'bg-secondary';
  }
}

// 获取任务状态图标
function getTaskStatusIcon(task: Task): string {
  switch (task.status) {
    case 'running': return '▶';
    case 'paused': return '⏸';
    case 'stopped': return '⏹';
    default: return '○';
  }
}

// 获取任务模式徽章样式
function getTaskModeBadge(task: Task): string {
  return task.mode === 'pump' ? 'bg-success' : 'bg-danger';
}

// 获取日志样式
function getLogClass(type: LogEntry['type']): string {
  switch (type) {
    case 'success': return 'text-success';
    case 'error': return 'text-danger';
    case 'warning': return 'text-warning';
    default: return '';
  }
}

// 获取日志图标
function getLogIcon(type: LogEntry['type']): string {
  switch (type) {
    case 'success': return '✓';
    case 'error': return '✗';
    case 'warning': return '⚠';
    default: return '•';
  }
}

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
}

// 格式化地址
function formatAddress(address: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 获取区块浏览器链接
function getExplorerUrl(txHash: string): string {
  const explorers: Record<number, string> = {
    56: 'https://bscscan.com/tx/',
    97: 'https://testnet.bscscan.com/tx/',
    66: 'https://www.oklink.com/okc/tx/'
  };
  return (explorers[selectedChainId.value] || 'https://bscscan.com/tx/') + txHash;
}
</script>

<style scoped>
.log-container {
  height: 250px;
  overflow-y: auto;
  background-color: #1a1a2e;
  color: #eee;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.75rem;
}

.log-entry {
  border-bottom-color: #333 !important;
}

.log-time {
  color: #888;
}

.log-icon {
  font-weight: bold;
}

.log-wallet code {
  background: transparent;
  color: #64b5f6;
}

.text-success .log-icon {
  color: #4caf50;
}

.text-danger .log-icon {
  color: #f44336;
}

.text-warning .log-icon {
  color: #ff9800;
}

.btn-group .btn.active {
  background-color: var(--bs-primary);
  color: white;
}

.log-container::-webkit-scrollbar {
  width: 6px;
}

.log-container::-webkit-scrollbar-thumb {
  background-color: #444;
  border-radius: 3px;
}

.log-container::-webkit-scrollbar-track {
  background-color: #222;
}
</style>

