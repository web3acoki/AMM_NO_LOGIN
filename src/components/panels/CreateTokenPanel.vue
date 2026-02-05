<template>
  <div class="create-token-panel">
    <!-- 标题 -->
    <div class="panel-header">
      <h5 class="mb-0">
        <i class="bi bi-coin me-2"></i>
        创建代币
      </h5>
      <div class="d-flex align-items-center gap-2">
        <select
          class="form-select form-select-sm"
          :class="currentNetwork === 'bscTestnet' ? 'border-warning text-warning' : 'border-success text-success'"
          style="width: 140px; font-weight: bold;"
          v-model="currentNetwork"
          @change="onNetworkChange"
        >
          <option value="bscTestnet">BSC 测试网</option>
          <option value="bscMainnet">BSC 主网</option>
        </select>
        <span class="badge bg-warning text-dark">FourMeme</span>
      </div>
    </div>

    <div class="panel-body">
      <!-- 钱包连接状态 -->
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-wallet2 me-1"></i>
            钱包连接
          </h6>
          <div class="d-flex align-items-center gap-2">
            <button
              v-if="!connectedWallet"
              class="btn btn-sm btn-primary"
              @click="connectWallet"
              :disabled="isLoading"
            >
              连接钱包
            </button>
            <span v-else class="badge bg-success">
              {{ connectedWallet.slice(0, 6) }}...{{ connectedWallet.slice(-4) }}
            </span>
          </div>
        </div>
        <div v-if="connectedWallet" class="card-body py-2 small">
          <div class="d-flex justify-content-between">
            <span class="text-muted">当前网络:</span>
            <span :class="currentNetwork === 'bscTestnet' ? 'text-warning fw-bold' : 'text-success fw-bold'">
              {{ NETWORKS[currentNetwork].name }}
            </span>
          </div>
          <div v-if="currentNetwork === 'bscTestnet'" class="mt-1 text-warning small">
            <i class="bi bi-exclamation-triangle me-1"></i>
            测试网模式 - FourMeme API 仅在主网可用
          </div>
        </div>
      </div>

      <!-- 合约状态 -->
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-info-circle me-1"></i>
            合约状态
          </h6>
          <button class="btn btn-sm btn-outline-primary" @click="refreshContractStatus" :disabled="isLoading">
            <i class="bi bi-arrow-clockwise" :class="{ 'spin': isLoading }"></i>
          </button>
        </div>
        <div class="card-body py-2">
          <div v-if="!bundlerAddress" class="text-warning">
            <i class="bi bi-exclamation-triangle me-1"></i>
            请先配置 FourMemeBundler 合约地址
          </div>
          <div v-else>
            <div class="row small">
              <div class="col-6">
                <div class="text-muted">合约地址</div>
                <code class="text-truncate d-block" style="max-width: 150px;">{{ bundlerAddress }}</code>
              </div>
              <div class="col-3">
                <div class="text-muted">注册钱包</div>
                <div class="fw-bold">{{ contractStatus.walletCount }}</div>
              </div>
              <div class="col-3">
                <div class="text-muted">总存款</div>
                <div class="fw-bold">{{ contractStatus.totalDeposits }} BNB</div>
              </div>
            </div>
            <div class="mt-2">
              <span class="badge" :class="contractStatus.launched ? 'bg-success' : 'bg-secondary'">
                {{ contractStatus.launched ? '已发射' : '待发射' }}
              </span>
              <span v-if="contractStatus.token && contractStatus.token !== '0x0000000000000000000000000000000000000000'" class="ms-2 small">
                代币: <code>{{ contractStatus.token.slice(0, 10) }}...{{ contractStatus.token.slice(-6) }}</code>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 合约配置 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <i class="bi bi-gear me-1"></i>
            合约配置
          </h6>
        </div>
        <div class="card-body">
          <div class="mb-3">
            <label class="form-label">FourMemeBundler 合约地址</label>
            <input
              type="text"
              class="form-control form-control-sm font-monospace"
              v-model="bundlerAddress"
              placeholder="0x..."
            />
            <small class="text-muted">部署合约后填入地址</small>
          </div>
        </div>
      </div>

      <!-- 步骤 1: 注册钱包 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <span class="badge bg-primary me-2">1</span>
            注册钱包到合约
          </h6>
        </div>
        <div class="card-body">
          <!-- 钱包批次选择 -->
          <div class="mb-3">
            <label class="form-label">选择钱包批次</label>
            <select class="form-select form-select-sm" v-model="selectedBatchId">
              <option value="">选择批次...</option>
              <option
                v-for="batch in walletStore.walletBatches"
                :key="batch.id"
                :value="batch.id"
              >
                {{ batch.remark }} ({{ batch.wallets.length }} 个钱包)
              </option>
            </select>
          </div>

          <!-- 显示批次钱包 -->
          <div v-if="selectedBatch" class="mb-3">
            <div class="small text-muted mb-2">批次钱包列表：</div>
            <div class="wallet-list">
              <div
                v-for="(wallet, index) in selectedBatch.wallets"
                :key="wallet.address"
                class="wallet-item d-flex align-items-center justify-content-between"
              >
                <div>
                  <span class="badge bg-secondary me-2">{{ index + 1 }}</span>
                  <code class="small">{{ wallet.address.slice(0, 10) }}...{{ wallet.address.slice(-6) }}</code>
                </div>
                <span class="small text-muted">{{ wallet.remark || '-' }}</span>
              </div>
            </div>
          </div>

          <button
            class="btn btn-outline-primary btn-sm w-100"
            @click="registerWallets"
            :disabled="!selectedBatch || isLoading"
          >
            <i class="bi bi-check2-circle me-1"></i>
            注册 {{ selectedBatch?.wallets.length || 0 }} 个钱包到合约
          </button>
        </div>
      </div>

      <!-- 步骤 2: 存入 BNB -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <span class="badge bg-primary me-2">2</span>
            批量存入 BNB
          </h6>
        </div>
        <div class="card-body">
          <div class="mb-3">
            <label class="form-label">每个钱包存入金额 (BNB)</label>
            <input
              type="number"
              class="form-control form-control-sm"
              v-model.number="depositPerWallet"
              placeholder="0.01"
              step="0.001"
              min="0"
            />
          </div>

          <div v-if="selectedBatch" class="alert alert-info py-2 small">
            <i class="bi bi-calculator me-1"></i>
            总计需要: <strong>{{ totalDepositAmount }} BNB</strong>
            ({{ selectedBatch.wallets.length }} 钱包 x {{ depositPerWallet }} BNB)
          </div>

          <button
            class="btn btn-outline-primary btn-sm w-100"
            @click="batchDeposit"
            :disabled="!selectedBatch || depositPerWallet <= 0 || isLoading"
          >
            <i class="bi bi-wallet2 me-1"></i>
            批量存入 BNB
          </button>
        </div>
      </div>

      <!-- 步骤 3: 代币信息 & 捆绑发射 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <span class="badge bg-primary me-2">3</span>
            代币信息 & 捆绑发射
          </h6>
        </div>
        <div class="card-body">
          <!-- 代币基本信息 -->
          <div class="row mb-3">
            <div class="col-6">
              <label class="form-label">代币名称 *</label>
              <input
                type="text"
                class="form-control form-control-sm"
                v-model="tokenInfo.name"
                placeholder="My Token"
              />
            </div>
            <div class="col-6">
              <label class="form-label">代币符号 *</label>
              <input
                type="text"
                class="form-control form-control-sm"
                v-model="tokenInfo.symbol"
                placeholder="MTK"
              />
            </div>
          </div>

          <div class="mb-3">
            <label class="form-label">代币描述 *</label>
            <textarea
              class="form-control form-control-sm"
              v-model="tokenInfo.desc"
              rows="2"
              placeholder="Token description..."
            ></textarea>
          </div>

          <div class="row mb-3">
            <div class="col-6">
              <label class="form-label">代币分类 *</label>
              <select class="form-select form-select-sm" v-model="tokenInfo.label">
                <option value="Meme">Meme</option>
                <option value="AI">AI</option>
                <option value="Defi">Defi</option>
                <option value="Games">Games</option>
                <option value="Infra">Infra</option>
                <option value="De-Sci">De-Sci</option>
                <option value="Social">Social</option>
                <option value="Depin">Depin</option>
                <option value="Charity">Charity</option>
                <option value="Others">Others</option>
              </select>
            </div>
            <div class="col-6">
              <label class="form-label">预购金额 (BNB)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="tokenInfo.presaleBNB"
                placeholder="0"
                step="0.01"
                min="0"
              />
            </div>
          </div>

          <!-- 代币图片 -->
          <div class="mb-3">
            <label class="form-label">代币图片 *</label>
            <input
              type="file"
              class="form-control form-control-sm"
              @change="handleImageSelect"
              accept="image/png,image/jpeg,image/gif,image/webp"
            />
            <small class="text-muted">支持 PNG, JPG, GIF, WEBP</small>
            <div v-if="imagePreview" class="mt-2">
              <img :src="imagePreview" alt="Token Image" class="img-thumbnail" style="max-width: 100px;" />
            </div>
          </div>

          <!-- 可选链接 -->
          <div class="mb-3">
            <label class="form-label">官网 (可选)</label>
            <input
              type="url"
              class="form-control form-control-sm"
              v-model="tokenInfo.webUrl"
              placeholder="https://..."
            />
          </div>

          <div class="row mb-3">
            <div class="col-6">
              <label class="form-label">Twitter (可选)</label>
              <input
                type="url"
                class="form-control form-control-sm"
                v-model="tokenInfo.twitterUrl"
                placeholder="https://x.com/..."
              />
            </div>
            <div class="col-6">
              <label class="form-label">Telegram (可选)</label>
              <input
                type="url"
                class="form-control form-control-sm"
                v-model="tokenInfo.telegramUrl"
                placeholder="https://t.me/..."
              />
            </div>
          </div>

          <!-- API 状态 -->
          <div v-if="apiStatus.loggedIn" class="alert alert-success py-2 small mb-3">
            <i class="bi bi-check-circle me-1"></i>
            FourMeme API 已登录
            <span v-if="apiStatus.imageUrl" class="ms-2">| 图片已上传</span>
            <span v-if="apiStatus.prepared" class="ms-2">| 已准备就绪</span>
          </div>

          <!-- 准备按钮 -->
          <div class="d-flex gap-2 mb-3">
            <button
              class="btn btn-outline-secondary btn-sm flex-fill"
              @click="loginToFourMeme"
              :disabled="!connectedWallet || isLoading"
            >
              <i class="bi bi-key me-1"></i>
              1. 登录 API
            </button>
            <button
              class="btn btn-outline-secondary btn-sm flex-fill"
              @click="uploadTokenImage"
              :disabled="!apiStatus.loggedIn || !selectedImage || isLoading"
            >
              <i class="bi bi-upload me-1"></i>
              2. 上传图片
            </button>
            <button
              class="btn btn-outline-secondary btn-sm flex-fill"
              @click="prepareTokenCreate"
              :disabled="!apiStatus.imageUrl || !canPrepare || isLoading"
            >
              <i class="bi bi-gear me-1"></i>
              3. 准备创建
            </button>
          </div>

          <div class="alert alert-warning py-2 small mb-3">
            <i class="bi bi-lightning-charge me-1"></i>
            <strong>原子操作</strong>：一笔交易完成 创建代币 + 批量买入，比狙击者快！
          </div>

          <button
            class="btn btn-success w-100"
            @click="launchAndBuy"
            :disabled="!canLaunch || isLoading"
          >
            <i class="bi bi-rocket-takeoff me-1"></i>
            {{ isLoading ? '处理中...' : '捆绑发射' }}
          </button>
        </div>
      </div>

      <!-- 步骤 4: 提取代币 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <span class="badge bg-primary me-2">4</span>
            提取代币
          </h6>
        </div>
        <div class="card-body">
          <button
            class="btn btn-outline-primary btn-sm w-100"
            @click="batchWithdrawTokens"
            :disabled="!contractStatus.launched || isLoading"
          >
            <i class="bi bi-box-arrow-up me-1"></i>
            批量提取代币到各钱包
          </button>
        </div>
      </div>

      <!-- 日志 -->
      <div class="card">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-terminal me-1"></i>
            操作日志
          </h6>
          <button
            v-if="logs.length > 0"
            class="btn btn-sm btn-outline-secondary"
            @click="logs = []"
          >
            清空
          </button>
        </div>
        <div class="card-body log-body" ref="logContainer">
          <div v-if="logs.length === 0" class="text-center text-muted py-3">
            暂无日志
          </div>
          <div v-else class="log-entries">
            <div
              v-for="(log, index) in logs"
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
import { ref, computed, watch, nextTick, onMounted, reactive } from 'vue';
import { createPublicClient, createWalletClient, custom, http, parseEther, formatEther } from 'viem';
import { bsc } from 'viem/chains';
import { useWalletStore } from '../../stores/walletStore';
import FourMemeBundlerABI from '../../contracts/FourMemeBundler.json';

