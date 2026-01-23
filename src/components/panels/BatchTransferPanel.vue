<template>
  <div class="batch-transfer-panel p-4">
    <!-- 标题栏 -->
    <div class="d-flex justify-content-between align-items-center mb-4">
      <div>
        <h5 class="mb-1"><i class="bi bi-send me-2"></i>批量转账</h5>
        <small class="text-muted">支持一对多、多对一、多对多转账模式</small>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="badge bg-secondary">{{ currentGovernanceToken }}</span>
        <span v-if="targetToken" class="badge bg-success">目标: {{ targetToken.symbol }}</span>
      </div>
    </div>

    <!-- 转账模式选择 -->
    <div class="card mb-4">
      <div class="card-header bg-light">
        <span class="fw-bold"><i class="bi bi-diagram-3 me-2"></i>转账模式</span>
      </div>
      <div class="card-body">
        <div class="btn-group w-100" role="group">
          <input type="radio" class="btn-check" name="transferMode" id="modeOneToMany" value="oneToMany" v-model="transferMode">
          <label class="btn btn-outline-primary" for="modeOneToMany">
            <i class="bi bi-arrow-down-circle me-1"></i>一对多
          </label>
          <input type="radio" class="btn-check" name="transferMode" id="modeManyToOne" value="manyToOne" v-model="transferMode">
          <label class="btn btn-outline-primary" for="modeManyToOne">
            <i class="bi bi-arrow-up-circle me-1"></i>多对一
          </label>
          <input type="radio" class="btn-check" name="transferMode" id="modeManyToMany" value="manyToMany" v-model="transferMode">
          <label class="btn btn-outline-primary" for="modeManyToMany">
            <i class="bi bi-arrow-left-right me-1"></i>多对多
          </label>
        </div>
        <div class="alert alert-info small mt-3 mb-0">
          <i class="bi bi-info-circle me-1"></i>
          <span v-if="transferMode === 'oneToMany'">一个源钱包向多个目标钱包转账（源钱包只能填1个，必须是主钱包）</span>
          <span v-else-if="transferMode === 'manyToOne'">多个源钱包向一个目标钱包转账（目标钱包必须是主钱包，源钱包可直接输入私钥）</span>
          <span v-else>源钱包和目标钱包一一对应转账（数量必须相等，源钱包可直接输入私钥）</span>
        </div>
      </div>
    </div>

    <!-- 地址输入区域 -->
    <div class="row g-4 mb-4">
      <!-- 源钱包 -->
      <div class="col-12 col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-light d-flex justify-content-between align-items-center">
            <span class="fw-bold">
              <i class="bi bi-wallet2 me-2"></i>源钱包地址
              <span class="badge bg-primary ms-2">{{ sourceAddressCount }} 个</span>
            </span>
            <div class="d-flex gap-2">
              <label class="btn btn-outline-primary btn-sm">
                <i class="bi bi-file-earmark-arrow-up me-1"></i>导入TXT
                <input type="file" accept=".txt" class="d-none" @change="handleSourceFileImport">
              </label>
              <button class="btn btn-outline-danger btn-sm" @click="sourceAddressesText = ''; selectedSourceBatchId = ''">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
          <div class="card-body">
            <!-- 批次选择 -->
            <div class="mb-3" v-if="walletBatches.length > 0">
              <label class="form-label small text-muted">从批次填充</label>
              <select class="form-select form-select-sm" v-model="selectedSourceBatchId">
                <option value="">-- 选择批次 --</option>
                <option v-for="batch in walletBatches" :key="batch.id" :value="batch.id">
                  {{ batch.remark }} ({{ batch.wallets.length }} 个)
                </option>
              </select>
            </div>
            <textarea
              class="form-control"
              v-model="sourceAddressesText"
              rows="10"
              placeholder="每行一个钱包地址或私钥&#10;0x1234...&#10;0x5678..."
              :class="{ 'is-invalid': sourceAddressError }"
            ></textarea>
            <div v-if="sourceAddressError" class="invalid-feedback">{{ sourceAddressError }}</div>
          </div>
        </div>
      </div>

      <!-- 目标钱包 -->
      <div class="col-12 col-lg-6">
        <div class="card h-100">
          <div class="card-header bg-light d-flex justify-content-between align-items-center">
            <span class="fw-bold">
              <i class="bi bi-wallet-fill me-2"></i>目标钱包地址
              <span class="badge bg-info ms-2">{{ targetAddressCount }} 个</span>
            </span>
            <div class="d-flex gap-2">
              <label class="btn btn-outline-primary btn-sm">
                <i class="bi bi-file-earmark-arrow-up me-1"></i>导入TXT
                <input type="file" accept=".txt" class="d-none" @change="handleTargetFileImport">
              </label>
              <button class="btn btn-outline-danger btn-sm" @click="targetAddressesText = ''; selectedTargetBatchId = ''">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
          <div class="card-body">
            <!-- 批次选择 -->
            <div class="mb-3" v-if="walletBatches.length > 0">
              <label class="form-label small text-muted">从批次填充</label>
              <select class="form-select form-select-sm" v-model="selectedTargetBatchId">
                <option value="">-- 选择批次 --</option>
                <option v-for="batch in walletBatches" :key="batch.id" :value="batch.id">
                  {{ batch.remark }} ({{ batch.wallets.length }} 个)
                </option>
              </select>
            </div>
            <textarea
              class="form-control"
              v-model="targetAddressesText"
              rows="10"
              placeholder="每行一个钱包地址&#10;0xabcd...&#10;0xefgh..."
              :class="{ 'is-invalid': targetAddressError }"
            ></textarea>
            <div v-if="targetAddressError" class="invalid-feedback">{{ targetAddressError }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 转账参数 -->
    <div class="card mb-4">
      <div class="card-header bg-light">
        <span class="fw-bold"><i class="bi bi-gear me-2"></i>转账参数</span>
      </div>
      <div class="card-body">
        <div class="row g-3 align-items-end">
          <div class="col-12 col-md-3">
            <label class="form-label">转账金额</label>
            <div class="input-group">
              <input
                type="number"
                class="form-control"
                v-model.number="transferAmount"
                placeholder="0.01"
                step="0.001"
                min="0"
                :disabled="transferAllBalance"
              >
              <span class="input-group-text">{{ transferTokenType === 'token' && targetToken ? targetToken.symbol : currentGovernanceToken }}</span>
            </div>
          </div>
          <div class="col-12 col-md-3">
            <label class="form-label">代币类型</label>
            <select class="form-select" v-model="transferTokenType">
              <option value="native">{{ currentGovernanceToken }}</option>
              <option value="token" :disabled="!targetToken">{{ targetToken ? targetToken.symbol : '目标代币' }}</option>
            </select>
          </div>
          <!-- 多转一和多转多模式显示"转全部余额"选项 -->
          <div v-if="transferMode === 'manyToMany' || transferMode === 'manyToOne'" class="col-12 col-md-3">
            <div class="form-check mt-4">
              <input
                type="checkbox"
                class="form-check-input"
                id="transferAllBalance"
                v-model="transferAllBalance"
              >
              <label class="form-check-label" for="transferAllBalance">
                转全部余额
                <small class="text-muted d-block">(仅扣除gas费)</small>
              </label>
            </div>
          </div>
          <div class="col-12 col-md-3">
            <button
              class="btn btn-primary w-100"
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
      </div>
    </div>

    <!-- 转账结果 -->
    <div v-if="transferResults.length > 0" class="card">
      <div class="card-header bg-light d-flex justify-content-between align-items-center">
        <span class="fw-bold">
          <i class="bi bi-list-check me-2"></i>转账结果
          <span class="badge bg-secondary ms-2">{{ transferResults.length }}</span>
          <span class="badge bg-success ms-1">{{ transferResults.filter(r => r.success).length }} 成功</span>
          <span v-if="transferResults.filter(r => !r.success).length > 0" class="badge bg-danger ms-1">
            {{ transferResults.filter(r => !r.success).length }} 失败
          </span>
        </span>
        <button class="btn btn-outline-secondary btn-sm" @click="transferResults = []">
          <i class="bi bi-x-lg me-1"></i>清除
        </button>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
          <table class="table table-sm table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th style="width: 50px;">#</th>
                <th style="width: 60px;">状态</th>
                <th>From</th>
                <th style="width: 40px;"></th>
                <th>To</th>
                <th>金额</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(result, idx) in transferResults" :key="idx" :class="result.success ? '' : 'table-danger'">
                <td class="text-muted">{{ idx + 1 }}</td>
                <td>
                  <i class="bi" :class="result.success ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'"></i>
                </td>
                <td>
                  <code class="text-primary">{{ formatAddress(result.source || '-') }}</code>
                </td>
                <td class="text-center">
                  <i class="bi bi-arrow-right text-muted"></i>
                </td>
                <td>
                  <code class="text-info">{{ formatAddress(result.target || '-') }}</code>
                </td>
                <td>
                  <span v-if="result.amount !== undefined" class="text-success fw-bold">
                    {{ transferAmount }} {{ transferTokenType === 'token' && targetToken ? targetToken.symbol : currentGovernanceToken }}
                  </span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td>
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
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';
import { privateKeyToAccount } from 'viem/accounts';

// 私钥正则表达式
const PRIVATE_KEY_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;

const walletStore = useWalletStore();
const chainStore = useChainStore();
const { targetToken, walletBatches } = storeToRefs(walletStore);
const { currentGovernanceToken } = storeToRefs(chainStore);

const isTransferring = ref(false);
const transferResults = ref<any[]>([]);

// 批量转账参数
const transferMode = ref<'oneToMany' | 'manyToOne' | 'manyToMany'>('oneToMany');
const sourceAddressesText = ref('');
const targetAddressesText = ref('');
const transferAmount = ref<number>(0.01);
const transferTokenType = ref<'native' | 'token'>('native');
const transferAllBalance = ref(false);

// 批次选择
const selectedSourceBatchId = ref('');
const selectedTargetBatchId = ref('');

// 当切换到多转多或多转一模式时，默认勾选"转全部余额"
watch(transferMode, (newMode) => {
  if (newMode === 'manyToMany' || newMode === 'manyToOne') {
    transferAllBalance.value = true;
  } else {
    transferAllBalance.value = false;
  }
});

// 当选择批次时，填充地址
watch(selectedSourceBatchId, (batchId) => {
  if (batchId) {
    const batch = walletBatches.value.find(b => b.id === batchId);
    if (batch) {
      sourceAddressesText.value = batch.wallets.map(w => w.address).join('\n');
    }
  }
});

watch(selectedTargetBatchId, (batchId) => {
  if (batchId) {
    const batch = walletBatches.value.find(b => b.id === batchId);
    if (batch) {
      targetAddressesText.value = batch.wallets.map(w => w.address).join('\n');
    }
  }
});

// 获取批次的私钥映射
const batchPrivateKeyMap = computed(() => {
  const map: Record<string, string> = {};
  if (selectedSourceBatchId.value) {
    const batch = walletBatches.value.find(b => b.id === selectedSourceBatchId.value);
    if (batch) {
      for (const wallet of batch.wallets) {
        map[wallet.address.toLowerCase()] = wallet.privateKey;
      }
    }
  }
  return map;
});

// 解析地址文本为地址数组
function parseAddresses(text: string): string[] {
  if (!text.trim()) return [];
  return text
    .split(/[\n,;]/)
    .map(addr => addr.trim())
    .filter(addr => addr.length > 0);
}

// 解析源地址（支持私钥输入，仅多转多模式）
function parseSourceAddressesWithPrivateKey(text: string): { addresses: string[]; privateKeyMap: Record<string, string> } {
  const addresses: string[] = [];
  const privateKeyMap: Record<string, string> = {};

  if (!text.trim()) return { addresses, privateKeyMap };

  const lines = text.split(/[\n,;]/).map(line => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (PRIVATE_KEY_REGEX.test(line)) {
      try {
        const normalizedKey = line.startsWith('0x') ? line : `0x${line}`;
        const account = privateKeyToAccount(normalizedKey as `0x${string}`);
        addresses.push(account.address);
        privateKeyMap[account.address.toLowerCase()] = normalizedKey;
      } catch (e) {
        console.warn('无效的私钥:', line.slice(0, 10) + '...');
      }
    } else if (/^0x[0-9a-fA-F]{40}$/.test(line)) {
      addresses.push(line);
    }
  }

  return { addresses, privateKeyMap };
}

// 处理源地址文件导入
async function handleSourceFileImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (sourceAddressesText.value.trim()) {
      sourceAddressesText.value += '\n' + lines.join('\n');
    } else {
      sourceAddressesText.value = lines.join('\n');
    }
  } catch (error) {
    alert('读取文件失败');
  }
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
    if (targetAddressesText.value.trim()) {
      targetAddressesText.value += '\n' + lines.join('\n');
    } else {
      targetAddressesText.value = lines.join('\n');
    }
  } catch (error) {
    alert('读取文件失败');
  }
  input.value = '';
}

