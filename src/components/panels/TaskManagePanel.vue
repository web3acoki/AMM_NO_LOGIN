<template>
  <div class="container-fluid py-3">
    <h1 class="h4 mb-3">任务管理</h1>
    <div class="row g-3">
      <!-- 左侧：任务列表和配置 -->
      <div class="col-lg-7">
        <div class="card shadow-sm">
          <div class="card-body">
            <TaskList />
          </div>
        </div>
      </div>

      <!-- 右侧：DEX面板和任务日志 -->
      <div class="col-lg-5">
        <!-- DEX 面板 -->
        <div class="card shadow-sm mb-3">
          <div class="card-body">
            <DexPanel />
          </div>
        </div>

        <!-- 任务日志面板 -->
        <div class="card shadow-sm">
          <div class="card-body">
            <TaskLogPanel />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import DexPanel from '../market/DexPanel.vue';
import TaskList from '../market/TaskList.vue';
import TaskLogPanel from '../market/TaskLogPanel.vue';

defineOptions({
  name: 'TaskManagePanel'
});
</script>

<style scoped>
</style>
