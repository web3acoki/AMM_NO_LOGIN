<template>
  <div class="wallet-table-container">
    <!-- 选择工具栏 -->
    <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
      <div class="d-flex align-items-center gap-2">
        <h6 class="mb-0">钱包列表</h6>
        <span v-if="selectedCount > 0" class="badge bg-primary">
          已选 {{ selectedCount }} / {{ wallets.length }}
        </span>
        <!-- 余额统计 -->
        <span v-if="selectedCount > 0" class="badge bg-warning text-dark">
          {{ selectedBalanceStats.totalNative }} {{ currentGovernanceToken }}
        </span>
        <span v-if="selectedCount > 0 && targetToken" class="badge bg-success">
          {{ selectedBalanceStats.totalToken }} {{ targetToken.symbol }}
        </span>
      </div>
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-outline-secondary btn-sm" @click="toggleSelectAll">
          <i class="bi" :class="isAllSelected ? 'bi-check-square' : 'bi-square'"></i>
          {{ isAllSelected ? '取消全选' : '全选' }}
        </button>
        <button class="btn btn-outline-secondary btn-sm" @click="invertSelection" :disabled="wallets.length === 0">
          <i class="bi bi-arrow-repeat"></i> 反选
        </button>
        <div class="input-group input-group-sm" style="width: auto;">
          <input
            type="text"
            class="form-control"
            placeholder="范围 如: 1-20"
            v-model="rangeInput"
            style="width: 90px;"
            @keyup.enter="selectRange"
          >
          <button class="btn btn-outline-secondary" @click="selectRange" :disabled="!rangeInput">
            选择
          </button>
        </div>
      </div>
    </div>

    <!-- 操作按钮栏 -->
    <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-outline-secondary btn-sm" @click="openImportBatchModal" :disabled="walletBatches.length === 0">
          <i class="bi bi-box-arrow-in-down me-1"></i>导入钱包
        </button>
        <button class="btn btn-outline-primary btn-sm" @click="refreshBalances" :disabled="isRefreshing">
          <i class="bi bi-arrow-clockwise me-1"></i>{{ isRefreshing ? '刷新中' : '刷新余额' }}
        </button>
        <button
          class="btn btn-outline-secondary btn-sm"
          @click="editSelectedRemark"
          :disabled="selectedCount === 0"
        >
          <i class="bi bi-pencil me-1"></i>编辑选中 ({{ selectedCount }})
        </button>
        <button
          class="btn btn-outline-danger btn-sm"
          @click="removeSelected"
          :disabled="selectedCount === 0"
        >
          <i class="bi bi-trash me-1"></i>删除选中 ({{ selectedCount }})
        </button>
        <button class="btn btn-outline-danger btn-sm" @click="clearAllWallets">
          <i class="bi bi-trash-fill me-1"></i>删除全部
        </button>
      </div>
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-outline-info btn-sm" @click="exportPrivateKeys" :disabled="!wallets || wallets.length === 0">
          <i class="bi bi-download me-1"></i>导出私钥
        </button>
      </div>
    </div>

    <!-- 从批次导入钱包 Modal -->
    <div class="modal fade" id="importBatchModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"><i class="bi bi-box-arrow-in-down me-2"></i>从批次导入钱包</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">选择钱包批次</label>
              <select class="form-select" v-model="selectedBatchId">
                <option value="">-- 请选择批次 --</option>
                <option v-for="batch in walletBatches" :key="batch.id" :value="batch.id">
                  {{ batch.remark }} ({{ batch.wallets.length }} 个钱包)
                </option>
              </select>
            </div>
            <div class="mb-3">
              <label class="form-label">钱包类型</label>
              <select class="form-select" v-model="batchImportType">
                <option value="normal">普通钱包</option>
                <option value="main">主钱包</option>
              </select>
            </div>
            <div v-if="walletBatches.length === 0" class="alert alert-warning small mb-0">
              <i class="bi bi-exclamation-triangle me-1"></i>
              暂无钱包批次，请先在"钱包批次管理"中生成批次
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
            <button type="button" class="btn btn-primary" @click="importFromBatch" :disabled="!selectedBatchId || batchImporting">
              <span v-if="batchImporting">
                <span class="spinner-border spinner-border-sm me-1"></span>导入中...
              </span>
              <span v-else>确认导入</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 钱包表格 -->
    <div class="table-responsive">
      <table class="table table-sm align-middle table-hover">
        <thead class="table-light">
          <tr>
            <th style="width: 40px;">
              <input
                type="checkbox"
                class="form-check-input"
                :checked="isAllSelected && wallets.length > 0"
                :indeterminate="selectedCount > 0 && !isAllSelected"
                @change="toggleSelectAll"
              >
            </th>
            <th style="width: 50px;">#</th>
            <th>类型</th>
            <th>备注</th>
            <th>创建时间</th>
            <th>地址</th>
            <th>私钥</th>
            <th>{{ currentGovernanceToken }} 余额</th>
            <th>{{ targetToken ? targetToken.symbol : '目标代币' }} 余额</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(w, idx) in wallets"
            :key="w.address"
            :class="{ 'table-primary': isSelected(w.address) }"
          >
            <td>
              <input
                type="checkbox"
                class="form-check-input"
                :checked="isSelected(w.address)"
                @change="toggleSelection(w.address)"
              >
            </td>
            <td>{{ idx + 1 }}</td>
            <td>
              <span class="badge" :class="w.walletType === 'main' ? 'bg-primary' : 'bg-secondary'">
                {{ w.walletType === 'main' ? '主钱包' : '普通钱包' }}
              </span>
            </td>
            <td>
              <span>{{ w.remark || '-' }}</span>
            </td>
            <td class="small text-muted">
              {{ w.createdAt ? new Date(w.createdAt).toLocaleString() : '-' }}
            </td>
            <td class="text-break" style="min-width: 220px;">
              <span class="font-monospace" :title="w.address">
                {{ w.address }}
              </span>
            </td>
            <td class="text-break small" style="min-width: 140px;">
              <span class="font-monospace text-muted" :title="w.encrypted">
                {{ w.encrypted ? w.encrypted.slice(0, 14) + '...' : '-' }}
              </span>
            </td>
            <td>
              <span v-if="w.nativeBalance !== undefined">{{ w.nativeBalance }}</span>
              <span v-else class="text-muted">-</span>
            </td>
            <td>
              <span v-if="targetToken && w.tokenBalance !== undefined">{{ w.tokenBalance }}</span>
              <span v-else class="text-muted">-</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="wallets.length === 0" class="text-center text-muted py-4">
        <i class="bi bi-wallet2 fs-1"></i>
        <p class="mt-2">暂无钱包，请先导入钱包</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';

