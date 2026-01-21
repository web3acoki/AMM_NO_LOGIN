<template>
  <div>
    <div class="mb-2 fw-semibold">选择公链 / 交易所 / RPC</div>
    <div class="row g-2 align-items-end">
      <div class="col-12 col-sm-3">
        <label class="form-label">公链</label>
        <select class="form-select" v-model="selectedChainId" @change="onChainChange">
          <option v-for="c in chains" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="col-12 col-sm-3">
        <label class="form-label">DEX</label>
        <select class="form-select" v-model="selectedDexId" @change="onDexChange">
          <option v-for="dex in availableDexs" :key="dex.id" :value="dex.id">{{ dex.name }}</option>
        </select>
      </div>
      <div class="col-12 col-sm-3">
        <label class="form-label">RPC 节点</label>
        <select class="form-select" v-model="rpcUrl" @change="onRpcChange">
          <option v-for="opt in currentRpcOptions" :key="opt.url" :value="opt.url">
            {{ opt.name }}
          </option>
        </select>
      </div>
      <div class="col-12 col-sm-3">
        <label class="form-label">
          自定义RPC
          <span v-if="customRpcUrl" class="badge bg-success ms-1">已启用</span>
        </label>
        <div class="input-group input-group-sm">
          <input
            type="text"
            class="form-control"
            v-model="customRpcInput"
            placeholder="https://..."
            @keyup.enter="applyCustomRpc"
          >
          <button
            class="btn btn-outline-primary"
            @click="applyCustomRpc"
            :disabled="!customRpcInput"
            title="应用自定义RPC"
          >
            <i class="bi bi-check-lg"></i>
          </button>
          <button
            v-if="customRpcUrl"
            class="btn btn-outline-danger"
            @click="clearCustomRpc"
            title="清除自定义RPC"
          >
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
    </div>
    <!-- 当前使用的RPC显示 -->
    <div class="form-text mt-1">
      <i class="bi bi-broadcast me-1"></i>
      当前RPC: <code class="text-primary">{{ effectiveRpcUrl }}</code>
      <span v-if="customRpcUrl" class="badge bg-warning text-dark ms-1">自定义</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useChainStore } from '../../stores/chainStore';
import { useDexStore } from '../../stores/dexStore';

const chainStore = useChainStore();
const dexStore = useDexStore();

const { chains, selectedChainId, rpcUrl, customRpcUrl, effectiveRpcUrl, currentGovernanceToken } = storeToRefs(chainStore);
const {
  currentDex,
  currentDexId,
  currentDexName,
  currentFactoryAddress,
  currentRouterAddress,
  currentBaseTokens,
  selectedDexId,
  allDexConfigs
} = storeToRefs(dexStore);

// 自定义RPC输入
const customRpcInput = ref('');

// 可用的DEX列表（根据当前公链过滤）
const availableDexs = computed(() => {
  const currentChainId = selectedChainId.value;
  const mapping = dexStore.chainDexMappings.find(m => m.chainId === currentChainId);

  if (mapping) {
    // 如果当前公链有对应的DEX，只显示该DEX
    const dex = allDexConfigs.value.find(d => d.id === mapping.dexId);
    return dex ? [dex] : [];
  } else {
    // 如果没有映射，显示所有DEX
    return allDexConfigs.value;
  }
});

// 获取当前链的RPC URL
const currentRpcUrl = computed(() => {
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  return chain?.rpc || '';
});

// 获取当前链的RPC选项
const currentRpcOptions = computed(() => {
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  return chain?.rpcOptions || [];
});

// 应用自定义RPC
function applyCustomRpc() {
  if (!customRpcInput.value) return;

  // 简单验证URL格式
  if (!customRpcInput.value.startsWith('http://') && !customRpcInput.value.startsWith('https://')) {
    alert('请输入有效的RPC URL（以 http:// 或 https:// 开头）');
    return;
  }

  chainStore.setCustomRpc(customRpcInput.value);
  alert(`自定义RPC已设置: ${customRpcInput.value}\n\n所有交易将通过此节点发送。`);
}

// 清除自定义RPC
function clearCustomRpc() {
  chainStore.clearCustomRpc();
  customRpcInput.value = '';
  alert('已清除自定义RPC，将使用默认节点。');
}

function onChainChange() {
  // 更新RPC URL（选择第一个RPC选项）
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  if (chain && chain.rpcOptions && chain.rpcOptions.length > 0) {
    rpcUrl.value = chain.rpcOptions[0].url;
  } else if (chain) {
    rpcUrl.value = chain.rpc;
  }

  // 自动选择对应的DEX
  dexStore.setDexByChainId(selectedChainId.value);

  // 清除自定义RPC（切换链时）
  chainStore.clearCustomRpc();
  customRpcInput.value = '';
}

function onRpcChange() {
  // RPC变化时的处理
  console.log('RPC切换到:', rpcUrl.value);
  // 如果选择了预设节点，清除自定义RPC
  chainStore.clearCustomRpc();
  customRpcInput.value = '';
}

function onDexChange() {
  // 手动选择DEX时的处理
  console.log('DEX切换到:', selectedDexId.value);
}

// 组件挂载时初始化DEX
onMounted(() => {
  dexStore.setDexByChainId(selectedChainId.value);
  // 如果有自定义RPC，显示在输入框中
  if (customRpcUrl.value) {
    customRpcInput.value = customRpcUrl.value;
  }
});
</script>


