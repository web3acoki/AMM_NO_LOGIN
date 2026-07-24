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
        >
          <option value="bscTestnet">BSC 测试网</option>
          <option value="bscMainnet">BSC 主网</option>
          <option value="robinhood">Robinhood Chain</option>
        </select>
        <span class="badge bg-warning text-dark">{{ usePons ? 'Pons / Uniswap V3' : 'FourMeme' }}</span>
      </div>
    </div>

    <!-- RPC 节点选择 -->
    <div class="px-3 py-2" style="background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--bs-border-color);">
      <div class="d-flex align-items-center gap-2">
        <small class="text-muted text-nowrap">RPC 节点:</small>
        <select
          class="form-select form-select-sm"
          style="font-size: 0.75rem;"
          v-model="selectedRpcUrl"
        >
          <option
            v-for="node in currentRpcNodes"
            :key="node.url"
            :value="node.url"
          >
            {{ node.label }}
          </option>
        </select>
      </div>
    </div>

    <div class="panel-body">
      <!-- 模式选择 -->
      <div v-if="!usePons" class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <i class="bi bi-toggles me-1"></i>
            创建模式
          </h6>
        </div>
        <div class="card-body py-2">
          <div class="d-flex gap-2">
            <button
              class="btn btn-sm flex-fill"
              :class="createMode === 'standard' ? 'btn-primary' : 'btn-outline-secondary'"
              @click="createMode = 'standard'"
            >
              <i class="bi bi-box me-1"></i>
              标准模式
            </button>
            <button
              class="btn btn-sm flex-fill"
              :class="createMode === 'agent' ? 'btn-info' : 'btn-outline-secondary'"
              @click="createMode = 'agent'"
            >
              <i class="bi bi-robot me-1"></i>
              AI Agent 模式
            </button>
          </div>
          <div v-if="createMode === 'agent'" class="mt-2">
            <small class="text-muted d-block mb-1">底池代币</small>
            <div class="d-flex gap-2">
              <button
                class="btn btn-sm flex-fill"
                :class="selectedRaisedToken === 'BNB' ? 'btn-warning' : 'btn-outline-secondary'"
                @click="selectedRaisedToken = 'BNB'"
              >
                BNB
              </button>
              <button
                class="btn btn-sm flex-fill"
                :class="selectedRaisedToken === 'ASTER' ? 'btn-warning' : 'btn-outline-secondary'"
                @click="selectedRaisedToken = 'ASTER'"
              >
                ASTER
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 主钱包选择 -->
      <div class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-wallet2 me-1"></i>
            主钱包 (创建代币)
          </h6>
          <span v-if="connectedWallet" class="badge bg-success">
            {{ connectedWallet.slice(0, 6) }}...{{ connectedWallet.slice(-4) }}
          </span>
        </div>
        <div class="card-body py-2">
          <label class="form-label small">选择钱包批次 (取第1个钱包)</label>
          <select class="form-select form-select-sm" v-model="mainWalletBatchId" @change="onMainBatchChange">
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
      </div>

      <!-- Agent NFT 注册 (仅 Agent 模式) -->
      <div v-if="!usePons && createMode === 'agent'" class="card mb-3">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-person-badge me-1"></i>
            Agent NFT 注册
          </h6>
          <div class="form-check form-switch mb-0">
            <input
              class="form-check-input"
              type="checkbox"
              v-model="enableNftRegistration"
              id="nftToggle"
            />
            <label class="form-check-label small" for="nftToggle">
              注册 EIP-8004 NFT
            </label>
          </div>
        </div>
        <div v-if="enableNftRegistration" class="card-body">
          <div class="mb-3">
            <label class="form-label">Agent 名称 *</label>
            <input
              type="text"
              class="form-control form-control-sm"
              v-model="agentInfo.name"
              placeholder="My AI Agent"
            />
          </div>

          <div class="mb-3">
            <label class="form-label">Agent 描述 (可选)</label>
            <textarea
              class="form-control form-control-sm"
              v-model="agentInfo.description"
              rows="2"
              placeholder="I'm four.meme trading agent"
            ></textarea>
          </div>

          <div class="mb-3">
            <label class="form-label">Agent 头像 (可选)</label>
            <input
              type="file"
              class="form-control form-control-sm"
              @change="handleAgentImageSelect"
              accept="image/png,image/jpeg,image/gif,image/webp"
            />
            <div v-if="agentImagePreview" class="mt-2">
              <img :src="agentImagePreview" alt="Agent Image" class="img-thumbnail" style="max-width: 80px;" />
            </div>
          </div>

          <button
            class="btn btn-info btn-sm w-100"
            @click="registerAgentNFT"
            :disabled="!connectedWallet || !agentInfo.name.trim() || isLoading || nftRegistered"
          >
            <i class="bi bi-shield-check me-1"></i>
            {{ nftRegistered ? 'Agent NFT 已注册' : '注册 Agent NFT' }}
          </button>

          <div v-if="nftRegistered" class="alert alert-success py-2 small mt-2 mb-0">
            <i class="bi bi-check-circle me-1"></i>
            Agent ID: <strong>{{ agentId }}</strong>
            <br />
            <small class="text-muted">TX: {{ nftTxHash.slice(0, 14) }}...{{ nftTxHash.slice(-8) }}</small>
          </div>
        </div>
        <div v-else class="card-body py-2">
          <small class="text-muted">
            <i class="bi bi-info-circle me-1"></i>
            已跳过 NFT 注册，将直接使用 Agent 模式参数创建代币
          </small>
        </div>
      </div>

      <!-- 步骤 1: 代币信息 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <span class="badge bg-primary me-2">1</span>
            代币信息
          </h6>
        </div>
        <div class="card-body">
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
            <div v-if="!usePons" class="col-6">
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
            <div :class="usePons ? 'col-12' : 'col-6'">
              <label class="form-label">创建者预购 ({{ usePons ? 'ETH' : (createMode === 'agent' ? selectedRaisedToken : 'BNB') }})</label>
              <input
                v-if="usePons"
                type="text"
                inputmode="decimal"
                class="form-control form-control-sm"
                v-model="ponsDeveloperBuy"
                placeholder="0"
              />
              <input
                v-else
                type="number"
                class="form-control form-control-sm"
                v-model.number="tokenInfo.presaleBNB"
                placeholder="0"
                step="0.01"
                min="0"
              />
              <small v-if="usePons" class="text-muted">不设置 Dev 买入上限；发送前按实际金额执行链上模拟并检查余额。</small>
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
        </div>
      </div>

      <!-- 步骤 3: 发射 -->
      <div class="card mb-3">
        <div class="card-header">
          <h6 class="mb-0">
            <span class="badge bg-primary me-2">2</span>
            发射
          </h6>
        </div>
        <div class="card-body">
          <!-- API 状态 -->
          <div v-if="usePons && apiStatus.prepared" class="alert alert-success py-2 small mb-3">
            <i class="bi bi-check-circle me-1"></i>
            Pons 链上配置已读取 | IPFS 图片已上传 | 已准备就绪
          </div>
          <div v-else-if="apiStatus.loggedIn" class="alert alert-success py-2 small mb-3">
            <i class="bi bi-check-circle me-1"></i>
            FourMeme API 已登录
            <span v-if="apiStatus.imageUrl" class="ms-2">| 图片已上传</span>
            <span v-if="apiStatus.prepared" class="ms-2">| 已准备就绪</span>
          </div>

          <!-- 准备按钮 -->
          <div class="d-flex gap-2 mb-3">
            <button
              v-if="!usePons"
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
              :disabled="(!usePons && !apiStatus.loggedIn) || !selectedImage || isLoading"
            >
              <i class="bi bi-upload me-1"></i>
              {{ usePons ? '1. 上传 IPFS 图片' : '2. 上传图片' }}
            </button>
            <button
              class="btn btn-outline-secondary btn-sm flex-fill"
              @click="prepareTokenCreate"
              :disabled="!apiStatus.imageUrl || !canPrepare || isLoading"
            >
              <i class="bi bi-gear me-1"></i>
              {{ usePons ? '2. 读取链上配置' : '3. 准备创建' }}
            </button>
          </div>

          <!-- Gas 设置 -->
          <div v-if="!usePons" class="row mb-3">
            <div class="col-12">
              <label class="form-label small">创建 Gas Price (Gwei)</label>
              <input
                type="number"
                class="form-control form-control-sm"
                v-model.number="createGasPrice"
                step="0.1"
                min="1"
              />
              <small class="text-muted">高优先级，确保先执行</small>
            </div>
          </div>
          <div v-else class="alert alert-info py-2 small mb-3">
            Robinhood Gas 将在发送时动态估算，并包含 L2 执行与 L1 calldata 成本。
          </div>

          <button
            class="btn btn-success w-100"
            @click="launchAndBuy"
            :disabled="!canLaunch || isLoading"
          >
            <i class="bi bi-rocket-takeoff me-1"></i>
            {{ isLoading ? '处理中...' : (usePons ? '在 Pons 发射代币' : '发射创建代币') }}
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
import { createPublicClient, createWalletClient, http, parseEther, formatEther, parseGwei, keccak256, encodePacked } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';
import {
  ROBINHOOD_CHAIN,
  ROBINHOOD_EXPLORER,
  ROBINHOOD_HTTP_RPCS,
  launchPonsToken,
  readPonsRuntimeConfig,
  requestPonsVerification,
  uploadPonsImage,
  validatePonsLaunch,
  type PonsRuntimeConfig,
} from '../../services/ponsService';
import {
  ROBINHOOD_CREATE_TOKEN_RPC_URL,
  resolveCreateTokenRpcUrl,
  type CreateTokenNetwork,
} from '../../services/createTokenRpc';

