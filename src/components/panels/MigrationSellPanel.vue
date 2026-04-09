<template>
  <div class="migration-panel">
    <!-- 标题 -->
    <div class="panel-header">
      <h5 class="mb-0">
        <i class="bi bi-arrow-repeat me-2"></i>
        迁移自动卖出
      </h5>
      <span class="badge bg-warning">FourMeme 内盘</span>
    </div>

    <div class="panel-body">
      <!-- 配置卡片 -->
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">卖出配置</h6>
          <button
            type="button"
            class="btn btn-link btn-sm p-0"
            @click="showConfig = !showConfig"
          >
            {{ showConfig ? '收起' : '展开' }}
          </button>
        </div>
        <div v-if="showConfig" class="card-body">
          <div class="row mb-2">
            <div class="col-6">
              <label class="form-label small">卖出比例 (%)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="migrationStore.config.sellPercent"
                min="1" max="100"
              />
            </div>
            <div class="col-6">
              <label class="form-label small">并发数</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="migrationStore.config.batchSize"
                min="1" max="50"
              />
            </div>
          </div>
          <div class="row mb-2">
            <div class="col-6">
              <label class="form-label small">Gas Price (Gwei)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="migrationStore.config.gasPrice"
                placeholder="0 = 自动"
                min="0"
              />
              <small class="text-muted">0 = 自动</small>
            </div>
            <div class="col-6">
              <label class="form-label small">Gas Limit</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="migrationStore.config.gasLimit"
                placeholder="0 = 自动"
                min="0"
              />
              <small class="text-muted">0 = 自动</small>
            </div>
          </div>
          <div class="row mb-2">
            <div class="col-6">
              <label class="form-label small">滑点 (%)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="migrationStore.config.slippage"
                min="0" max="100"
              />
            </div>
            <div class="col-6">
              <label class="form-label small">轮询间隔 (ms)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="migrationStore.config.pollInterval"
                min="1000" step="1000"
              />
            </div>
          </div>
          <div class="form-check">
            <input
              class="form-check-input"
              type="checkbox"
              id="autoSellEnabled"
              v-model="migrationStore.config.autoSellEnabled"
            />
            <label class="form-check-label" for="autoSellEnabled">
              检测到迁移时自动卖出
            </label>
          </div>
        </div>
      </div>

      <!-- 钱包选择 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">执行钱包</h6>
        </div>
        <div class="card-body">
          <div class="btn-group btn-group-sm w-100 mb-2">
            <button
              type="button"
              class="btn"
              :class="migrationStore.walletMode === 'all' ? 'btn-primary' : 'btn-outline-primary'"
              @click="migrationStore.walletMode = 'all'"
            >
              全部钱包
            </button>
            <button
              type="button"
              class="btn"
              :class="migrationStore.walletMode === 'selected' ? 'btn-primary' : 'btn-outline-primary'"
              @click="migrationStore.walletMode = 'selected'"
            >
              已勾选 ({{ walletStore.selectedWalletAddresses.length }})
            </button>
            <button
              type="button"
              class="btn"
              :class="migrationStore.walletMode === 'batch' ? 'btn-primary' : 'btn-outline-primary'"
              @click="migrationStore.walletMode = 'batch'"
            >
              钱包批次
            </button>
          </div>
          <div v-if="migrationStore.walletMode === 'batch'">
            <select class="form-select form-select-sm" v-model="migrationStore.selectedBatchId">
              <option value="">选择批次...</option>
              <option
                v-for="batch in walletStore.walletBatches"
                :key="batch.id"
                :value="batch.id"
              >
                {{ batch.remark || batch.id }} ({{ batch.wallets.length }} 个钱包)
              </option>
            </select>
          </div>
          <div v-else-if="migrationStore.walletMode === 'selected'" class="small text-muted">
            <span v-if="walletStore.selectedWalletAddresses.length === 0">请在钱包管理中勾选要使用的钱包</span>
            <span v-else>已选择 {{ walletStore.selectedWalletAddresses.length }} 个钱包</span>
          </div>
          <div v-else class="small text-muted">
            将使用所有已导入的钱包
          </div>
        </div>
      </div>

      <!-- 监控代币 -->
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">监控代币</h6>
          <span class="badge bg-info">{{ migrationStore.monitoredTokens.size }}</span>
        </div>
        <div class="card-body">
          <!-- 添加代币 -->
          <div class="input-group input-group-sm mb-2">
            <input
              type="text"
              class="form-control"
              v-model="newTokenAddress"
              placeholder="输入代币合约地址 0x..."
              @keyup.enter="addToken"
            />
            <button
              class="btn btn-outline-primary"
              @click="addToken"
              :disabled="!newTokenAddress.trim()"
            >
              添加
            </button>
          </div>

          <div class="d-flex gap-2 mb-2">
            <button
              class="btn btn-sm btn-outline-secondary"
              @click="refreshHoldings"
              :disabled="migrationStore.isScanning || migrationStore.monitoredTokens.size === 0"
            >
              <span v-if="migrationStore.isScanning" class="spinner-border spinner-border-sm me-1"></span>
              刷新持仓
            </button>
          </div>

          <!-- 代币列表 -->
          <div v-if="migrationStore.monitoredTokens.size === 0" class="text-center text-muted py-3 small">
            暂无监控代币，请添加代币地址
          </div>
          <div v-else class="token-list">
            <div
              v-for="[addr, token] in migrationStore.monitoredTokens"
              :key="addr"
              class="token-item d-flex justify-content-between align-items-center"
            >
              <div class="token-info">
                <div class="d-flex align-items-center gap-2">
                  <span class="badge bg-secondary">{{ token.symbol }}</span>
                  <code class="small">{{ addr.slice(0, 8) }}...{{ addr.slice(-6) }}</code>
                </div>
                <div class="small text-muted">
                  {{ token.walletBalances.size }} 个钱包持仓
                  <span v-if="token.walletBalances.size > 0">
                    · 总计 {{ formatTokenBalance(token) }}
                  </span>
                </div>
              </div>
              <div class="token-actions d-flex gap-1">
                <button
                  class="btn btn-sm btn-outline-danger px-2"
                  @click="migrationStore.manualSell(addr)"
                  :disabled="migrationStore.isSelling || token.walletBalances.size === 0"
                  title="手动卖出"
                >
                  <i class="bi bi-cash-stack"></i>
                </button>
                <button
                  class="btn btn-sm btn-outline-secondary px-2"
                  @click="migrationStore.removeToken(addr)"
                  title="移除"
                >
                  <i class="bi bi-x-lg"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 控制按钮 -->
      <div class="card mb-3">
        <div class="card-body">
          <button
            v-if="!migrationStore.isMonitoring"
            class="btn btn-success w-100"
            @click="startMonitoring"
            :disabled="migrationStore.monitoredTokens.size === 0"
          >
            <i class="bi bi-play-fill me-1"></i>
            启动监控
          </button>
          <button
            v-else
            class="btn btn-danger w-100"
            @click="stopMonitoring"
          >
            <i class="bi bi-stop-fill me-1"></i>
            停止监控
          </button>
          <div class="small text-muted text-center mt-1">
            <span v-if="migrationStore.isMonitoring" class="text-success">
              <i class="bi bi-circle-fill me-1" style="font-size: 0.5rem;"></i>
              监控运行中
            </span>
            <span v-if="migrationStore.isSelling" class="text-warning ms-2">
              <span class="spinner-border spinner-border-sm me-1"></span>
              卖出执行中
            </span>
            <span v-if="migrationStore.isPreApproving" class="text-info ms-2">
              <span class="spinner-border spinner-border-sm me-1"></span>
              预授权中
            </span>
          </div>
        </div>
      </div>

      <!-- 迁移事件 -->
      <div v-if="migrationStore.migrationEvents.length > 0" class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <i class="bi bi-bell me-1"></i>
            迁移事件 ({{ migrationStore.migrationEvents.length }})
          </h6>
        </div>
        <div class="card-body p-0">
          <div class="list-group list-group-flush">
            <div
              v-for="(event, idx) in migrationStore.migrationEvents.slice().reverse()"
              :key="idx"
              class="list-group-item small"
            >
              <div class="d-flex justify-content-between">
                <code>{{ event.tokenAddress.slice(0, 10) }}...</code>
                <span class="badge bg-success">{{ event.source }}</span>
              </div>
              <div class="text-muted" v-if="event.pairAddress">
                交易对: {{ event.pairAddress.slice(0, 10) }}...
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 日志面板 -->
      <div class="card">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-terminal me-1"></i>
            运行日志
          </h6>
          <button
            v-if="migrationStore.logs.length > 0"
            class="btn btn-sm btn-outline-secondary"
            @click="migrationStore.clearLogs()"
          >
            清空
          </button>
        </div>
        <div class="card-body log-body" ref="logContainer">
          <div v-if="migrationStore.logs.length === 0" class="text-center text-muted py-3">
            暂无日志
          </div>
          <div v-else class="log-entries">
            <div
              v-for="(log, index) in migrationStore.logs"
              :key="index"
              class="log-entry"
              :class="'log-' + log.type"
            >
              <span class="log-time">{{ formatTime(log.timestamp) }}</span>
              <span class="log-type">[{{ log.type.toUpperCase() }}]</span>
              <span class="log-message">{{ log.message }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useMigrationStore, type TokenHolding } from '../../stores/migrationStore';
