<template>
  <div class="task-list">
    <!-- 任务列表 -->
    <div v-if="tasks.length > 0" class="mb-3">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="fw-semibold mb-0">
          <i class="bi bi-list-task me-1"></i>任务列表
          <span class="badge bg-primary ms-1">{{ tasks.length }}</span>
          <span v-if="runningCount > 0" class="badge bg-success ms-1">{{ runningCount }} 运行中</span>
        </h6>
      </div>
      
      <div class="task-cards-container" style="max-height: 300px; overflow-y: auto;">
        <TaskCard 
          v-for="task in tasks" 
          :key="task.id" 
          :task="task" 
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTaskStore } from '../../stores/taskStore';
import { storeToRefs } from 'pinia';
import TaskCard from './TaskCard.vue';
import TaskConfigForm from './TaskConfigForm.vue';

const taskStore = useTaskStore();
const { tasks, runningTasks } = storeToRefs(taskStore);

const runningCount = computed(() => runningTasks.value.length);
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