const walletStore = useWalletStore();
const chainStore = useChainStore();

// ========== 常量 ==========

// FourMeme 合约地址
const FOURMEME_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as const;

// CREATE2 预测参数
const DEPLOYER = '0x757eba15a64468e6535532fcf093cef90e226f85' as const;
const INIT_CODE_HASH = '0x3eb722ec5d79ddc2f52880ea62f1b7e7d95c66d4ae0dfe32f988ca9eca52b359' as const;

// 创建费用
const CREATE_FEE = parseEther('0.01');

// EIP-8004 NFT contract
const NFT_8004_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

// EIP-8004 ABI
const NFT_8004_ABI = [
  { name: 'register', type: 'function', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'Registered', type: 'event', inputs: [{ name: 'agentId', type: 'uint256', indexed: true }, { name: 'agentURI', type: 'string', indexed: false }, { name: 'owner', type: 'address', indexed: true }] }
] as const;

// TokenManager2 fee query ABI (for dynamic fee)
const TM2_FEE_ABI = [
  { name: '_launchFee', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: '_tradingFeeRate', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }
] as const;

// FourMeme createToken ABI
const FOURMEME_ABI = [
  {
    name: 'createToken',
    type: 'function',
    inputs: [
      { name: 'createArgs', type: 'bytes' },
      { name: 'signature', type: 'bytes' }
    ],
    outputs: [],
    stateMutability: 'payable'
  }
] as const;