import { useWalletStore } from '../../stores/walletStore';
import { formatUnits } from 'viem';

const migrationStore = useMigrationStore();
const walletStore = useWalletStore();

// 配置展开状态
const showConfig = ref(false);

// 新代币地址输入
const newTokenAddress = ref('');

// 日志容器引用
const logContainer = ref<HTMLElement | null>(null);

// 添加代币
async function addToken() {
  const addr = newTokenAddress.value.trim();
  if (!addr) return;

  const success = await migrationStore.addToken(addr);
  if (success) {
    newTokenAddress.value = '';
  }
}

// 刷新持仓
function refreshHoldings() {
  migrationStore.scanTokenHoldings();
}

// 启动监控
async function startMonitoring() {
  await migrationStore.startMonitoring();
}

// 停止监控
function stopMonitoring() {
  migrationStore.stopMonitoring();
}

// 格式化代币余额
function formatTokenBalance(token: TokenHolding): string {
  const total = Array.from(token.walletBalances.values()).reduce((a, b) => a + b, 0n);
  const formatted = formatUnits(total, token.decimals);
  // 简化大数字
  const num = parseFloat(formatted);
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(4);
}

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

// 监听日志变化，自动滚动到底部
watch(() => migrationStore.logs.length, async () => {
  await nextTick();
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
});
</script>

<style scoped>
.migration-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-header {
  padding: 1rem;
  background: var(--bs-dark);
  border-bottom: 1px solid var(--bs-border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.card-header {
  background: rgba(255, 255, 255, 0.05);
  padding: 0.75rem 1rem;
}

.token-list {
  max-height: 300px;
  overflow-y: auto;
}

.token-item {
  padding: 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.token-item:last-child {
  border-bottom: none;
}

.token-info {
  flex: 1;
  min-width: 0;
}

.token-actions .btn {
  min-width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.log-body {
  height: 250px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 0.8rem;
  background: #1a1a1a;
  padding: 0.5rem;
}

.log-entry {
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.log-time {
  color: #888;
  margin-right: 0.5rem;
}

.log-type {
  margin-right: 0.5rem;
  font-weight: bold;
}

.log-info .log-type {
  color: #17a2b8;
}

.log-success .log-type {
  color: #28a745;
}

.log-error .log-type {
  color: #dc3545;
}

.log-warning .log-type {
  color: #ffc107;
}

.log-message {
  color: #e0e0e0;
}
</style>
