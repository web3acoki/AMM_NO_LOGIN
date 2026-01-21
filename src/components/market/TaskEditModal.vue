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
                <label class="form-label">代币合约地址</label>
                <input
                  type="text"
                  class="form-control font-monospace"
                  v-model="formData.tokenContract"
                  placeholder="0x..."
                >
              </div>
            </div>

            <div class="row">
              <!-- 金额区间最小值 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">金额区间最小值 (BNB)</label>
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
                <label class="form-label">金额区间最大值 (BNB)</label>
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
                  <option value="count">执行次数</option>
                  <option value="amount">花费金额</option>
                  <option value="time">运行时间(秒)</option>
                  <option value="price">目标价格</option>
                  <option value="marketcap">目标市值(BNB)</option>
                </select>
              </div>

              <!-- 停止条件值 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">条件值</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.stopValue"
                  min="0"
                  step="any"
                >
              </div>
            </div>

            <div class="row">
              <!-- 交易间隔 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">交易间隔(秒)</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.interval"
                  min="1"
                  step="1"
                >
              </div>

              <!-- 线程数 -->
              <div class="col-md-6 mb-3">
                <label class="form-label">线程数</label>
                <input
                  type="number"
                  class="form-control"
                  v-model.number="formData.threadCount"
                  min="1"
                  step="1"
                >
                <div class="form-text">每个间隔内同时执行的钱包数量</div>
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

            <!-- 砸盘模式：卖出全部选项 -->
            <div class="mb-3" v-if="props.task.mode === 'dump'">
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

// 表单数据
const formData = ref({
  name: '',
  tokenContract: '',
  amountMin: 0.01,
  amountMax: 0.05,
  stopType: 'count' as 'count' | 'amount' | 'time' | 'price' | 'marketcap',
  stopValue: 10,
  interval: 5,
  threadCount: 1,
  gasPrice: undefined as number | undefined,
  gasLimit: undefined as number | undefined,
  sellAll: true,
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

// 初始化表单数据
onMounted(() => {
  const task = props.task;
  formData.value = {
    name: task.name,
    tokenContract: task.config.tokenContract,
    amountMin: task.config.amountMin,
    amountMax: task.config.amountMax,
    stopType: task.config.stopType,
    stopValue: task.config.stopValue,
    interval: task.config.interval,
    threadCount: task.config.threadCount || 1,
    gasPrice: task.config.gasPrice,
    gasLimit: task.config.gasLimit,
    sellAll: task.config.sellAll ?? true,
    walletAddressesText: task.walletAddresses.join('\n')
  };
});

// 关闭弹窗
function handleClose() {
  emit('close');
}

// 保存修改
function handleSave() {
  // 解析钱包地址
  const walletAddresses = formData.value.walletAddressesText
    .split('\n')
    .map(addr => addr.trim())
    .filter(addr => /^0x[0-9a-fA-F]{40}$/.test(addr));

  // 构建更新数据
  const updates = {
    name: formData.value.name,
    config: {
      tokenContract: formData.value.tokenContract,
      amountMin: formData.value.amountMin,
      amountMax: formData.value.amountMax,
      stopType: formData.value.stopType,
      stopValue: formData.value.stopValue,
      interval: formData.value.interval,
      threadCount: formData.value.threadCount,
      gasPrice: formData.value.gasPrice || undefined,
      gasLimit: formData.value.gasLimit || undefined,
      sellAll: formData.value.sellAll
    } as Partial<TaskConfig>,
    walletAddresses
  };

  // 调用 store 更新任务
  const success = taskStore.updateTask(props.task.id, updates);

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