// 网络配置
const NETWORKS: Record<string, { chainId: string; chainIdDecimal: number; name: string }> = {
  bscMainnet: {
    chainId: '0x38',
    chainIdDecimal: 56,
    name: 'BSC Mainnet',
  },
  bscTestnet: {
    chainId: '0x61',
    chainIdDecimal: 97,
    name: 'BSC Testnet',
  },
  robinhood: {
    chainId: '0x1237',
    chainIdDecimal: 4663,
    name: 'Robinhood Chain Mainnet',
  },
};

// RPC 节点列表
const RPC_NODES: Record<string, { label: string; url: string }[]> = {
  bscMainnet: [
    { label: 'BNB Chain 官方', url: 'https://bsc-dataseed.bnbchain.org' },
    { label: 'BNB Chain 备用1', url: 'https://bsc-dataseed1.bnbchain.org' },
    { label: 'BNB Chain 备用2', url: 'https://bsc-dataseed2.bnbchain.org' },
    { label: 'BNB Chain 备用3', url: 'https://bsc-dataseed3.bnbchain.org' },
    { label: 'BNB Chain 备用4', url: 'https://bsc-dataseed4.bnbchain.org' },
    { label: 'PublicNode', url: 'https://bsc-rpc.publicnode.com' },
    { label: 'Nodereal', url: 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3' },
    { label: '1RPC', url: 'https://1rpc.io/bnb' },
  ],
  bscTestnet: [
    { label: 'BNB Chain 测试网', url: 'https://bsc-testnet-dataseed.bnbchain.org' },
    { label: 'PublicNode 测试网', url: 'https://bsc-testnet-rpc.publicnode.com' },
  ],
  robinhood: [
    { label: 'Robinhood 官方节点', url: ROBINHOOD_HTTP_RPCS[0] },
    { label: 'ArrowRPC 免费节点', url: ROBINHOOD_HTTP_RPCS[1] },
  ],
};

// ========== 状态 ==========

type CreateNetwork = CreateTokenNetwork;
const currentNetwork = ref<CreateNetwork>(
  (localStorage.getItem('selectedNetwork') as CreateNetwork) || 'bscMainnet'
);

const selectedRpcUrl = ref(
  currentNetwork.value === 'robinhood'
    ? ROBINHOOD_CREATE_TOKEN_RPC_URL
    : (localStorage.getItem('selectedRpcUrl') || RPC_NODES.bscMainnet[0].url)
);

// 当前网络可用的 RPC 节点
const currentRpcNodes = computed(() => (
  currentNetwork.value === 'robinhood'
    ? [{ label: 'Robinhood 官方普通节点（创建专用）', url: ROBINHOOD_CREATE_TOKEN_RPC_URL }]
    : (RPC_NODES[currentNetwork.value] || [])
));
const activeRpcUrl = computed(() => (
  resolveCreateTokenRpcUrl(currentNetwork.value, selectedRpcUrl.value)
));
const usePons = computed(() => currentNetwork.value === 'robinhood');

watch(currentNetwork, (val) => {
  localStorage.setItem('selectedNetwork', val);
  // 切换网络时重置 RPC 为该网络的第一个节点
  selectedRpcUrl.value = val === 'robinhood'
    ? ROBINHOOD_CREATE_TOKEN_RPC_URL
    : RPC_NODES[val][0].url;
  localStorage.setItem('selectedRpcUrl', selectedRpcUrl.value);
  const chainId = NETWORKS[val].chainIdDecimal;
  if (chainStore.selectedChainId !== chainId) chainStore.setSelectedChain(chainId);
  if (val === 'robinhood') createMode.value = 'standard';
  onNetworkChange();
});

watch(() => chainStore.selectedChainId, (chainId) => {
  // 创建面板不支持 OKX；不要把全局 OKX 选择误改回 BSC。
  if (![56, 97, 4663].includes(chainId)) return;
  const target: CreateNetwork = chainId === 4663 ? 'robinhood' : chainId === 97 ? 'bscTestnet' : 'bscMainnet';
  if (currentNetwork.value !== target) currentNetwork.value = target;
}, { immediate: true });

watch(selectedRpcUrl, (val) => {
  localStorage.setItem('selectedRpcUrl', val);
});

function onNetworkChange() {
  apiStatus.loggedIn = false;
  apiStatus.accessToken = '';
  apiStatus.imageUrl = '';
  apiStatus.prepared = false;
  apiStatus.createArgs = '';
  apiStatus.signature = '';
  predictedAddress.value = '';
  ponsRuntimeConfig.value = null;
  addLog('info', `已切换到 ${NETWORKS[currentNetwork.value].name}`);
}

const mainWalletBatchId = ref('');
const isLoading = ref(false);
const logs = ref<{ type: string; message: string; timestamp: number }[]>([]);
const logContainer = ref<HTMLElement | null>(null);
const predictedAddress = ref('');

// Gas 设置
const createGasPrice = ref(5);

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
const ponsDeveloperBuy = ref('0');

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

// Mode selection: 'standard' or 'agent'
const createMode = ref<'standard' | 'agent'>('standard');

// Raised token selection (agent mode)
const selectedRaisedToken = ref<'BNB' | 'ASTER'>('BNB');

const RAISED_TOKEN_MAP: Record<string, string> = {
  'BNB': '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  'ASTER': '0x000ae314e2a2172a039b26378814c252734f556a',
};

// Agent info (separate from token info)
const agentInfo = reactive({
  name: '',
  description: '',
});
const agentImage = ref<File | null>(null);
const agentImagePreview = ref<string | null>(null);
const agentImageUrl = ref('');

// NFT registration state
const nftRegistered = ref(false);
const agentId = ref<number | null>(null);
const nftTxHash = ref('');
const enableNftRegistration = ref(true);

// Public config (raisedToken)
const publicConfig = ref<any>(null);
const ponsRuntimeConfig = ref<PonsRuntimeConfig | null>(null);

// ========== 计算属性 ==========

const mainWalletBatch = computed(() => {
  if (!mainWalletBatchId.value) return null;
  return walletStore.walletBatches.find(b => b.id === mainWalletBatchId.value);
});

const mainWallet = computed(() => {
  if (!mainWalletBatch.value || mainWalletBatch.value.wallets.length === 0) return null;
  return mainWalletBatch.value.wallets[0];
});

const connectedWallet = computed(() => mainWallet.value?.address || null);

const canPrepare = computed(() => {
  return tokenInfo.name && tokenInfo.symbol && tokenInfo.desc && tokenInfo.label;
});

const canLaunch = computed(() => {
  if (usePons.value) return apiStatus.prepared && !!apiStatus.imageUrl && !!connectedWallet.value;
  return apiStatus.prepared &&
    apiStatus.createArgs &&
    apiStatus.signature &&
    connectedWallet.value;
});

function parsePonsDeveloperBuy(value: string): bigint {
  const amount = value.trim() || '0';
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount)) {
    throw new Error('Dev 买入金额必须是非负十进制数，且最多 18 位小数');
  }
  return parseEther(amount);
}

