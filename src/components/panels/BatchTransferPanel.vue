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
      <div class="card-header bg-light d-flex justify-content-between align-items-center">
        <span class="fw-bold"><i class="bi bi-gear me-2"></i>转账参数</span>
        <button
          class="btn btn-sm"
          :class="showSecondTransfer ? 'btn-outline-danger' : 'btn-outline-success'"
          @click="toggleSecondTransfer"
          :title="showSecondTransfer ? '移除第二组转账' : '添加第二组转账'"
        >
          <i class="bi" :class="showSecondTransfer ? 'bi-dash-lg' : 'bi-plus-lg'"></i>
          {{ showSecondTransfer ? '移除' : '添加第二组' }}
        </button>
      </div>
      <div class="card-body">
        <!-- 第一组标签 -->
        <div v-if="showSecondTransfer" class="badge bg-primary mb-2">第一组</div>
        <div class="row g-3 align-items-end">
          <div class="col-12 col-md-3">
            <label class="form-label">转账金额</label>
            <div class="input-group">
              <input
                type="text"
                inputmode="decimal"
                pattern="[0-9]+([.][0-9]+)?"
                class="form-control"
                v-model="transferAmount"
                placeholder="0.01"
                :disabled="transferAllBalance"
              >
              <span class="input-group-text">{{ transferTokenType === 'aster' ? 'ASTER' : (transferTokenType === 'token' && targetToken ? targetToken.symbol : currentGovernanceToken) }}</span>
            </div>
          </div>
          <div class="col-12 col-md-3">
            <label class="form-label">代币类型</label>
            <select class="form-select" v-model="transferTokenType">
              <option value="native">{{ currentGovernanceToken }}</option>
              <option v-if="isBscChain" value="aster">ASTER</option>
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
        </div>

        <!-- 第二组转账参数 -->
        <div v-if="showSecondTransfer" class="mt-3">
          <div class="badge bg-success mb-2">第二组</div>
          <div class="row g-3 align-items-end">
            <div class="col-12 col-md-3">
              <label class="form-label">转账金额</label>
              <div class="input-group">
                <input
                  type="text"
                  inputmode="decimal"
                  pattern="[0-9]+([.][0-9]+)?"
                  class="form-control"
                  v-model="transferAmount2"
                  placeholder="0.01"
                  :disabled="transferAllBalance2"
                >
                <span class="input-group-text">{{ tokenLabel(transferTokenType2) }}</span>
              </div>
            </div>
            <div class="col-12 col-md-3">
              <label class="form-label">代币类型</label>
            <select class="form-select" v-model="transferTokenType2">
              <option value="native">{{ currentGovernanceToken }}</option>
              <option v-if="isBscChain" value="aster">ASTER</option>
              <option value="token" :disabled="!targetToken">{{ targetToken ? targetToken.symbol : '目标代币' }}</option>
            </select>
            </div>
            <div v-if="transferMode === 'manyToMany' || transferMode === 'manyToOne'" class="col-12 col-md-3">
              <div class="form-check mt-4">
                <input
                  type="checkbox"
                  class="form-check-input"
                  id="transferAllBalance2"
                  v-model="transferAllBalance2"
                >
                <label class="form-check-label" for="transferAllBalance2">
                  转全部余额
                  <small class="text-muted d-block">(仅扣除gas费)</small>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- 转账间隔设置 -->
        <div v-if="transferMode !== 'oneToMany'" class="row g-3 mt-2 align-items-center">
          <div class="col-auto">
            <div class="form-check">
              <input
                type="checkbox"
                class="form-check-input"
                id="intervalEnabled"
                v-model="intervalEnabled"
              >
              <label class="form-check-label" for="intervalEnabled">
                启用转账间隔
                <small class="text-muted d-block">每笔转账之间等待指定秒数</small>
              </label>
            </div>
          </div>
          <div v-if="intervalEnabled" class="col-auto">
            <div class="input-group input-group-sm">
              <span class="input-group-text"><i class="bi bi-clock me-1"></i>间隔</span>
              <input
                type="number"
                class="form-control"
                style="width: 80px;"
                v-model.number="intervalSeconds"
                min="1"
                max="3600"
                step="1"
              >
              <span class="input-group-text">秒</span>
            </div>
          </div>
        </div>
        <div v-else class="alert alert-info py-2 mt-3 mb-0 small">
          <i class="bi bi-lightning-charge-fill me-1"></i>
          一对多使用连续 nonce 快速广播，不逐笔等待回执，也不启用人为转账间隔。
        </div>

        <!-- 执行按钮 -->
        <div class="mt-3">
          <button
            class="btn btn-primary"
            @click="executeTransfer"
            :disabled="!canExecuteTransfer || isTransferring"
          >
            <span v-if="isTransferring">
              <span class="spinner-border spinner-border-sm me-1"></span>转账中...
            </span>
            <span v-else>
              <i class="bi bi-send me-1"></i>执行转账 ({{ sourceAddressCount }} → {{ targetAddressCount }})
              <span v-if="showSecondTransfer" class="ms-1">[{{ tokenLabel(transferTokenType) }} + {{ tokenLabel(transferTokenType2) }}]</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 转账结果 -->
    <div v-if="transferResults.length > 0" class="card">
      <div class="card-header bg-light d-flex justify-content-between align-items-center">
        <span class="fw-bold">
          <i class="bi bi-list-check me-2"></i>转账结果
          <span class="badge bg-secondary ms-2">{{ transferResults.length }}</span>
          <span class="badge bg-success ms-1">{{ confirmedResultCount }} 已确认</span>
          <span v-if="pendingResultCount > 0" class="badge bg-warning text-dark ms-1">
            {{ pendingResultCount }} 确认中
          </span>
          <span v-if="unknownResultCount > 0" class="badge bg-warning text-dark ms-1">
            {{ unknownResultCount }} 待核对
          </span>
          <span v-if="failedResultCount > 0" class="badge bg-danger ms-1">
            {{ failedResultCount }} 未完成
          </span>
        </span>
        <div>
          <button
            v-if="retryableResults.length > 0"
            class="btn btn-outline-danger btn-sm me-2"
            :disabled="isTransferring"
            @click="retryFailedTransfers"
          >
            <i class="bi bi-arrow-repeat me-1"></i>重试未发送 ({{ retryableResults.length }})
          </button>
          <button class="btn btn-outline-secondary btn-sm" @click="transferResults = []">
            <i class="bi bi-x-lg me-1"></i>清除
          </button>
        </div>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
          <table class="table table-sm table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th style="width: 50px;">#</th>
                <th style="width: 100px;">状态</th>
                <th>From</th>
                <th style="width: 40px;"></th>
                <th>To</th>
                <th>金额</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(result, idx) in transferResults" :key="idx" :class="resultRowClass(result)">
                <td class="text-muted">{{ idx + 1 }}</td>
                <td>
                  <i class="bi me-1" :class="resultStatusIcon(result)"></i>
                  <small>{{ resultStatusLabel(result) }}</small>
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
                    {{ result.amount }} {{ result._tokenLabel || tokenLabel(transferTokenType) }}
                  </span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td>
                  <div v-if="result.hash">
                    <a :href="getExplorerTxUrl(result.hash)" target="_blank" class="text-decoration-none">
                      <i class="bi bi-box-arrow-up-right me-1"></i>{{ formatAddress(result.hash) }}
                    </a>
                    <small v-if="result.error" class="d-block" :class="resultDetailClass(result)" :title="result.error">
                      {{ truncateError(result.error) }}
                    </small>
                  </div>
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
const { currentGovernanceToken, selectedChainId } = storeToRefs(chainStore);
const isBscChain = computed(() => selectedChainId.value === 56 || selectedChainId.value === 97);