const walletStore = useWalletStore();

// FourMeme API 配置
// 使用 Vercel API 代理解决 CORS 问题
const FOURMEME_API_BASE = '/api/fourmeme';

// 网络配置
const NETWORKS = {
  bscMainnet: {
    chainId: '0x38',
    chainIdDecimal: 56,
    name: 'BSC Mainnet',
    rpcUrl: 'https://bsc-rpc.publicnode.com'
  },
  bscTestnet: {
    chainId: '0x61',
    chainIdDecimal: 97,
    name: 'BSC Testnet',
    rpcUrl: 'https://bsc-testnet-rpc.publicnode.com'
  }
};

// 当前网络（可切换）
const currentNetwork = ref<'bscMainnet' | 'bscTestnet'>(
  (localStorage.getItem('selectedNetwork') as 'bscMainnet' | 'bscTestnet') || 'bscTestnet'
);

// 保存网络选择
watch(currentNetwork, (val) => {
  localStorage.setItem('selectedNetwork', val);
});

// 网络切换处理
function onNetworkChange() {
  connectedWallet.value = null;
  contractStatus.value = {
    walletCount: 0,
    totalDeposits: '0',
    launched: false,
    token: ''
  };
  apiStatus.loggedIn = false;
  apiStatus.accessToken = '';
  apiStatus.imageUrl = '';
  apiStatus.prepared = false;
  apiStatus.createArgs = '';
  apiStatus.signature = '';
  addLog('info', `已切换到 ${NETWORKS[currentNetwork.value].name}`);
}

