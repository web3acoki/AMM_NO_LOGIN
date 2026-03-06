<template>
  <div class="card mb-3 border-warning">
    <div class="card-header bg-warning text-dark d-flex justify-content-between align-items-center">
      <span><i class="bi bi-cart-dash me-1"></i>一键批量卖出</span>
      <button type="button" class="btn-close" @click="$emit('close')"></button>
    </div>
    <div class="card-body">
      <!-- 代币地址输入 -->
      <div class="mb-3">
        <label class="form-label">代币合约地址</label>
        <input
          type="text"
          class="form-control"
          v-model.trim="tokenAddress"
          placeholder="输入代币合约地址 0x..."
        >
      </div>

      <!-- 卖出模式选择 -->
      <div class="mb-3">
        <label class="form-label">卖出模式</label>
        <div class="btn-group w-100" role="group">
          <input type="radio" class="btn-check" name="sellMode" id="sellModeFixed" value="fixed" v-model="sellMode">
          <label class="btn btn-outline-primary" for="sellModeFixed">
            <i class="bi bi-percent me-1"></i>固定百分比
          </label>
          <input type="radio" class="btn-check" name="sellMode" id="sellModeRange" value="range" v-model="sellMode">
          <label class="btn btn-outline-primary" for="sellModeRange">
            <i class="bi bi-shuffle me-1"></i>区间随机
          </label>
        </div>
      </div>

      <!-- 固定百分比 -->
      <div v-if="sellMode === 'fixed'" class="mb-3">
        <label class="form-label">卖出百分比</label>
        <div class="input-group">
          <input
            type="number"
            class="form-control"
            v-model.number="fixedPercent"
            min="1"
            max="100"
            placeholder="50"
          >
          <span class="input-group-text">%</span>
        </div>
        <div class="form-text">所有选中钱包将卖出相同比例的代币</div>
      </div>

      <!-- 区间随机 -->
      <div v-if="sellMode === 'range'" class="mb-3">
        <label class="form-label">随机区间</label>
        <div class="row g-2">
          <div class="col">
            <div class="input-group">
              <input
                type="number"
                class="form-control"
                v-model.number="minPercent"
                min="1"
                max="99"
                placeholder="10"
              >
              <span class="input-group-text">%</span>
            </div>
          </div>
          <div class="col-auto d-flex align-items-center">
            <span class="text-muted">~</span>
          </div>
          <div class="col">
            <div class="input-group">
              <input
                type="number"
                class="form-control"
                v-model.number="maxPercent"
                min="2"
                max="100"
                placeholder="100"
              >
              <span class="input-group-text">%</span>
            </div>
          </div>
        </div>
        <div class="form-text">每个钱包将在此区间内随机选择卖出比例</div>
      </div>

      <!-- 底池类型选择 -->
      <div class="mb-3">
        <label class="form-label">底池类型</label>
        <div class="btn-group w-100" role="group">
          <input type="radio" class="btn-check" name="batchSellPoolType" id="batchSellPoolBNB" value="BNB" v-model="poolType">
          <label class="btn btn-outline-primary" for="batchSellPoolBNB">BNB底池</label>
          <input type="radio" class="btn-check" name="batchSellPoolType" id="batchSellPoolASTER" value="ASTER" v-model="poolType">
          <label class="btn btn-outline-primary" for="batchSellPoolASTER">ASTER底池</label>
        </div>
        <div class="form-text">{{ poolType === 'BNB' ? '直接路径 Token→WBNB' : 'ASTER底池：多跳路由 Token→ASTER→WBNB' }}</div>
      </div>

      <!-- 并发控制 -->
      <div class="mb-3">
        <label class="form-label">并发控制</label>
        <div class="row g-2">
          <div class="col">
            <div class="input-group input-group-sm">
              <span class="input-group-text">线程数</span>
              <input
                type="number"
                class="form-control"
                v-model.number="concurrency"
                min="1"
                max="50"
                placeholder="5"
              >
            </div>
          </div>
          <div class="col">
            <div class="input-group input-group-sm">
              <span class="input-group-text">间隔</span>
              <input
                type="number"
                class="form-control"
                v-model.number="batchInterval"
                min="0"
                max="10000"
                step="100"
                placeholder="500"
              >
              <span class="input-group-text">ms</span>
            </div>
          </div>
        </div>
        <div class="form-text">
          每批 {{ concurrency }} 个钱包并发执行，批次间隔 {{ batchInterval }}ms
          <br>
        </div>
      </div>

      <!-- 选中钱包信息 -->
      <div class="alert alert-info mb-3">
        <div class="d-flex justify-content-between align-items-center">
          <span>
            <i class="bi bi-wallet2 me-1"></i>
            选中钱包：<strong>{{ selectedCount }}</strong> 个
          </span>
          <button
            class="btn btn-sm btn-outline-info"
            @click="refreshTokenBalances"
            :disabled="!tokenAddress || !tokenAddress.startsWith('0x') || isRefreshing"
          >
            <i class="bi bi-arrow-clockwise me-1" :class="{ 'spin': isRefreshing }"></i>
            {{ isRefreshing ? '刷新中' : '刷新余额' }}
          </button>
        </div>
      </div>

      <!-- 执行按钮 -->
      <div class="d-grid gap-2">
        <button
          class="btn btn-warning btn-lg"
          @click="executeBatchSell"
          :disabled="!canExecute || isSelling"
        >
          <span v-if="isSelling">
            <span class="spinner-border spinner-border-sm me-1" role="status"></span>
            卖出中...
          </span>
          <span v-else>
            <i class="bi bi-cart-dash me-1"></i>
            一键卖出
          </span>
        </button>
      </div>

      <!-- 卖出结果 -->
      <div v-if="sellResults.length > 0" class="mt-3">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="small mb-0">
            <i class="bi bi-list-check me-1"></i>卖出结果
            <span class="badge bg-secondary ms-1">{{ sellResults.length }}</span>
            <span class="badge bg-success ms-1">{{ sellResults.filter(r => r.success).length }} 成功</span>
            <span v-if="sellResults.filter(r => !r.success).length > 0" class="badge bg-danger ms-1">
              {{ sellResults.filter(r => !r.success).length }} 失败
            </span>
          </h6>
          <button class="btn btn-outline-secondary btn-sm" @click="sellResults = []">
            <i class="bi bi-x-lg"></i> 清除
          </button>
        </div>
        <div class="results-list border rounded" style="max-height: 200px; overflow-y: auto;">
          <table class="table table-sm table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>#</th>
                <th>状态</th>
                <th>钱包</th>
                <th>比例</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(result, idx) in sellResults" :key="idx" :class="result.success ? '' : 'table-danger'">
                <td class="small text-muted">{{ idx + 1 }}</td>
                <td>
                  <i class="bi" :class="result.success ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'"></i>
                </td>
                <td class="small">
                  <code class="text-primary">{{ formatAddress(result.wallet) }}</code>
                </td>
                <td class="small">
                  <span class="badge bg-info">{{ result.percent?.toFixed(1) }}%</span>
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
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useDexStore } from '../../stores/dexStore';
import { useChainStore } from '../../stores/chainStore';

