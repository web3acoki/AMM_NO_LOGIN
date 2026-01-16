<template>
  <div class="container-fluid py-3">
    <h1 class="h4 mb-3">市值管理面板</h1>
    <div class="row g-3">
      <div class="col-lg-7">
        <div class="card shadow-sm">
          <div class="card-body">
            <h2 class="h6">连接与设置</h2>
            <div class="row g-3">
              <div class="col-12 col-md-6">
                <NetworkSelector />
              </div>
              <div class="col-12 col-md-6">
                <WalletManager />
              </div>
            </div>
          </div>
        </div>

        <div class="card shadow-sm mt-3">
          <div class="card-body">
            <LiquidityPoolQuery />
          </div>
        </div>

        <div class="card shadow-sm mt-3">
          <div class="card-body">
            <h2 class="h6">钱包导入</h2>
            <WalletImportPanel />
            <div class="mt-4">
              <WalletTable />
            </div>
          </div>
        </div>
      </div>

      <div class="col-lg-5">
        <!-- 任务管理（新建+任务列表） -->
        <div class="card shadow-sm mb-3">
          <div class="card-body">
            <TaskList />
          </div>
        </div>

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
import NetworkSelector from '../market/NetworkSelector.vue';
import WalletManager from '../market/WalletManager.vue';
import LiquidityPoolQuery from '../market/LiquidityPoolQuery.vue';
import WalletImportPanel from '../market/WalletImportPanel.vue';
import WalletTable from '../market/WalletTable.vue';
import DexPanel from '../market/DexPanel.vue';
import TaskList from '../market/TaskList.vue';
import TaskLogPanel from '../market/TaskLogPanel.vue';
</script>
