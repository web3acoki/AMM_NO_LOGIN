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
        <ul class="nav nav-tabs mb-3">
          <li class="nav-item">
            <a class="nav-link" :class="{ active: transferMode === 'distribute' }" href="#" @click.prevent="transferMode = 'distribute'">
              一对多（分发）
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link" :class="{ active: transferMode === 'collect' }" href="#" @click.prevent="transferMode = 'collect'">
              多对一（归集）
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link" :class="{ active: transferMode === 'manyToMany' }" href="#" @click.prevent="transferMode = 'manyToMany'">
              多对多
            </a>
          </li>
        </ul>

        <!-- 一对多（分发）-->
        <div v-if="transferMode === 'distribute'">
          <div class="alert alert-info small mb-2">
            <i class="bi bi-info-circle me-1"></i>
            <strong>使用说明：</strong>
            <ol class="mb-0 mt-1 small">
              <li>先在钱包列表中勾选<strong>一个源钱包</strong>，点击"设置源钱包"</li>
              <li>重新勾选<strong>目标钱包</strong>（用于接收资金）</li>
              <li>选择代币类型（{{ currentGovernanceToken }} 或 USDT）</li>
              <li>设置每个目标的转账金额，点击执行</li>
            </ol>
          </div>
          
          <div class="row g-2 mb-2">
            <div class="col-12 col-md-6">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="small"><strong>源钱包：</strong></span>
                <button 
                  class="btn btn-outline-secondary btn-sm" 
                  @click="setDistributeSourceWallet"
                  :disabled="selectedCount !== 1"
                >
                  <i class="bi bi-check-circle me-1"></i>设置源钱包
                </button>
                <span v-if="selectedCount !== 1 && !distributeSourceAddress" class="text-warning small">
                  （请选择1个钱包）
                </span>
              </div>
              <div v-if="distributeSourceAddress" class="small">
                <span class="badge bg-success me-1">已设置</span>
                <code>{{ formatAddress(distributeSourceAddress) }}</code>
              </div>
            </div>
            <div class="col-12 col-md-6">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="small"><strong>目标钱包：</strong>{{ distributeTargetAddresses.length }} 个</span>
                <button 
                  class="btn btn-outline-primary btn-sm" 
                  @click="setDistributeTargetWallets"
                  :disabled="selectedCount === 0"
                >
                  <i class="bi bi-check-circle me-1"></i>设置目标钱包
                </button>
              </div>
              <div v-if="distributeTargetAddresses.length > 0" class="small text-muted">
                <span v-for="(addr, idx) in distributeTargetAddresses.slice(0, 3)" :key="addr" class="me-2">
                  {{ formatAddress(addr) }}
                </span>
                <span v-if="distributeTargetAddresses.length > 3">...</span>
              </div>
            </div>
          </div>

          <div class="row g-2 align-items-end">
            <div class="col-auto">
              <label class="form-label small">代币类型</label>
              <select class="form-select form-select-sm" v-model="distributeTokenType">
                <option value="native">{{ currentGovernanceToken }}</option>
                <option value="usdt">USDT</option>
              </select>
            </div>
            <div class="col-auto" v-if="distributeTokenType === 'usdt'">
              <label class="form-label small">USDT 合约</label>
              <input type="text" class="form-control form-control-sm" :value="currentUsdtAddress" disabled style="width: 200px;">
            </div>
            <div class="col-auto">
              <label class="form-label small">每个钱包金额</label>
              <div class="input-group input-group-sm">
                <input type="number" class="form-control" v-model.number="distributeAmount" placeholder="0.01" step="0.001" min="0">
                <span class="input-group-text">{{ distributeTokenType === 'usdt' ? 'USDT' : currentGovernanceToken }}</span>
              </div>
            </div>
            <div class="col-auto">
              <button 
                class="btn btn-primary btn-sm" 
                @click="executeDistribute"
                :disabled="!distributeSourceAddress || distributeTargetAddresses.length === 0 || !distributeAmount || distributeAmount <= 0 || isTransferring"
              >
                {{ isTransferring ? '转账中...' : `分发 (1 → ${distributeTargetAddresses.length})` }}
              </button>
            </div>
          </div>
        </div>

        <!-- 多对一（归集）-->
        <div v-if="transferMode === 'collect'">
          <p class="text-muted small mb-2">
            从选中的本地钱包各转出指定金额到目标地址。
            <span v-if="selectedCount === 0" class="text-warning">（请先选择钱包）</span>
          </p>
          <div class="row g-2 align-items-end">
            <div class="col-12 col-md-6">
              <label class="form-label small">目标地址</label>
              <input type="text" class="form-control form-control-sm" v-model="collectTargetAddress" placeholder="0x...">
            </div>
            <div class="col-auto">
              <label class="form-label small">代币类型</label>
              <select class="form-select form-select-sm" v-model="collectTokenType">
                <option value="native">{{ currentGovernanceToken }}</option>
                <option value="usdt">USDT</option>
              </select>
            </div>
            <div class="col-auto">
              <label class="form-label small">每个钱包转出金额</label>
              <div class="input-group input-group-sm">
                <input type="number" class="form-control" v-model.number="collectAmount" placeholder="2" step="0.01" min="0">
                <span class="input-group-text">{{ collectTokenType === 'usdt' ? 'USDT' : currentGovernanceToken }}</span>
              </div>
            </div>
            <div class="col-auto">
              <button 
                class="btn btn-primary btn-sm" 
                @click="executeCollect"
                :disabled="selectedCount === 0 || !collectTargetAddress || !collectAmount || collectAmount <= 0 || isTransferring"
              >
                {{ isTransferring ? '归集中...' : `从 ${selectedCount} 个钱包归集` }}
              </button>
            </div>
          </div>
        </div>

        <!-- 多对多 -->
        <div v-if="transferMode === 'manyToMany'">
          <div class="alert alert-info small mb-2">
            <i class="bi bi-info-circle me-1"></i>
            <strong>使用说明：</strong>
            <ol class="mb-0 mt-1 small">
              <li>先在钱包列表中勾选<strong>源钱包</strong>（用于发送资金）</li>
              <li>点击"设置目标钱包"按钮，将当前选中的钱包设置为目标钱包</li>
              <li>重新勾选源钱包（如果需要不同的源钱包）</li>
              <li>设置每个目标的转账金额和分配策略</li>
              <li>点击"执行多对多转账"开始转账</li>
            </ol>
          </div>
          
          <div class="row g-2 mb-2">
            <div class="col-12 col-md-6">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="small"><strong>源钱包：</strong>{{ sourceWalletCount }} 个</span>
                <button 
                  class="btn btn-outline-secondary btn-sm" 
                  @click="setSourceWallets"
                  :disabled="selectedCount === 0"
                >
                  <i class="bi bi-check-circle me-1"></i>设置为源钱包
                </button>
              </div>
              <div v-if="sourceWalletAddresses.length > 0" class="small text-muted">
                <span v-for="(addr, idx) in sourceWalletAddresses.slice(0, 3)" :key="addr" class="me-2">
                  {{ formatAddress(addr) }}
                </span>
                <span v-if="sourceWalletAddresses.length > 3">...</span>
                <span class="ms-1">(共 {{ sourceWalletAddresses.length }} 个)</span>
              </div>
            </div>
            <div class="col-12 col-md-6">
              <div class="d-flex align-items-center gap-2 mb-1">
                <span class="small"><strong>目标钱包：</strong>{{ targetWalletAddresses.length }} 个</span>
                <button 
                  class="btn btn-outline-primary btn-sm" 
                  @click="setTargetWallets"
                  :disabled="selectedCount === 0"
                >
                  <i class="bi bi-check-circle me-1"></i>设置目标钱包
                </button>
              </div>
              <div v-if="targetWalletAddresses.length > 0" class="small text-muted">
                <span v-for="(addr, idx) in targetWalletAddresses.slice(0, 3)" :key="addr" class="me-2">
                  {{ formatAddress(addr) }}
                </span>
                <span v-if="targetWalletAddresses.length > 3">...</span>
                <span class="ms-1">(共 {{ targetWalletAddresses.length }} 个)</span>
              </div>
            </div>
          </div>

          <div v-if="targetWalletAddresses.length > 0" class="alert alert-warning small mb-2">
            <i class="bi bi-exclamation-triangle me-1"></i>
            <span v-if="invalidTargetAddresses.length > 0" class="text-danger">
              检测到 {{ invalidTargetAddresses.length }} 个无效目标地址，已自动过滤。
            </span>
            <span v-else>
              所有目标地址格式正确（共 {{ validTargetAddresses.length }} 个）
            </span>
          </div>

          <div class="row g-2 align-items-end">
            <div class="col-auto">
              <label class="form-label small">代币类型</label>
              <select class="form-select form-select-sm" v-model="manyToManyTokenType">
                <option value="native">{{ currentGovernanceToken }}</option>
                <option value="usdt">USDT</option>
              </select>
            </div>
            <div class="col-auto">
              <label class="form-label small">每个目标金额</label>
              <div class="input-group input-group-sm">
                <input type="number" class="form-control" v-model.number="manyToManyAmount" placeholder="0.01" step="0.001" min="0">
                <span class="input-group-text">{{ manyToManyTokenType === 'usdt' ? 'USDT' : currentGovernanceToken }}</span>
              </div>
            </div>
            <!-- 分配策略已注释，功能保留但默认使用顺序分配 -->
            <!-- <div class="col-auto">
              <label class="form-label small">分配策略</label>
              <select class="form-select form-select-sm" v-model="manyToManyStrategy">
                <option value="sequential">顺序分配</option>
                <option value="random">随机分配</option>
              </select>
            </div> -->
            <div class="col-auto">
              <button 
                class="btn btn-primary btn-sm" 
                @click="executeManyToMany"
                :disabled="sourceWalletAddresses.length === 0 || validTargetAddresses.length === 0 || !manyToManyAmount || manyToManyAmount <= 0 || isTransferring"
              >
                {{ isTransferring ? '转账中...' : `执行多对多转账 (${sourceWalletAddresses.length} → ${validTargetAddresses.length})` }}
              </button>
            </div>
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
                    <code class="text-primary">{{ formatAddress(result.wallet || result.source || '-') }}</code>
                  </td>
                  <td class="text-center">
                    <i class="bi bi-arrow-right text-muted"></i>
                  </td>
                  <td class="small">
                    <code class="text-info">{{ formatAddress(result.target || '-') }}</code>
                  </td>
                  <td class="small">
                    <span v-if="result.amount" class="text-success fw-bold">
                      {{ result.amount }} {{ result.tokenType === 'usdt' ? 'USDT' : currentGovernanceToken }}
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
            <th>USDT 余额</th>
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
            <td class="text-break small" style="max-width: 180px;">
              <span class="text-truncate d-inline-block" style="max-width: 180px;" :title="w.address">
                {{ w.address }}
              </span>
            </td>
            <td class="text-break small" style="max-width: 120px;">
              <span class="text-truncate d-inline-block" style="max-width: 120px;" :title="w.encrypted">
                {{ w.encrypted ? w.encrypted.slice(0, 10) + '...' : '-' }}
              </span>
            </td>
            <td>
              <span v-if="w.nativeBalance !== undefined">{{ w.nativeBalance }}</span>
              <span v-else class="text-muted">-</span>
            </td>
            <td>
              <span v-if="w.tokenBalance !== undefined">{{ w.tokenBalance }}</span>
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
const { localWallets: wallets, selectedWalletAddresses, selectedCount, isAllSelected } = storeToRefs(walletStore);
const { currentGovernanceToken } = storeToRefs(chainStore);

