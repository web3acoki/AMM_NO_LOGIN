<template>
  <div class="modal-backdrop fade show" @click.self="handleClose"></div>
  <div class="modal fade show d-block" tabindex="-1">
    <div class="modal-dialog modal-lg modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">
            <i class="bi bi-pencil-square me-2"></i>编辑任务
          </h5>
          <button type="button" class="btn-close" @click="handleClose"></button>
        </div>
        <div class="modal-body">
          <form @submit.prevent="handleSave">
            <!-- 任务名称 -->
            <div class="mb-3">
              <label class="form-label">任务名称</label>
              <input
                type="text"
                class="form-control"
                v-model="formData.name"
                placeholder="输入任务名称"
              >
            </div>

            <div class="row">
              <!-- 代币合约地址 -->
              <div class="col-12 mb-3">
                <label class="form-label">
                  {{ props.task.config.marketType === 'inner' ? '内盘目标代币地址' : '代币合约地址' }}
                  <span class="badge bg-secondary ms-1">{{ props.task.config.marketType === 'inner' ? '内盘' : '外盘' }}</span>
                </label>
                <input
                  type="text"
                  class="form-control font-monospace"
                  v-model="formData.tokenContract"
                  placeholder="0x..."
                >
                <div v-if="props.task.config.marketType === 'inner'" class="form-text text-muted">
                  <i class="bi bi-info-circle me-1"></i>修改此地址将更新内盘交易的目标代币
                </div>
              </div>

              <!-- 底池类型选择 -->
              <div class="col-12 mb-3">
                <label class="form-label">底池类型</label>
                <div class="btn-group w-100">
                  <button
                    type="button"
                    class="btn"
                    :class="formData.poolType === 'BNB' ? 'btn-primary' : 'btn-outline-primary'"
                    @click="formData.poolType = 'BNB'"
                  >
                    BNB底池
                  </button>
                  <button
                    type="button"
                    class="btn"
                    :class="formData.poolType === 'ASTER' ? 'btn-primary' : 'btn-outline-primary'"
                    @click="formData.poolType = 'ASTER'"
                  >
                    ASTER底池
                  </button>
                </div>
                <div class="form-text text-muted">
                  <i class="bi bi-info-circle me-1"></i>
                  {{ props.task.config.marketType === 'inner'
                    ? (formData.poolType === 'BNB' ? 'BNB底池：用 BNB 购买代币' : 'ASTER底池：用 ASTER 代币购买')
                    : (formData.poolType === 'BNB' ? 'BNB底池：用 BNB 买卖代币' : 'ASTER底池：用 ASTER 买卖代币')
                  }}
                </div>
              </div>
            </div>

            <div class="row">
              <!-- 金额区间最小值 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">金额区间最小值 ({{ amountUnitLabel }})</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.amountMin"
                  min="0"
                  step="any"
                >
              </div>

              <!-- 金额区间最大值 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">金额区间最大值 ({{ amountUnitLabel }})</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.amountMax"
                  min="0"
                  step="any"
                >
              </div>
            </div>

            <div class="row">
              <!-- 停止条件 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">停止条件</label>
                <select class="form-select" v-model="formData.stopType">
                  <option value="none">手动停止</option>
                  <option value="count">执行次数</option>
                  <option value="amount">花费金额</option>
                  <option value="time">运行时间(秒)</option>
                  <option value="price">目标价格</option>
                  <option value="marketcap">目标市值(BNB)</option>
                </select>
              </div>

              <!-- 停止条件值 -->
              <div class="col-md-6 mb-3" v-if="formData.stopType !== 'none'">
                <label class="form-label">条件值</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.stopValue"
                  min="0"
                  step="any"
                >
              </div>
              <div class="col-md-6 mb-3" v-else>
                <label class="form-label">&nbsp;</label>
                <div class="form-text text-muted">
                  <i class="bi bi-infinity me-1"></i>持续运行直到手动停止
                </div>
              </div>
            </div>

            <div class="row">
              <!-- 交易间隔 -->
              <div class="col-md-4 mb-3">
                <label class="form-label">交易间隔(秒)</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.interval"
                  min="1"
                  step="1"
                >
              </div>

              <!-- 买入线程数 -->
              <div class="col-md-4 mb-3">
                <label class="form-label">买入线程数</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.buyThreadCount"
                  min="0"
                  step="1"
                >
                <div class="form-text">每个间隔内买入的钱包数量</div>
              </div>

              <!-- 卖出线程数 -->
              <div class="col-md-4 mb-3">
                <label class="form-label">卖出线程数</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.sellThreadCount"
                  min="0"
                  step="1"
                >
                <div class="form-text">每个间隔内卖出的钱包数量</div>
              </div>
            </div>

            <div class="row">
              <!-- Gas Price -->
              <div class="col-md-6 mb-3">
                <label class="form-label">Gas Price (Gwei)</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.gasPrice"
                  min="0"
                  step="0.1"
                  placeholder="留空使用默认值"
                >
              </div>

              <!-- Gas Limit -->
              <div class="col-md-6 mb-3">
                <label class="form-label">Gas Limit</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.gasLimit"
                  min="21000"
                  step="1000"
                  placeholder="留空使用默认值"
                >
              </div>
            </div>

            <!-- 内盘滑点设置（仅内盘任务显示） -->
            <div class="mb-3" v-if="props.task.config.marketType === 'inner'">
              <label class="form-label">内盘滑点保护 (%)</label>
              <div class="input-group">
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.innerSlippage"
                  min="0"
                  max="100"
                  placeholder="0 表示不限制"
                >
                <span class="input-group-text">%</span>
              </div>
              <div class="form-text text-muted">
                <i class="bi bi-shield-check me-1"></i>设置滑点保护，0 表示不限制。例如 10 表示允许最多 10% 的价格滑动
              </div>
            </div>

            <!-- 防夹节点设置（内盘和外盘都显示） -->
            <div class="mb-3">
              <label class="form-label">
                <i class="bi bi-shield-lock me-1"></i>RPC 节点
              </label>
              <select class="form-select" v-model="formData.antiSandwichRpcType">
                <option value="network">跟随网络设置</option>
                <option value="premium">高速付费节点 (QuickNode + MEV 保护)</option>
                <option value="blxrbdn">https://bsc.rpc.blxrbdn.com (防夹)</option>
                <option value="binance">https://bsc-dataseed.binance.org</option>
                <option value="blocksec">https://bsc.rpc.blocksec.com</option>
                <option value="48club">https://rpc-bsc.48.club</option>
                <option value="custom">自定义节点</option>
              </select>
              <div v-if="formData.antiSandwichRpcType === 'custom'" class="mt-2">
                <input
                  type="text"
                  class="form-control"
                  v-model="formData.customAntiSandwichRpc"
                  placeholder="输入自定义 RPC URL"
                >
              </div>
              <div class="form-text text-muted">
                <i class="bi bi-info-circle me-1"></i>选择防夹节点可保护交易不被 MEV 机器人攻击
              </div>
            </div>

            <!-- 卖出全部选项（sellThreadCount > 0 时显示） -->
            <div class="mb-3" v-if="formData.sellThreadCount > 0">
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="editSellAllCheck" v-model="formData.sellAll">
                <label class="form-check-label" for="editSellAllCheck">
                  <i class="bi bi-lightning-charge me-1"></i>卖出全部代币
                </label>
              </div>
              <div class="form-text">勾选后将卖出钱包中100%的代币余额</div>
            </div>

            <!-- 参与钱包列表 -->
            <div class="mb-3">
              <label class="form-label">
                参与钱包地址
                <span class="badge bg-secondary ms-1">{{ walletAddressCount }} 个</span>
              </label>
              <textarea
                class="form-control font-monospace"
                v-model="formData.walletAddressesText"
                rows="5"
                placeholder="每行一个钱包地址&#10;0x1234...&#10;0x5678..."
              ></textarea>
              <div class="form-text">每行填写一个钱包地址，钱包必须在本地钱包列表中存在</div>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" @click="handleClose">
            取消
          </button>
          <button type="button" class="btn btn-primary" @click="handleSave">
            <i class="bi bi-check-lg me-1"></i>保存修改
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useTaskStore, type Task, type TaskConfig } from '../../stores/taskStore';

