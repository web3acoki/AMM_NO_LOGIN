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
      <button class="btn btn-link btn-sm py-0 ms-2" type="button" @click="switchBrowserWalletNetwork">
        添加/切换浏览器钱包网络
      </button>
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
  // 用同一个 action 原子更新 chainId、预设 RPC 并清除旧链自定义 RPC。
  // 直接通过 v-model 只改 chainId 会短暂留下上一条链的 rpcUrl，其他组件
  // 可能在 change handler 之前观察到这个混合状态并向错误网络读取合约。
  chainStore.setSelectedChain(selectedChainId.value);

  // 自动选择对应的DEX
  dexStore.setDexByChainId(selectedChainId.value);

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

async function switchBrowserWalletNetwork() {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    alert('未检测到浏览器钱包；本地私钥钱包仍可直接执行任务。');
    return;
  }
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  if (!chain) return;
  const chainIdHex = `0x${chain.id.toString(16)}`;
  try {
    await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  } catch (error: any) {
    if (error?.code !== 4902) {
      alert(`切换网络失败: ${error?.message || '未知错误'}`);
      return;
    }
    const explorerFallbacks: Record<number, string> = {
      56: 'https://bscscan.com',
      97: 'https://testnet.bscscan.com',
      66: 'https://www.oklink.com/okc',
      4663: 'https://robinhoodchain.blockscout.com',
    };
    await ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainIdHex,
        chainName: chain.name,
        nativeCurrency: {
          name: chain.governanceToken === 'ETH' ? 'Ether' : chain.governanceToken,
          symbol: chain.governanceToken,
          decimals: 18,
        },
        rpcUrls: chain.rpcOptions.map(option => option.url),
        blockExplorerUrls: [chain.explorerUrl || explorerFallbacks[chain.id]].filter(Boolean),
      }],
    });
  }
}

// 组件挂载时初始化DEX
onMounted(() => {
  chainStore.ensureSelectedChainRpc();
  dexStore.setDexByChainId(selectedChainId.value);
  // 如果有自定义RPC，显示在输入框中
  if (customRpcUrl.value) {
    customRpcInput.value = customRpcUrl.value;
  }
});
</script>