const isRefreshing = ref(false);
const rangeInput = ref('');
const showTransferPanel = ref(false);
const transferMode = ref<'distribute' | 'collect' | 'manyToMany'>('distribute');
const isTransferring = ref(false);
const transferResults = ref<any[]>([]);

// 分发参数
const distributeAmount = ref(0.01);
const distributeSourceAddress = ref('');
const distributeTargetAddresses = ref<string[]>([]);
const distributeTokenType = ref<'native' | 'usdt'>('native');

// 当前网络的 USDT 合约地址
const currentUsdtAddress = computed(() => {
  return walletStore.getUsdtContractAddress() || '未配置';
});

// 设置分发源钱包（只能选择一个）
function setDistributeSourceWallet() {
  if (selectedCount.value !== 1) {
    alert('请选择且仅选择 1 个钱包作为源钱包');
    return;
  }
  const sourceAddr = selectedWalletAddresses.value[0];
  const sourceWallet = walletStore.localWallets.find(w => w.address === sourceAddr);
  
  if (!sourceWallet?.encrypted) {
    alert('所选钱包没有私钥，无法作为源钱包');
    return;
  }
  
  distributeSourceAddress.value = sourceAddr;
  alert(`已设置源钱包：${formatAddress(sourceAddr)}`);
}