const props = defineProps<{
  task: Task;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const taskStore = useTaskStore();

// ASTER 代币地址常量
const ASTER_TOKEN_ADDRESS = '0x000ae314e2a2172a039b26378814c252734f556a';

// 防夹节点 URL 映射
const ANTI_SANDWICH_RPC_MAP: Record<string, string> = {
  blxrbdn: 'https://bsc.rpc.blxrbdn.com',
  binance: 'https://bsc-dataseed.binance.org',
  blocksec: 'https://bsc.rpc.blocksec.com',
  '48club': 'https://rpc-bsc.48.club',
};

// 根据 URL 和 premium 标志反推类型
function getRpcTypeFromConfig(config: { antiSandwichRpc?: string; buyUsePremiumRpc?: boolean }): 'network' | 'premium' | 'blxrbdn' | 'binance' | 'blocksec' | '48club' | 'custom' {
  if (config.buyUsePremiumRpc) return 'premium';
  if (!config.antiSandwichRpc) return 'network';
  for (const [type, rpcUrl] of Object.entries(ANTI_SANDWICH_RPC_MAP)) {
    if (config.antiSandwichRpc === rpcUrl) return type as 'blxrbdn' | 'binance' | 'blocksec' | '48club';
  }
  return 'custom';
}

// 表单数据
const formData = ref({
  name: '',
  tokenContract: '',
  innerTokenAddress: '',  // 内盘代币地址
  amountMin: 0.01,
  amountMax: 0.05,
  stopType: 'count' as 'none' | 'count' | 'amount' | 'time' | 'price' | 'marketcap',
  stopValue: 10,
  interval: 5,
  buyThreadCount: 1,
  sellThreadCount: 0,
  gasPrice: undefined as number | undefined,
  gasLimit: undefined as number | undefined,
  innerSlippage: undefined as number | undefined,  // 内盘滑点
  antiSandwichRpcType: 'network' as 'network' | 'premium' | 'blxrbdn' | 'binance' | 'blocksec' | '48club' | 'custom',  // RPC节点类型
  customAntiSandwichRpc: '',  // 自定义 RPC URL
  sellAll: true,
  poolType: 'BNB' as 'BNB' | 'ASTER',  // 底池类型
  walletAddressesText: ''
});

// 钱包地址数量
const walletAddressCount = computed(() => {
  const addresses = formData.value.walletAddressesText
    .split('\n')
    .map(addr => addr.trim())
    .filter(addr => /^0x[0-9a-fA-F]{40}$/.test(addr));
  return addresses.length;
});

// 金额单位标签（根据底池类型变化）
const amountUnitLabel = computed(() => {
  // 内盘或外盘选择 ASTER 底池时，金额单位都是 ASTER
  if (formData.value.poolType === 'ASTER') {
    return 'ASTER';
  }
  return 'BNB';
});

// 初始化表单数据
onMounted(() => {
  const task = props.task;
  // 内盘模式优先使用 innerTokenAddress，外盘使用 tokenContract
  const isInner = task.config.marketType === 'inner';
  // 显示的代币地址：内盘用 innerTokenAddress，外盘用 tokenContract
  const displayTokenAddress = isInner
    ? (task.config.innerTokenAddress || task.config.tokenContract)
    : task.config.tokenContract;

  // 解析防夹节点配置（包含 premium 检测）
  const rpcType = getRpcTypeFromConfig(task.config);
  const customRpc = rpcType === 'custom' ? (task.config.antiSandwichRpc || '') : '';

  formData.value = {
    name: task.name,
    tokenContract: displayTokenAddress,
    innerTokenAddress: task.config.innerTokenAddress || '',
    amountMin: task.config.amountMin,
    amountMax: task.config.amountMax,
    stopType: task.config.stopType,
    stopValue: task.config.stopValue,
    interval: task.config.interval,
    buyThreadCount: task.config.buyThreadCount || 0,
    sellThreadCount: task.config.sellThreadCount || 0,
    gasPrice: task.config.gasPrice,
    gasLimit: task.config.gasLimit,
    innerSlippage: task.config.innerSlippage,
    antiSandwichRpcType: rpcType,
    customAntiSandwichRpc: customRpc,
    sellAll: task.config.sellAll ?? true,
    poolType: task.config.poolBaseToken ? 'ASTER' : 'BNB',
    walletAddressesText: task.walletAddresses.join('\n')
  };
});

// 关闭弹窗
function handleClose() {
  emit('close');
}

// 保存修改
async function handleSave() {
  // 解析钱包地址
  const walletAddresses = formData.value.walletAddressesText
    .split('\n')
    .map(addr => addr.trim())
    .filter(addr => /^0x[0-9a-fA-F]{40}$/.test(addr));

  // 判断是否是内盘任务
  const isInner = props.task.config.marketType === 'inner';

  // 计算 RPC URL（'network' 和 'premium' 返回 undefined 表示跟随网络设置/使用付费节点）
  let antiSandwichRpc: string | undefined;
  if (formData.value.antiSandwichRpcType === 'network' || formData.value.antiSandwichRpcType === 'premium') {
    antiSandwichRpc = undefined;
  } else if (formData.value.antiSandwichRpcType === 'custom') {
    antiSandwichRpc = formData.value.customAntiSandwichRpc || undefined;
  } else {
    antiSandwichRpc = ANTI_SANDWICH_RPC_MAP[formData.value.antiSandwichRpcType];
  }

  // 构建更新数据
  const updates = {
    name: formData.value.name,
    config: {
      tokenContract: formData.value.tokenContract,
      // 内盘模式同时更新 innerTokenAddress
      innerTokenAddress: isInner ? formData.value.tokenContract : formData.value.innerTokenAddress,
      amountMin: formData.value.amountMin,
      amountMax: formData.value.amountMax,
      stopType: formData.value.stopType,
      stopValue: formData.value.stopValue,
      interval: formData.value.interval,
      buyThreadCount: formData.value.buyThreadCount || 0,
      sellThreadCount: formData.value.sellThreadCount || 0,
      gasPrice: formData.value.gasPrice || undefined,
      gasLimit: formData.value.gasLimit || undefined,
      innerSlippage: isInner ? formData.value.innerSlippage : undefined,
      antiSandwichRpc: antiSandwichRpc, // 内盘和外盘都使用
      buyUsePremiumRpc: formData.value.antiSandwichRpcType === 'premium', // 买入是否使用高速付费节点
      sellAll: formData.value.sellAll,
      poolBaseToken: formData.value.poolType === 'ASTER' ? ASTER_TOKEN_ADDRESS : undefined,
    } as Partial<TaskConfig>,
    walletAddresses
  };

  // 调用 store 更新任务
  const success = await taskStore.updateTask(props.task.id, updates);

  if (success) {
    alert('任务配置已更新');
    emit('close');
  } else {
    alert('更新失败，请确保任务处于暂停或停止状态');
  }
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 1040;
}

.modal {
  z-index: 1050;
}

.modal-dialog {
  max-width: 700px;
}

.font-monospace {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.9em;
}
</style>
