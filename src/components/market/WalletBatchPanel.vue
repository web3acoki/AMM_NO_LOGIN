<template>
  <div class="wallet-batch-panel">
    <!-- 生成钱包批次 -->
    <div class="mb-3">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="mb-0"><i class="bi bi-collection me-1"></i>钱包任务批次</h6>
        <span class="badge bg-secondary">{{ walletBatches.length }} 个批次</span>
      </div>

      <div class="row g-2 align-items-end">
        <div class="col-auto">
          <label class="form-label small mb-1">生成数量</label>
          <input
            type="number"
            class="form-control form-control-sm"
            v-model.number="generateCount"
            min="1"
            max="1000"
            placeholder="数量"
            style="width: 80px;"
          >
        </div>
        <div class="col-auto">
          <label class="form-label small mb-1">钱包类型</label>
          <select class="form-select form-select-sm" v-model="generateWalletType">
            <option value="main">主钱包</option>
            <option value="normal">普通钱包</option>
          </select>
        </div>
        <div class="col">
          <label class="form-label small mb-1">批次备注</label>
          <input
            type="text"
            class="form-control form-control-sm"
            v-model="generateRemark"
            placeholder="输入备注（可选）"
          >
        </div>
        <div class="col-auto d-flex gap-1">
          <button
            class="btn btn-primary btn-sm"
            @click="generateBatch"
            :disabled="isGenerating || !generateCount || generateCount < 1"
          >
            <span v-if="isGenerating">
              <span class="spinner-border spinner-border-sm me-1"></span>生成中...
            </span>
            <span v-else>
              <i class="bi bi-plus-circle me-1"></i>生成钱包批次
            </span>
          </button>
          <button
            class="btn btn-outline-success btn-sm"
            @click="openImportModal"
          >
            <i class="bi bi-box-arrow-in-down me-1"></i>导入钱包
          </button>
        </div>
      </div>
      <div class="form-text small text-muted mt-1">
        生成后会自动下载私钥文件备份，请妥善保管。
      </div>
    </div>

    <!-- 批次列表 -->
    <div v-if="walletBatches.length > 0" class="batch-list">
      <div
        v-for="batch in walletBatches"
        :key="batch.id"
        class="card mb-2 batch-card"
        :class="{ 'border-primary': expandedBatchId === batch.id }"
      >
        <div class="card-body py-2 px-3">
          <!-- 批次信息 -->
          <div class="d-flex justify-content-between align-items-center mb-2">
            <div class="batch-info">
              <span class="fw-bold">{{ batch.remark }}</span>
              <span class="badge ms-2" :class="batch.walletType === 'main' ? 'bg-danger' : 'bg-secondary'">
                {{ batch.walletType === 'main' ? '主钱包' : '普通钱包' }}
              </span>
              <span class="badge bg-info ms-1">{{ batch.wallets.length }} 个</span>
              <span class="text-muted small ms-2">{{ formatDate(batch.createdAt) }}</span>
            </div>
            <div v-if="batch.totalNativeBalance || batch.totalTokenBalance">
              <span v-if="batch.totalNativeBalance" class="badge bg-warning text-dark me-1">
                {{ formatBalance(batch.totalNativeBalance) }} {{ currentGovernanceToken }}
              </span>
              <span v-if="batch.totalTokenBalance && targetToken" class="badge bg-success">
                {{ formatBalance(batch.totalTokenBalance) }} {{ targetToken.symbol }}
              </span>
            </div>
          </div>

          <!-- 操作按钮行 -->
          <div class="d-flex flex-wrap gap-1">
            <button class="btn btn-outline-secondary btn-sm" @click="editRemark(batch)" title="编辑备注">
              <i class="bi bi-pencil me-1"></i>备注
            </button>
            <button class="btn btn-outline-info btn-sm" @click="toggleExpand(batch.id)" title="查看地址">
              <i class="bi bi-eye me-1"></i>地址
            </button>
            <button class="btn btn-outline-warning btn-sm" @click="showPrivateKeys(batch)" title="查看私钥">
              <i class="bi bi-key me-1"></i>私钥
            </button>
            <button
              class="btn btn-outline-primary btn-sm"
              @click="queryBalances(batch)"
              :disabled="queryingBatchId === batch.id"
              title="查询余额"
            >
              <span v-if="queryingBatchId === batch.id">
                <span class="spinner-border spinner-border-sm me-1"></span>
              </span>
              <i v-else class="bi bi-wallet2 me-1"></i>余额
            </button>
            <button class="btn btn-outline-success btn-sm" @click="exportBatch(batch)" title="导出">
              <i class="bi bi-download me-1"></i>导出
            </button>
            <button class="btn btn-outline-danger btn-sm" @click="deleteBatch(batch)" title="删除">
              <i class="bi bi-trash me-1"></i>删除
            </button>
          </div>

          <!-- 展开的钱包地址列表 -->
          <div v-if="expandedBatchId === batch.id" class="mt-2 pt-2 border-top">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span class="small text-muted">钱包地址列表</span>
              <button class="btn btn-outline-primary btn-sm" @click="copyAddresses(batch)">
                <i class="bi bi-clipboard me-1"></i>复制全部地址
              </button>
            </div>
            <div class="wallet-list-scroll">
              <table class="table table-sm table-striped mb-0">
                <thead class="table-light">
                  <tr>
                    <th style="width: 40px;">#</th>
                    <th>地址</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(wallet, idx) in batch.wallets" :key="wallet.address">
                    <td class="text-muted">{{ idx + 1 }}</td>
                    <td class="font-monospace small">{{ wallet.address }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-center text-muted py-3">
      <i class="bi bi-inbox fs-4"></i>
      <p class="mb-0 mt-1 small">暂无钱包批次，点击上方按钮生成</p>
    </div>

    <!-- 私钥查看弹窗 -->
    <div v-if="showPrivateKeyModal" class="modal show d-block" tabindex="-1" @click.self="showPrivateKeyModal = false">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header bg-warning">
            <h5 class="modal-title"><i class="bi bi-exclamation-triangle me-2"></i>私钥信息 - {{ selectedBatch?.remark }}</h5>
            <button type="button" class="btn-close" @click="showPrivateKeyModal = false"></button>
          </div>
          <div class="modal-body">
            <div class="alert alert-danger small">
              <i class="bi bi-shield-exclamation me-1"></i>
              <strong>警告：</strong>私钥是您钱包的唯一凭证，请勿泄露给任何人！
            </div>
            <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
              <table class="table table-sm table-striped">
                <thead class="table-light sticky-top">
                  <tr>
                    <th style="width: 40px;">#</th>
                    <th>地址</th>
                    <th>私钥</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(wallet, idx) in selectedBatch?.wallets" :key="wallet.address">
                    <td class="text-muted">{{ idx + 1 }}</td>
                    <td class="font-monospace small">{{ formatAddress(wallet.address) }}</td>
                    <td class="font-monospace small text-danger">{{ wallet.privateKey }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-primary btn-sm" @click="copyPrivateKeys">
              <i class="bi bi-clipboard me-1"></i>复制全部私钥
            </button>
            <button type="button" class="btn btn-secondary btn-sm" @click="showPrivateKeyModal = false">关闭</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showPrivateKeyModal" class="modal-backdrop show"></div>

    <!-- 导入钱包选择弹窗 -->
    <div v-if="showImportModal" class="modal show d-block" tabindex="-1" @click.self="showImportModal = false">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header bg-success text-white">
            <h5 class="modal-title"><i class="bi bi-box-arrow-in-down me-2"></i>从批次导入钱包</h5>
            <button type="button" class="btn-close btn-close-white" @click="showImportModal = false"></button>
          </div> 
          <div class="modal-body">
            <!-- 选择批次 -->
            <div class="mb-3">
              <label class="form-label">选择钱包批次</label>
              <select class="form-select" v-model="selectedImportBatchId" @change="onBatchChange">
                <option value="">-- 请选择批次 --</option>
                <option v-for="batch in walletBatches" :key="batch.id" :value="batch.id">
                  {{ batch.remark }} ({{ batch.wallets.length }} 个钱包)
                </option>
              </select>
            </div>

            <!-- 钱包类型 -->
            <div class="mb-3">
              <label class="form-label">导入为</label>
              <select class="form-select" v-model="importWalletType">
                <option value="normal">普通钱包</option>
                <option value="main">主钱包</option>
              </select>
            </div>

            <!-- 钱包选择列表 -->
            <div v-if="importBatchWallets.length > 0">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="small fw-bold">选择要导入的钱包</span>
                <div>
                  <button class="btn btn-outline-primary btn-sm me-1" @click="selectAllWallets">
                    <i class="bi bi-check-all me-1"></i>全选
                  </button>
                  <button class="btn btn-outline-secondary btn-sm" @click="deselectAllWallets">
                    <i class="bi bi-x-lg me-1"></i>取消全选
                  </button>
                </div>
              </div>
              <div class="border rounded p-2" style="max-height: 300px; overflow-y: auto;">
                <div
                  v-for="(wallet, idx) in importBatchWallets"
                  :key="wallet.address"
                  class="form-check py-1 border-bottom"
                  :class="{ 'border-bottom-0': idx === importBatchWallets.length - 1 }"
                >
                  <input
                    type="checkbox"
                    class="form-check-input"
                    :id="'wallet-' + idx"
                    :value="wallet.address"
                    v-model="selectedWalletAddresses"
                  >
                  <label class="form-check-label w-100 d-flex justify-content-between" :for="'wallet-' + idx">
                    <span class="font-monospace small">{{ wallet.address }}</span>
                    <span class="badge bg-secondary">{{ idx + 1 }}</span>
                  </label>
                </div>
              </div>
              <div class="text-muted small mt-2">
                已选择 <strong>{{ selectedWalletAddresses.length }}</strong> / {{ importBatchWallets.length }} 个钱包
              </div>
            </div>
            <div v-else-if="selectedImportBatchId" class="alert alert-warning small mb-0">
              <i class="bi bi-exclamation-triangle me-1"></i>该批次没有钱包
            </div>
            <div v-else class="alert alert-info small mb-0">
              <i class="bi bi-info-circle me-1"></i>请先选择一个钱包批次
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" @click="showImportModal = false">取消</button>
            <button
              type="button"
              class="btn btn-success"
              @click="confirmImport"
              :disabled="selectedWalletAddresses.length === 0 || isImporting"
            >
              <span v-if="isImporting">
                <span class="spinner-border spinner-border-sm me-1"></span>导入中...
              </span>
              <span v-else>
                <i class="bi bi-check-lg me-1"></i>确认导入 ({{ selectedWalletAddresses.length }} 个)
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showImportModal" class="modal-backdrop show"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';

const walletStore = useWalletStore();
const chainStore = useChainStore();
const { walletBatches, targetToken } = storeToRefs(walletStore);
const { currentGovernanceToken } = storeToRefs(chainStore);

const generateCount = ref<number | undefined>(undefined);
const generateRemark = ref('');
const generateWalletType = ref<'main' | 'normal'>('normal');
const isGenerating = ref(false);
const expandedBatchId = ref<string | null>(null);
const queryingBatchId = ref<string | null>(null);
const showPrivateKeyModal = ref(false);
const selectedBatch = ref<any>(null);

// 导入钱包相关
const showImportModal = ref(false);
const selectedImportBatchId = ref('');
const importWalletType = ref<'main' | 'normal'>('normal');
const selectedWalletAddresses = ref<string[]>([]);
const isImporting = ref(false);

// 计算属性：获取当前选中批次的钱包列表
const importBatchWallets = computed(() => {
  if (!selectedImportBatchId.value) return [];
  const batch = walletBatches.value.find(b => b.id === selectedImportBatchId.value);
  return batch?.wallets || [];
});

// 生成钱包批次
async function generateBatch() {
  if (!generateCount.value || generateCount.value < 1) {
    alert('请输入有效的生成数量');
    return;
  }

  isGenerating.value = true;
  try {
    await walletStore.generateWalletBatch(generateCount.value, generateRemark.value, generateWalletType.value);
    alert(`成功生成 ${generateCount.value} 个${generateWalletType.value === 'main' ? '主' : '普通'}钱包，私钥文件已自动下载`);
    generateRemark.value = '';
  } catch (error: any) {
    alert(error.message || '生成失败');
  } finally {
    isGenerating.value = false;
  }
}

// 切换展开状态
function toggleExpand(batchId: string) {
  expandedBatchId.value = expandedBatchId.value === batchId ? null : batchId;
}

// 编辑备注
function editRemark(batch: any) {
  const newRemark = prompt('请输入新的备注：', batch.remark);
  if (newRemark !== null && newRemark !== batch.remark) {
    walletStore.updateBatchRemark(batch.id, newRemark);
  }
}

// 查看私钥
function showPrivateKeys(batch: any) {
  selectedBatch.value = batch;
  showPrivateKeyModal.value = true;
}

// 查询余额
async function queryBalances(batch: any) {
  queryingBatchId.value = batch.id;
  try {
    const result = await walletStore.refreshBatchBalances(batch.id);
    if (result) {
      const nativeBalance = formatBalance(result.totalNativeBalance);
      const tokenBalance = result.totalTokenBalance ? formatBalance(result.totalTokenBalance) : null;
      alert(`余额查询完成\n\n${currentGovernanceToken.value} 总计: ${nativeBalance}${tokenBalance ? `\n${targetToken.value?.symbol || '代币'} 总计: ${tokenBalance}` : ''}\n\n钱包数量: ${batch.wallets.length} 个`);
    }
  } catch (error: any) {
    alert(error.message || '查询失败');
  } finally {
    queryingBatchId.value = null;
  }
}

// 导出批次
function exportBatch(batch: any) {
  walletStore.exportBatchToFile(batch);
}

// 删除批次
function deleteBatch(batch: any) {
  if (confirm(`确定要删除批次 "${batch.remark}" 吗？\n\n注意：删除后无法恢复，请确保已备份私钥！`)) {
    walletStore.deleteBatch(batch.id);
  }
}

// 复制地址
function copyAddresses(batch: any) {
  const addresses = batch.wallets.map((w: any) => w.address).join('\n');
  navigator.clipboard.writeText(addresses).then(() => {
    alert('已复制全部地址到剪贴板');
  });
}

// 复制私钥
function copyPrivateKeys() {
  if (!selectedBatch.value) return;
  const keys = selectedBatch.value.wallets.map((w: any) => w.privateKey).join('\n');
  navigator.clipboard.writeText(keys).then(() => {
    alert('已复制全部私钥到剪贴板');
  });
}

// 格式化日期
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

// 格式化地址
function formatAddress(address: string): string {
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

// 格式化余额（保留4位小数）
function formatBalance(balance: string | undefined): string {
  if (!balance) return '0';
  const num = parseFloat(balance);
  if (isNaN(num)) return '0';
  // 如果数字很大，显示完整；如果很小，保留更多小数
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.0001) return num.toFixed(6);
  return num.toExponential(2);
}

// 打开导入钱包弹窗
function openImportModal() {
  showImportModal.value = true;
  selectedImportBatchId.value = '';
  selectedWalletAddresses.value = [];
  importWalletType.value = 'normal';
}

// 批次选择变化时，默认选中所有钱包
function onBatchChange() {
  selectedWalletAddresses.value = importBatchWallets.value.map(w => w.address);
}

// 全选
function selectAllWallets() {
  selectedWalletAddresses.value = importBatchWallets.value.map(w => w.address);
}

// 取消全选
function deselectAllWallets() {
  selectedWalletAddresses.value = [];
}

// 确认导入选中的钱包
async function confirmImport() {
  if (selectedWalletAddresses.value.length === 0) {
    alert('请至少选择一个钱包');
    return;
  }

  const batch = walletBatches.value.find(b => b.id === selectedImportBatchId.value);
  if (!batch) {
    alert('批次不存在');
    return;
  }

  isImporting.value = true;
  try {
    // 获取选中的钱包私钥
    const selectedWallets = batch.wallets.filter(w => 
      selectedWalletAddresses.value.includes(w.address)
    );
    const privateKeys = selectedWallets.map(w => w.privateKey);

    // 导入钱包
    const importResult = walletStore.importWalletsFromPrivateKeys(privateKeys, {
      walletType: importWalletType.value,
      remark: batch.remark,
    });

    if (importResult.added > 0) {
      await walletStore.refreshAllBalances();
      alert(`成功导入 ${importResult.added} 个钱包${importResult.duplicates > 0 ? `，${importResult.duplicates} 个重复已跳过` : ''}`);
    } else if (importResult.duplicates > 0) {
      alert(`所有钱包都已存在，${importResult.duplicates} 个重复已跳过`);
    }

    showImportModal.value = false;
  } catch (error: any) {
    alert(error.message || '导入失败');
  } finally {
    isImporting.value = false;
  }
}
</script>

<style scoped>
.wallet-batch-panel {
  font-size: 0.9rem;
}

.batch-card {
  transition: border-color 0.2s;
}

.batch-card:hover {
  border-color: var(--bs-primary);
}

.wallet-list-scroll {
  max-height: 200px;
  overflow-y: auto;
}

.modal.show {
  background-color: rgba(0, 0, 0, 0.5);
}
</style>