// 源地址列表
const sourceAddresses = computed(() => {
  // 多转多和多转一模式都支持私钥输入
  if (transferMode.value === 'manyToMany' || transferMode.value === 'manyToOne') {
    return parseSourceAddressesWithPrivateKey(sourceAddressesText.value).addresses;
  }
  return parseAddresses(sourceAddressesText.value);
});
const targetAddresses = computed(() => parseAddresses(targetAddressesText.value));

// 获取私钥映射（多转多和多转一模式）
const sourcePrivateKeyMap = computed(() => {
  if (transferMode.value === 'manyToMany' || transferMode.value === 'manyToOne') {
    return parseSourceAddressesWithPrivateKey(sourceAddressesText.value).privateKeyMap;
  }
  return {};
});

// 地址计数
const sourceAddressCount = computed(() => sourceAddresses.value.length);
const targetAddressCount = computed(() => targetAddresses.value.length);

// 源地址验证错误
const sourceAddressError = computed(() => {
  const addresses = sourceAddresses.value;
  if (addresses.length === 0) return '';

  // 多转多和多转一模式支持私钥输入
  if (transferMode.value === 'manyToMany' || transferMode.value === 'manyToOne') {
    const lines = sourceAddressesText.value.split(/[\n,;]/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const isAddress = /^0x[0-9a-fA-F]{40}$/.test(line);
      const isPrivateKey = PRIVATE_KEY_REGEX.test(line);
      if (!isAddress && !isPrivateKey) {
        return '存在无效的地址或私钥格式';
      }
    }

    const walletsWithKey = addresses.filter(addr => {
      // 优先检查批次私钥映射
      if (batchPrivateKeyMap.value[addr.toLowerCase()]) return true;
      // 其次检查手动输入的私钥映射
      if (sourcePrivateKeyMap.value[addr.toLowerCase()]) return true;
      // 最后检查本地钱包
      const wallet = walletStore.localWallets.find(w => w.address.toLowerCase() === addr.toLowerCase());
      return wallet?.encrypted;
    });

    if (walletsWithKey.length < addresses.length) {
      const missingCount = addresses.length - walletsWithKey.length;
      return `${missingCount} 个地址没有私钥（请直接输入私钥而不是地址）`;
    }

    return '';
  }

  // 一对多模式：检查格式
  const invalidAddrs = addresses.filter(addr => !isValidAddress(addr));
  if (invalidAddrs.length > 0) {
    return `${invalidAddrs.length} 个地址格式无效`;
  }

  const walletsWithKey = addresses.filter(addr => {
    if (batchPrivateKeyMap.value[addr.toLowerCase()]) return true;
    const wallet = walletStore.localWallets.find(w => w.address.toLowerCase() === addr.toLowerCase());
    return wallet?.encrypted;
  });

  if (walletsWithKey.length < addresses.length) {
    const missingCount = addresses.length - walletsWithKey.length;
    return `${missingCount} 个地址在本地钱包中不存在或无私钥`;
  }

  if (transferMode.value === 'oneToMany' && addresses.length > 1) {
    return '一对多模式只能填写一个源钱包地址';
  }

  return '';
});