const isTransferring = ref(false);
const transferResults = ref<any[]>([]);

type TransferResultStatus = 'confirmed' | 'pending' | 'failed' | 'not_sent' | 'unknown';

function resultStatus(result: any): TransferResultStatus {
  if (result.status) return result.status;
  return result.success ? 'confirmed' : 'failed';
}

const confirmedResultCount = computed(() => (
  transferResults.value.filter(result => resultStatus(result) === 'confirmed').length
));
const pendingResultCount = computed(() => (
  transferResults.value.filter(result => resultStatus(result) === 'pending').length
));
const unknownResultCount = computed(() => (
  transferResults.value.filter(result => resultStatus(result) === 'unknown').length
));
const failedResultCount = computed(() => (
  transferResults.value.filter(result => ['failed', 'not_sent'].includes(resultStatus(result))).length
));
const retryableResults = computed(() => transferResults.value.filter((result) => {
  if (result.retryable !== undefined) return result.retryable === true && !result.hash;
  // 兼容旧的多对一/多对多结果；任何已有 hash 的交易都不能重新付款。
  return !result.success && !result.hash;
}));

function resultStatusLabel(result: any): string {
  switch (resultStatus(result)) {
    case 'confirmed': return '已确认';
    case 'pending': return '确认中';
    case 'unknown': return '待核对';
    case 'not_sent': return '未发送';
    default: return '失败';
  }
}