const walletStore = useWalletStore();
const chainStore = useChainStore();
const { localWallets: wallets, selectedWalletAddresses, selectedCount, isAllSelected, targetToken, walletBatches } = storeToRefs(walletStore);
const { currentGovernanceToken } = storeToRefs(chainStore);

const isRefreshing = ref(false);
const rangeInput = ref('');

// 从批次导入相关
const selectedBatchId = ref('');
const batchImportType = ref<'main' | 'normal'>('normal');
const batchImporting = ref(false);
let importBatchModal: any = null;

// 计算已选钱包的余额统计
const selectedBalanceStats = computed(() => {
  const selectedWallets = wallets.value.filter(w => selectedWalletAddresses.value.includes(w.address));
  let totalNative = 0;
  let totalToken = 0;

  for (const wallet of selectedWallets) {
    if (wallet.nativeBalance && wallet.nativeBalance !== '-' && wallet.nativeBalance !== 'Error') {
      totalNative += parseFloat(wallet.nativeBalance) || 0;
    }
    if (wallet.tokenBalance && wallet.tokenBalance !== '-' && wallet.tokenBalance !== 'Error') {
      totalToken += parseFloat(wallet.tokenBalance) || 0;
    }
  }

  return {
    totalNative: totalNative.toFixed(6),
    totalToken: totalToken.toFixed(6),
  };
});

// 检查钱包是否被选中
function isSelected(address: string): boolean {
  return selectedWalletAddresses.value.includes(address);
}

// 切换单个钱包选择
function toggleSelection(address: string) {
  walletStore.toggleWalletSelection(address);
}

// 切换全选
function toggleSelectAll() {
  if (isAllSelected.value) {
    walletStore.deselectAll();
  } else {
    walletStore.selectAll();
  }
}