// 设置分发目标钱包
function setDistributeTargetWallets() {
  if (selectedCount.value === 0) {
    alert('请先选择目标钱包');
    return;
  }
  
  // 过滤掉源钱包（不能自己给自己转）
  const targets = selectedWalletAddresses.value.filter(addr => addr !== distributeSourceAddress.value);
  
  if (targets.length === 0) {
    alert('没有有效的目标钱包（目标钱包不能与源钱包相同）');
    return;
  }
  
  distributeTargetAddresses.value = targets;
  alert(`已设置 ${targets.length} 个目标钱包`);
}

// 归集参数
const collectTargetAddress = ref('');
const collectTokenType = ref<'native' | 'usdt'>('native');
const collectAmount = ref<number>(0);

// 多对多参数
const sourceWalletAddresses = ref<string[]>([]);
const targetWalletAddresses = ref<string[]>([]);
const manyToManyAmount = ref(0.01);
const manyToManyStrategy = ref<'sequential' | 'random'>('sequential');
const manyToManyTokenType = ref<'native' | 'usdt'>('native');

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

// 计算有效和无效的目标地址
const validTargetAddresses = computed(() => {
  return targetWalletAddresses.value.filter(addr => isValidAddress(addr));
});

const invalidTargetAddresses = computed(() => {
  return targetWalletAddresses.value.filter(addr => !isValidAddress(addr));
});