// Reset agent state when mode changes
watch(createMode, () => {
  selectedRaisedToken.value = 'BNB';
  nftRegistered.value = false;
  agentId.value = null;
  nftTxHash.value = '';
  agentInfo.name = '';
  agentInfo.description = '';
  agentImage.value = null;
  agentImagePreview.value = null;
  agentImageUrl.value = '';
  publicConfig.value = null;
});

// ========== 工具函数 ==========

function unicodeToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function addLog(type: 'info' | 'success' | 'error' | 'warning', message: string) {
  logs.value.push({ type, message, timestamp: Date.now() });
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// ========== 钱包操作 ==========

function onMainBatchChange() {
  apiStatus.loggedIn = false;
  apiStatus.accessToken = '';
  apiStatus.imageUrl = '';
  apiStatus.prepared = false;
  apiStatus.createArgs = '';
  apiStatus.signature = '';
  predictedAddress.value = '';
  if (mainWallet.value) {
    addLog('info', `主钱包已选择: ${mainWallet.value.address.slice(0, 6)}...${mainWallet.value.address.slice(-4)}`);
  }
}

function getMainWalletClient() {
  if (!mainWallet.value) {
    throw new Error('请先选择主钱包批次');
  }

  const account = privateKeyToAccount(mainWallet.value.privateKey as `0x${string}`);
  const chain = currentNetwork.value === 'robinhood' ? ROBINHOOD_CHAIN : currentNetwork.value === 'bscMainnet' ? bsc : {
    id: 97,
    name: 'BSC Testnet',
    nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: { default: { http: [activeRpcUrl.value] } }
  };

  return createWalletClient({
    account,
    chain,
    transport: http(activeRpcUrl.value, { timeout: 60_000, retryCount: 3, retryDelay: 2_000 })
  });
}

function getPublicClient() {
  return createPublicClient({
    chain: currentNetwork.value === 'robinhood' ? ROBINHOOD_CHAIN : currentNetwork.value === 'bscMainnet' ? bsc : {
      id: 97,
      name: 'BSC Testnet',
      nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
      rpcUrls: { default: { http: [activeRpcUrl.value] } }
    },
    transport: http(activeRpcUrl.value, { timeout: 60_000, retryCount: 3, retryDelay: 2_000 })
  });
}

// ========== 图片处理 ==========

function handleImageSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files[0]) {
    selectedImage.value = input.files[0];
    imagePreview.value = URL.createObjectURL(input.files[0]);
    apiStatus.imageUrl = '';
    apiStatus.prepared = false;
  }
}

// ========== Agent 图片处理 ==========

function handleAgentImageSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files[0]) {
    agentImage.value = input.files[0];
    agentImagePreview.value = URL.createObjectURL(input.files[0]);
    agentImageUrl.value = '';
  }
}

async function uploadAgentImage() {
  if (!agentImage.value) return;

  // Ensure logged in
  if (!apiStatus.loggedIn) {
    await loginToFourMeme();
    if (!apiStatus.loggedIn) {
      throw new Error('需要先登录 FourMeme API 才能上传图片');
    }
  }

  addLog('info', '正在上传 Agent 图片...');
  const formData = new FormData();
  formData.append('file', agentImage.value);

  const response = await fetch('/api/fourmeme/upload', {
    method: 'POST',
    headers: { 'meme-web-access': apiStatus.accessToken },
    body: formData
  });
  const data = await response.json();
  if (data.code !== 0 && data.code !== '0') {
    throw new Error(`上传 Agent 图片失败: ${JSON.stringify(data)}`);
  }

  agentImageUrl.value = data.data;
  addLog('success', 'Agent 图片上传成功');
}

// ========== NFT Registration ==========

