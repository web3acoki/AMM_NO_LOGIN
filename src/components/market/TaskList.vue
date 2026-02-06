<template>
  <div class="task-list">
    <div class="row g-3">
      <!-- 左侧：新建任务表单 -->
      <div class="col-lg-3">
        <div class="sticky-top" style="top: 1rem;">
          <TaskConfigForm />
        </div>
      </div>

      <!-- 右侧：任务列表（拉盘和砸盘分开） -->
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
          </div>
        </div>

        <div v-if="tasks.length > 0" class="row g-3">
          <!-- 拉盘任务（左列） -->
          <div class="col-md-6">
            <div class="task-column pump-column">
              <div class="column-header pump-header">
                <i class="bi bi-graph-up-arrow me-1"></i>
                拉盘任务
                <span class="badge bg-success ms-1">{{ pumpTasks.length }}</span>
                <span v-if="runningPumpCount > 0" class="badge bg-light text-success ms-1">{{ runningPumpCount }} 运行</span>
              </div>
              <div class="task-cards-container">
                <TaskCard
                  v-for="task in pumpTasks"
                  :key="task.id"
                  :task="task"
                  :selected="selectedTaskIds.includes(task.id)"
                  @toggle-select="toggleTaskSelect(task.id)"
                  @edit="handleEditTask"
                />
                <div v-if="pumpTasks.length === 0" class="text-center text-muted py-4">
                  <i class="bi bi-inbox d-block mb-1"></i>
                  <small>暂无拉盘任务</small>
                </div>
              </div>
            </div>
          </div>

          <!-- 砸盘任务（右列） -->
          <div class="col-md-6">
            <div class="task-column dump-column">
              <div class="column-header dump-header">
                <i class="bi bi-graph-down-arrow me-1"></i>
                砸盘任务
                <span class="badge bg-danger ms-1">{{ dumpTasks.length }}</span>
                <span v-if="runningDumpCount > 0" class="badge bg-light text-danger ms-1">{{ runningDumpCount }} 运行</span>
              </div>
              <div class="task-cards-container">
                <TaskCard
                  v-for="task in dumpTasks"
                  :key="task.id"
                  :task="task"
                  :selected="selectedTaskIds.includes(task.id)"
                  @toggle-select="toggleTaskSelect(task.id)"
                  @edit="handleEditTask"
                />
                <div v-if="dumpTasks.length === 0" class="text-center text-muted py-4">
                  <i class="bi bi-inbox d-block mb-1"></i>
                  <small>暂无砸盘任务</small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="text-center text-muted py-5">
          <i class="bi bi-inbox fs-1 d-block mb-2"></i>
          <p class="mb-0">暂无任务，请在左侧创建新任务</p>
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
const runningCount = computed(() => runningTasks.value.length);

// 拉盘任务
const pumpTasks = computed(() => tasks.value.filter(t => t.mode === 'pump'));
// 砸盘任务
const dumpTasks = computed(() => tasks.value.filter(t => t.mode === 'dump'));

// 运行中的拉盘任务数
const runningPumpCount = computed(() => pumpTasks.value.filter(t => t.status === 'running').length);
// 运行中的砸盘任务数
const runningDumpCount = computed(() => dumpTasks.value.filter(t => t.status === 'running').length);

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
.task-column {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 0.5rem;
  overflow: hidden;
}

.column-header {
  padding: 0.75rem 1rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.pump-header {
  background: rgba(25, 135, 84, 0.2);
  color: #198754;
  border-bottom: 2px solid rgba(25, 135, 84, 0.3);
}

.dump-header {
  background: rgba(220, 53, 69, 0.2);
  color: #dc3545;
  border-bottom: 2px solid rgba(220, 53, 69, 0.3);
}

.task-cards-container {
  padding: 0.5rem;
  min-height: 200px;
  max-height: 600px;
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
