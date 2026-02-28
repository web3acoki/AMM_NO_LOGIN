<template>
  <div class="task-list">
    <div class="row g-3">
      <!-- 左侧：新建任务表单 -->
      <div class="col-lg-3">
        <div class="sticky-top" style="top: 1rem;">
          <TaskConfigForm />
        </div>
      </div>

      <!-- 右侧：任务列表（单列展示） -->
      <div class="col-lg-9">
        <!-- 批量操作栏 -->
        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
          <div class="d-flex align-items-center gap-2">
            <h6 class="fw-semibold mb-0">
              <i class="bi bi-list-task me-1"></i>任务列表
              <span class="badge bg-primary ms-1">{{ tasks.length }}</span>
              <span v-if="runningCount > 0" class="badge bg-success ms-1">{{ runningCount }} 运行中</span>
              <span v-if="selectedTaskIds.length > 0" class="badge bg-info ms-1">已选 {{ selectedTaskIds.length }}</span>
            </h6>
          </div>
          <div class="d-flex gap-2 flex-wrap">
            <button class="btn btn-outline-secondary btn-sm" @click="toggleSelectAll">
              <i class="bi" :class="isAllSelected ? 'bi-check-square' : 'bi-square'"></i>
              {{ isAllSelected ? '取消全选' : '全选' }}
            </button>
            <button class="btn btn-outline-secondary btn-sm" @click="selectStopped" :disabled="stoppedTasks.length === 0">
              <i class="bi bi-stop-circle me-1"></i>选已停止
            </button>
            <button
              class="btn btn-outline-danger btn-sm"
              @click="deleteSelectedTasks"
              :disabled="deletableSelectedCount === 0"
            >
              <i class="bi bi-trash me-1"></i>删除 ({{ deletableSelectedCount }})
            </button>
            <button
              class="btn btn-success btn-sm"
              @click="startSelectedTasks"
              :disabled="startableSelectedCount === 0"
            >
              <i class="bi bi-play-fill me-1"></i>启动 ({{ startableSelectedCount }})
            </button>
            <button
              class="btn btn-danger btn-sm"
              @click="stopSelectedTasks"
              :disabled="stoppableSelectedCount === 0"
            >
              <i class="bi bi-stop-fill me-1"></i>停止 ({{ stoppableSelectedCount }})
            </button>
            <button
              class="btn btn-outline-warning btn-sm"
              @click="handleBatchUpdateToken"
              :disabled="innerSelectedCount === 0"
              title="批量更改选中内盘任务的代币地址"
            >
              <i class="bi bi-pencil-square me-1"></i>改地址 ({{ innerSelectedCount }})
            </button>
          </div>
        </div>

        <!-- 筛选标签 -->
        <div class="d-flex gap-2 mb-2" v-if="tasks.length > 0">
          <button
            class="btn btn-sm"
            :class="filterMode === 'all' ? 'btn-primary' : 'btn-outline-primary'"
            @click="filterMode = 'all'"
          >
            全部 ({{ tasks.length }})
          </button>
          <button
            class="btn btn-sm"
            :class="filterMode === 'buy' ? 'btn-success' : 'btn-outline-success'"
            @click="filterMode = 'buy'"
          >
            纯买入 ({{ pureBuyTasks.length }})
          </button>
          <button
            class="btn btn-sm"
            :class="filterMode === 'sell' ? 'btn-danger' : 'btn-outline-danger'"
            @click="filterMode = 'sell'"
          >
            纯卖出 ({{ pureSellTasks.length }})
          </button>
          <button
            class="btn btn-sm"
            :class="filterMode === 'mixed' ? 'btn-info' : 'btn-outline-info'"
            @click="filterMode = 'mixed'"
          >
            混合买卖 ({{ mixedTasks.length }})
          </button>
        </div>

        <div v-if="filteredTasks.length > 0" class="task-cards-container">
          <TaskCard
            v-for="task in filteredTasks"
            :key="task.id"
            :task="task"
            :selected="selectedTaskIds.includes(task.id)"
            @toggle-select="toggleTaskSelect(task.id)"
            @edit="handleEditTask"
          />
        </div>

        <!-- 空状态 -->
        <div v-else-if="tasks.length === 0" class="text-center text-muted py-5">
          <i class="bi bi-inbox fs-1 d-block mb-2"></i>
          <p class="mb-0">暂无任务，请在左侧创建新任务</p>
        </div>
        <div v-else class="text-center text-muted py-4">
          <i class="bi bi-funnel d-block mb-1"></i>
          <small>当前筛选条件下没有任务</small>
        </div>
      </div>
    </div>

    <!-- 任务编辑弹窗 -->
    <TaskEditModal
      v-if="editingTask"
      :task="editingTask"
      @close="handleEditClose"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useTaskStore, type Task } from '../../stores/taskStore';
import { storeToRefs } from 'pinia';
import TaskCard from './TaskCard.vue';
import TaskConfigForm from './TaskConfigForm.vue';
import TaskEditModal from './TaskEditModal.vue';

const taskStore = useTaskStore();
const { tasks, runningTasks } = storeToRefs(taskStore);

const selectedTaskIds = ref<string[]>([]);
const editingTask = ref<Task | null>(null);
const filterMode = ref<'all' | 'buy' | 'sell' | 'mixed'>('all');
const runningCount = computed(() => runningTasks.value.length);