function resultStatusIcon(result: any): string {
  switch (resultStatus(result)) {
    case 'confirmed': return 'bi-check-circle-fill text-success';
    case 'pending': return 'bi-hourglass-split text-warning';
    case 'unknown': return 'bi-question-circle-fill text-warning';
    case 'not_sent': return 'bi-slash-circle text-danger';
    default: return 'bi-x-circle-fill text-danger';
  }
}

function resultRowClass(result: any): string {
  const status = resultStatus(result);
  if (status === 'pending' || status === 'unknown') return 'table-warning';
  if (status === 'failed' || status === 'not_sent') return 'table-danger';
  return '';
}

function resultDetailClass(result: any): string {
  const status = resultStatus(result);
  return status === 'pending' || status === 'unknown' ? 'text-warning' : 'text-danger';
}

// 批量转账参数
const transferMode = ref<'oneToMany' | 'manyToOne' | 'manyToMany'>('oneToMany');
const sourceAddressesText = ref('');
const targetAddressesText = ref('');
const transferAmount = ref('0.01');
const transferTokenType = ref<'native' | 'token' | 'aster'>('native');
const transferAllBalance = ref(false);

// 第二组转账参数
const showSecondTransfer = ref(false);
const transferAmount2 = ref('0.01');
const transferTokenType2 = ref<'native' | 'token' | 'aster'>('aster');
const transferAllBalance2 = ref(false);

// 转账间隔
const intervalEnabled = ref(false);
const intervalSeconds = ref(3);

// 批次选择
const selectedSourceBatchId = ref('');
const selectedTargetBatchId = ref('');

// 当切换到多转多或多转一模式时，默认勾选"转全部余额"
watch(transferMode, (newMode) => {
  if (newMode === 'manyToMany' || newMode === 'manyToOne') {
    transferAllBalance.value = true;
    transferAllBalance2.value = true;
  } else {
    transferAllBalance.value = false;
    transferAllBalance2.value = false;
    intervalEnabled.value = false;
  }
});