// 合约地址（部署后配置）
const bundlerAddress = ref(localStorage.getItem('bundlerAddress') || '');

// 保存合约地址到 localStorage
watch(bundlerAddress, (val) => {
  localStorage.setItem('bundlerAddress', val);
});

// 钱包连接状态
const connectedWallet = ref<string | null>(null);

// 状态
const isLoading = ref(false);
const selectedBatchId = ref('');
const depositPerWallet = ref(0.01);
const logs = ref<{ type: string; message: string; timestamp: number }[]>([]);
const logContainer = ref<HTMLElement | null>(null);

// 代币信息
const tokenInfo = reactive({
  name: '',
  symbol: '',
  desc: '',
  label: 'Meme',
  presaleBNB: 0,
  webUrl: '',
  twitterUrl: '',
  telegramUrl: ''
});

// 图片状态
const selectedImage = ref<File | null>(null);
const imagePreview = ref<string | null>(null);

// API 状态
const apiStatus = reactive({
  loggedIn: false,
  accessToken: '',
  imageUrl: '',
  prepared: false,
  createArgs: '',
  signature: ''
});

// 合约状态
const contractStatus = ref({
  walletCount: 0,
  totalDeposits: '0',
  launched: false,
  token: ''
});

// 选中的批次
const selectedBatch = computed(() => {
  if (!selectedBatchId.value) return null;
  return walletStore.walletBatches.find(b => b.id === selectedBatchId.value);
});