// 纯买入任务（buyThreadCount > 0 且 sellThreadCount === 0）
const pureBuyTasks = computed(() => tasks.value.filter(t =>
  (t.config.buyThreadCount || 0) > 0 && (t.config.sellThreadCount || 0) === 0
));
// 纯卖出任务（sellThreadCount > 0 且 buyThreadCount === 0）
const pureSellTasks = computed(() => tasks.value.filter(t =>
  (t.config.sellThreadCount || 0) > 0 && (t.config.buyThreadCount || 0) === 0
));
// 混合买卖任务（buyThreadCount > 0 且 sellThreadCount > 0）
const mixedTasks = computed(() => tasks.value.filter(t =>
  (t.config.buyThreadCount || 0) > 0 && (t.config.sellThreadCount || 0) > 0
));

// 按筛选模式过滤任务
const filteredTasks = computed(() => {
  switch (filterMode.value) {
    case 'buy': return pureBuyTasks.value;
    case 'sell': return pureSellTasks.value;
    case 'mixed': return mixedTasks.value;
    default: return tasks.value;
  }
});

// 已停止的任务
const stoppedTasks = computed(() => tasks.value.filter(t => t.status === 'stopped'));

// 是否全选
const isAllSelected = computed(() =>
  tasks.value.length > 0 && selectedTaskIds.value.length === tasks.value.length
);

// 选中的可启动任务数量（已停止或已暂停）
const startableSelectedCount = computed(() => {
  return tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    (t.status === 'stopped' || t.status === 'paused')
  ).length;
});

// 选中的可停止任务数量（运行中或已暂停）
const stoppableSelectedCount = computed(() => {
  return tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    (t.status === 'running' || t.status === 'paused')
  ).length;
});

// 选中的可删除任务数量（已停止的任务）
const deletableSelectedCount = computed(() => {
  return tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    t.status === 'stopped'
  ).length;
});

// 选中的内盘任务数量（非运行中）
const innerSelectedCount = computed(() => {
  return tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    t.config.marketType === 'inner' &&
    t.status !== 'running'
  ).length;
});

// 切换任务选择
function toggleTaskSelect(taskId: string) {
  const index = selectedTaskIds.value.indexOf(taskId);
  if (index > -1) {
    selectedTaskIds.value.splice(index, 1);
  } else {
    selectedTaskIds.value.push(taskId);
  }
}

// 全选/取消全选
function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedTaskIds.value = [];
  } else {
    selectedTaskIds.value = tasks.value.map(t => t.id);
  }
}

// 选择所有已停止的任务
function selectStopped() {
  selectedTaskIds.value = stoppedTasks.value.map(t => t.id);
}

// 一键启动选中的任务
function startSelectedTasks() {
  const tasksToStart = tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    (t.status === 'stopped' || t.status === 'paused')
  );

  if (tasksToStart.length === 0) return;

  if (!confirm(`确定要同时启动 ${tasksToStart.length} 个任务吗？`)) return;

  // 同时启动所有选中的任务
  for (const task of tasksToStart) {
    if (task.status === 'paused') {
      taskStore.resumeTask(task.id);
    } else {
      taskStore.startTask(task.id);
    }
  }
}

// 一键停止选中的任务
function stopSelectedTasks() {
  const tasksToStop = tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    (t.status === 'running' || t.status === 'paused')
  );

  if (tasksToStop.length === 0) return;

  if (!confirm(`确定要停止 ${tasksToStop.length} 个任务吗？`)) return;

  // 停止所有选中的任务
  for (const task of tasksToStop) {
    taskStore.stopTask(task.id);
  }
}

// 一键删除选中的任务（仅已停止）
function deleteSelectedTasks() {
  const tasksToDelete = tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    t.status === 'stopped'
  );

  if (tasksToDelete.length === 0) return;

  const runningSelected = tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    t.status !== 'stopped'
  ).length;

  let msg = `确定要删除 ${tasksToDelete.length} 个已停止的任务吗？\n\n删除后无法恢复。`;
  if (runningSelected > 0) {
    msg += `\n\n注意：还有 ${runningSelected} 个运行中/暂停的任务不会被删除。`;
  }

  if (!confirm(msg)) return;

  const idsToDelete = tasksToDelete.map(t => t.id);
  const deleted = taskStore.deleteMultipleTasks(idsToDelete);

  // 清理已删除的选中状态
  selectedTaskIds.value = selectedTaskIds.value.filter(id => !idsToDelete.includes(id));
}

// 批量更改代币地址
function handleBatchUpdateToken() {
  const innerTasks = tasks.value.filter(t =>
    selectedTaskIds.value.includes(t.id) &&
    t.config.marketType === 'inner' &&
    t.status !== 'running'
  );

  if (innerTasks.length === 0) {
    alert('没有可更新的内盘任务（需要选中内盘任务且非运行中状态）');
    return;
  }

  const newAddress = prompt(`批量更改 ${innerTasks.length} 个内盘任务的代币地址\n\n请输入新的代币合约地址：`);
  if (!newAddress) return;

  // 验证地址格式
  if (!/^0x[a-fA-F0-9]{40}$/.test(newAddress)) {
    alert('无效的合约地址格式，请输入正确的 0x 开头的 40 位十六进制地址');
    return;
  }

  const taskIds = innerTasks.map(t => t.id);
  const updatedCount = taskStore.batchUpdateTokenAddress(taskIds, newAddress);

  alert(`已更新 ${updatedCount} 个内盘任务的代币地址`);
}

// 编辑任务
function handleEditTask(task: Task) {
  editingTask.value = task;
}

// 关闭编辑弹窗
function handleEditClose() {
  editingTask.value = null;
}
</script>

<style scoped>
.task-cards-container {
  max-height: 700px;
  overflow-y: auto;
}

.task-cards-container::-webkit-scrollbar {
  width: 6px;
}

.task-cards-container::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.task-cards-container::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