// 目标地址验证错误
const targetAddressError = computed(() => {
  const addresses = targetAddresses.value;
  if (addresses.length === 0) return '';

  const invalidAddrs = addresses.filter(addr => !isValidAddress(addr));
  if (invalidAddrs.length > 0) {
    return `${invalidAddrs.length} 个地址格式无效`;
  }

  if (transferMode.value === 'manyToOne' && addresses.length > 1) {
    return '多对一模式只能填写一个目标钱包地址';
  }

  if (transferMode.value === 'manyToMany' && sourceAddressCount.value !== addresses.length) {
    return `多对多模式需要源地址和目标地址数量相等（源: ${sourceAddressCount.value}, 目标: ${addresses.length}）`;
  }

  return '';
});

// 是否可以执行转账
const canExecuteTransfer = computed(() => {
  if (sourceAddressCount.value === 0) return false;
  if (targetAddressCount.value === 0) return false;
  if (!transferAllBalance.value && (!transferAmount.value || transferAmount.value <= 0)) return false;
  if (sourceAddressError.value) return false;
  if (targetAddressError.value) return false;
  if (transferTokenType.value === 'token' && !targetToken.value) return false;
  return true;
});

// 执行转账
async function executeTransfer() {
  if (!canExecuteTransfer.value) return;

  const walletTypeError = validateWalletTypes();
  if (walletTypeError) {
    alert(walletTypeError);
    return;
  }

  isTransferring.value = true;
  transferResults.value = [];

  try {
    const mergedPrivateKeyMap = {
      ...batchPrivateKeyMap.value,
      ...sourcePrivateKeyMap.value
    };

    const results = await walletStore.batchTransferByAddresses(
      sourceAddresses.value,
      targetAddresses.value,
      transferAllBalance.value ? 0 : transferAmount.value,
      transferTokenType.value,
      transferMode.value,
      {
        privateKeyMap: mergedPrivateKeyMap,
        transferAllBalance: transferAllBalance.value
      }
    );
    transferResults.value = results;

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    if (failCount === 0) {
      alert(`转账完成！成功 ${successCount} 笔`);
    } else if (successCount === 0) {
      const firstError = results.find(r => r.error)?.error || '未知错误';
      alert(`转账全部失败！共 ${failCount} 笔\n\n失败原因: ${firstError}`);
    } else {
      const firstError = results.find(r => r.error)?.error || '未知错误';
      alert(`转账部分完成\n\n成功: ${successCount} 笔\n失败: ${failCount} 笔\n\n失败原因: ${firstError}`);
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
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed);
}

// 检查钱包是否为主钱包
function isMainWallet(address: string): boolean {
  const walletType = walletStore.getWalletTypeByAddress(address);
  return walletType === 'main';
}

// 验证钱包类型
function validateWalletTypes(): string | null {
  if (transferMode.value === 'oneToMany') {
    const sourceAddr = sourceAddresses.value[0];
    if (sourceAddr && !isMainWallet(sourceAddr)) {
      return '一转多模式下，源钱包必须是主钱包';
    }
  } else if (transferMode.value === 'manyToOne') {
    const targetAddr = targetAddresses.value[0];
    if (targetAddr && !isMainWallet(targetAddr)) {
      return '多转一模式下，目标钱包必须是主钱包';
    }
  }
  return null;
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
</script>

<style scoped>
.batch-transfer-panel {
  max-width: 1400px;
  margin: 0 auto;
}

.card {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.card-header {
  font-size: 0.95rem;
}

textarea.form-control {
  font-family: monospace;
  font-size: 0.85rem;
}

.table th, .table td {
  vertical-align: middle;
  font-size: 0.85rem;
}

.btn-group .btn {
  flex: 1;
}
</style>
