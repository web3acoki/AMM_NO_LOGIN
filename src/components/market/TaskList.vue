<template>
  <div class="task-list">
    <!-- 任务列表 -->
    <div v-if="tasks.length > 0" class="mb-3">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="fw-semibold mb-0">
          <i class="bi bi-list-task me-1"></i>任务列表
          <span class="badge bg-primary ms-1">{{ tasks.length }}</span>
          <span v-if="runningCount > 0" class="badge bg-success ms-1">{{ runningCount }} 运行中</span>
          <span v-if="selectedTaskIds.length > 0" class="badge bg-info ms-1">已选 {{ selectedTaskIds.length }}</span>
        </h6>
      </div>

      <!-- 批量操作栏 -->
      <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
        <div class="d-flex gap-2">
          <button class="btn btn-outline-secondary btn-sm" @click="toggleSelectAll">
            <i class="bi" :class="isAllSelected ? 'bi-check-square' : 'bi-square'"></i>
            {{ isAllSelected ? '取消全选' : '全选' }}
          </button>
          <button class="btn btn-outline-secondary btn-sm" @click="selectStopped" :disabled="stoppedTasks.length === 0">
            <i class="bi bi-stop-circle me-1"></i>选择已停止
          </button>
        </div>
        <div class="d-flex gap-2">
          <button
            class="btn btn-success btn-sm"
            @click="startSelectedTasks"
            :disabled="startableSelectedCount === 0"
          >
            <i class="bi bi-play-fill me-1"></i>一键启动 ({{ startableSelectedCount }})
          </button>
          <button
            class="btn btn-danger btn-sm"
            @click="stopSelectedTasks"
            :disabled="stoppableSelectedCount === 0"
          >
            <i class="bi bi-stop-fill me-1"></i>一键停止 ({{ stoppableSelectedCount }})
          </button>
        </div>
      </div>

      <div class="task-cards-container" style="max-height: 300px; overflow-y: auto;">
        <TaskCard
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          :selected="selectedTaskIds.includes(task.id)"
          @toggle-select="toggleTaskSelect(task.id)"
          @edit="handleEditTask"
        />
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="text-center text-muted py-3 mb-3">
      <i class="bi bi-inbox fs-1 d-block mb-2"></i>
      <p class="small mb-0">暂无任务，请在下方创建新任务</p>
    </div>

    <hr class="my-3">

    <!-- 新建任务表单 -->
    <TaskConfigForm />

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
const runningCount = computed(() => runningTasks.value.length);

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
.task-cards-container::-webkit-scrollbar {
  width: 4px;
}

.task-cards-container::-webkit-scrollbar-thumb {
  background-color: #ccc;
  border-radius: 2px;
}
</style>