// 总存款金额
const totalDepositAmount = computed(() => {
  if (!selectedBatch.value) return 0;
  return (selectedBatch.value.wallets.length * depositPerWallet.value).toFixed(4);
});

// 是否可以准备
const canPrepare = computed(() => {
  return tokenInfo.name && tokenInfo.symbol && tokenInfo.desc && tokenInfo.label;
});

// 是否可以发射
const canLaunch = computed(() => {
  return bundlerAddress.value &&
    apiStatus.prepared &&
    apiStatus.createArgs &&
    apiStatus.signature &&
    connectedWallet.value;
});

// 添加日志
function addLog(type: 'info' | 'success' | 'error' | 'warning', message: string) {
  logs.value.push({ type, message, timestamp: Date.now() });
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  });
}

// 格式化时间
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// 获取钱包提供者
function getWalletProvider() {
  // 检查各种钱包提供者
  if (window.ethereum) {
    return window.ethereum;
  }
  // OKX Wallet
  if ((window as any).okxwallet) {
    return (window as any).okxwallet;
  }
  // Trust Wallet
  if ((window as any).trustwallet) {
    return (window as any).trustwallet;
  }
  // Coinbase Wallet
  if ((window as any).coinbaseWalletExtension) {
    return (window as any).coinbaseWalletExtension;
  }
  return null;
}

