<template>
  <div class="container-fluid py-3">
    <h1 class="h4 mb-3">任务管理</h1>

    <!-- 第一行：查询底池 -->
    <div class="row g-3 mb-3">
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body">
            <LiquidityPoolQuery />
          </div>
        </div>
      </div>
    </div>

    <!-- 第二行：任务列表（大区域） -->
    <div class="row g-3 mb-3">
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body">
            <TaskList />
          </div>
        </div>
      </div>
    </div>

    <!-- 第三行：任务日志 -->
    <div class="row g-3">
      <div class="col-12">
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
import TaskList from '../market/TaskList.vue';
import TaskLogPanel from '../market/TaskLogPanel.vue';
import LiquidityPoolQuery from '../market/LiquidityPoolQuery.vue';

defineOptions({
  name: 'TaskManagePanel'
});
</script>

<style scoped>
</style>