// 反选
function invertSelection() {
  walletStore.invertSelection();
}

// 范围选择
function selectRange() {
  if (!rangeInput.value) return;

  const match = rangeInput.value.match(/^(\d+)\s*[-~到]\s*(\d+)$/);
  if (match) {
    const start = parseInt(match[1]);
    const end = parseInt(match[2]);
    walletStore.selectRangeOnly(start, end);
    rangeInput.value = '';
  } else {
    alert('格式错误，请输入如 "1-20" 或 "1~20" 的范围');
  }
}

// 编辑选中钱包的备注
function editSelectedRemark() {
  if (selectedCount.value === 0) return;

  const selectedWallets = walletStore.selectedWallets;
  const firstRemark = selectedWallets[0]?.remark || '';
  const allSameRemark = selectedWallets.every(w => w.remark === firstRemark);
  const initialValue = allSameRemark ? firstRemark : '';

  const newRemark = prompt(
    `为选中的 ${selectedCount.value} 个钱包设置备注：\n\n（留空则清除备注）`,
    initialValue
  );

  if (newRemark !== null) {
    walletStore.updateSelectedWalletsRemark(newRemark);
    alert(`已更新 ${selectedCount.value} 个钱包的备注`);
  }
}

// 删除选中钱包
function removeSelected() {
  if (selectedCount.value === 0) return;
  if (confirm(`确定要删除选中的 ${selectedCount.value} 个钱包吗？`)) {
    walletStore.removeSelectedWallets();
  }
}

// 刷新所有余额
async function refreshBalances() {
  if (isRefreshing.value) return;
  isRefreshing.value = true;
  try {
    await walletStore.refreshAllBalances();
    if (targetToken.value) {
      await walletStore.refreshTargetTokenBalance();
    }
  } finally {
    isRefreshing.value = false;
  }
}

// 删除全部钱包
function clearAllWallets() {
  if (confirm('确定要删除所有钱包吗？')) {
    walletStore.clearLocalWallets();
  }
}

// 打开从批次导入 Modal
function openImportBatchModal() {
  const el = document.getElementById('importBatchModal');
  if (!el) return;

  if (!importBatchModal) {
    const Bootstrap = (window as any).bootstrap;
    importBatchModal = new Bootstrap.Modal(el);
  }
  selectedBatchId.value = '';
  batchImportType.value = 'normal';
  importBatchModal.show();
}

// 从批次导入钱包
async function importFromBatch() {
  if (!selectedBatchId.value) {
    alert('请先选择批次');
    return;
  }

  batchImporting.value = true;
  try {
    const importResult = walletStore.importWalletsFromBatch(selectedBatchId.value, batchImportType.value);

    if (importResult.added > 0) {
      await walletStore.refreshAllBalances();
      if (importBatchModal) {
        importBatchModal.hide();
      }
      alert(`成功导入 ${importResult.added} 个钱包${importResult.duplicates > 0 ? `，${importResult.duplicates} 个重复已跳过` : ''}`);
    } else if (importResult.duplicates > 0) {
      alert(`所有钱包都已存在，${importResult.duplicates} 个重复已跳过`);
    }
  } catch (error: any) {
    alert(error.message || '导入失败');
  } finally {
    batchImporting.value = false;
  }
}

// 导出私钥
async function exportPrivateKeys() {
  if (!wallets.value || wallets.value.length === 0) {
    alert('没有钱包可导出');
    return;
  }

  try {
    await walletStore.exportPrivateKeys();
  } catch (error: any) {
    alert('导出失败: ' + error.message);
  }
}
</script>

<style scoped>
.wallet-table-container {
  font-size: 0.95rem;
}

.table th, .table td {
  vertical-align: middle;
  padding: 0.75rem 0.5rem;
}

.table th {
  font-weight: 600;
  white-space: nowrap;
}

.form-check-input {
  cursor: pointer;
  width: 1.2em;
  height: 1.2em;
}

.form-check-input:indeterminate {
  background-color: var(--bs-primary);
  border-color: var(--bs-primary);
}

/* 让地址列更宽 */
.table td:nth-child(6) {
  min-width: 200px;
}

/* 让余额列有固定宽度 */
.table td:nth-child(8),
.table td:nth-child(9) {
  min-width: 120px;
}
</style>