// 检测钱包名称
function detectWalletName(): string {
  if (!window.ethereum) return 'Unknown';

  if (window.ethereum.isMetaMask) return 'MetaMask';
  if ((window.ethereum as any).isOkxWallet || (window as any).okxwallet) return 'OKX Wallet';
  if ((window.ethereum as any).isTrust || (window as any).trustwallet) return 'Trust Wallet';
  if ((window.ethereum as any).isCoinbaseWallet) return 'Coinbase Wallet';
  if ((window.ethereum as any).isTokenPocket) return 'TokenPocket';
  if ((window.ethereum as any).isBitKeep) return 'BitKeep';
  if ((window.ethereum as any).isSafePal) return 'SafePal';

  return 'Web3 Wallet';
}

// 连接钱包
async function connectWallet() {
  const provider = getWalletProvider();
  if (!provider) {
    addLog('error', '请安装 Web3 钱包（如 MetaMask、OKX Wallet、Trust Wallet 等）');
    return;
  }

  isLoading.value = true;
  try {
    await provider.request({ method: 'eth_requestAccounts' });

    const network = NETWORKS[currentNetwork.value];

    // 检查网络
    const chainId = await provider.request({ method: 'eth_chainId' });
    if (chainId !== network.chainId) {
      addLog('warning', `请切换到 ${network.name}`);
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: network.chainId }]
        });
      } catch (switchError: any) {
        // 如果网络不存在，尝试添加
        if (switchError.code === 4902) {
          try {
            await provider.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: network.chainId,
                chainName: network.name,
                nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
                rpcUrls: [network.rpcUrl],
                blockExplorerUrls: [currentNetwork.value === 'bscMainnet'
                  ? 'https://bscscan.com'
                  : 'https://testnet.bscscan.com']
              }]
            });
          } catch (addError) {
            addLog('error', '添加网络失败');
            return;
          }
        } else {
          addLog('error', `请手动切换到 ${network.name}`);
          return;
        }
      }
    }

    const accounts = await provider.request({ method: 'eth_accounts' });
    if (accounts && accounts.length > 0) {
      connectedWallet.value = accounts[0];
      const walletName = detectWalletName();
      addLog('success', `${walletName} 已连接: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`);
      addLog('info', `当前网络: ${network.name}`);
    }
  } catch (error: any) {
    addLog('error', `连接钱包失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 获取钱包客户端
async function getWalletClient() {
  const provider = getWalletProvider();
  if (!provider || !connectedWallet.value) {
    throw new Error('请先连接钱包');
  }

  const network = NETWORKS[currentNetwork.value];
  const chain = currentNetwork.value === 'bscMainnet' ? bsc : {
    id: 97,
    name: 'BSC Testnet',
    nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: {
      default: { http: [network.rpcUrl] }
    }
  };

  const walletClient = createWalletClient({
    chain,
    transport: custom(provider)
  });

  return { walletClient, address: connectedWallet.value as `0x${string}` };
}

// 获取公共客户端
function getPublicClient() {
  const network = NETWORKS[currentNetwork.value];
  return createPublicClient({
    chain: currentNetwork.value === 'bscMainnet' ? bsc : {
      id: 97,
      name: 'BSC Testnet',
      nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
      rpcUrls: {
        default: { http: [network.rpcUrl] }
      }
    },
    transport: http(network.rpcUrl)
  });
}

// 处理图片选择
function handleImageSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files[0]) {
    selectedImage.value = input.files[0];
    imagePreview.value = URL.createObjectURL(input.files[0]);
    apiStatus.imageUrl = '';
    apiStatus.prepared = false;
  }
}

// FourMeme API: 登录
async function loginToFourMeme() {
  if (!connectedWallet.value) {
    addLog('error', '请先连接钱包');
    return;
  }

  isLoading.value = true;
  try {
    const address = connectedWallet.value.toLowerCase();

    // 1. 获取 nonce
    addLog('info', '正在获取登录 nonce...');
    const nonceResponse = await fetch(`${FOURMEME_API_BASE}/private/user/nonce/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountAddress: address,
        verifyType: 'LOGIN',
        networkCode: 'BSC'
      })
    });
    const nonceData = await nonceResponse.json();
    // code 可能是数字 0 或字符串 '0'
    if (nonceData.code !== 0 && nonceData.code !== '0') {
      throw new Error(`获取 nonce 失败: ${JSON.stringify(nonceData)}`);
    }
    const nonce = nonceData.data;
    addLog('info', `获取 nonce 成功: ${nonce}`);

    // 2. 签名消息
    const message = `You are sign in Meme ${nonce}`;
    addLog('info', '请在钱包中签名...');

    const provider = getWalletProvider();
    if (!provider) {
      throw new Error('钱包未连接');
    }

    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, connectedWallet.value]
    });

    // 3. 登录
    const walletName = detectWalletName();
    addLog('info', `正在登录 FourMeme API (${walletName})...`);
    const loginResponse = await fetch(`${FOURMEME_API_BASE}/private/user/login/dex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: 'WEB',
        langType: 'EN',
        loginIp: '',
        inviteCode: '',
        verifyInfo: {
          address: address,
          networkCode: 'BSC',
          signature: signature,
          verifyType: 'LOGIN'
        },
        walletName: walletName
      })
    });
    const loginData = await loginResponse.json();
    if (loginData.code !== 0 && loginData.code !== '0') {
      throw new Error(`登录失败: ${JSON.stringify(loginData)}`);
    }

    apiStatus.accessToken = loginData.data;
    apiStatus.loggedIn = true;
    addLog('success', 'FourMeme API 登录成功');
  } catch (error: any) {
    addLog('error', `登录失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// FourMeme API: 上传图片
async function uploadTokenImage() {
  if (!apiStatus.accessToken || !selectedImage.value) {
    addLog('error', '请先登录并选择图片');
    return;
  }

  isLoading.value = true;
  try {
    addLog('info', '正在上传代币图片...');

    const formData = new FormData();
    formData.append('file', selectedImage.value);

    // 使用专门的上传代理端点
    const response = await fetch('/api/fourmeme/upload', {
      method: 'POST',
      headers: {
        'meme-web-access': apiStatus.accessToken
      },
      body: formData
    });
    const data = await response.json();
    if (data.code !== 0 && data.code !== '0') {
      throw new Error(`上传失败: ${JSON.stringify(data)}`);
    }

    apiStatus.imageUrl = data.data;
    addLog('success', `图片上传成功`);
  } catch (error: any) {
    addLog('error', `上传失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// FourMeme API: 准备创建代币
async function prepareTokenCreate() {
  if (!apiStatus.accessToken || !apiStatus.imageUrl) {
    addLog('error', '请先登录并上传图片');
    return;
  }

  if (!canPrepare.value) {
    addLog('error', '请填写完整的代币信息');
    return;
  }

  isLoading.value = true;
  try {
    addLog('info', '正在准备创建代币...');

    const payload: Record<string, any> = {
      name: tokenInfo.name,
      shortName: tokenInfo.symbol,
      desc: tokenInfo.desc,
      imgUrl: apiStatus.imageUrl,
      launchTime: Date.now() + 60000, // 1 分钟后发射
      label: tokenInfo.label,
      preSale: String(tokenInfo.presaleBNB || '0'),
      onlyMPC: false,
      lpTradingFee: 0.0025,
      // 固定参数
      totalSupply: 1000000000,
      raisedAmount: 24,
      saleRate: 0.8,
      reserveRate: 0,
      funGroup: false,
      clickFun: false,
      symbol: 'BNB',
      symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
    };

    // 可选链接
    if (tokenInfo.webUrl) payload.webUrl = tokenInfo.webUrl;
    if (tokenInfo.twitterUrl) payload.twitterUrl = tokenInfo.twitterUrl;
    if (tokenInfo.telegramUrl) payload.telegramUrl = tokenInfo.telegramUrl;

    const response = await fetch(`${FOURMEME_API_BASE}/private/token/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'meme-web-access': apiStatus.accessToken
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.code !== 0 && data.code !== '0') {
      throw new Error(`准备失败: ${JSON.stringify(data)}`);
    }

    const result = data.data;
    apiStatus.createArgs = result.createArg || result.create_arg || result.arg;
    apiStatus.signature = result.signature || result.sign || result.signatureHex;

    if (!apiStatus.createArgs || !apiStatus.signature) {
      throw new Error(`API 返回数据格式错误: ${JSON.stringify(result)}`);
    }

    apiStatus.prepared = true;
    addLog('success', '代币创建准备就绪');
    addLog('info', `createArgs 长度: ${apiStatus.createArgs.length}`);
    addLog('info', `signature 长度: ${apiStatus.signature.length}`);
  } catch (error: any) {
    addLog('error', `准备失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 刷新合约状态
async function refreshContractStatus() {
  if (!bundlerAddress.value) return;

  isLoading.value = true;
  try {
    const publicClient = getPublicClient();

    // 获取合约状态
    const status = await publicClient.readContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'getContractStatus'
    }) as [bigint, bigint, boolean, string];

    // 获取 owner
    const owner = await publicClient.readContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'owner'
    }) as string;

    contractStatus.value = {
      walletCount: Number(status[0]),
      totalDeposits: formatEther(status[1]),
      launched: status[2],
      token: status[3]
    };

    addLog('info', '合约状态已刷新');
    addLog('info', `合约 Owner: ${owner.slice(0, 8)}...${owner.slice(-6)}`);

    // 检查当前钱包是否是 owner
    if (connectedWallet.value) {
      const isOwner = owner.toLowerCase() === connectedWallet.value.toLowerCase();
      if (!isOwner) {
        addLog('warning', `当前钱包不是合约 Owner！无法执行管理操作`);
        addLog('warning', `Owner: ${owner}`);
        addLog('warning', `当前: ${connectedWallet.value}`);
      } else {
        addLog('success', '当前钱包是合约 Owner');
      }
    }
  } catch (error: any) {
    addLog('error', `获取合约状态失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 注册钱包
async function registerWallets() {
  if (!selectedBatch.value || !bundlerAddress.value) return;

  isLoading.value = true;
  try {
    const { walletClient, address } = await getWalletClient();
    const publicClient = getPublicClient();
    const walletAddresses = selectedBatch.value.wallets.map(w => w.address as `0x${string}`);

    // 先检查是否是 owner
    const owner = await publicClient.readContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'owner'
    }) as string;

    if (owner.toLowerCase() !== address.toLowerCase()) {
      addLog('error', `当前钱包不是合约 Owner，无法注册钱包`);
      addLog('error', `Owner: ${owner}`);
      addLog('error', `当前: ${address}`);
      return;
    }

    // 检查是否已发射
    const status = await publicClient.readContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'launchCompleted'
    }) as boolean;

    if (status) {
      addLog('error', '合约已发射，无法再注册钱包');
      return;
    }

    addLog('info', `正在注册 ${walletAddresses.length} 个钱包...`);
    addLog('info', `钱包地址: ${walletAddresses[0].slice(0, 10)}... 等 ${walletAddresses.length} 个`);

    const hash = await walletClient.writeContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'registerWallets',
      args: [walletAddresses],
      account: address,
      gas: BigInt(100000 * walletAddresses.length) // 每个钱包约 100k gas
    });

    addLog('info', `交易已发送: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'success') {
      addLog('success', `钱包注册成功! Gas: ${receipt.gasUsed}`);
      await refreshContractStatus();
    } else {
      addLog('error', '交易失败');
    }
  } catch (error: any) {
    addLog('error', `注册失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 批量存入
async function batchDeposit() {
  if (!selectedBatch.value || !bundlerAddress.value || depositPerWallet.value <= 0) return;

  isLoading.value = true;
  try {
    const { walletClient, address } = await getWalletClient();
    const walletAddresses = selectedBatch.value.wallets.map(w => w.address as `0x${string}`);
    const amountPerWallet = parseEther(depositPerWallet.value.toString());
    const totalAmount = amountPerWallet * BigInt(walletAddresses.length);

    addLog('info', `准备存入: ${walletAddresses.length} 个钱包 × ${depositPerWallet.value} BNB = ${formatEther(totalAmount)} BNB`);

    // 先检查钱包是否都已注册
    const publicClient = getPublicClient();
    for (const addr of walletAddresses) {
      const info = await publicClient.readContract({
        address: bundlerAddress.value as `0x${string}`,
        abi: FourMemeBundlerABI.abi,
        functionName: 'getWalletInfo',
        args: [addr]
      }) as [boolean, bigint, bigint];

      if (!info[0]) {
        addLog('error', `钱包 ${addr.slice(0, 8)}... 未注册，请先注册`);
        return;
      }
    }

    addLog('info', '所有钱包已验证，正在发送交易...');

    const hash = await walletClient.writeContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'batchDeposit',
      args: [walletAddresses, amountPerWallet],
      value: totalAmount,
      account: address
    });

    addLog('info', `交易已发送: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'success') {
      addLog('success', `存款成功! Gas: ${receipt.gasUsed}`);
      await refreshContractStatus();
    } else {
      addLog('error', '交易失败');
    }
  } catch (error: any) {
    addLog('error', `存款失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 捆绑发射
async function launchAndBuy() {
  if (!canLaunch.value) return;

  isLoading.value = true;
  try {
    const { walletClient, address } = await getWalletClient();
    const presaleWei = parseEther(String(tokenInfo.presaleBNB || 0));
    const createFee = parseEther('0.01'); // 0.01 BNB 创建费

    // 总 value = 创建费 + 预购金额
    // 注意：批量买入的 BNB 已经通过 batchDeposit 存入合约，不需要再发送
    const totalValue = createFee + presaleWei;

    addLog('info', '正在执行捆绑发射...');
    addLog('info', `创建费: 0.01 BNB, 预购: ${tokenInfo.presaleBNB} BNB`);
    addLog('info', `合约已存入: ${contractStatus.value.totalDeposits} BNB (用于批量买入)`);
    addLog('info', '一笔交易完成: 创建代币 + 批量买入');

    const hash = await walletClient.writeContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'launchAndBuy',
      args: [
        apiStatus.createArgs as `0x${string}`,
        apiStatus.signature as `0x${string}`,
        presaleWei
      ],
      value: totalValue,
      account: address,
      gas: BigInt(5000000)
    });

    addLog('info', `交易已发送: ${hash}`);

    const publicClient = getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'success') {
      addLog('success', `捆绑发射成功! Gas: ${receipt.gasUsed}`);
      await refreshContractStatus();

      if (contractStatus.value.token && contractStatus.value.token !== '0x0000000000000000000000000000000000000000') {
        addLog('success', `代币地址: ${contractStatus.value.token}`);
        addLog('success', `查看: https://four.meme/token/${contractStatus.value.token}`);
      }
    } else {
      addLog('error', '交易失败');
    }
  } catch (error: any) {
    addLog('error', `发射失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 批量提取代币
async function batchWithdrawTokens() {
  if (!bundlerAddress.value || !contractStatus.value.launched) return;

  isLoading.value = true;
  try {
    const { walletClient, address } = await getWalletClient();

    addLog('info', '正在批量提取代币...');

    const hash = await walletClient.writeContract({
      address: bundlerAddress.value as `0x${string}`,
      abi: FourMemeBundlerABI.abi,
      functionName: 'batchWithdrawTokens',
      account: address
    });

    addLog('info', `交易已发送: ${hash}`);

    const publicClient = getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'success') {
      addLog('success', `代币提取成功! Gas: ${receipt.gasUsed}`);
    } else {
      addLog('error', '交易失败');
    }
  } catch (error: any) {
    addLog('error', `提取失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// 初始化
onMounted(async () => {
  // 检查是否已连接钱包
  const provider = getWalletProvider();
  if (provider) {
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (accounts && accounts.length > 0) {
        connectedWallet.value = accounts[0];
      }
    } catch (e) {
      // ignore
    }
  }

  if (bundlerAddress.value) {
    refreshContractStatus();
  }
});
</script>

<style scoped>
.create-token-panel {
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

.wallet-list {
  max-height: 200px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 0.25rem;
  padding: 0.5rem;
}

.wallet-item {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.wallet-item:last-child {
  border-bottom: none;
}

.log-body {
  height: 200px;
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

.font-monospace {
  font-family: monospace;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.img-thumbnail {
  max-width: 80px;
  max-height: 80px;
  object-fit: cover;
}
</style>
