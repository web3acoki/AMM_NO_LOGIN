<template>
  <div class="wallet-table-container">
    <!-- 选择工具栏 -->
    <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
      <div class="d-flex align-items-center gap-2">
        <h6 class="mb-0">钱包列表</h6>
        <span v-if="selectedCount > 0" class="badge bg-primary">
          已选 {{ selectedCount }} / {{ wallets.length }}
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
        <button 
          class="btn btn-outline-success btn-sm" 
          @click="showTransferPanel = !showTransferPanel"
          :disabled="wallets.length === 0"
        >
          <i class="bi bi-send me-1"></i>批量转账
        </button>
      </div>
    </div>

    <!-- 批量转账面板 -->
    <div v-if="showTransferPanel" class="card mb-3 border-primary">
      <div class="card-header bg-primary text-white d-flex justify-content-between align-items-center">
        <span><i class="bi bi-send me-1"></i>批量转账操作</span>
        <button type="button" class="btn-close btn-close-white" @click="showTransferPanel = false"></button>
      </div>
      <div class="card-body">
        <!-- 转账模式选择 -->
        <div class="mb-3">
          <label class="form-label small fw-bold">转账模式</label>
          <div class="btn-group w-100" role="group">
            <input type="radio" class="btn-check" name="transferMode" id="modeOneToMany" value="oneToMany" v-model="transferMode">
            <label class="btn btn-outline-primary" for="modeOneToMany">一对多</label>
            <input type="radio" class="btn-check" name="transferMode" id="modeManyToOne" value="manyToOne" v-model="transferMode">
            <label class="btn btn-outline-primary" for="modeManyToOne">多对一</label>
            <input type="radio" class="btn-check" name="transferMode" id="modeManyToMany" value="manyToMany" v-model="transferMode">
            <label class="btn btn-outline-primary" for="modeManyToMany">多对多</label>
          </div>
          <div class="form-text small mt-1">
            <span v-if="transferMode === 'oneToMany'">一个源钱包向多个目标钱包转账（源钱包只能填1个）</span>
            <span v-else-if="transferMode === 'manyToOne'">多个源钱包向一个目标钱包转账（目标钱包只能填1个）</span>
            <span v-else>源钱包和目标钱包一一对应转账（数量必须相等）</span>
          </div>
        </div>

        <!-- 地址输入区域 -->
        <div class="row g-3 mb-3">
          <div class="col-12 col-md-6">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <label class="form-label small fw-bold mb-0">
                源钱包地址（每行一个）
                <span class="badge bg-secondary ms-1">{{ sourceAddressCount }} 个</span>
              </label>
              <div class="d-flex gap-2">
                <label class="btn btn-outline-primary btn-sm">
                  <i class="bi bi-file-earmark-arrow-up me-1"></i>导入TXT
                  <input type="file" accept=".txt" class="d-none" @change="handleSourceFileImport">
                </label>
                <button class="btn btn-outline-danger btn-sm" @click="sourceAddressesText = ''">
                  <i class="bi bi-trash me-1"></i>清空
                </button>
              </div>
            </div>
            <textarea
              class="form-control form-control-sm"
              v-model="sourceAddressesText"
              rows="6"
              placeholder="0x1234...&#10;0x5678...&#10;每行一个钱包地址"
              :class="{ 'is-invalid': sourceAddressError }"
            ></textarea>
            <div v-if="sourceAddressError" class="invalid-feedback">{{ sourceAddressError }}</div>
          </div>
          <div class="col-12 col-md-6">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <label class="form-label small fw-bold mb-0">
                目标钱包地址（每行一个）
                <span class="badge bg-secondary ms-1">{{ targetAddressCount }} 个</span>
              </label>
              <div class="d-flex gap-2">
                <label class="btn btn-outline-primary btn-sm">
                  <i class="bi bi-file-earmark-arrow-up me-1"></i>导入TXT
                  <input type="file" accept=".txt" class="d-none" @change="handleTargetFileImport">
                </label>
                <button class="btn btn-outline-danger btn-sm" @click="targetAddressesText = ''">
                  <i class="bi bi-trash me-1"></i>清空
                </button>
              </div>
            </div>
            <textarea
              class="form-control form-control-sm"
              v-model="targetAddressesText"
              rows="6"
              placeholder="0xabcd...&#10;0xefgh...&#10;每行一个钱包地址"
              :class="{ 'is-invalid': targetAddressError }"
            ></textarea>
            <div v-if="targetAddressError" class="invalid-feedback">{{ targetAddressError }}</div>
          </div>
        </div>

        <!-- 转账参数 -->
        <div class="row g-2 align-items-end mb-3">
          <div class="col-auto">
            <label class="form-label small">转账金额</label>
            <div class="input-group input-group-sm">
              <input type="number" class="form-control" v-model.number="transferAmount" placeholder="0.01" step="0.001" min="0">
              <span class="input-group-text">{{ transferTokenType === 'token' && targetToken ? targetToken.symbol : currentGovernanceToken }}</span>
            </div>
          </div>
          <div class="col-auto">
            <label class="form-label small">代币类型</label>
            <select class="form-select form-select-sm" v-model="transferTokenType">
              <option value="native">{{ currentGovernanceToken }}</option>
              <option value="token" :disabled="!targetToken">{{ targetToken ? targetToken.symbol : '目标代币' }}</option>
            </select>
          </div>
          <div class="col-auto">
            <button
              class="btn btn-primary btn-sm"
              @click="executeTransfer"
              :disabled="!canExecuteTransfer || isTransferring"
            >
              <span v-if="isTransferring">
                <span class="spinner-border spinner-border-sm me-1"></span>转账中...
              </span>
              <span v-else>
                <i class="bi bi-send me-1"></i>执行转账 ({{ sourceAddressCount }} → {{ targetAddressCount }})
              </span>
            </button>
          </div>
        </div>

        <!-- 转账结果 -->
        <div v-if="transferResults.length > 0" class="mt-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h6 class="small mb-0">
              <i class="bi bi-list-check me-1"></i>转账结果
              <span class="badge bg-secondary ms-1">{{ transferResults.length }}</span>
              <span class="badge bg-success ms-1">{{ transferResults.filter(r => r.success).length }} 成功</span>
              <span v-if="transferResults.filter(r => !r.success).length > 0" class="badge bg-danger ms-1">
                {{ transferResults.filter(r => !r.success).length }} 失败
              </span>
            </h6>
            <button class="btn btn-outline-secondary btn-sm" @click="transferResults = []">
              <i class="bi bi-x-lg"></i> 清除
            </button>
          </div>
          <div class="transfer-results-list border rounded" style="max-height: 250px; overflow-y: auto;">
            <table class="table table-sm table-striped mb-0">
              <thead class="table-light sticky-top">
                <tr>
                  <th style="width: 30px;">#</th>
                  <th style="width: 40px;">状态</th>
                  <th>From</th>
                  <th style="width: 30px;"></th>
                  <th>To</th>
                  <th>金额</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(result, idx) in transferResults" :key="idx" :class="result.success ? '' : 'table-danger'">
                  <td class="small text-muted">{{ idx + 1 }}</td>
                  <td>
                    <i class="bi" :class="result.success ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'"></i>
                  </td>
                  <td class="small">
                    <code class="text-primary">{{ formatAddress(result.source || '-') }}</code>
                  </td>
                  <td class="text-center">
                    <i class="bi bi-arrow-right text-muted"></i>
                  </td>
                  <td class="small">
                    <code class="text-info">{{ formatAddress(result.target || '-') }}</code>
                  </td>
                  <td class="small">
                    <span v-if="result.amount !== undefined" class="text-success fw-bold">
                      {{ transferAmount }} {{ transferTokenType === 'token' && targetToken ? targetToken.symbol : currentGovernanceToken }}
                    </span>
                    <span v-else class="text-muted">-</span>
                  </td>
                  <td class="small">
                    <a v-if="result.hash" :href="getExplorerTxUrl(result.hash)" target="_blank" class="text-decoration-none">
                      <i class="bi bi-box-arrow-up-right me-1"></i>{{ formatAddress(result.hash) }}
                    </a>
                    <span v-else-if="result.error" class="text-danger" :title="result.error">
                      <i class="bi bi-exclamation-triangle me-1"></i>{{ truncateError(result.error) }}
                    </span>
                    <span v-else class="text-muted">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
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
        <p class="mt-2">暂无钱包，请先导入或生成钱包</p>
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
const { localWallets: wallets, selectedWalletAddresses, selectedCount, isAllSelected, targetToken } = storeToRefs(walletStore);
const { currentGovernanceToken } = storeToRefs(chainStore);