const emit = defineEmits(['close']);

const walletStore = useWalletStore();
const dexStore = useDexStore();
const chainStore = useChainStore();

const { selectedCount, selectedWalletAddresses } = storeToRefs(walletStore);

// 状态
const tokenAddress = ref('');
const sellMode = ref<'fixed' | 'range'>('fixed');
const fixedPercent = ref(100);
const minPercent = ref(10);
const maxPercent = ref(100);
const isSelling = ref(false);
const isRefreshing = ref(false);
const sellResults = ref<any[]>([]);
// 并发控制参数
const concurrency = ref(10);
const batchInterval = ref(500);
const poolType = ref<'BNB' | 'ASTER'>('BNB');

// 预估完成时间
const estimatedTime = computed(() => {
  if (selectedCount.value === 0) return '0秒';
  const batches = Math.ceil(selectedCount.value / concurrency.value);
  const totalMs = (batches - 1) * batchInterval.value; // 最后一批不需要等待
  const totalSeconds = Math.ceil(totalMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds}秒`;
});

// 是否可以执行
const canExecute = computed(() => {
  if (!tokenAddress.value || !tokenAddress.value.startsWith('0x')) return false;
  if (selectedCount.value === 0) return false;

  if (sellMode.value === 'fixed') {
    return fixedPercent.value > 0 && fixedPercent.value <= 100;
  } else {
    return minPercent.value > 0 &&
           maxPercent.value > 0 &&
           minPercent.value < maxPercent.value &&
           maxPercent.value <= 100;
  }
});

// 刷新代币余额
async function refreshTokenBalances() {
  if (!tokenAddress.value || !tokenAddress.value.startsWith('0x')) return;

  isRefreshing.value = true;
  try {
    await walletStore.refreshTargetTokenBalance();
  } finally {
    isRefreshing.value = false;
  }
}

// 获取钱包私钥
function getWalletPrivateKey(walletAddress: string): string | null {
  const wallet = walletStore.localWallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  return wallet?.encrypted || null;
}

// 执行批量卖出（两阶段执行：先授权，再同时发送卖出）
async function executeBatchSell() {
  if (!canExecute.value) return;

  const routerAddress = dexStore.currentRouterAddress;
  if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
    alert('当前DEX的Router地址未配置');
    return;
  }

  isSelling.value = true;
  sellResults.value = [];

  try {
    const walletAddresses = selectedWalletAddresses.value;
    const sellTokenAddress = tokenAddress.value;
    const chainId = chainStore.selectedChainId;
    const rpcUrl = chainStore.effectiveRpcUrl;

    console.log(`批量卖出：共 ${walletAddresses.length} 个钱包，采用两阶段执行`);

    // ========== 第一阶段：检查余额和授权 ==========
    console.log(`[阶段1] 检查余额和处理授权...`);

    interface PreparedWallet {
      walletAddr: string;
      privateKey: string;
      percent: number;
      sellAmount: bigint;
    }

    const preparePromises = walletAddresses.map(async (walletAddr) => {
      // 计算卖出百分比
      let percent: number;
      if (sellMode.value === 'fixed') {
        percent = fixedPercent.value;
      } else {
        percent = Math.random() * (maxPercent.value - minPercent.value) + minPercent.value;
      }

      // 获取私钥
      const privateKey = getWalletPrivateKey(walletAddr);
      if (!privateKey) {
        return { walletAddr, percent, success: false, error: '钱包没有私钥' };
      }

      try {
        // 创建临时客户端检查余额和授权
        const { createPublicClient, createWalletClient, http } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');
        const { bsc, bscTestnet } = await import('viem/chains');
        const { erc20Abi } = await import('../../viem/abis/erc20');

        const chain = chainId === 97 ? bscTestnet : bsc;
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

        // 获取代币余额
        const tokenBalance = await publicClient.readContract({
          address: sellTokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [walletAddr as `0x${string}`]
        }) as bigint;

        if (tokenBalance <= 0n) {
          return { walletAddr, percent, success: false, error: '代币余额为零' };
        }

        // 计算卖出数量
        const sellAmount = (tokenBalance * BigInt(Math.floor(percent))) / 100n;
        if (sellAmount <= 0n) {
          return { walletAddr, percent, success: false, error: '卖出数量为零' };
        }

        // 检查授权
        const allowance = await publicClient.readContract({
          address: sellTokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [walletAddr as `0x${string}`, routerAddress as `0x${string}`]
        }) as bigint;

        // 如果授权不足，进行授权并等待确认
        if (allowance < sellAmount) {
          console.log(`${walletAddr.slice(0, 10)}... 需要授权`);
          const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
          const approveTxHash = await walletClient.writeContract({
            address: sellTokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'approve',
            args: [routerAddress as `0x${string}`, maxApproval]
          });
          // 等待授权确认
          await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
          console.log(`${walletAddr.slice(0, 10)}... 授权完成`);
        }

        return { walletAddr, privateKey, percent, sellAmount, success: true };
      } catch (error: any) {
        return { walletAddr, percent, success: false, error: error.message || '准备失败' };
      }
    });

    const prepareResults = await Promise.all(preparePromises);
    const readyWallets: PreparedWallet[] = prepareResults
      .filter((r): r is PreparedWallet & { success: true } => r.success === true && 'privateKey' in r)
      .map(r => ({ walletAddr: r.walletAddr, privateKey: r.privateKey, percent: r.percent, sellAmount: r.sellAmount }));

    // 添加失败的钱包到结果
    prepareResults.filter(r => !r.success).forEach(r => {
      sellResults.value.push({
        wallet: r.walletAddr,
        percent: r.percent,
        success: false,
        error: r.error
      });
    });

    if (readyWallets.length === 0) {
      alert('没有钱包准备成功，取消批量卖出');
      return;
    }

    console.log(`[阶段2] ${readyWallets.length} 个钱包准备就绪，同时发送卖出交易...`);

    // ========== 第二阶段：同时发送所有卖出交易（不等待确认）==========
    const { createPublicClient, createWalletClient, http, parseUnits, formatUnits } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { bsc, bscTestnet } = await import('viem/chains');
    const { pancakeV2RouterAbi } = await import('../../viem/abis/pancakeV2');
    const { WBNB_ADDRESSES, ASTER_TOKEN_ADDRESS } = await import('../../constants');

    const chain = chainId === 97 ? bscTestnet : bsc;
    const wbnbAddress = WBNB_ADDRESSES[chainId] || WBNB_ADDRESSES[56];
    const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + 1200);

    const sellPromises = readyWallets.map(async ({ walletAddr, privateKey, percent, sellAmount }) => {
      try {
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

        const path: `0x${string}`[] = poolType.value === 'ASTER'
          ? [sellTokenAddress as `0x${string}`, ASTER_TOKEN_ADDRESS, wbnbAddress]
          : [sellTokenAddress as `0x${string}`, wbnbAddress];

        // 获取预期输出（用于计算滑点）
        const amountsOut = await publicClient.readContract({
          address: routerAddress as `0x${string}`,
          abi: pancakeV2RouterAbi,
          functionName: 'getAmountsOut',
          args: [sellAmount, path]
        }) as bigint[];

        const expectedOut = amountsOut[amountsOut.length - 1];
        const minAmountOut = (expectedOut * 70n) / 100n; // 30% 滑点保护

        // 获取 nonce
        const nonce = await publicClient.getTransactionCount({
          address: walletAddr as `0x${string}`,
          blockTag: 'pending'
        });

        // 发送卖出交易（不等待确认）
        const txHash = await walletClient.writeContract({
          address: routerAddress as `0x${string}`,
          abi: pancakeV2RouterAbi,
          functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
          args: [sellAmount, minAmountOut, path, walletAddr as `0x${string}`, deadlineTimestamp],
          nonce
        });

        console.log(`${walletAddr.slice(0, 10)}... 卖出交易已发送: ${txHash}`);

        return {
          wallet: walletAddr,
          percent,
          success: true,
          hash: txHash,
          amountIn: formatUnits(sellAmount, 18),
          error: null
        };
      } catch (error: any) {
        console.error(`${walletAddr.slice(0, 10)}... 卖出失败:`, error);
        return {
          wallet: walletAddr,
          percent,
          success: false,
          error: error.message || '卖出失败'
        };
      }
    });

    // 同时发送所有交易
    const sellResultsList = await Promise.all(sellPromises);
    sellResults.value.push(...sellResultsList);

    // 统计结果
    const successCount = sellResults.value.filter(r => r.success).length;
    const failCount = sellResults.value.filter(r => !r.success).length;

    if (failCount === 0) {
      alert(`卖出完成！成功发送 ${successCount} 笔交易`);
    } else {
      alert(`卖出完成！成功 ${successCount} 笔，失败 ${failCount} 笔`);
    }

  } catch (error: any) {
    console.error('批量卖出失败:', error);
    alert(`批量卖出失败: ${error.message || '未知错误'}`);
  } finally {
    isSelling.value = false;
  }
}

// 格式化地址
function formatAddress(address: string): string {
  if (!address) return '-';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 获取区块浏览器链接
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
  return error.length > 25 ? error.slice(0, 25) + '...' : error;
}
</script>

<style scoped>
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.results-list {
  font-size: 0.75rem;
}
</style>
