<template>
  <div>
    <div class="mb-2 fw-semibold">选择公链 / 交易所 / RPC</div>
    <div class="row g-2 align-items-end">
      <div class="col-12 col-sm-4">
        <label class="form-label">公链</label>
        <select class="form-select" v-model="selectedChainId" @change="onChainChange">
          <option v-for="c in chains" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="col-12 col-sm-4">
        <label class="form-label">DEX</label>
        <select class="form-select" v-model="selectedDexId" @change="onDexChange">
          <option v-for="dex in availableDexs" :key="dex.id" :value="dex.id">{{ dex.name }}</option>
        </select>
      </div>
      <div class="col-12 col-sm-4">
        <label class="form-label">RPC 节点</label>
        <select class="form-select" v-model="rpcUrl" @change="onRpcChange">
          <option v-for="opt in currentRpcOptions" :key="opt.url" :value="opt.url">
            {{ opt.name }} - {{ formatUrl(opt.url) }}
          </option>
        </select>
      </div>
    </div>
    <!-- 隐藏的调试信息，功能保留但不显示 -->
    <div style="display: none;">
      <div class="form-text mt-1">
        <i class="bi bi-info-circle me-1"></i>
        选择公链后，DEX 和 RPC 节点会自动切换。当前：{{ currentDexName || '未选择' }} | {{ currentGovernanceToken }}
      </div>
      <div v-if="currentDex" class="mt-2">
        <small class="text-muted">
          <strong>Factory:</strong> {{ currentFactoryAddress }}<br>
          <strong>Router:</strong> {{ currentRouterAddress }}<br>
          <strong>基准币:</strong> {{ currentBaseTokens.length }} 个
        </small>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useChainStore } from '../../stores/chainStore';
import { useDexStore } from '../../stores/dexStore';

const chainStore = useChainStore();
const dexStore = useDexStore();

const { chains, selectedChainId, rpcUrl, currentGovernanceToken } = storeToRefs(chainStore);
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

// 格式化URL显示（截取域名部分）
function formatUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
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
}

function onRpcChange() {
  // RPC变化时的处理
  console.log('RPC切换到:', rpcUrl.value);
}

function onDexChange() {
  // 手动选择DEX时的处理
  console.log('DEX切换到:', selectedDexId.value);
}

// 组件挂载时初始化DEX
onMounted(() => {
  dexStore.setDexByChainId(selectedChainId.value);
});
</script>