async function registerAgentNFT() {
  if (!mainWallet.value) {
    addLog('error', '请先选择主钱包批次');
    return;
  }
  if (!agentInfo.name.trim()) {
    addLog('error', '请填写 Agent 名称');
    return;
  }

  isLoading.value = true;
  try {
    // Upload agent image if selected
    if (agentImage.value && !agentImageUrl.value) {
      await uploadAgentImage();
    }

    // Build agentURI
    const payload = {
      type: REGISTRATION_TYPE,
      name: agentInfo.name.trim(),
      description: agentInfo.description.trim() || "I'm four.meme trading agent",
      image: agentImageUrl.value,
      active: true,
      supportedTrust: ['']
    };
    const agentURI = `data:application/json;base64,${unicodeToBase64(JSON.stringify(payload))}`;

    addLog('info', '正在注册 EIP-8004 Agent NFT...');

    const mainClient = getMainWalletClient();
    const publicClient = getPublicClient();

    const txHash = await mainClient.writeContract({
      address: NFT_8004_ADDRESS,
      abi: NFT_8004_ABI,
      functionName: 'register',
      args: [agentURI],
    });

    nftTxHash.value = txHash;
    addLog('info', `NFT 注册交易已发送: ${txHash.slice(0, 14)}...`);
    addLog('info', '等待交易确认...');

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      throw new Error('NFT 注册交易失败');
    }

    // Parse Registered event to get agentId
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === NFT_8004_ADDRESS.toLowerCase() && log.topics[0]) {
        // Registered event: topics[1] is agentId (indexed uint256)
        if (log.topics[1]) {
          agentId.value = Number(BigInt(log.topics[1]));
          break;
        }
      }
    }

    nftRegistered.value = true;
    addLog('success', `Agent NFT 注册成功! Agent ID: ${agentId.value}`);
    addLog('info', `交易哈希: ${txHash}`);
  } catch (error: any) {
    addLog('error', `NFT 注册失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// ========== Public Config ==========

async function fetchPublicConfig() {
  try {
    addLog('info', '正在获取公共配置...');
    const response = await fetch('/api/fourmeme/config');
    const data = await response.json();

    if (data.code !== 0 && data.code !== '0') {
      throw new Error(`获取配置失败: ${JSON.stringify(data)}`);
    }

    // Find raisedToken matching selected token with status PUBLISH
    const configList = data.data || [];
    let tokenConfig = null;
    for (const item of configList) {
      if (item.raisedToken && item.raisedToken.symbol === selectedRaisedToken.value && item.status === 'PUBLISH') {
        tokenConfig = item;
        break;
      }
      // Also check top-level symbol
      if (item.symbol === selectedRaisedToken.value && item.status === 'PUBLISH') {
        tokenConfig = item;
        break;
      }
    }

    if (tokenConfig) {
      publicConfig.value = {
        totalSupply: tokenConfig.totalSupply || 1000000000,
        raisedAmount: tokenConfig.raisedAmount || 24,
        saleRate: tokenConfig.saleRate || 0.8,
        raisedToken: tokenConfig.raisedToken || undefined,
        tokenManager: tokenConfig.tokenManager || tokenConfig.contractAddress || undefined,
      };
      addLog('success', `公共配置已获取 (${selectedRaisedToken.value}): totalSupply=${publicConfig.value.totalSupply}, raisedAmount=${publicConfig.value.raisedAmount}`);
    } else {
      // Use the raw data if structure is different
      publicConfig.value = {
        totalSupply: data.data?.totalSupply || 1000000000,
        raisedAmount: data.data?.raisedAmount || 24,
        saleRate: data.data?.saleRate || 0.8,
        raisedToken: data.data?.raisedToken || undefined,
        tokenManager: data.data?.tokenManager || data.data?.contractAddress || undefined,
      };
      addLog('warning', '使用默认配置值');
    }
  } catch (error: any) {
    addLog('error', `获取配置失败: ${error.message}，使用默认值`);
    publicConfig.value = {
      totalSupply: 1000000000,
      raisedAmount: 24,
      saleRate: 0.8,
    };
  }
}

// ========== FourMeme API ==========

async function loginToFourMeme() {
  if (!mainWallet.value) {
    addLog('error', '请先选择主钱包批次');
    return;
  }

  isLoading.value = true;
  try {
    const account = privateKeyToAccount(mainWallet.value.privateKey as `0x${string}`);
    const address = account.address.toLowerCase();

    addLog('info', '正在获取登录 nonce...');
    const nonceResponse = await fetch('/api/fourmeme/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountAddress: address,
        verifyType: 'LOGIN',
        networkCode: 'BSC'
      })
    });
    const nonceData = await nonceResponse.json();
    if (nonceData.code !== 0 && nonceData.code !== '0') {
      throw new Error(`获取 nonce 失败: ${JSON.stringify(nonceData)}`);
    }
    const nonce = nonceData.data;
    addLog('info', `获取 nonce 成功: ${nonce}`);

    const message = `You are sign in Meme ${nonce}`;
    addLog('info', '正在使用私钥签名...');

    const signature = await account.signMessage({ message });

    addLog('info', '正在登录 FourMeme API...');
    const loginResponse = await fetch('/api/fourmeme/login', {
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
        walletName: 'Web3 Wallet'
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

async function uploadTokenImage() {
  if (!selectedImage.value) {
    addLog('error', '请先选择图片');
    return;
  }

  if (usePons.value) {
    isLoading.value = true;
    try {
      addLog('info', '正在通过服务端代理上传图片到 Pons IPFS...');
      apiStatus.imageUrl = await uploadPonsImage(selectedImage.value);
      apiStatus.prepared = false;
      ponsRuntimeConfig.value = null;
      addLog('success', `Pons IPFS 图片上传成功: ${apiStatus.imageUrl}`);
    } catch (error: any) {
      addLog('error', `Pons 图片上传失败: ${error.message}`);
    } finally {
      isLoading.value = false;
    }
    return;
  }

  if (!apiStatus.accessToken) {
    addLog('error', '请先登录 FourMeme API');
    return;
  }

  isLoading.value = true;
  try {
    addLog('info', '正在上传代币图片...');

    const formData = new FormData();
    formData.append('file', selectedImage.value);

    const response = await fetch('/api/fourmeme/upload', {
      method: 'POST',
      headers: { 'meme-web-access': apiStatus.accessToken },
      body: formData
    });
    const data = await response.json();
    if (data.code !== 0 && data.code !== '0') {
      throw new Error(`上传失败: ${JSON.stringify(data)}`);
    }

    apiStatus.imageUrl = data.data;
    addLog('success', '图片上传成功');
  } catch (error: any) {
    addLog('error', `上传失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

async function prepareTokenCreate() {
  if (!apiStatus.imageUrl) {
    addLog('error', '请先上传图片');
    return;
  }
  if (!canPrepare.value) {
    addLog('error', '请填写完整的代币信息');
    return;
  }

  isLoading.value = true;
  try {
    if (usePons.value) {
      if (!mainWallet.value) throw new Error('请先选择主钱包批次');
      const account = privateKeyToAccount(mainWallet.value.privateKey as `0x${string}`);
      const ponsInput = {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        logo: apiStatus.imageUrl,
        description: tokenInfo.desc,
        feeWallet: account.address,
        developerBuy: parsePonsDeveloperBuy(ponsDeveloperBuy.value),
        twitter: tokenInfo.twitterUrl,
        telegram: tokenInfo.telegramUrl,
        website: tokenInfo.webUrl,
      };
      validatePonsLaunch(ponsInput);
      addLog('info', '正在从 Pons Factory 动态读取 launchFee、launch config 和 dex config...');
      ponsRuntimeConfig.value = await readPonsRuntimeConfig(getPublicClient());
      const runtime = ponsRuntimeConfig.value;
      if (!runtime.launchEnabled || !runtime.launch.enabled || !runtime.dex.enabled) {
        throw new Error('Pons 当前发射或 Uniswap V3 配置未启用');
      }
      apiStatus.prepared = true;
      addLog('success', `Pons 配置就绪：创建费 ${formatEther(runtime.launchFee)} ETH`);
      addLog('info', 'Dev 买入不设置客户端金额上限；正式发送前将按完整金额执行链上模拟');
      addLog('info', `供应量 ${formatEther(runtime.launch.supply)}，V3 fee ${runtime.dex.poolFee}，毕业阈值 ${formatEther(runtime.launch.graduationThreshold)} ETH`);
      return;
    }

    if (!apiStatus.accessToken) throw new Error('请先登录 FourMeme API');
    // In agent mode, fetch public config first
    if (createMode.value === 'agent') {
      await fetchPublicConfig();
    }

    addLog('info', '正在准备创建代币...');

    const payload: Record<string, any> = {
      name: tokenInfo.name,
      shortName: tokenInfo.symbol,
      desc: tokenInfo.desc,
      imgUrl: apiStatus.imageUrl,
      launchTime: Date.now() + 60000,
      label: tokenInfo.label,
      preSale: String(tokenInfo.presaleBNB || '0'),
      onlyMPC: false,
      lpTradingFee: 0.0025,
      totalSupply: createMode.value === 'agent' ? (publicConfig.value?.totalSupply || 1000000000) : 1000000000,
      raisedAmount: createMode.value === 'agent' ? (publicConfig.value?.raisedAmount || 24) : 24,
      saleRate: createMode.value === 'agent' ? (publicConfig.value?.saleRate || 0.8) : 0.8,
      reserveRate: 0,
      funGroup: false,
      clickFun: false,
      symbol: createMode.value === 'agent' ? selectedRaisedToken.value : 'BNB',
      symbolAddress: createMode.value === 'agent' ? RAISED_TOKEN_MAP[selectedRaisedToken.value] : RAISED_TOKEN_MAP['BNB']
    };

    // Add agent-mode-specific params
    if (createMode.value === 'agent') {
      if (publicConfig.value?.raisedToken) {
        payload.raisedToken = publicConfig.value.raisedToken;
      }
      payload.dexType = 'PANCAKE_SWAP';
      payload.rushMode = false;
      payload.feePlan = false;
    }

    if (tokenInfo.webUrl) payload.webUrl = tokenInfo.webUrl;
    if (tokenInfo.twitterUrl) payload.twitterUrl = tokenInfo.twitterUrl;
    if (tokenInfo.telegramUrl) payload.telegramUrl = tokenInfo.telegramUrl;

    const response = await fetch('/api/fourmeme/create', {
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

    // 预测代币地址
    try {
      const salt = extractSaltFromCreateArgs(apiStatus.createArgs);
      const predicted = predictTokenAddress(salt);
      predictedAddress.value = predicted;
      addLog('success', `预测代币地址: ${predicted}`);
    } catch (e: any) {
      addLog('warning', `地址预测失败: ${e.message}，发射时将从链上获取`);
    }
  } catch (error: any) {
    addLog('error', `准备失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// ========== CREATE2 地址预测 ==========

function extractSaltFromCreateArgs(createArgs: string): `0x${string}` {
  // createArgs 是 ABI 编码的参数，salt 在第 6 个 word (index 5)
  // 位置: 0x前缀(2) + 5个word(5*64=320) = 322
  const data = createArgs.startsWith('0x') ? createArgs : '0x' + createArgs;
  if (data.length < 386) {
    throw new Error(`createArgs 太短，无法提取 salt (长度: ${data.length})`);
  }
  const salt = '0x' + data.slice(322, 386);
  return salt as `0x${string}`;
}

function predictTokenAddress(salt: `0x${string}`): string {
  const hash = keccak256(
    encodePacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', DEPLOYER, salt, INIT_CODE_HASH]
    )
  );
  // 取后 20 字节作为地址
  return '0x' + hash.slice(26);
}

// ========== 核心：发射 ==========

async function launchAndBuy() {
  if (!canLaunch.value) return;

  if (usePons.value) {
    await launchPonsAndBuy();
    return;
  }

  isLoading.value = true;
  try {
    const mainWalletClient = getMainWalletClient();
    const publicClient = getPublicClient();

    // Gas Price 最低保护（BSC 最低 1 Gwei）
    const actualCreateGas = Math.max(createGasPrice.value ?? 5, 1);

    addLog('info', `主钱包创建代币`);
    addLog('info', `创建 Gas: ${actualCreateGas} Gwei`);

    const presaleWei = parseEther(String(tokenInfo.presaleBNB || 0));
    let totalValue: bigint;

    // 始终从链上查询实际费用，避免硬编码值与合约不一致导致 revert
    let launchFee = CREATE_FEE;
    let tradingFee = 0n;
    const feeQueryAddress = (publicConfig.value?.tokenManager || FOURMEME_ADDRESS) as `0x${string}`;

    try {
      addLog('info', '正在查询链上创建费用...');
      const onChainFee = await publicClient.readContract({
        address: feeQueryAddress,
        abi: TM2_FEE_ABI,
        functionName: '_launchFee'
      });
      launchFee = onChainFee as bigint;
      addLog('info', `链上创建费: ${formatEther(launchFee)} BNB`);

      if (presaleWei > 0n) {
        try {
          const feeRate = await publicClient.readContract({
            address: feeQueryAddress,
            abi: TM2_FEE_ABI,
            functionName: '_tradingFeeRate'
          });
          tradingFee = (presaleWei * (feeRate as bigint)) / 10000n;
          addLog('info', `交易费率: ${feeRate}, 交易费: ${formatEther(tradingFee)} BNB`);
        } catch (e: any) {
          addLog('warning', `查询交易费率失败: ${e.message}，跳过`);
        }
      }
    } catch (e: any) {
      addLog('warning', `查询链上费用失败: ${e.message}，使用默认 ${formatEther(CREATE_FEE)} BNB`);
    }

    totalValue = launchFee + presaleWei + tradingFee;
    addLog('info', `创建费: ${formatEther(launchFee)} BNB + 预购: ${tokenInfo.presaleBNB || 0} + 交易费: ${formatEther(tradingFee)} BNB = ${formatEther(totalValue)} BNB`);

    // 获取 fresh createArgs（避免签名过期 Expired）
    addLog('info', '正在获取 fresh createArgs...');
    const freshPayload: Record<string, any> = {
      name: tokenInfo.name,
      shortName: tokenInfo.symbol,
      desc: tokenInfo.desc,
      imgUrl: apiStatus.imageUrl,
      launchTime: Date.now() + 60000,
      label: tokenInfo.label,
      preSale: String(tokenInfo.presaleBNB || '0'),
      onlyMPC: false,
      lpTradingFee: 0.0025,
      totalSupply: createMode.value === 'agent' ? (publicConfig.value?.totalSupply || 1000000000) : 1000000000,
      raisedAmount: createMode.value === 'agent' ? (publicConfig.value?.raisedAmount || 24) : 24,
      saleRate: createMode.value === 'agent' ? (publicConfig.value?.saleRate || 0.8) : 0.8,
      reserveRate: 0,
      funGroup: false,
      clickFun: false,
      symbol: createMode.value === 'agent' ? selectedRaisedToken.value : 'BNB',
      symbolAddress: createMode.value === 'agent' ? RAISED_TOKEN_MAP[selectedRaisedToken.value] : RAISED_TOKEN_MAP['BNB']
    };
    if (createMode.value === 'agent') {
      if (publicConfig.value?.raisedToken) freshPayload.raisedToken = publicConfig.value.raisedToken;
      freshPayload.dexType = 'PANCAKE_SWAP';
      freshPayload.rushMode = false;
      freshPayload.feePlan = false;
    }
    if (tokenInfo.webUrl) freshPayload.webUrl = tokenInfo.webUrl;
    if (tokenInfo.twitterUrl) freshPayload.twitterUrl = tokenInfo.twitterUrl;
    if (tokenInfo.telegramUrl) freshPayload.telegramUrl = tokenInfo.telegramUrl;

    const freshResp = await fetch('/api/fourmeme/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'meme-web-access': apiStatus.accessToken },
      body: JSON.stringify(freshPayload)
    });
    const freshData = await freshResp.json();
    if (freshData.code !== 0 && freshData.code !== '0') {
      throw new Error(`获取 fresh createArgs 失败: ${JSON.stringify(freshData)}`);
    }
    const freshResult = freshData.data;
    const freshCreateArgs = freshResult.createArg || freshResult.create_arg || freshResult.arg;
    const freshSignature = freshResult.signature || freshResult.sign || freshResult.signatureHex;
    if (!freshCreateArgs || !freshSignature) {
      throw new Error(`fresh API 返回数据格式错误: ${JSON.stringify(freshResult)}`);
    }
    addLog('success', 'fresh createArgs 已获取，立即发送交易');

    // 发送创建交易
    const createHash = await mainWalletClient.writeContract({
      address: FOURMEME_ADDRESS,
      abi: FOURMEME_ABI,
      functionName: 'createToken',
      args: [freshCreateArgs as `0x${string}`, freshSignature as `0x${string}`],
      value: totalValue,
      gasPrice: parseGwei(String(actualCreateGas)),
      gas: 3000000n
    });

    addLog('success', `创建交易已发送: ${createHash.slice(0, 14)}...`);

    // 等待创建交易确认
    addLog('info', '等待创建交易确认...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

    if (receipt.status !== 'success') {
      addLog('error', `创建交易失败 (gasUsed: ${receipt.gasUsed}, tx: ${createHash})`);
      return;
    }

    addLog('success', `创建交易确认成功! Gas: ${receipt.gasUsed}`);

    // 从 receipt logs 获取代币地址
    let tokenAddress = '';
    for (const log of receipt.logs) {
      if (log.address && log.address.toLowerCase() !== FOURMEME_ADDRESS.toLowerCase()) {
        tokenAddress = log.address;
        break;
      }
    }

    if (!tokenAddress) {
      addLog('error', '无法从链上获取代币地址');
      return;
    }

    addLog('success', `代币地址: ${tokenAddress}`);
    addLog('success', `查看: https://four.meme/token/${tokenAddress}`);
  } catch (error: any) {
    addLog('error', `发射失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

async function launchPonsAndBuy() {
  if (!mainWallet.value || !apiStatus.imageUrl) {
    addLog('error', '请先选择主钱包并上传图片');
    return;
  }

  isLoading.value = true;
  try {
    const account = privateKeyToAccount(mainWallet.value.privateKey as `0x${string}`);
    const publicClient = getPublicClient();
    const walletClient = getMainWalletClient();
    // Re-read owner-mutable configuration immediately before sending.
    const runtime = await readPonsRuntimeConfig(publicClient);
    ponsRuntimeConfig.value = runtime;
    const developerBuy = parsePonsDeveloperBuy(ponsDeveloperBuy.value);
    addLog('info', `Pons 发射总 value: ${formatEther(runtime.launchFee)} ETH 创建费 + ${formatEther(developerBuy)} ETH 开发者预购`);
    addLog('info', 'Dev 买入不设金额上限，正在使用完全相同的 calldata 和 value 执行链上模拟、Gas 与余额检查');
    addLog('info', `使用 ${runtime.dex.name || 'Uniswap V3'}，pool fee=${runtime.dex.poolFee}；Gas 由 RPC 动态估算`);

    const result = await launchPonsToken({
      input: {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        logo: apiStatus.imageUrl,
        description: tokenInfo.desc,
        feeWallet: account.address,
        developerBuy,
        twitter: tokenInfo.twitterUrl,
        telegram: tokenInfo.telegramUrl,
        website: tokenInfo.webUrl,
      },
      account,
      publicClient,
      walletClient,
    });

    addLog('success', `Pons 链上模拟通过；Gas 估算 ${result.gasEstimate}，发送上限 ${result.gasLimit}，最大 Gas 预算 ${formatEther(result.estimatedGasCost)} ETH`);
    addLog('success', `Pons 发射交易确认成功: ${result.hash}`);
    if (!result.token) {
      addLog('warning', '交易成功，但未能从 TokenLaunched 日志解析代币地址');
      return;
    }
    predictedAddress.value = result.token;
    addLog('success', `代币地址: ${result.token}`);
    addLog('success', `浏览器: ${ROBINHOOD_EXPLORER}/tx/${result.hash}`);
    if (!result.developerBuyVerified) {
      addLog(
        'error',
        `代币交易已确认，但原子买入回执校验失败；链上记录 ${formatEther(result.initialBuyAmount ?? 0n)} ETH、Dev 到账 ${formatEther(result.developerTokensReceived)} 枚`,
      );
      addLog('warning', '已停止后续验证流程。请先在区块浏览器核对这笔交易，切勿直接重复创建');
      return;
    }
    if (developerBuy > 0n) {
      addLog(
        'success',
        `Dev 原子买入已核验：${formatEther(result.initialBuyAmount ?? 0n)} ETH → ${formatEther(result.developerTokensReceived)} ${tokenInfo.symbol.trim().toUpperCase()}`,
      );
    } else {
      addLog('info', '本次未设置 Dev 买入，链上 initialBuyAmount 已核验为 0');
    }
    addLog('success', `Pons: https://pons.family/launchpad/${result.token}`);

    requestPonsVerification(result.token)
      .then(() => addLog('success', 'Pons 代币验证请求已提交'))
      .catch((error) => addLog('warning', `代币已创建，但验证请求失败: ${error.message}`));
  } catch (error: any) {
    addLog('error', `Pons 发射失败: ${error.message}`);
  } finally {
    isLoading.value = false;
  }
}

// ========== 初始化 ==========

onMounted(() => {
  // 主钱包现在从批次中选择，无需自动连接
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

.log-info .log-type { color: #17a2b8; }
.log-success .log-type { color: #28a745; }
.log-error .log-type { color: #dc3545; }
.log-warning .log-type { color: #ffc107; }

.log-message {
  color: #e0e0e0;
}

.font-monospace {
  font-family: monospace;
}

.img-thumbnail {
  max-width: 80px;
  max-height: 80px;
  object-fit: cover;
}
</style>