const sourceWalletCount = computed(() => sourceWalletAddresses.value.length);

// 设置源钱包
function setSourceWallets() {
  if (selectedCount.value === 0) {
    alert('请先选择源钱包');
    return;
  }
  sourceWalletAddresses.value = [...selectedWalletAddresses.value];
  alert(`已设置 ${sourceWalletAddresses.value.length} 个源钱包`);
}

// 设置目标钱包
function setTargetWallets() {
  if (selectedCount.value === 0) {
    alert('请先选择目标钱包');
    return;
  }
  targetWalletAddresses.value = [...selectedWalletAddresses.value];
  
  // 校验目标地址
  const invalid = invalidTargetAddresses.value;
  if (invalid.length > 0) {
    alert(`已设置 ${targetWalletAddresses.value.length} 个目标钱包，但检测到 ${invalid.length} 个无效地址，已自动过滤。`);
  } else {
    alert(`已设置 ${targetWalletAddresses.value.length} 个目标钱包`);
  }
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


// 执行分发（一对多）
async function executeDistribute() {
  // 检查源钱包
  if (!distributeSourceAddress.value) {
    alert('请先设置源钱包');
    return;
  }
  
  // 检查目标钱包
  if (distributeTargetAddresses.value.length === 0) {
    alert('请先设置目标钱包');
    return;
  }
  
  // 检查金额
  if (!distributeAmount.value || distributeAmount.value <= 0) {
    alert('请输入有效的转账金额');
    return;
  }
  
  // 检查源钱包是否有私钥
  const sourceWallet = walletStore.localWallets.find(w => w.address === distributeSourceAddress.value);
  if (!sourceWallet?.encrypted) {
    alert('源钱包没有私钥，无法执行转账');
    return;
  }
  
  // 如果选择 USDT，检查合约地址
  if (distributeTokenType.value === 'usdt' && currentUsdtAddress.value === '未配置') {
    alert('当前网络未配置 USDT 合约地址');
    return;
  }
  
  isTransferring.value = true;
  transferResults.value = [];
  
  try {
    const results = await walletStore.distributeFromSource(
      distributeSourceAddress.value,
      distributeTargetAddresses.value,
      distributeAmount.value,
      distributeTokenType.value
    );
    transferResults.value = results;
  } catch (error: any) {
    alert(error.message || '分发失败');
  } finally {
    isTransferring.value = false;
  }
}

// 执行归集（多对一）
async function executeCollect() {
  if (selectedCount.value === 0 || !collectTargetAddress.value || !collectAmount.value || collectAmount.value <= 0) return;
  
  isTransferring.value = true;
  transferResults.value = [];
  
  try {
    const results = await walletStore.collectFromSelected(
      collectTargetAddress.value,
      collectAmount.value,
      collectTokenType.value
    );
    transferResults.value = results;
  } catch (error: any) {
    alert(error.message || '归集失败');
  } finally {
    isTransferring.value = false;
  }
}

// 执行多对多
async function executeManyToMany() {
  // 检查源钱包
  if (sourceWalletAddresses.value.length === 0) {
    alert('请先设置源钱包');
    return;
  }
  
  // 检查目标钱包
  if (validTargetAddresses.value.length === 0) {
    alert('请先设置有效的目标钱包（地址格式必须正确：0x开头，42位长度）');
    return;
  }
  
  if (!manyToManyAmount.value || manyToManyAmount.value <= 0) {
    alert('请输入有效的转账金额');
    return;
  }
  
  // 检查源钱包是否有私钥
  const sourceWallets = walletStore.localWallets.filter(w => 
    sourceWalletAddresses.value.includes(w.address)
  );
  
  const walletsWithKey = sourceWallets.filter(w => w.encrypted);
  if (walletsWithKey.length === 0) {
    alert('源钱包中没有包含私钥的钱包，无法执行转账');
    return;
  }
  
  if (walletsWithKey.length < sourceWallets.length) {
    const missingCount = sourceWallets.length - walletsWithKey.length;
    if (!confirm(`警告：${missingCount} 个源钱包没有私钥，将被跳过。是否继续？`)) {
      return;
    }
  }
  
  isTransferring.value = true;
  transferResults.value = [];
  
  try {
    const results = await walletStore.manyToManyTransfer(
      validTargetAddresses.value,
      manyToManyAmount.value,
      manyToManyStrategy.value,
      sourceWalletAddresses.value,
      manyToManyTokenType.value
    );
    transferResults.value = results;
  } catch (error: any) {
    alert(error.message || '多对多转账失败');
  } finally {
    isTransferring.value = false;
  }
}
</script>

<style scoped>
.wallet-table-container {
  font-size: 0.875rem;
}

.table th, .table td {
  vertical-align: middle;
}

.form-check-input {
  cursor: pointer;
}

.form-check-input:indeterminate {
  background-color: var(--bs-primary);
  border-color: var(--bs-primary);
}

.transfer-results-list {
  font-size: 0.75rem;
}
</style>
