<template>
  <div class="container-fluid py-3">
    <h1 class="h4 mb-3">钱包管理</h1>
    <div class="row g-3">
      <!-- 网络与代币设置、资金池查询 -->
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body">
            <LiquidityPoolQuery />
          </div>
        </div>
      </div>

      <!-- 钱包导入 -->
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body">
            <h2 class="h6">钱包导入</h2>
            <WalletImportPanel />
          </div>
        </div>
      </div>

      <!-- 批量卖出 -->
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center">
              <h2 class="h6 mb-0">批量卖出</h2>
              <button
                class="btn btn-outline-warning btn-sm"
                @click="showBatchSellPanel = !showBatchSellPanel"
              >
                <i class="bi bi-cart-dash me-1"></i>
                {{ showBatchSellPanel ? '收起面板' : '展开面板' }}
              </button>
            </div>
            <BatchSellPanel v-if="showBatchSellPanel" class="mt-3" @close="showBatchSellPanel = false" />
          </div>
        </div>
      </div>

      <!-- 钱包列表 -->
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body wallet-table-wrapper">
            <WalletTable />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import LiquidityPoolQuery from '../market/LiquidityPoolQuery.vue';
import WalletImportPanel from '../market/WalletImportPanel.vue';
import WalletTable from '../market/WalletTable.vue';
import BatchSellPanel from '../market/BatchSellPanel.vue';

defineOptions({
  name: 'WalletManagePanel'
});

const showBatchSellPanel = ref(false);
</script>

<style scoped>
.wallet-table-wrapper {
  min-height: 400px;
}

.wallet-table-wrapper :deep(.table-responsive) {
  max-height: 600px;
  overflow-y: auto;
}

.wallet-table-wrapper :deep(.table) {
  font-size: 0.9rem;
}

.wallet-table-wrapper :deep(.table th),
.wallet-table-wrapper :deep(.table td) {
  padding: 0.75rem;
}
</style>