const isRefreshing = ref(false);
const rangeInput = ref('');
const showTransferPanel = ref(false);
const isTransferring = ref(false);
const transferResults = ref<any[]>([]);

// 批量转账参数（基于文本框输入）
const transferMode = ref<'oneToMany' | 'manyToOne' | 'manyToMany'>('oneToMany');
const sourceAddressesText = ref('');
const targetAddressesText = ref('');
const transferAmount = ref<number>(0.01);
const transferTokenType = ref<'native' | 'token'>('native');

// 解析地址文本为地址数组
function parseAddresses(text: string): string[] {
  if (!text.trim()) return [];
  return text
    .split(/[\n,;]/)
    .map(addr => addr.trim())
    .filter(addr => addr.length > 0);
}

// 处理源地址文件导入
async function handleSourceFileImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // 追加到现有内容，用换行符分隔
    if (sourceAddressesText.value.trim()) {
      sourceAddressesText.value += '\n' + lines.join('\n');
    } else {
      sourceAddressesText.value = lines.join('\n');
    }
  } catch (error) {
    alert('读取文件失败');
  }

  // 清空input以便可以再次选择同一文件
  input.value = '';
}

// 处理目标地址文件导入
async function handleTargetFileImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // 追加到现有内容，用换行符分隔
    if (targetAddressesText.value.trim()) {
      targetAddressesText.value += '\n' + lines.join('\n');
    } else {
      targetAddressesText.value = lines.join('\n');
    }
  } catch (error) {
    alert('读取文件失败');
  }

  // 清空input以便可以再次选择同一文件
  input.value = '';
}