watch(selectedChainId, () => {
  if (!isBscChain.value) {
    if (transferTokenType.value === 'aster') transferTokenType.value = 'native';
    if (transferTokenType2.value === 'aster') {
      transferTokenType2.value = targetToken.value ? 'token' : 'native';
    }
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

// 切换第二组转账
function toggleSecondTransfer() {
  showSecondTransfer.value = !showSecondTransfer.value;
  if (showSecondTransfer.value) {
    // 自动选择与第一组不同的代币类型
    if (transferTokenType.value === 'native') {
      transferTokenType2.value = isBscChain.value
        ? 'aster'
        : (targetToken.value ? 'token' : 'native');
    } else {
      transferTokenType2.value = 'native';
    }
    transferAllBalance.value = false;
  }
}

// 代币类型标签
function tokenLabel(type: string): string {
  if (type === 'aster') return 'ASTER';
  if (type === 'token' && targetToken.value) return targetToken.value.symbol;
  return currentGovernanceToken.value;
}

const BATCH_REPLAY_GUARD_KEY = 'amm-batch-transfer-replay-guard-v1';
const BATCH_REPLAY_GUARD_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_REPLAY_GUARD_MAX_ENTRIES = 20;

type ReplayGuardEntry = {
  fingerprint: string;
  broadcastCount: number;
  createdAt: number;
  hashes?: string[];
};

function canonicalDecimalText(value: string): string {
  const [wholePart, fractionPart = ''] = value.trim().split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionPart.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function buildBatchFingerprint(): string {
  const normalizedSources = sourceAddresses.value.map(address => address.toLowerCase());
  const normalizedTargets = targetAddresses.value.map(address => address.toLowerCase());
  const paymentShape = transferMode.value === 'oneToMany'
    ? {
        source: normalizedSources[0],
        targets: [...normalizedTargets].sort(),
      }
    : transferMode.value === 'manyToOne'
      ? {
          sources: [...normalizedSources].sort(),
          target: normalizedTargets[0],
        }
      : {
          pairs: normalizedSources
            .map((source, index) => `${source}:${normalizedTargets[index]}`)
            .sort(),
        };

  const fingerprintRounds = [
    {
      tokenType: transferTokenType.value,
      amount: transferAllBalance.value ? 'ALL' : canonicalDecimalText(transferAmount.value),
    },
    ...(showSecondTransfer.value ? [{
      tokenType: transferTokenType2.value,
      amount: transferAllBalance2.value ? 'ALL' : canonicalDecimalText(transferAmount2.value),
    }] : []),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const usesTargetToken = fingerprintRounds.some(round => round.tokenType === 'token');

  return JSON.stringify({
    chainId: selectedChainId.value,
    mode: transferMode.value,
    paymentShape,
    targetToken: usesTargetToken ? (targetToken.value?.address?.toLowerCase() || null) : null,
    rounds: fingerprintRounds,
  });
}

function loadReplayGuards(): ReplayGuardEntry[] {
  try {
    const raw = localStorage.getItem(BATCH_REPLAY_GUARD_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Accept the earlier single-entry shape and migrate it on the next write.
    const candidates = Array.isArray(parsed?.entries) ? parsed.entries : [parsed];
    const guards = candidates.filter((guard: any): guard is ReplayGuardEntry => (
      typeof guard?.fingerprint === 'string' &&
      typeof guard?.broadcastCount === 'number' &&
      typeof guard?.createdAt === 'number' &&
      Date.now() - guard.createdAt <= BATCH_REPLAY_GUARD_TTL_MS
    ));
    if (guards.length === 0) {
      localStorage.removeItem(BATCH_REPLAY_GUARD_KEY);
      return [];
    }
    return guards.slice(0, BATCH_REPLAY_GUARD_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function rememberBroadcastedBatch(fingerprint: string, results: any[]) {
  const broadcastResults = results.filter(result => Boolean(result.hash));
  const broadcastCount = broadcastResults.length;
  if (broadcastCount === 0) return;
  try {
    const priorEntries = loadReplayGuards().filter(entry => entry.fingerprint !== fingerprint);
    const entry: ReplayGuardEntry = {
      fingerprint,
      broadcastCount,
      createdAt: Date.now(),
      hashes: [...new Set(broadcastResults.map(result => String(result.hash).toLowerCase()))],
    };
    localStorage.setItem(BATCH_REPLAY_GUARD_KEY, JSON.stringify({
      entries: [entry, ...priorEntries].slice(0, BATCH_REPLAY_GUARD_MAX_ENTRIES),
    }));
  } catch {
    // localStorage 不可用时，链上 nonce/哈希保护仍然生效。
  }
}

// 获取批次的私钥映射
const batchPrivateKeyMap = computed(() => {
  const map: Record<string, string> = {};
  if (selectedSourceBatchId.value) {
    const batch = walletBatches.value.find(b => b.id === selectedSourceBatchId.value);
    if (batch) {
      for (const wallet of batch.wallets) {
        // 服务器模式下 privateKey 可能为空，但地址依然有效
        // 私钥会在执行转账时从服务器获取
        if (wallet.privateKey) {
          map[wallet.address.toLowerCase()] = wallet.privateKey;
        }
      }
    }
  }
  return map;
});

// 检查是否选择了批次（用于跳过私钥验证）
const isUsingBatch = computed(() => !!selectedSourceBatchId.value);

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
    // 服务器模式下私钥会在执行时从服务器获取，不需要本地验证
    return '';
  }

  // 一对多模式：只检查地址格式
  const invalidAddrs = addresses.filter(addr => !isValidAddress(addr));
  if (invalidAddrs.length > 0) {
    return `${invalidAddrs.length} 个地址格式无效`;
  }

  // 服务器模式下私钥会在执行时从服务器获取，不需要本地验证

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
function isPositiveDecimalAmount(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed) && /[1-9]/.test(trimmed);
}

const canExecuteTransfer = computed(() => {
  if (sourceAddressCount.value === 0) return false;
  if (targetAddressCount.value === 0) return false;
  if (!transferAllBalance.value && !isPositiveDecimalAmount(transferAmount.value)) return false;
  if (sourceAddressError.value) return false;
  if (targetAddressError.value) return false;
  if (transferTokenType.value === 'token' && !targetToken.value) return false;
  if (!isBscChain.value && transferTokenType.value === 'aster') return false;
  // 第二组验证
  if (showSecondTransfer.value) {
    if (!transferAllBalance2.value && !isPositiveDecimalAmount(transferAmount2.value)) return false;
    if (transferTokenType2.value === transferTokenType.value) return false;
    if (transferTokenType2.value === 'token' && !targetToken.value) return false;
    if (!isBscChain.value && transferTokenType2.value === 'aster') return false;
  }
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

  const batchFingerprint = buildBatchFingerprint();
  const previousBroadcast = loadReplayGuards().find(entry => entry.fingerprint === batchFingerprint);
  if (
    previousBroadcast?.fingerprint === batchFingerprint &&
    !window.confirm(
      `检测到完全相同的批次在最近 24 小时内已经广播过 ${previousBroadcast.broadcastCount} 笔。\n\n` +
      '再次执行会向相同地址重新付款。只有在你明确要重复付款时才点击“确定”。',
    )
  ) {
    return;
  }

  // Freeze every input that affects signed transactions. The chain/target-token
  // watcher records even a brief switch while round one is confirming, so round
  // two can never silently run on a different network or token under the old
  // replay fingerprint.
  const executionMode = transferMode.value;
  const executionSourceAddresses = [...sourceAddresses.value];
  const executionTargetAddresses = [...targetAddresses.value];
  const executionChainId = selectedChainId.value;
  const executionTargetTokenAddress = targetToken.value?.address?.toLowerCase() || null;
  const executionIntervalMs = executionMode === 'oneToMany'
    ? 0
    : (intervalEnabled.value ? intervalSeconds.value * 1000 : 0);
  let executionContextChanged = false;
  const stopExecutionContextWatch = watch(
    [selectedChainId, () => targetToken.value?.address?.toLowerCase() || null],
    () => {
      executionContextChanged = true;
    },
  );

  isTransferring.value = true;
  transferResults.value = [];

  try {
    const mergedPrivateKeyMap = {
      ...batchPrivateKeyMap.value,
      ...sourcePrivateKeyMap.value
    };

    // 构建转账轮次
    const rounds: { amount: string; tokenType: 'native' | 'token' | 'aster'; label: string; allBalance: boolean }[] = [
      { amount: transferAllBalance.value ? '0' : transferAmount.value.trim(), tokenType: transferTokenType.value, label: tokenLabel(transferTokenType.value), allBalance: transferAllBalance.value }
    ];
    if (showSecondTransfer.value) {
      rounds.push({ amount: transferAllBalance2.value ? '0' : transferAmount2.value.trim(), tokenType: transferTokenType2.value, label: tokenLabel(transferTokenType2.value), allBalance: transferAllBalance2.value });
      // native 转全部余额放最后，避免 gas 不足导致第二组失败
      if (rounds[0].tokenType === 'native' && rounds[0].allBalance) {
        rounds.reverse();
      }
    }

    let allResults: any[] = [];

    for (const round of rounds) {
      if (executionContextChanged || selectedChainId.value !== executionChainId) {
        throw new Error('执行期间网络或目标代币发生过切换。已广播结果保留，后续轮次未发送');
      }
      if (
        round.tokenType === 'token' &&
        (targetToken.value?.address?.toLowerCase() || null) !== executionTargetTokenAddress
      ) {
        throw new Error('执行期间目标代币发生变化。已广播结果保留，后续轮次未发送');
      }

      const decorateRoundResults = (results: any[]) => results.map(result => ({
        ...result,
        _tokenLabel: round.label,
        _tokenType: round.tokenType,
        _amount: round.amount,
      }));

      const results = await walletStore.batchTransferByAddresses(
        executionSourceAddresses,
        executionTargetAddresses,
        round.amount,
        round.tokenType,
        executionMode,
        {
          privateKeyMap: mergedPrivateKeyMap,
          transferAllBalance: round.allBalance,
          intervalMs: executionIntervalMs,
          onProgress: (progressResults) => {
            const currentResults = [...allResults, ...decorateRoundResults(progressResults)];
            transferResults.value = currentResults;
            rememberBroadcastedBatch(batchFingerprint, currentResults);
          },
        }
      );
      // 标记每笔结果的代币类型和金额。
      allResults.push(...decorateRoundResults(results));
      rememberBroadcastedBatch(batchFingerprint, allResults);
      // 每组完成后立即保留结果。若第二组预检被 pending nonce 阻止，第一组的
      // 已广播 hash 仍会显示，避免交易员误以为未发送而重复付款。
      transferResults.value = [...allResults];

      if (
        executionMode === 'oneToMany' &&
        results.some(result => resultStatus(result) !== 'confirmed')
      ) {
        break;
      }
    }

    transferResults.value = allResults;

    const confirmedCount = allResults.filter(r => resultStatus(r) === 'confirmed').length;
    const pendingCount = allResults.filter(r => resultStatus(r) === 'pending').length;
    const unknownCount = allResults.filter(r => resultStatus(r) === 'unknown').length;
    const failCount = allResults.filter(r => ['failed', 'not_sent'].includes(resultStatus(r))).length;

    if (confirmedCount === allResults.length) {
      alert(`转账完成！已确认 ${confirmedCount} 笔`);
    } else if (pendingCount + unknownCount > 0) {
      alert(
        `批量广播已结束\n\n已确认: ${confirmedCount} 笔\n确认中: ${pendingCount} 笔\n待节点核对: ${unknownCount} 笔\n未完成: ${failCount} 笔` +
        '\n\n确认中或待核对的交易均已保留哈希，请勿重复转账。',
      );
    } else if (confirmedCount === 0) {
      const firstError = allResults.find(r => r.error)?.error || '未知错误';
      alert(`转账未完成！共 ${failCount} 笔\n\n原因: ${firstError}`);
    } else {
      const firstError = allResults.find(r => r.error)?.error || '未知错误';
      alert(`转账部分完成\n\n已确认: ${confirmedCount} 笔\n未完成: ${failCount} 笔\n\n原因: ${firstError}`);
    }
  } catch (error: any) {
    alert(error.message || '转账失败');
  } finally {
    stopExecutionContextWatch();
    isTransferring.value = false;
  }
}

// 重试失败的转账
async function retryFailedTransfers() {
  // 只允许旧流程中“明确没有 hash 且标记可重试”的任务进入这里。
  // 新的一对多流水线全部禁止盲目重试，pending/unknown 永远不会进入。
  const failedResults = [...retryableResults.value];
  if (failedResults.length === 0) return;

  isTransferring.value = true;

  try {
    const mergedPrivateKeyMap = {
      ...batchPrivateKeyMap.value,
      ...sourcePrivateKeyMap.value
    };

    // 按代币类型分组重试
    const grouped = new Map<string, any[]>();
    for (const r of failedResults) {
      const key = r._tokenType || transferTokenType.value;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }

    let allRetryResults: any[] = [];

    for (const [tType, group] of grouped) {
      const retrySources = group.map(r => r.source).filter(Boolean);
      const retryTargets = group.map(r => r.target).filter(Boolean);
      if (retrySources.length === 0 || retryTargets.length === 0) continue;

      const amount = group[0]._amount ?? (transferAllBalance.value ? 0 : transferAmount.value);
      const label = group[0]._tokenLabel || tokenLabel(tType);

      // 若所有失败任务来自同一个源地址（oneToMany场景），必须用 oneToMany 串行执行，
      // 否则并发时会出现 nonce 竞态，导致 RPC 返回 invalid params
      const uniqueSources = [...new Set(retrySources)];
      const retryMode = uniqueSources.length === 1 ? 'oneToMany' : 'manyToMany';
      const retrySrc = retryMode === 'oneToMany' ? [uniqueSources[0]] : retrySources;

      const retryResults = await walletStore.batchTransferByAddresses(
        retrySrc,
        retryTargets,
        amount,
        tType as 'native' | 'token' | 'aster',
        retryMode,
        {
          privateKeyMap: mergedPrivateKeyMap,
          transferAllBalance: String(amount) === '0',
          intervalMs: intervalEnabled.value ? intervalSeconds.value * 1000 : 0
        }
      );

      for (const r of retryResults) {
        r._tokenLabel = label;
        r._tokenType = tType;
        r._amount = amount;
      }
      allRetryResults.push(...retryResults);
    }

    // 合并结果：只替换本次确实选择重试的行，保留 pending/hash 等安全状态。
    const retrySet = new Set(failedResults);
    const retainedResults = transferResults.value.filter(result => !retrySet.has(result));
    transferResults.value = [...retainedResults, ...allRetryResults];

    const retrySuccess = allRetryResults.filter(r => r.success).length;
    const retryFail = allRetryResults.filter(r => !r.success).length;

    if (retryFail === 0) {
      alert(`重试完成！全部 ${retrySuccess} 笔成功`);
    } else {
      const firstError = allRetryResults.find(r => r.error)?.error || '未知错误';
      alert(`重试结果\n\n成功: ${retrySuccess} 笔\n仍失败: ${retryFail} 笔\n\n失败原因: ${firstError}`);
    }
  } catch (error: any) {
    alert(error.message || '重试失败');
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
    66: 'https://www.oklink.com/okc/tx/',
    4663: 'https://robinhoodchain.blockscout.com/tx/'
  };
  const explorer = explorers[chainId];
  return explorer ? explorer + hash : '#';
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
