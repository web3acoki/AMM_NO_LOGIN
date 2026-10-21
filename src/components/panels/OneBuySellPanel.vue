<template>
  <div class="container-fluid py-3 one-buy-sell-panel">
    <div class="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3">
      <div>
        <h4 class="mb-1">一买一卖</h4>
        <div class="text-muted small">仅用于 Robinhood Chain（4663）；读写复用服务器下发的付费节点。</div>
      </div>
      <button class="btn btn-primary" :disabled="showForm" @click="openCreateForm">新建组</button>
    </div>

    <div v-if="store.error" class="alert alert-danger d-flex justify-content-between gap-3">
      <span class="text-break">{{ store.error }}</span>
      <button class="btn-close flex-shrink-0" type="button" @click="store.clearError" />
    </div>

    <div v-if="showForm" class="card shadow-sm mb-3">
      <div class="card-header d-flex justify-content-between align-items-center">
        <strong>{{ editingGroupId ? '编辑一买一卖组' : '新建一买一卖组' }}</strong>
        <button class="btn-close" type="button" @click="closeForm" />
      </div>
      <div class="card-body">
        <div v-if="editingGroup && tokenChangedFromSaved" class="alert alert-warning py-2">
          目标代币已改变。旧运行中遗留在钱包里的原代币不会自动处理，请确认后再保存。
        </div>

        <div class="row g-3">
          <div class="col-lg-4">
            <label class="form-label">组名称</label>
            <input v-model.trim="form.name" class="form-control" maxlength="200" placeholder="例如：Robinhood 第 1 组">
          </div>
          <div class="col-lg-8">
            <label class="form-label">目标代币合约地址</label>
            <div class="input-group">
              <input
                v-model.trim="form.tokenAddress"
                class="form-control font-monospace"
                placeholder="0x..."
                @input="tokenValidation = null"
              >
              <button
                class="btn btn-outline-secondary"
                type="button"
                :disabled="validatingToken || !form.tokenAddress"
                @click="validateToken"
              >
                {{ validatingToken ? '验证中…' : '验证代币与池' }}
              </button>
            </div>
            <div v-if="tokenValidation" class="form-text text-success">
              已验证 {{ tokenValidation.symbol }}（{{ tokenValidation.name }}），Robinhood 1% V3 池
            </div>
          </div>

          <div class="col-lg-6">
            <label class="form-label">绑定钱包批次</label>
            <select v-model="form.batchId" class="form-select" @change="handleBatchChanged">
              <option value="">请选择一个钱包批次</option>
              <option v-for="batch in walletStore.walletBatches" :key="batch.id" :value="batch.id">
                {{ batch.remark || batch.id }}（{{ batch.wallets.length }} 个钱包）
              </option>
            </select>
            <div class="form-text">保存时固定当前批次钱包快照；之后批次变化不会改变本组。</div>
          </div>
          <div class="col-lg-6">
            <label class="form-label">第一个钱包</label>
            <select v-model="form.firstWalletAddress" class="form-select" :disabled="!selectedBatch">
              <option value="">请选择</option>
              <option
                v-for="(wallet, index) in selectedBatch?.wallets || []"
                :key="`${wallet.address}-${index}`"
                :value="wallet.address.toLowerCase()"
              >
                {{ index + 1 }}. {{ wallet.remark || shortAddress(wallet.address) }} — {{ wallet.address }}
              </option>
            </select>
          </div>

          <div class="col-md-6 col-lg-3">
            <label class="form-label">随机买入最小值（ETH）</label>
            <input v-model.trim="form.amountMin" class="form-control" inputmode="decimal" placeholder="0.01">
          </div>
          <div class="col-md-6 col-lg-3">
            <label class="form-label">随机买入最大值（ETH）</label>
            <input v-model.trim="form.amountMax" class="form-control" inputmode="decimal" placeholder="0.05">
          </div>
          <div class="col-md-6 col-lg-2">
            <label class="form-label">卖出等待（秒）</label>
            <input v-model.number="form.sellDelaySeconds" class="form-control" type="number" min="0" step="1">
          </div>
          <div class="col-md-6 col-lg-2">
            <label class="form-label">买入滑点（%）</label>
            <input v-model.number="form.buySlippage" class="form-control" type="number" min="0" max="100" step="0.1">
          </div>
          <div class="col-md-6 col-lg-2">
            <label class="form-label">卖出滑点（%）</label>
            <input v-model.number="form.sellSlippage" class="form-control" type="number" min="0" max="100" step="0.1">
          </div>
        </div>

        <div class="form-text mt-2">
          买入金额按区间均匀随机，最多 6 位小数，允许最小值等于最大值。滑点填 0 表示不限制最小输出。
        </div>
        <div v-if="duplicateAddresses.length" class="alert alert-danger py-2 mt-3 mb-0">
          当前批次含重复钱包，不能保存：{{ duplicateAddresses.join('、') }}
        </div>

        <div v-if="previewOrder.length" class="order-preview mt-3">
          <div class="fw-semibold mb-2">最终执行顺序（{{ previewOrder.length }} 个钱包）</div>
          <div class="order-grid">
            <div v-for="(address, index) in previewOrder" :key="`${address}-${index}`" class="order-row">
              <span class="order-index">{{ index + 1 }}</span>
              <span class="font-monospace text-break">{{ address }}</span>
              <span v-if="index === 0" class="badge text-bg-primary">第一个</span>
              <span v-if="index === previewOrder.length - 1" class="badge text-bg-success">最终汇聚</span>
            </div>
          </div>
        </div>

        <div class="d-flex justify-content-end gap-2 mt-3">
          <button class="btn btn-outline-secondary" @click="closeForm">取消</button>
          <button class="btn btn-primary" :disabled="store.saving || validatingToken" @click="saveGroup">
            {{ store.saving ? '保存中…' : '验证并保存' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="store.loading && !store.groups.length" class="text-center text-muted py-5">
      正在加载一买一卖组…
    </div>
    <div v-else-if="!store.groups.length" class="card shadow-sm">
      <div class="card-body text-center text-muted py-5">
        还没有组。新建后可手动开始，每个钱包依次执行买入、等待、全部卖出和 ETH 归集。
      </div>
    </div>

    <div v-else class="row g-3">
      <div class="col-xl-5">
        <div class="d-grid gap-3">
          <div
            v-for="group in store.groups"
            :key="group._id"
            class="card shadow-sm group-card"
            :class="{ selected: store.selectedGroupId === group._id }"
            @click="selectGroup(group)"
          >
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-start gap-3">
                <div class="min-width-0">
                  <div class="d-flex align-items-center gap-2 flex-wrap">
                    <h6 class="mb-0 text-break">{{ group.name }}</h6>
                    <span class="badge" :class="statusBadge(group.latestRunStatus)">{{ statusText(group) }}</span>
                  </div>
                  <div class="small text-muted mt-1">
                    {{ group.tokenSymbol || 'Token' }} · {{ shortAddress(group.tokenAddress) }} ·
                    {{ group.walletOrder.length }} 个钱包
                  </div>
                </div>
                <div class="small text-muted flex-shrink-0">第 {{ group.runCount || 0 }} 轮</div>
              </div>

              <div class="config-summary mt-3">
                <span>买入 {{ group.amountMin }}–{{ group.amountMax }} ETH</span>
                <span>确认后等待 {{ group.sellDelaySeconds }} 秒</span>
                <span>滑点 买 {{ slippageText(group.buySlippage) }} / 卖 {{ slippageText(group.sellSlippage) }}</span>
              </div>

              <div v-if="group.latestRun" class="mt-3">
                <div class="d-flex justify-content-between small mb-1">
                  <span>{{ currentWalletText(group.latestRun) }}</span>
                  <span>{{ completedCount(group.latestRun) }}/{{ group.latestRun.walletProgress.length }}</span>
                </div>
                <div class="progress" role="progressbar">
                  <div class="progress-bar" :style="{ width: `${progressPercent(group.latestRun)}%` }" />
                </div>
                <div v-if="group.latestRun.pauseReason" class="small text-danger mt-2 text-break">
                  {{ group.latestRun.pauseReason }}
                </div>
                <div v-if="sellCountdown(group.latestRun)" class="small text-primary mt-2">
                  {{ sellCountdown(group.latestRun) }}
                </div>
              </div>

              <div class="d-flex flex-wrap gap-2 mt-3" @click.stop>
                <button
                  v-if="group.latestRunStatus === 'none' || group.latestRunStatus === 'stopped'"
                  class="btn btn-success btn-sm"
                  :disabled="isGroupBusy(group)"
                  @click="startGroup(group)"
                >
                  {{ isGroupBusy(group) ? '启动中…' : '开始' }}
                </button>
                <button
                  v-if="group.latestRunStatus === 'paused' || (group.latestRunStatus === 'running' && !group.runtimeActive)"
                  class="btn btn-success btn-sm"
                  :disabled="isGroupBusy(group)"
                  @click="continueGroup(group)"
                >
                  {{ isGroupBusy(group) ? '继续中…' : '继续' }}
                </button>
                <button v-if="group.latestRunStatus === 'running'" class="btn btn-warning btn-sm" @click="pauseGroup(group)">
                  暂停
                </button>
                <button
                  v-if="group.latestRunStatus === 'running' || group.latestRunStatus === 'paused'"
                  class="btn btn-outline-danger btn-sm"
                  @click="stopGroup(group)"
                >
                  停止
                </button>
                <button
                  v-if="group.latestRunStatus === 'none' || group.latestRunStatus === 'stopped'"
                  class="btn btn-outline-primary btn-sm"
                  @click="openEditForm(group)"
                >
                  编辑
                </button>
                <button
                  v-if="group.latestRunStatus !== 'running' && group.latestRunStatus !== 'paused'"
                  class="btn btn-outline-secondary btn-sm"
                  @click="removeGroup(group)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="col-xl-7">
        <div v-if="selectedGroup" class="card shadow-sm detail-card">
          <div class="card-header d-flex justify-content-between align-items-center gap-2">
            <strong>{{ selectedGroup.name }} · 运行详情</strong>
            <select v-if="store.selectedRuns.length" v-model="selectedRunId" class="form-select form-select-sm run-selector">
              <option v-for="run in store.selectedRuns" :key="run._id" :value="run._id">
                第 {{ run.runNumber }} 轮 · {{ runStatusText(run.status) }} · {{ formatTime(run.createdAt) }}
              </option>
            </select>
          </div>
          <div v-if="selectedRun" class="card-body">
            <div class="row g-2 mb-3">
              <div class="col-sm-6 col-lg-3">
                <div class="metric"><span>当前钱包</span><strong>{{ Math.min(selectedRun.currentWalletIndex + 1, selectedRun.walletProgress.length) }}/{{ selectedRun.walletProgress.length }}</strong></div>
              </div>
              <div class="col-sm-6 col-lg-3">
                <div class="metric"><span>当前步骤</span><strong>{{ stepText(currentWallet(selectedRun)?.step || selectedRun.currentStep) }}</strong></div>
              </div>
              <div class="col-sm-6 col-lg-3">
                <div class="metric"><span>已完成</span><strong>{{ completedCount(selectedRun) }}</strong></div>
              </div>
              <div class="col-sm-6 col-lg-3">
                <div class="metric"><span>卖出倒计时</span><strong>{{ countdownOnly(selectedRun) }}</strong></div>
              </div>
            </div>

            <div class="table-responsive wallet-progress-table mb-3">
              <table class="table table-sm align-middle mb-0">
                <thead><tr><th>#</th><th>钱包</th><th>步骤</th><th>随机买入</th><th>交易</th><th>结果</th></tr></thead>
                <tbody>
                  <tr
                    v-for="wallet in selectedRun.walletProgress"
                    :key="`${selectedRun._id}-${wallet.orderIndex}`"
                    :class="{ 'table-primary': wallet.orderIndex === selectedRun.currentWalletIndex && selectedRun.status !== 'completed' }"
                  >
                    <td>{{ wallet.orderIndex + 1 }}</td>
                    <td>
                      <div class="font-monospace">{{ shortAddress(wallet.address) }}</div>
                      <div v-if="wallet.transferTo" class="text-muted tiny">→ {{ shortAddress(wallet.transferTo) }}</div>
                    </td>
                    <td><span class="badge" :class="walletStatusBadge(wallet.status)">{{ stepText(wallet.step) }}</span></td>
                    <td>
                      <span v-if="wallet.randomBuyAmount">{{ wallet.randomBuyAmount }} ETH</span>
                      <span v-else class="text-muted">—</span>
                      <div v-if="wallet.safeBuyMax" class="text-muted tiny">安全上限 {{ compactNumber(wallet.safeBuyMax) }}</div>
                    </td>
                    <td class="tx-links">
                      <a v-if="wallet.buyTxHash" :href="txUrl(wallet.buyTxHash)" target="_blank" rel="noopener">买</a>
                      <a v-if="wallet.approvalTxHash" :href="txUrl(wallet.approvalTxHash)" target="_blank" rel="noopener">批</a>
                      <a v-if="wallet.sellTxHash" :href="txUrl(wallet.sellTxHash)" target="_blank" rel="noopener">卖</a>
                      <a v-if="wallet.transferTxHash" :href="txUrl(wallet.transferTxHash)" target="_blank" rel="noopener">转</a>
                      <span v-if="!wallet.buyTxHash && !wallet.approvalTxHash && !wallet.sellTxHash && !wallet.transferTxHash" class="text-muted">—</span>
                    </td>
                    <td class="small">
                      <div v-if="wallet.transferredEth">转出 {{ compactNumber(wallet.transferredEth) }} ETH</div>
                      <div v-if="wallet.finalEthBalance">保留 {{ compactNumber(wallet.finalEthBalance) }} ETH</div>
                      <div v-if="wallet.error" class="text-danger text-break">{{ wallet.error }}</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="d-flex justify-content-between align-items-center mb-2">
              <strong>运行日志</strong><span class="text-muted small">{{ (selectedRun.logs || []).length }} 条</span>
            </div>
            <div class="run-logs">
              <div
                v-for="(log, index) in [...(selectedRun.logs || [])].reverse()"
                :key="`${log.timestamp}-${index}`"
                class="log-row"
                :class="`log-${log.level}`"
              >
                <span class="log-time">{{ formatTime(log.timestamp) }}</span>
                <span class="log-message">{{ log.message }}</span>
                <a v-if="log.txHash" :href="txUrl(log.txHash)" target="_blank" rel="noopener">{{ shortHash(log.txHash) }}</a>
              </div>
              <div v-if="!(selectedRun.logs || []).length" class="text-muted small">暂无日志</div>
            </div>
          </div>
          <div v-else class="card-body text-muted text-center py-5">这个组还没有运行记录。</div>
        </div>
        <div v-else class="card shadow-sm">
          <div class="card-body text-center text-muted py-5">选择左侧组查看钱包进度和日志。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ROBINHOOD_EXPLORER_URL } from '../../constants';
import { type OneBuySellGroup, type OneBuySellRun, type OneBuySellWalletStatus } from '../../services/oneBuySellApi';
import { validateOneBuySellToken, type ValidatedOneBuySellToken } from '../../services/oneBuySellExecution';
import { useOneBuySellStore } from '../../stores/oneBuySellStore';
import { useWalletStore } from '../../stores/walletStore';

defineOptions({ name: 'OneBuySellPanel' });

const store = useOneBuySellStore();
const walletStore = useWalletStore();
const showForm = ref(false);
const editingGroupId = ref('');
const validatingToken = ref(false);
const tokenValidation = ref<ValidatedOneBuySellToken | null>(null);
const selectedRunId = ref('');
const clock = ref(Date.now());
let clockTimer: number | undefined;

const form = reactive({
  name: '',
  tokenAddress: '',
  batchId: '',
  firstWalletAddress: '',
  amountMin: '0.01',
  amountMax: '0.05',
  sellDelaySeconds: 60,
  buySlippage: 30,
  sellSlippage: 30,
});

const editingGroup = computed(() => editingGroupId.value
  ? store.groups.find(group => group._id === editingGroupId.value)
  : undefined);
const selectedGroup = computed(() => store.selectedGroup);
const selectedBatch = computed(() => walletStore.walletBatches.find(batch => batch.id === form.batchId));
const duplicateAddresses = computed(() => {
  const counts = new Map<string, number>();
  for (const wallet of selectedBatch.value?.wallets || []) {
    const address = wallet.address.trim().toLowerCase();
    counts.set(address, (counts.get(address) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([address]) => address);
});
const previewOrder = computed(() => {
  const wallets = selectedBatch.value?.wallets || [];
  const first = form.firstWalletAddress.toLowerCase();
  const index = wallets.findIndex(wallet => wallet.address.toLowerCase() === first);
  if (index < 0) return wallets.map(wallet => wallet.address.toLowerCase());
  return [...wallets.slice(index), ...wallets.slice(0, index)].map(wallet => wallet.address.toLowerCase());
});
const tokenChangedFromSaved = computed(() => Boolean(
  editingGroup.value
  && form.tokenAddress
  && editingGroup.value.tokenAddress.toLowerCase() !== form.tokenAddress.toLowerCase(),
));
const selectedRun = computed(() => (
  store.selectedRuns.find(run => run._id === selectedRunId.value)
  || selectedGroup.value?.latestRun
  || store.selectedRuns[0]
));

watch(() => store.selectedRuns, runs => {
  if (!runs.some(run => run._id === selectedRunId.value)) selectedRunId.value = runs[0]?._id || '';
}, { deep: true });

function resetForm() {
  Object.assign(form, {
    name: '',
    tokenAddress: '',
    batchId: '',
    firstWalletAddress: '',
    amountMin: '0.01',
    amountMax: '0.05',
    sellDelaySeconds: 60,
    buySlippage: 30,
    sellSlippage: 30,
  });
  tokenValidation.value = null;
  editingGroupId.value = '';
}

function openCreateForm() {
  store.clearError();
  resetForm();
  showForm.value = true;
}

function openEditForm(group: OneBuySellGroup) {
  store.clearError();
  editingGroupId.value = group._id;
  Object.assign(form, {
    name: group.name,
    tokenAddress: group.tokenAddress,
    batchId: group.batchId,
    firstWalletAddress: group.firstWalletAddress,
    amountMin: String(group.amountMin),
    amountMax: String(group.amountMax),
    sellDelaySeconds: group.sellDelaySeconds,
    buySlippage: group.buySlippage,
    sellSlippage: group.sellSlippage,
  });
  tokenValidation.value = {
    address: group.tokenAddress as `0x${string}`,
    name: group.tokenName,
    symbol: group.tokenSymbol,
    decimals: group.tokenDecimals,
    poolAddress: '0x0000000000000000000000000000000000000000',
  };
  showForm.value = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeForm() {
  showForm.value = false;
  resetForm();
}

function handleBatchChanged() {
  const first = selectedBatch.value?.wallets[0]?.address;
  form.firstWalletAddress = first ? first.toLowerCase() : '';
}

async function validateToken() {
  validatingToken.value = true;
  store.clearError();
  try {
    tokenValidation.value = await validateOneBuySellToken(form.tokenAddress);
  } catch (error) {
    tokenValidation.value = null;
    store.setError(error);
    throw error;
  } finally {
    validatingToken.value = false;
  }
}

function validateForm() {
  if (!form.name.trim()) throw new Error('请输入组名称');
  if (!selectedBatch.value) throw new Error('请选择一个有效的钱包批次');
  if (!form.firstWalletAddress) throw new Error('请选择第一个钱包');
  if (duplicateAddresses.value.length) throw new Error(`钱包批次存在重复地址：${duplicateAddresses.value.join('、')}`);
  const amountPattern = /^\d+(?:\.\d{1,6})?$/;
  if (!amountPattern.test(form.amountMin) || Number(form.amountMin) <= 0) throw new Error('随机买入最小值必须大于 0，并且最多保留 6 位小数');
  if (!amountPattern.test(form.amountMax) || Number(form.amountMax) <= 0) throw new Error('随机买入最大值必须大于 0，并且最多保留 6 位小数');
  if (Number(form.amountMax) < Number(form.amountMin)) throw new Error('随机买入最大值不能小于最小值');
  if (!Number.isInteger(form.sellDelaySeconds) || form.sellDelaySeconds < 0) throw new Error('卖出等待时间必须是大于或等于 0 的整数秒');
  for (const [label, value] of [['买入滑点', form.buySlippage], ['卖出滑点', form.sellSlippage]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${label}必须在 0–100% 之间`);
  }
}

async function saveGroup() {
  store.clearError();
  try {
    validateForm();
    const existing = editingGroup.value;
    const unchangedToken = existing && existing.tokenAddress.toLowerCase() === form.tokenAddress.toLowerCase();
    if (!unchangedToken || !tokenValidation.value) await validateToken();
    const token = unchangedToken
      ? { name: existing.tokenName, symbol: existing.tokenSymbol, decimals: existing.tokenDecimals }
      : tokenValidation.value!;
    await store.saveGroup({
      name: form.name,
      tokenAddress: form.tokenAddress,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      batchId: form.batchId,
      firstWalletAddress: form.firstWalletAddress,
      amountMin: form.amountMin,
      amountMax: form.amountMax,
      sellDelaySeconds: form.sellDelaySeconds,
      buySlippage: form.buySlippage,
      sellSlippage: form.sellSlippage,
    }, editingGroupId.value || undefined);
    closeForm();
  } catch (error) {
    store.setError(error);
  }
}

async function selectGroup(group: OneBuySellGroup) {
  await store.selectGroup(group._id);
  selectedRunId.value = store.selectedRuns[0]?._id || '';
}

async function startGroup(group: OneBuySellGroup) {
  try {
    await store.startGroup(group._id);
    await store.selectGroup(group._id);
    selectedRunId.value = store.selectedRuns[0]?._id || '';
  } catch { /* Store exposes the error. */ }
}

async function continueGroup(group: OneBuySellGroup) {
  if (!group.latestRunId) return;
  try { await store.continueRun(group.latestRunId); } catch { /* Store exposes the error. */ }
}

async function pauseGroup(group: OneBuySellGroup) {
  if (!group.latestRunId) return;
  try { await store.pauseRun(group.latestRunId); } catch { /* Store exposes the error. */ }
}

async function stopGroup(group: OneBuySellGroup) {
  if (!group.latestRunId) return;
  if (!window.confirm('停止会立即禁止后续交易。已经广播的交易无法撤销；如果当前钱包已经买入但尚未卖出，代币会留在该钱包。确定停止吗？')) return;
  try { await store.stopRun(group.latestRunId); } catch { /* Store exposes the error. */ }
}

async function removeGroup(group: OneBuySellGroup) {
  if (!window.confirm(`确定删除组“${group.name}”以及它的全部历史运行和日志吗？`)) return;
  try { await store.removeGroup(group._id); } catch { /* Store exposes the error. */ }
}

function currentWallet(run: OneBuySellRun) {
  return run.walletProgress[Math.min(run.currentWalletIndex, run.walletProgress.length - 1)];
}
function completedCount(run: OneBuySellRun) {
  return run.walletProgress.filter(wallet => wallet.status === 'completed').length;
}
function progressPercent(run: OneBuySellRun) {
  return run.walletProgress.length ? Math.round((completedCount(run) / run.walletProgress.length) * 100) : 0;
}
function currentWalletText(run: OneBuySellRun) {
  if (run.status === 'completed') return '全部钱包已完成';
  const wallet = currentWallet(run);
  return `钱包 ${Math.min(run.currentWalletIndex + 1, run.walletProgress.length)}/${run.walletProgress.length} · ${stepText(wallet?.step || run.currentStep)}`;
}
function statusText(group: OneBuySellGroup) {
  if (group.latestRunStatus === 'running' && !group.runtimeActive) return '页面中断，待继续';
  return { none: '未开始', running: '运行中', paused: '已暂停', stopped: '已停止', completed: '已完成' }[group.latestRunStatus];
}
function runStatusText(status: OneBuySellRun['status']) {
  return { running: '运行中', paused: '已暂停', stopped: '已停止', completed: '已完成' }[status];
}
function statusBadge(status: OneBuySellGroup['latestRunStatus']) {
  return { none: 'text-bg-secondary', running: 'text-bg-primary', paused: 'text-bg-warning', stopped: 'text-bg-dark', completed: 'text-bg-success' }[status];
}
function walletStatusBadge(status: OneBuySellWalletStatus) {
  return { pending: 'text-bg-secondary', running: 'text-bg-primary', paused: 'text-bg-warning', stopped: 'text-bg-dark', completed: 'text-bg-success', failed: 'text-bg-danger' }[status];
}
function stepText(step: string) {
  return {
    ready: '待开始',
    preflight: '资金预检',
    buying: '买入中',
    waiting_sell: '等待卖出',
    approving: '授权中',
    selling: '全部卖出',
    transferring: '归集 ETH',
    completed: '已完成',
    paused: '已暂停',
    stopped: '已停止',
    failed: '失败',
  }[step] || step;
}
function countdownOnly(run: OneBuySellRun) {
  const wallet = currentWallet(run);
  const sellAt = wallet?.sellAt || run.sellAt;
  if (!sellAt || wallet?.step !== 'waiting_sell') return '—';
  const remaining = Math.max(0, Math.ceil((new Date(sellAt).getTime() - clock.value) / 1000));
  return remaining > 0 ? `${remaining} 秒` : '等待立即卖出';
}
function sellCountdown(run: OneBuySellRun) {
  const value = countdownOnly(run);
  return value === '—' ? '' : `距离全部卖出：${value}`;
}
function isGroupBusy(group: OneBuySellGroup) {
  return Boolean(group.latestRunId && store.busyRunIds.includes(group.latestRunId));
}
function slippageText(value: number) { return value === 0 ? '不限' : `${value}%`; }
function shortAddress(value: string) { return value?.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function shortHash(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }
function txUrl(hash: string) { return `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`; }
function compactNumber(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString(undefined, { maximumFractionDigits: 8 }) : value;
}
function formatTime(value?: string) { return value ? new Date(value).toLocaleString() : '—'; }

onMounted(async () => {
  clockTimer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
  try {
    await store.loadGroups();
    if (store.groups[0]) await selectGroup(store.groups[0]);
  } catch { /* Store exposes the error. */ }
});
onBeforeUnmount(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
});
</script>

<style scoped>
.one-buy-sell-panel { min-width: 980px; }
.group-card { cursor: pointer; border: 1px solid #e2e8f0; transition: border-color .15s ease, box-shadow .15s ease; }
.group-card:hover, .group-card.selected { border-color: #60a5fa; }
.group-card.selected { box-shadow: 0 0 0 2px rgb(59 130 246 / 12%) !important; }
.min-width-0 { min-width: 0; }
.config-summary { display: flex; flex-wrap: wrap; gap: .4rem .9rem; color: #475569; font-size: .82rem; }
.progress { height: 7px; }
.order-preview { border: 1px solid #dbe3ee; border-radius: .5rem; padding: .9rem; background: #f8fafc; }
.order-grid { max-height: 280px; overflow: auto; display: grid; gap: .35rem; }
.order-row { display: flex; align-items: center; gap: .55rem; padding: .35rem .5rem; border-radius: .35rem; background: #fff; font-size: .82rem; }
.order-index { width: 2rem; color: #64748b; text-align: right; flex-shrink: 0; }
.run-selector { width: min(330px, 50%); }
.metric { border: 1px solid #e2e8f0; border-radius: .45rem; padding: .65rem .75rem; background: #f8fafc; }
.metric span { display: block; color: #64748b; font-size: .75rem; margin-bottom: .2rem; }
.metric strong { font-size: .92rem; }
.wallet-progress-table { max-height: 430px; border: 1px solid #e2e8f0; border-radius: .45rem; }
.wallet-progress-table thead { position: sticky; top: 0; z-index: 1; background: #f8fafc; }
.tiny { font-size: .7rem; }
.tx-links { white-space: nowrap; }
.tx-links a { display: inline-flex; align-items: center; justify-content: center; width: 1.55rem; height: 1.55rem; margin-right: .2rem; border-radius: .3rem; background: #e0f2fe; text-decoration: none; font-size: .75rem; }
.run-logs { max-height: 360px; overflow: auto; border: 1px solid #e2e8f0; border-radius: .45rem; background: #0f172a; color: #dbeafe; padding: .7rem; }
.log-row { display: grid; grid-template-columns: 155px minmax(0, 1fr) auto; gap: .6rem; padding: .28rem 0; font-size: .78rem; border-bottom: 1px solid rgb(148 163 184 / 14%); }
.log-row:last-child { border-bottom: 0; }
.log-time { color: #94a3b8; }
.log-message { min-width: 0; overflow-wrap: anywhere; }
.log-row a { color: #7dd3fc; }
.log-success .log-message { color: #86efac; }
.log-warning .log-message { color: #fde68a; }
.log-error .log-message { color: #fca5a5; }
</style>