// 源地址列表
const sourceAddresses = computed(() => parseAddresses(sourceAddressesText.value));
const targetAddresses = computed(() => parseAddresses(targetAddressesText.value));

// 地址计数
const sourceAddressCount = computed(() => sourceAddresses.value.length);
const targetAddressCount = computed(() => targetAddresses.value.length);

// 源地址验证错误
const sourceAddressError = computed(() => {
  const addresses = sourceAddresses.value;
  if (addresses.length === 0) return '';

  // 检查格式
  const invalidAddrs = addresses.filter(addr => !isValidAddress(addr));
  if (invalidAddrs.length > 0) {
    return `${invalidAddrs.length} 个地址格式无效`;
  }

  // 检查是否有私钥
  const walletsWithKey = addresses.filter(addr => {
    const wallet = walletStore.localWallets.find(w => w.address.toLowerCase() === addr.toLowerCase());
    return wallet?.encrypted;
  });

  if (walletsWithKey.length < addresses.length) {
    const missingCount = addresses.length - walletsWithKey.length;
    return `${missingCount} 个地址在本地钱包中不存在或无私钥`;
  }

  // 一对多模式只能有一个源地址
  if (transferMode.value === 'oneToMany' && addresses.length > 1) {
    return '一对多模式只能填写一个源钱包地址';
  }

  return '';
});

// 目标地址验证错误
const targetAddressError = computed(() => {
  const addresses = targetAddresses.value;
  if (addresses.length === 0) return '';

  // 检查格式
  const invalidAddrs = addresses.filter(addr => !isValidAddress(addr));
  if (invalidAddrs.length > 0) {
    return `${invalidAddrs.length} 个地址格式无效`;
  }

  // 多对一模式只能有一个目标地址
  if (transferMode.value === 'manyToOne' && addresses.length > 1) {
    return '多对一模式只能填写一个目标钱包地址';
  }

  // 多对多模式数量必须相等
  if (transferMode.value === 'manyToMany' && sourceAddressCount.value !== addresses.length) {
    return `多对多模式需要源地址和目标地址数量相等（源: ${sourceAddressCount.value}, 目标: ${addresses.length}）`;
  }

  return '';
});

// 是否可以执行转账
const canExecuteTransfer = computed(() => {
  if (sourceAddressCount.value === 0) return false;
  if (targetAddressCount.value === 0) return false;
  if (!transferAmount.value || transferAmount.value <= 0) return false;
  if (sourceAddressError.value) return false;
  if (targetAddressError.value) return false;
  if (transferTokenType.value === 'token' && !targetToken.value) return false;
  return true;
});

// 执行转账
async function executeTransfer() {
  if (!canExecuteTransfer.value) return;

  isTransferring.value = true;
  transferResults.value = [];

  try {
    const results = await walletStore.batchTransferByAddresses(
      sourceAddresses.value,
      targetAddresses.value,
      transferAmount.value,
      transferTokenType.value,
      transferMode.value
    );
    transferResults.value = results;

    // 统计结果
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    if (failCount === 0) {
      alert(`转账完成！成功 ${successCount} 笔`);
    } else {
      alert(`转账完成！成功 ${successCount} 笔，失败 ${failCount} 笔`);
    }
  } catch (error: any) {
    alert(error.message || '转账失败');
  } finally {
    isTransferring.value = false;
  }
}

// 地址校验函数
function isValidAddress(address: string): boolean {
  if (!address) return false;
  const trimmed = address.trim();
  // 必须是 0x 开头，总长度 42 位，后面 40 位是十六进制字符
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed);
}

// 格式化地址显示
function formatAddress(address: string): string {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 获取区块浏览器交易链接
function getExplorerTxUrl(hash: string): string {
  const chainId = walletStore.currentChainId;
  const explorers: Record<number, string> = {
    56: 'https://bscscan.com/tx/',
    97: 'https://testnet.bscscan.com/tx/',
    66: 'https://www.oklink.com/okc/tx/'
  };
  return (explorers[chainId] || 'https://bscscan.com/tx/') + hash;
}

// 截断错误信息
function truncateError(error: string): string {
  if (!error) return '';
  return error.length > 30 ? error.slice(0, 30) + '...' : error;
}

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
  
  // 获取选中钱包的备注（如果所有选中钱包备注相同，显示该备注；否则显示空）
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
    // 如果设置了目标代币，也刷新目标代币余额
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

.transfer-results-list {
  font-size: 0.8rem;
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
