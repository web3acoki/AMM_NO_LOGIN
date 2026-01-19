<template>
  <div class="task-card border rounded p-2 mb-2" :class="[statusClass, { 'border-info border-2': selected }]">
    <!-- 任务头部 -->
    <div class="d-flex justify-content-between align-items-center mb-2">
      <div class="d-flex align-items-center gap-2">
        <input
          type="checkbox"
          class="form-check-input"
          :checked="selected"
          @change="$emit('toggle-select')"
        >
        <span class="badge" :class="modeBadgeClass">
          {{ task.mode === 'pump' ? '拉盘' : '砸盘' }}
        </span>
        <strong class="small">{{ task.name }}</strong>
      </div>
      <span class="badge" :class="statusBadgeClass">
        <i class="bi me-1" :class="statusIcon"></i>
        {{ statusText }}
      </span>
    </div>

    <!-- 任务信息 -->
    <div class="small text-muted mb-2">
      <div class="d-flex flex-wrap gap-2">
        <span><i class="bi bi-wallet2 me-1"></i>{{ task.walletAddresses.length }} 钱包</span>
        <span><i class="bi bi-arrow-repeat me-1"></i>{{ task.config.walletMode === 'parallel' ? '同时' : '顺序' }}</span>
        <span><i class="bi bi-clock me-1"></i>{{ task.config.interval }}s</span>
      </div>
      <div class="mt-1">
        <span class="me-2">
          <i class="bi bi-stop-circle me-1"></i>{{ stopConditionText }}
        </span>
      </div>
    </div>

    <!-- 进度条（非价格停止条件时显示） -->
    <div v-if="task.config.stopType !== 'price'" class="progress mb-2" style="height: 4px;">
      <div 
        class="progress-bar" 
        :class="task.status === 'running' ? 'progress-bar-striped progress-bar-animated' : ''"
        :style="{ width: progressPercent + '%' }"
      ></div>
    </div>

    <!-- 统计信息 -->
    <div class="d-flex justify-content-between small text-muted mb-2">
      <span>执行: {{ task.stats.executedCount }} 次</span>
      <span>花费: {{ task.stats.spentAmount.toFixed(4) }} {{ task.config.spendToken }}</span>
      <span>时间: {{ formatTime(task.stats.elapsedTime) }}</span>
    </div>

    <!-- 操作按钮 -->
    <div class="d-flex gap-2 flex-wrap align-items-center">
      <!-- 主操作按钮 -->
      <div class="d-flex gap-1">
        <button
          v-if="task.status === 'stopped' || task.status === 'paused'"
          class="btn btn-success btn-sm"
          @click="handleStart"
        >
          <i class="bi bi-play-fill me-1"></i>
          {{ task.status === 'paused' ? '继续' : '开始' }}
        </button>

        <button
          v-if="task.status === 'running'"
          class="btn btn-warning btn-sm"
          @click="handlePause"
        >
          <i class="bi bi-pause-fill me-1"></i>暂停
        </button>

        <button
          v-if="task.status === 'running' || task.status === 'paused'"
          class="btn btn-danger btn-sm"
          @click="handleStop"
          title="停止任务"
        >
          <i class="bi bi-stop-fill me-1"></i>停止
        </button>
      </div>

      <!-- 分隔 -->
      <div class="flex-grow-1"></div>

      <!-- 辅助操作按钮 -->
      <div class="d-flex gap-2">
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
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

// 计算属性
const isActiveLog = computed(() => activeLogTaskId.value === props.task.id);

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

const modeBadgeClass = computed(() => {
  return props.task.mode === 'pump' ? 'bg-success' : 'bg-danger';
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
    taskStore.stopTask(props.task.id);
  }
}

function handleDelete() {
  if (confirm(`确定要删除任务 "${props.task.name}" 吗？\n\n删除后无法恢复。`)) {
    taskStore.deleteTask(props.task.id);
  }
}

function handleViewLogs() {
  taskStore.setActiveLogTask(props.task.id);
}

function handleEdit() {
  emit('edit', props.task);
}
</script>

<style scoped>
.task-card {
  transition: all 0.2s ease;
}

.task-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.btn-sm {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
}
</style>

