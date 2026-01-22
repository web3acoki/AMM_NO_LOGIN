<template>
  <div>
    <div class="mb-2 fw-semibold">钱包管理</div>
    <div class="d-flex flex-wrap gap-2 mb-2">
      <button v-if="!connectedAddress" class="btn btn-primary btn-sm" @click="openWalletModal">
        <i class="bi bi-wallet2 me-1"></i>连接浏览器钱包
      </button>
      <button v-else class="btn btn-outline-danger btn-sm" @click="disconnectWallet">
        <i class="bi bi-x-circle me-1"></i>断开钱包
      </button>
      <button
        class="btn btn-outline-success btn-sm"
        @click="openBatchTransferModal"
        :disabled="!localWallets || localWallets.length === 0"
        :title="localWallets && localWallets.length > 0 ? '批量转账到所有钱包' : '请先生成刷单钱包'"
        style="pointer-events: auto;"
      >
        <i class="bi bi-arrow-right-circle me-1"></i>{{ currentGovernanceToken }} 批量转账
        <small v-if="localWallets" class="ms-1">({{ localWallets.length }}个)</small>
      </button>
      
      <!-- 测试功能已隐藏，保留核心功能 -->
      
      <!-- 调试功能 - 仅在开发环境显示 -->
      <button v-if="showDebugTools" class="btn btn-outline-warning btn-sm" @click="fixWalletData" :disabled="!localWallets || localWallets.length === 0">
        <i class="bi bi-tools me-1"></i>修复数据
      </button>
      <button v-if="showDebugTools" class="btn btn-outline-info btn-sm" @click="testContractConnection">
        <i class="bi bi-link-45deg me-1"></i>测试合约连接
      </button>
      
      <!-- 扩展冲突提示 -->
      <div v-if="showExtensionConflictWarning" class="alert alert-warning alert-dismissible fade show mt-2" role="alert">
        <i class="bi bi-exclamation-triangle me-2"></i>
        <strong>检测到钱包扩展冲突！</strong><br>
        如果连接钱包失败，请尝试：
        <ul class="mb-0 mt-1">
          <li>刷新页面</li>
          <li>暂时禁用其他钱包扩展</li>
          <li>使用无痕模式</li>
        </ul>
        <button type="button" class="btn-close" @click="hideExtensionConflictWarning"></button>
      </div>
    </div>

    <div class="small text-muted">
      当前连接：<span class="text-body">{{ connectedAddress || '未连接' }}</span>
      <span v-if="connectedAddress" class="text-success ms-2">
        <i class="bi bi-check-circle me-1"></i>已连接 ({{ connectedWalletType }})
      </span>
    </div>

    <!-- 钱包选择 Modal -->
    <div class="modal fade" id="walletModal" tabindex="-1" aria-labelledby="walletModalLabel" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="walletModalLabel">
              选择钱包 - {{ selectedChainName }}
              <small class="text-muted d-block">{{ currentGovernanceToken }} 网络</small>
            </h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <!-- 调试信息 -->
            <div class="alert alert-info small mb-3" v-if="showDebugInfo">
              <strong>检测到的钱包：</strong><br>
              <div v-for="wallet in availableWallets" :key="wallet.name" class="d-flex justify-content-between">
                <span>{{ wallet.name }}:</span>
                <span class="text-success">✓</span>
              </div>
              <div v-if="availableWallets.length === 0" class="text-muted">未检测到任何钱包</div>
              <div v-if="walletConflict" class="alert alert-warning mt-2 small">
                <strong>⚠️ 钱包冲突检测：</strong><br>
                检测到多个钱包同时存在，可能导致连接问题。<br>
                建议暂时禁用其中一个钱包扩展。
              </div>
              <button class="btn btn-sm btn-outline-secondary mt-2" @click="toggleDebugInfo">隐藏调试信息</button>
            </div>
            <div class="text-center mb-3" v-if="!showDebugInfo">
              <button class="btn btn-sm btn-outline-info" @click="toggleDebugInfo">显示钱包检测状态</button>
              <button class="btn btn-sm btn-outline-secondary ms-2" @click="toggleDebugTools">
                {{ showDebugTools ? '隐藏' : '显示' }}调试工具
              </button>
            </div>
            
            <!-- 钱包冲突警告 -->
            <div class="alert alert-warning small mb-3" v-if="walletConflict && !showDebugInfo">
              <i class="bi bi-exclamation-triangle me-1"></i>
              <strong>检测到多个钱包扩展</strong>，可能导致连接问题。
              <div class="mt-2">
                <button class="btn btn-sm btn-outline-warning me-2" @click="refreshPage">
                  <i class="bi bi-arrow-clockwise me-1"></i>刷新页面
                </button>
                <small class="text-muted">或暂时禁用其中一个钱包扩展</small>
              </div>
            </div>
            
            <!-- 网络信息提示 -->
            <div class="alert alert-primary small mb-3">
              <i class="bi bi-info-circle me-1"></i>
              <strong>当前网络：</strong>{{ selectedChainName }} ({{ selectedChainId }})<br>
              <strong>治理代币：</strong>{{ currentGovernanceToken }}<br>
              <small class="text-muted">请确保您的钱包已切换到正确的网络</small>
            </div>

            <div class="d-grid gap-3">
              <!-- 动态显示检测到的钱包 -->
              <div v-for="wallet in availableWallets" :key="wallet.name" class="wallet-option" @click="connectWallet(wallet.name.toLowerCase().replace(' ', ''))">
                <div class="d-flex align-items-center p-3 border rounded-3 hover-shadow">
                  <div class="wallet-icon me-3">
                    <img :src="getWalletIcon(wallet.name)" :alt="wallet.name" width="40" height="40">
                  </div>
                  <div class="flex-grow-1">
                    <h6 class="mb-1 fw-semibold">{{ wallet.name }}</h6>
                    <small class="text-muted">连接到 {{ selectedChainName }} 网络</small>
                  </div>
                  <i class="bi bi-chevron-right text-muted"></i>
                </div>
              </div>
              
              <!-- 如果没有检测到钱包 -->
              <div v-if="availableWallets.length === 0" class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning fs-1"></i>
                <h6 class="mt-2">未检测到任何钱包</h6>
                <small class="text-muted">请安装 MetaMask 或 OKX Wallet 扩展</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 批量转账 Modal -->
    <div class="modal fade" id="batchTransferModal" tabindex="-1" aria-labelledby="batchTransferModalLabel" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="batchTransferModalLabel">输入向每个刷单钱包转账的{{ currentGovernanceToken }}数量</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">转账数量</label>
              <input 
                type="number" 
                step="0.000001" 
                min="0" 
                class="form-control" 
                v-model.number="transferAmount" 
                :placeholder="`请输入每个钱包的${currentGovernanceToken}数量`"
              />
            </div>
            <div class="alert alert-info small">
              <i class="bi bi-info-circle me-1"></i>
              将向 <strong>{{ localWallets.length }}</strong> 个刷单钱包各转账 <strong>{{ transferAmount || 0 }}</strong> {{ currentGovernanceToken }}
            </div>
            <div class="alert alert-warning small">
              <i class="bi bi-exclamation-triangle me-1"></i>
              <strong>批量转账说明：</strong><br>
              • 优先尝试合约批量转账（一次授权）<br>
              • 如果合约不可用，将使用连续转账模式<br>
              • 连续转账需要为每笔交易单独授权<br>
              • 总金额：{{ (transferAmount || 0) * (localWallets?.length || 0) }} {{ currentGovernanceToken }}
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-danger" data-bs-dismiss="modal">取消</button>
            <button type="button" class="btn btn-primary" @click="confirmBatchTransfer" :disabled="!transferAmount || transferAmount <= 0">
              确定转账
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';
import { storeToRefs } from 'pinia';
import { formatEther, parseEther } from 'viem';

const walletStore = useWalletStore();
const chainStore = useChainStore();
const { connectedAddress, connectedWalletType, localWallets } = storeToRefs(walletStore);
const { currentGovernanceToken, selectedChainId, chains } = storeToRefs(chainStore);

// 计算当前选择的链信息
const selectedChainName = computed(() => {
  const chain = chains.value.find(c => c.id === selectedChainId.value);
  return chain?.name || '未知网络';
});

const generateCount = ref<number>(5);
const generateWalletType = ref<'main' | 'normal'>('normal');
const generateRemark = ref<string>('');
const transferAmount = ref<number>(0);
let modal: any = null;
let walletModal: any = null;
let batchTransferModal: any = null;

// 调试信息
const showDebugInfo = ref<boolean>(false);
const showDebugTools = ref<boolean>(false); // 默认隐藏调试工具
const availableWallets = ref<any[]>([]);
const walletConflict = ref<boolean>(false);
const showExtensionConflictWarning = ref<boolean>(false);

function toggleDebugInfo() {
  showDebugInfo.value = !showDebugInfo.value;
  if (showDebugInfo.value) {
    checkWalletAvailability();
  }
}

function toggleDebugTools() {
  showDebugTools.value = !showDebugTools.value;
}

function hideExtensionConflictWarning() {
  showExtensionConflictWarning.value = false;
}

function checkWalletAvailability() {
  console.log('检测钱包可用性...');
  
  // 使用钱包检测器
  const detector = walletStore.walletDetector;
  availableWallets.value = detector.getAvailableWallets();
  walletConflict.value = detector.hasWalletConflict();
  
  console.log('检测到的钱包:', availableWallets.value);
  console.log('钱包冲突:', walletConflict.value);
  
  if (walletConflict.value) {
    console.warn('检测到钱包冲突:', detector.getWalletConflictInfo());
  }
}

function refreshPage() {
  window.location.reload();
}

function getWalletIcon(walletName: string): string {
  const icons: { [key: string]: string } = {
    'MetaMask': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iI0Y2ODU0NyIvPgo8cGF0aCBkPSJNMjAgMTJMMjYgMjBMMjAgMjhMMTQgMjBMMjAgMTJaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4K',
    'OKX Wallet': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzAwMDAwMCIvPgo8cmVjdCB4PSI4IiB5PSI4IiB3aWR0aD0iNiIgaGVpZ2h0PSI2IiBmaWxsPSJ3aGl0ZSIvPgo8cmVjdCB4PSIyNiIgeT0iOCIgd2lkdGg9IjYiIGhlaWdodD0iNiIgZmlsbD0id2hpdGUiLz4KPHJlY3QgeD0iOCIgeT0iMjYiIHdpZHRoPSI2IiBoZWlnaHQ9IjYiIGZpbGw9IndoaXRlIi8+CjxyZWN0IHg9IjI2IiB5PSIyNiIgd2lkdGg9IjYiIGhlaWdodD0iNiIgZmlsbD0id2hpdGUiLz4KPHJlY3QgeD0iMTciIHk9IjE3IiB3aWR0aD0iNiIgaGVpZ2h0PSI2IiBmaWxsPSJibGFjayIvPgo8L3N2Zz4K',
    'Coinbase Wallet': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzAwNTJGRiIvPgo8Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxNiIgZmlsbD0id2hpdGUiLz4KPGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iOCIgZmlsbD0iIzAwNTJGRiIvPgo8L3N2Zz4K',
    'Trust Wallet': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzAwN0JGRiIvPgo8Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxNiIgZmlsbD0id2hpdGUiLz4KPGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iOCIgZmlsbD0iIzAwN0JGRiIvPgo8L3N2Zz4K'
  };
  
  return icons[walletName] || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzZDNzI4MCIvPgo8Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxNiIgZmlsbD0id2hpdGUiLz4KPGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iOCIgZmlsbD0iIzZDNzI4MCIvPgo8L3N2Zz4K';
}

function openGenerateModal() {
  const el = document.getElementById('genModal');
  if (!el) {
    console.error('找不到genModal元素');
    return;
  }
  
  if (modal) {
    modal.show();
  } else {
    console.error('generateModal未初始化');
    // 尝试重新初始化
    try {
      const Bootstrap = (window as any).bootstrap;
      modal = new Bootstrap.Modal(el, {
        backdrop: true,
        keyboard: true,
        focus: true
      });
      modal.show();
    } catch (error) {
      console.error('重新初始化Modal失败:', error);
      alert('Modal初始化失败，请刷新页面重试');
    }
  }
}

function openWalletModal() {
  const el = document.getElementById('walletModal');
  if (!el) {
    console.error('找不到walletModal元素');
    return;
  }
  
  if (walletModal) {
    walletModal.show();
  } else {
    console.error('walletModal未初始化');
    // 尝试重新初始化
    try {
      const Bootstrap = (window as any).bootstrap;
      walletModal = new Bootstrap.Modal(el, {
        backdrop: true,
        keyboard: true,
        focus: true
      });
      walletModal.show();
    } catch (error) {
      console.error('重新初始化walletModal失败:', error);
      alert('Modal初始化失败，请刷新页面重试');
    }
  }
}

async function connectWallet(walletName: string) {
  // 将钱包名称转换为 ID
  const walletId = walletName.toLowerCase().replace(' ', '');
  
  // 如果检测到钱包冲突，显示警告
  if (walletConflict.value) {
    const confirm = window.confirm(
      `检测到多个钱包扩展同时存在，这可能导致连接问题。\n\n` +
      `您确定要连接 ${walletName} 吗？\n\n` +
      `建议：\n` +
      `1. 暂时禁用另一个钱包扩展\n` +
      `2. 或者刷新页面后重试\n\n` +
      `点击"确定"继续连接，点击"取消"返回选择。`
    );
    
    if (!confirm) {
      return;
    }
  }
  
  try {
    // 先连接钱包
    await walletStore.connectWallet(walletId as any);
    
    // 连接成功后，尝试切换网络
    await switchToSelectedNetwork();
    
    if (walletModal) {
      walletModal.hide();
    }
  } catch (error: any) {
    console.error('连接钱包失败:', error);
    
    // 检查是否是扩展冲突错误
    if (error.message?.includes('扩展冲突') || 
        error.message?.includes('message channel closed') ||
        error.message?.includes('chrome-extension')) {
      showExtensionConflictWarning.value = true;
    }
    
    // 显示错误信息
    alert(`连接钱包失败：${error.message || '未知错误'}`);
  }
}

// 切换到选择的网络
async function switchToSelectedNetwork() {
  try {
    const chainId = selectedChainId.value;
    const chainName = selectedChainName.value;
    
    // 网络配置
    const networkConfigs: { [key: number]: any } = {
      56: { // BSC Mainnet
        chainId: '0x38',
        chainName: 'BSC Mainnet',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: ['https://bsc-dataseed.binance.org'],
        blockExplorerUrls: ['https://bscscan.com']
      },
      97: { // BSC Testnet
        chainId: '0x61',
        chainName: 'BSC Testnet',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: ['https://bsc-testnet.publicnode.com'],
        blockExplorerUrls: ['https://testnet.bscscan.com']
      },
      66: { // OKX Chain
        chainId: '0x42',
        chainName: 'OKX Chain',
        nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
        rpcUrls: ['https://exchainrpc.okex.org'],
        blockExplorerUrls: ['https://www.oklink.com/okc']
      }
    };
    
    const config = networkConfigs[chainId];
    if (!config) {
      console.warn(`未找到链ID ${chainId} 的网络配置`);
      return;
    }
    
    // 检查当前网络
    const currentChainId = await (window as any).ethereum.request({ method: 'eth_chainId' });
    if (currentChainId === config.chainId) {
      console.log(`钱包已在 ${chainName} 网络`);
      return;
    }
    
    // 尝试切换网络
    try {
      await (window as any).ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: config.chainId }],
      });
      console.log(`成功切换到 ${chainName} 网络`);
    } catch (switchError: any) {
      // 如果网络不存在，尝试添加网络
      if (switchError.code === 4902) {
        try {
          await (window as any).ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [config],
          });
          console.log(`成功添加并切换到 ${chainName} 网络`);
        } catch (addError) {
          console.error(`添加 ${chainName} 网络失败:`, addError);
          alert(`请手动添加 ${chainName} 网络到您的钱包`);
        }
      } else {
        console.error(`切换网络失败:`, switchError);
        alert(`请手动切换到 ${chainName} 网络`);
      }
    }
  } catch (error) {
    console.error('网络切换失败:', error);
    // 不阻止钱包连接，只是警告用户
    alert(`钱包连接成功，但请确保已切换到 ${selectedChainName.value} 网络`);
  }
}

async function generateWallets() {
  const countBefore = localWallets.value?.length || 0;

  await walletStore.generateLocalWallets(generateCount.value, {
    walletType: generateWalletType.value,
    remark: generateRemark.value
  });

  // 获取新生成的钱包
  const newWallets = localWallets.value?.slice(countBefore) || [];

  // 自动下载Excel
  if (newWallets.length > 0) {
    downloadWalletsExcel(newWallets);
  }

  // 重置表单
  generateWalletType.value = 'normal';
  generateRemark.value = '';

  modal?.hide();
}

// 下载钱包信息为Excel文件
function downloadWalletsExcel(wallets: any[]) {
  // 生成CSV内容（Excel兼容）
  const BOM = '\uFEFF'; // UTF-8 BOM for Excel compatibility
  const headers = ['序号', '钱包地址', '私钥', '备注', '钱包类型', '创建时间'];

  const rows = wallets.map((wallet, index) => {
    return [
      index + 1,
      wallet.address,
      wallet.encrypted || '', // 私钥
      wallet.remark || '',
      wallet.walletType === 'main' ? '主钱包' : '普通钱包',
      wallet.createdAt ? new Date(wallet.createdAt).toLocaleString() : ''
    ].map(cell => {
      // 处理CSV特殊字符
      const str = String(cell);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',');
  });

  const csvContent = BOM + [headers.join(','), ...rows].join('\n');

  // 创建Blob并下载
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;

  // 生成文件名
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  link.download = `钱包信息_${timestamp}.csv`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  console.log(`已下载 ${wallets.length} 个钱包信息到Excel文件`);
}


async function exportPrivateKeys() {
  // 确认对话框
  const confirm = window.confirm(
    '⚠️ 安全警告 ⚠️\n\n' +
    '您即将导出所有本地钱包的私钥信息。\n\n' +
    '私钥是访问钱包资产的唯一凭证，请务必：\n' +
    '• 妥善保管导出的文件\n' +
    '• 不要将私钥泄露给任何人\n' +
    '• 不要在网络上传输私钥文件\n' +
    '• 建议使用加密存储\n\n' +
    '确定要继续导出吗？'
  );
  
  if (!confirm) {
    return;
  }

  try {
    // 检查方法是否存在
    if (typeof walletStore.exportPrivateKeys !== 'function') {
      console.error('exportPrivateKeys 方法不存在');
      alert('导出功能暂不可用，请检查代码');
      return;
    }
    
    await walletStore.exportPrivateKeys();
  } catch (error) {
    console.error('导出私钥失败:', error);
    alert('导出私钥失败，请重试');
  }
}

async function fixWalletData() {
  const confirm = window.confirm(
    '🔧 修复钱包数据\n\n' +
    '此功能将检查所有钱包的私钥和地址是否匹配，\n' +
    '并自动修复不匹配的数据。\n\n' +
    '修复过程会：\n' +
    '• 验证每个钱包的私钥和地址\n' +
    '• 使用私钥重新计算正确的地址\n' +
    '• 移除无效的钱包数据\n\n' +
    '确定要开始修复吗？'
  );
  
  if (!confirm) {
    return;
  }

  try {
    await walletStore.fixWalletData();
    alert('钱包数据修复完成！请查看控制台了解详细信息。');
  } catch (error) {
    console.error('修复钱包数据失败:', error);
    alert('修复失败，请重试');
  }
}

function testBatchTransfer() {
  console.log('测试按钮被点击');
  console.log('localWallets:', localWallets.value);
  console.log('localWallets.length:', localWallets.value?.length);
  console.log('batchTransferModal:', batchTransferModal);
  alert('测试按钮被点击！请查看控制台输出');
}

async function checkWalletStatus() {
  console.log('检查钱包状态...');
  
  const status = {
    connectedAddress: walletStore.connectedAddress,
    localWalletsCount: walletStore.localWallets.length,
    currentChain: chainStore.selectedChainId,
    governanceToken: chainStore.currentGovernanceToken
  };
  
  console.log('钱包状态:', status);
  
  if (walletStore.connectedAddress) {
    try {
      // 使用当前选择的链ID创建publicClient
      const publicClient = walletStore.getPublicClient();
      const balance = await publicClient.getBalance({ 
        address: walletStore.connectedAddress as `0x${string}` 
      });
      
      const balanceFormatted = formatEther(balance);
      const currentToken = chainStore.currentGovernanceToken;
      const currentChainName = selectedChainName.value;
      console.log(`当前余额: ${balanceFormatted} ${currentToken} (${currentChainName})`);
      
      alert(`钱包状态检查：\n\n连接地址: ${walletStore.connectedAddress}\n当前余额: ${balanceFormatted} ${currentToken}\n本地钱包数量: ${walletStore.localWallets.length}\n当前网络: ${currentChainName} (${chainStore.selectedChainId})\n治理代币: ${currentToken}`);
    } catch (error) {
      console.error('获取余额失败:', error);
      const currentToken = chainStore.currentGovernanceToken;
      const currentChainName = selectedChainName.value;
      alert(`钱包状态检查：\n\n连接地址: ${walletStore.connectedAddress}\n余额获取失败: ${error}\n本地钱包数量: ${walletStore.localWallets.length}\n当前网络: ${currentChainName} (${chainStore.selectedChainId})\n治理代币: ${currentToken}`);
    }
  } else {
    const currentToken = chainStore.currentGovernanceToken;
    const currentChainName = selectedChainName.value;
    alert(`钱包状态检查：\n\n未连接钱包\n本地钱包数量: ${walletStore.localWallets.length}\n当前网络: ${currentChainName} (${chainStore.selectedChainId})\n治理代币: ${currentToken}`);
  }
}

async function testWalletConnection() {
  console.log('测试钱包连接...');
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    console.log('ethereum provider:', ethereum);
    console.log('ethereum.isMetaMask:', ethereum.isMetaMask);
    console.log('ethereum.isOkxWallet:', ethereum.isOkxWallet);
    
    // 测试获取账户
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    console.log('当前账户:', accounts);
    
    // 测试获取网络
    const chainId = await ethereum.request({ method: 'eth_chainId' });
    console.log('当前链ID:', chainId);
    
    // 测试获取余额
    if (accounts && accounts.length > 0) {
      const balance = await ethereum.request({
        method: 'eth_getBalance',
        params: [accounts[0], 'latest']
      });
      console.log('当前余额:', balance);
    }
    
    alert(`钱包连接测试成功！\n\n账户数量: ${accounts?.length || 0}\n链ID: ${chainId}\n余额: ${accounts?.length ? '已获取' : '无账户'}`);
    
  } catch (error: any) {
    console.error('钱包连接测试失败:', error);
    
    const errorDetails = [
      `错误类型: ${error.name || 'Unknown'}`,
      `错误代码: ${error.code || 'N/A'}`,
      `错误信息: ${error.message || '未知错误'}`,
      `完整错误: ${JSON.stringify(error, null, 2)}`
    ].join('\n');
    
    alert(`钱包连接测试失败：\n\n${errorDetails}`);
  }
}

async function checkBalance() {
  console.log('检查钱包余额...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    console.log('=== 余额检查调试信息 ===');
    console.log('钱包地址:', walletStore.connectedAddress);
    
    // 检查当前网络
    const chainId = await ethereum.request({ method: 'eth_chainId' });
    console.log('当前链ID:', chainId);
    console.log('期望链ID:', chainStore.selectedChainId);
    
    // 检查余额
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [walletStore.connectedAddress, 'latest']
    });
    
    const balanceWei = BigInt(balance);
    const balanceEth = (balanceWei / BigInt(1e18)).toString();
    const balanceEthFormatted = (Number(balanceWei) / 1e18).toFixed(6);
    
    console.log('余额 (Wei):', balance);
    console.log('余额 (ETH):', balanceEthFormatted);
    
    // 检查是否有足够的余额进行测试转账
    const testAmount = 0.001;
    const testAmountWei = BigInt((testAmount * 1e18).toString());
    const hasEnoughBalance = balanceWei >= testAmountWei;
    
    console.log('测试转账金额 (ETH):', testAmount);
    console.log('测试转账金额 (Wei):', testAmountWei.toString());
    console.log('余额是否足够:', hasEnoughBalance);
    
    let message = `钱包余额检查：\n\n`;
    message += `钱包地址: ${walletStore.connectedAddress}\n`;
    message += `当前网络: ${chainId}\n`;
    message += `期望网络: ${chainStore.selectedChainId}\n`;
    message += `当前余额: ${balanceEthFormatted} ETH\n`;
    message += `测试金额: ${testAmount} ETH\n`;
    message += `余额状态: ${hasEnoughBalance ? '✅ 足够' : '❌ 不足'}\n\n`;
    
    if (chainId !== chainStore.selectedChainId) {
      message += `⚠️ 警告: 当前网络与选择的不匹配！\n`;
      message += `请切换到正确的网络后再试。`;
    } else if (!hasEnoughBalance) {
      message += `💡 建议: 请向钱包充值至少 ${testAmount} ETH 进行测试。`;
    } else {
      message += `✅ 钱包状态正常，可以进行转账测试。`;
    }
    
    alert(message);
    
  } catch (error: any) {
    console.error('余额检查失败:', error);
    
    const errorDetails = [
      `错误类型: ${error.name || 'Unknown'}`,
      `错误代码: ${error.code || 'N/A'}`,
      `错误信息: ${error.message || '未知错误'}`,
      `完整错误: ${JSON.stringify(error, null, 2)}`
    ].join('\n');
    
    alert(`余额检查失败：\n\n${errorDetails}`);
  }
}

async function diagnoseWallet() {
  console.log('开始诊断钱包...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    console.log('=== 钱包诊断报告 ===');
    
    // 0. 检查应用配置
    console.log('0. 应用配置:');
    console.log('  - 当前选择的链ID:', chainStore.selectedChainId);
    console.log('  - 链配置:', chainStore.chains);
    
    // 1. 检查钱包基本信息
    console.log('1. 钱包基本信息:');
    console.log('  - 钱包地址:', walletStore.connectedAddress);
    console.log('  - Provider类型:', ethereum.isMetaMask ? 'MetaMask' : ethereum.isOkxWallet ? 'OKX Wallet' : 'Unknown');
    console.log('  - Provider版本:', ethereum.version || 'Unknown');
    
    // 2. 检查网络信息
    console.log('2. 网络信息:');
    const chainId = await ethereum.request({ method: 'eth_chainId' });
    const expectedChainId = chainStore.selectedChainId;
    const currentChainIdDecimal = parseInt(chainId, 16);
    // expectedChainId 已经是数字，不需要转换
    const expectedChainIdDecimal = expectedChainId;
    console.log('  - 当前链ID (Hex):', chainId);
    console.log('  - 当前链ID (Decimal):', currentChainIdDecimal);
    console.log('  - 期望链ID (Number):', expectedChainId);
    console.log('  - 期望链ID (Decimal):', expectedChainIdDecimal);
    console.log('  - 网络匹配:', currentChainIdDecimal === expectedChainIdDecimal ? '✅ 是' : '❌ 否');
    
    // 3. 检查账户信息
    console.log('3. 账户信息:');
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    console.log('  - 连接账户数:', accounts?.length || 0);
    console.log('  - 当前账户:', accounts?.[0] || 'None');
    console.log('  - 账户匹配:', accounts?.[0] === walletStore.connectedAddress ? '✅ 是' : '❌ 否');
    
    // 4. 检查余额
    console.log('4. 余额信息:');
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [walletStore.connectedAddress, 'latest']
    });
    const balanceWei = BigInt(balance);
    const balanceEth = (Number(balanceWei) / 1e18).toFixed(6);
    console.log('  - 余额 (Wei):', balance);
    console.log('  - 余额 (ETH):', balanceEth);
    console.log('  - 余额状态:', balanceWei > 0n ? '✅ 有余额' : '❌ 无余额');
    
    // 5. 检查Gas价格
    console.log('5. Gas信息:');
    try {
      const gasPrice = await ethereum.request({ method: 'eth_gasPrice' });
      console.log('  - Gas价格:', gasPrice);
      console.log('  - Gas价格 (Gwei):', (parseInt(gasPrice, 16) / 1e9).toFixed(2));
    } catch (e: any) {
      console.log('  - Gas价格获取失败:', e.message);
    }
    
    // 6. 检查网络切换能力
    console.log('6. 网络切换能力:');
    try {
      const result = await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: expectedChainId }]
      });
      console.log('  - 网络切换结果:', result);
    } catch (e: any) {
      console.log('  - 网络切换失败:', e.message);
      if (e.code === 4902) {
        console.log('  - 需要添加网络');
      }
    }
    
    // 7. 检查交易能力
    console.log('7. 交易能力测试:');
    try {
      // 尝试估算Gas
      const testAmount = '0x1'; // 1 wei
      const gasEstimate = await ethereum.request({
        method: 'eth_estimateGas',
        params: [{
          from: walletStore.connectedAddress,
          to: walletStore.connectedAddress, // 发送给自己
          value: testAmount
        }]
      });
      console.log('  - Gas估算成功:', gasEstimate);
    } catch (e: any) {
      console.log('  - Gas估算失败:', e.message);
    }
    
    // 生成诊断报告
    let report = `钱包诊断报告：\n\n`;
    report += `1. 钱包类型: ${ethereum.isMetaMask ? 'MetaMask' : ethereum.isOkxWallet ? 'OKX Wallet' : 'Unknown'}\n`;
    report += `2. 钱包地址: ${walletStore.connectedAddress}\n`;
    report += `3. 当前网络: ${chainId} (${currentChainIdDecimal})\n`;
    report += `4. 期望网络: ${expectedChainId}\n`;
    report += `5. 网络匹配: ${currentChainIdDecimal === expectedChainIdDecimal ? '✅ 是' : '❌ 否'}\n`;
    report += `6. 当前余额: ${balanceEth} ETH\n`;
    report += `7. 账户状态: ${accounts?.[0] === walletStore.connectedAddress ? '✅ 正常' : '❌ 异常'}\n\n`;
    
    if (currentChainIdDecimal !== expectedChainIdDecimal) {
      report += `⚠️ 问题: 网络不匹配！\n`;
      report += `请切换到正确的网络 (${expectedChainId}) 后再试。\n\n`;
    }
    
    if (balanceWei === 0n) {
      report += `⚠️ 问题: 余额为0！\n`;
      report += `请向钱包充值后再试。\n\n`;
    }
    
    if (accounts?.[0] !== walletStore.connectedAddress) {
      report += `⚠️ 问题: 账户不匹配！\n`;
      report += `请重新连接钱包。\n\n`;
    }
    
    if (currentChainIdDecimal === expectedChainIdDecimal && balanceWei > 0n && accounts?.[0] === walletStore.connectedAddress) {
      report += `✅ 钱包状态正常，可以进行转账测试。\n`;
      report += `如果仍然失败，可能是钱包插件的问题。`;
    }
    
    console.log('诊断报告:', report);
    alert(report);
    
  } catch (error: any) {
    console.error('钱包诊断失败:', error);
    
    const errorDetails = [
      `错误类型: ${error.name || 'Unknown'}`,
      `错误代码: ${error.code || 'N/A'}`,
      `错误信息: ${error.message || '未知错误'}`,
      `完整错误: ${JSON.stringify(error, null, 2)}`
    ].join('\n');
    
    alert(`钱包诊断失败：\n\n${errorDetails}`);
  }
}

async function switchToBscTestnet() {
  console.log('尝试切换到BSC测试网...');
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    // BSC测试网配置
    const bscTestnetConfig = {
      chainId: '0x61', // 97 in hex
      chainName: 'BSC Testnet',
      nativeCurrency: {
        name: 'BNB',
        symbol: 'BNB',
        decimals: 18,
      },
      rpcUrls: ['https://bsc-testnet.publicnode.com'],
      blockExplorerUrls: ['https://testnet.bscscan.com'],
    };
    
    console.log('BSC测试网配置:', bscTestnetConfig);
    
    try {
      // 尝试切换网络
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: bscTestnetConfig.chainId }],
      });
      
      console.log('网络切换成功');
      alert('已成功切换到BSC测试网！\n\n请重新测试转账功能。');
      
    } catch (switchError: any) {
      console.log('网络切换失败，尝试添加网络:', switchError);
      
      if (switchError.code === 4902) {
        // 网络不存在，尝试添加
        try {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [bscTestnetConfig],
          });
          
          console.log('网络添加成功');
          alert('已成功添加并切换到BSC测试网！\n\n请重新测试转账功能。');
          
        } catch (addError: any) {
          console.error('添加网络失败:', addError);
          throw new Error(`添加网络失败: ${addError.message}`);
        }
      } else {
        throw new Error(`切换网络失败: ${switchError.message}`);
      }
    }
    
  } catch (error: any) {
    console.error('切换到BSC测试网失败:', error);
    alert(`切换到BSC测试网失败：\n\n${error.message}\n\n请手动在钱包中切换到BSC测试网。`);
  }
}

async function analyzeError() {
  console.log('开始分析错误...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    console.log('=== 错误分析报告 ===');
    
    // 1. 检查钱包状态
    console.log('1. 钱包状态检查:');
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    const chainId = await ethereum.request({ method: 'eth_chainId' });
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [walletStore.connectedAddress, 'latest']
    });
    
    console.log('  - 连接账户:', accounts?.length || 0);
    console.log('  - 当前链ID:', chainId);
    console.log('  - 当前余额:', balance);
    
    // 2. 检查Gas价格
    console.log('2. Gas价格检查:');
    let gasPrice, gasLimit;
    try {
      gasPrice = await ethereum.request({ method: 'eth_gasPrice' });
      console.log('  - Gas价格:', gasPrice);
      console.log('  - Gas价格 (Gwei):', (parseInt(gasPrice, 16) / 1e9).toFixed(2));
    } catch (e: any) {
      console.log('  - Gas价格获取失败:', e.message);
      gasPrice = '0x3b9aca00'; // 1 gwei
    }
    
    // 3. 尝试Gas估算
    console.log('3. Gas估算检查:');
    try {
      gasLimit = await ethereum.request({
        method: 'eth_estimateGas',
        params: [{
          from: walletStore.connectedAddress,
          to: walletStore.connectedAddress,
          value: '0x1'
        }]
      });
      console.log('  - Gas限制:', gasLimit);
    } catch (e: any) {
      console.log('  - Gas估算失败:', e.message);
      gasLimit = '0x5208'; // 21000
    }
    
    // 4. 检查网络状态
    console.log('4. 网络状态检查:');
    try {
      const blockNumber = await ethereum.request({ method: 'eth_blockNumber' });
      console.log('  - 最新区块:', blockNumber);
      console.log('  - 网络状态: 正常');
    } catch (e: any) {
      console.log('  - 网络状态: 异常', e.message);
    }
    
    // 5. 尝试不同的交易方法
    console.log('5. 交易方法测试:');
    
    // 方法1: 最简单的交易
    try {
      console.log('  测试方法1: 最简单交易');
      const tx1 = await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletStore.connectedAddress,
          to: walletStore.connectedAddress,
          value: '0x0' // 0 wei
        }]
      });
      console.log('  方法1成功:', tx1);
    } catch (e: any) {
      console.log('  方法1失败:', e.message);
    }
    
    // 方法2: 带Gas参数的交易
    try {
      console.log('  测试方法2: 带Gas参数');
      const tx2 = await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletStore.connectedAddress,
          to: walletStore.connectedAddress,
          value: '0x0',
          gas: gasLimit,
          gasPrice: gasPrice
        }]
      });
      console.log('  方法2成功:', tx2);
    } catch (e: any) {
      console.log('  方法2失败:', e.message);
    }
    
    // 方法3: 使用sendRawTransaction
    try {
      console.log('  测试方法3: 检查sendRawTransaction支持');
      const methods = await ethereum.request({ method: 'rpc_methods' });
      console.log('  支持的RPC方法:', methods);
    } catch (e: any) {
      console.log('  无法获取RPC方法列表:', e.message);
    }
    
    // 6. 检查钱包插件问题
    console.log('6. 钱包插件检查:');
    console.log('  - Provider类型:', ethereum.isMetaMask ? 'MetaMask' : ethereum.isOkxWallet ? 'OKX Wallet' : 'Unknown');
    console.log('  - Provider版本:', ethereum.version || 'Unknown');
    console.log('  - 是否有sendTransaction方法:', typeof ethereum.request === 'function');
    
    // 生成分析报告
    let report = `错误分析报告：\n\n`;
    report += `1. 钱包状态: ${accounts?.length ? '✅ 已连接' : '❌ 未连接'}\n`;
    report += `2. 网络状态: ${chainId} (${parseInt(chainId, 16)})\n`;
    report += `3. 余额状态: ${balance} Wei\n`;
    report += `4. Gas价格: ${gasPrice}\n`;
    report += `5. Gas限制: ${gasLimit}\n`;
    report += `6. 钱包类型: ${ethereum.isMetaMask ? 'MetaMask' : ethereum.isOkxWallet ? 'OKX Wallet' : 'Unknown'}\n\n`;
    
    // 分析可能的问题
    const balanceWei = BigInt(balance);
    const gasPriceWei = BigInt(gasPrice);
    const gasLimitWei = BigInt(gasLimit);
    const totalCost = gasPriceWei * gasLimitWei;
    
    if (balanceWei < totalCost) {
      report += `⚠️ 问题: 余额不足以支付Gas费用！\n`;
      report += `需要: ${(Number(totalCost) / 1e18).toFixed(6)} ETH\n`;
      report += `当前: ${(Number(balanceWei) / 1e18).toFixed(6)} ETH\n\n`;
    }
    
    if (parseInt(chainId, 16) !== 97) {
      report += `⚠️ 问题: 网络不匹配！\n`;
      report += `当前: ${parseInt(chainId, 16)}, 期望: 97\n\n`;
    }
    
    if (!accounts?.length) {
      report += `⚠️ 问题: 钱包未连接！\n\n`;
    }
    
    if (balanceWei >= totalCost && parseInt(chainId, 16) === 97 && accounts?.length) {
      report += `✅ 基本条件满足，问题可能是：\n`;
      report += `1. 钱包插件内部错误\n`;
      report += `2. 网络拥堵\n`;
      report += `3. 钱包设置问题\n`;
      report += `4. 浏览器扩展冲突\n\n`;
      report += `建议：\n`;
      report += `1. 重启浏览器\n`;
      report += `2. 重新安装钱包插件\n`;
      report += `3. 尝试其他钱包\n`;
      report += `4. 检查浏览器扩展冲突`;
    }
    
    console.log('分析报告:', report);
    alert(report);
    
  } catch (error: any) {
    console.error('错误分析失败:', error);
    alert(`错误分析失败：\n\n${error.message}`);
  }
}

async function testDirectCall() {
  console.log('开始直接调用测试...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    console.log('=== 直接调用测试 ===');
    console.log('钱包地址:', walletStore.connectedAddress);
    
    // 测试1: 直接调用sendTransaction
    console.log('测试1: 直接调用sendTransaction');
    try {
      const result1 = await ethereum.sendTransaction({
        from: walletStore.connectedAddress,
        to: walletStore.connectedAddress,
        value: '0x0'
      });
      console.log('sendTransaction成功:', result1);
      alert(`直接调用成功！\n交易哈希: ${result1}\n\n这证明钱包基本功能正常！`);
      return;
    } catch (e: any) {
      console.log('sendTransaction失败:', e.message);
    }
    
    // 测试2: 使用request方法
    console.log('测试2: 使用request方法');
    try {
      const result2 = await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletStore.connectedAddress,
          to: walletStore.connectedAddress,
          value: '0x0'
        }]
      });
      console.log('request成功:', result2);
      alert(`request方法成功！\n交易哈希: ${result2}\n\n这证明钱包基本功能正常！`);
      return;
    } catch (e: any) {
      console.log('request失败:', e.message);
    }
    
    // 测试3: 检查是否有其他方法
    console.log('测试3: 检查可用方法');
    console.log('ethereum对象:', ethereum);
    console.log('可用方法:', Object.getOwnPropertyNames(ethereum));
    console.log('是否有sendTransaction:', 'sendTransaction' in ethereum);
    console.log('是否有request:', 'request' in ethereum);
    
    // 测试4: 尝试使用不同的参数格式
    console.log('测试4: 尝试不同参数格式');
    try {
      const result4 = await ethereum.request({
        method: 'eth_sendTransaction',
        params: {
          from: walletStore.connectedAddress,
          to: walletStore.connectedAddress,
          value: '0x0'
        }
      });
      console.log('不同参数格式成功:', result4);
      alert(`不同参数格式成功！\n交易哈希: ${result4}\n\n这证明钱包基本功能正常！`);
      return;
    } catch (e: any) {
      console.log('不同参数格式失败:', e.message);
    }
    
    // 测试5: 尝试使用sendAsync
    console.log('测试5: 尝试sendAsync');
    if (ethereum.sendAsync) {
      try {
        const result5 = await new Promise((resolve, reject) => {
          ethereum.sendAsync({
            method: 'eth_sendTransaction',
            params: [{
              from: walletStore.connectedAddress,
              to: walletStore.connectedAddress,
              value: '0x0'
            }]
          }, (err: any, result: any) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        console.log('sendAsync成功:', result5);
        alert(`sendAsync成功！\n结果: ${JSON.stringify(result5)}\n\n这证明钱包基本功能正常！`);
        return;
      } catch (e: any) {
        console.log('sendAsync失败:', e.message);
      }
    }
    
    // 如果所有方法都失败
    console.log('所有直接调用方法都失败了');
    alert(`所有直接调用方法都失败了。\n\n可能的原因：\n1. 钱包插件内部错误\n2. 浏览器扩展冲突\n3. 网络问题\n\n建议：\n1. 重启浏览器\n2. 重新安装MetaMask\n3. 尝试其他钱包`);
    
  } catch (error: any) {
    console.error('直接调用测试失败:', error);
    alert(`直接调用测试失败：\n\n${error.message}`);
  }
}

async function testSelfTransfer() {
  console.log('开始自转账测试...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    console.log('=== 自转账测试 ===');
    console.log('发送方:', walletStore.connectedAddress);
    console.log('接收方:', walletStore.connectedAddress);
    console.log('金额: 1 wei (最小单位)');
    
    // 发送 1 wei 给自己
    const amountHex = '0x1'; // 1 wei
    
    console.log('交易参数:', {
      from: walletStore.connectedAddress,
      to: walletStore.connectedAddress,
      value: amountHex
    });
    
    // 先检查余额
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [walletStore.connectedAddress, 'latest']
    });
    
    const balanceWei = BigInt(balance);
    console.log('当前余额 (Wei):', balance);
    console.log('当前余额 (ETH):', (Number(balanceWei) / 1e18).toFixed(6));
    
    if (balanceWei < 1n) {
      throw new Error('余额不足，至少需要 1 wei');
    }
    
    console.log('发送自转账交易...');
    
    const txHash = await ethereum.request({
      method: 'eth_sendTransaction',
      params: [{
        from: walletStore.connectedAddress,
        to: walletStore.connectedAddress,
        value: amountHex
      }]
    });
    
    console.log('自转账成功:', txHash);
    alert(`自转账成功！\n交易哈希: ${txHash}\n\n这证明钱包基本功能正常！`);
    
  } catch (error: any) {
    console.error('自转账失败:', error);
    
    let errorMessage = '未知错误';
    if (error.code === 4001) {
      errorMessage = '用户拒绝了交易';
    } else if (error.code === -32002) {
      errorMessage = '交易请求已在进行中';
    } else if (error.code === -32603) {
      errorMessage = '交易执行失败 - 可能是Gas费用不足、余额不足或网络问题';
    } else if (error.message?.includes('insufficient funds')) {
      errorMessage = '余额不足';
    } else if (error.message?.includes('gas')) {
      errorMessage = 'Gas费用不足';
    } else if (error.message?.includes('network')) {
      errorMessage = '网络错误';
    } else if (error.message?.includes('Transaction failed')) {
      errorMessage = '交易失败 - 请检查余额和Gas费用';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    console.error('详细错误信息:', {
      code: error.code,
      message: error.message,
      data: error.data,
      stack: error.stack,
      name: error.name
    });
    
    alert(`自转账失败：\n\n错误代码: ${error.code || 'N/A'}\n错误信息: ${errorMessage}\n\n请查看控制台获取详细信息`);
  }
}

async function minimalTransfer() {
  console.log('开始最小转账测试...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  if (!localWallets.value || localWallets.value.length === 0) {
    alert('请先生成一些本地钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    const testWallet = localWallets.value[0];
    const amount = 0.0001; // 更小的测试金额
    
    console.log('=== 最小转账测试 ===');
    console.log('发送方:', walletStore.connectedAddress);
    console.log('接收方:', testWallet.address);
    console.log('金额:', amount, 'ETH');
    
    // 使用最小的转账金额
    const amountWei = (amount * 1e18).toString();
    const amountHex = `0x${BigInt(amountWei).toString(16)}`;
    
    console.log('金额 (Wei):', amountWei);
    console.log('金额 (Hex):', amountHex);
    
    // 检查余额
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [walletStore.connectedAddress, 'latest']
    });
    
    const balanceWei = BigInt(balance);
    const amountWeiBigInt = BigInt(amountWei);
    
    console.log('当前余额 (Wei):', balance);
    console.log('当前余额 (ETH):', (balanceWei / BigInt(1e18)).toString());
    
    if (balanceWei < amountWeiBigInt) {
      throw new Error(`余额不足！当前余额: ${(balanceWei / BigInt(1e18)).toString()} ETH，需要: ${amount} ETH`);
    }
    
    // 使用最简单的参数，不设置任何Gas相关参数
    console.log('发送交易（无Gas参数）...');
    
    const txHash = await ethereum.request({
      method: 'eth_sendTransaction',
      params: [{
        from: walletStore.connectedAddress,
        to: testWallet.address,
        value: amountHex
      }]
    });
    
    console.log('最小转账成功:', txHash);
    alert(`最小转账成功！\n交易哈希: ${txHash}\n\n请检查钱包是否弹出了授权窗口`);
    
  } catch (error: any) {
    console.error('最小转账失败:', error);
    
    let errorMessage = '未知错误';
    if (error.code === 4001) {
      errorMessage = '用户拒绝了交易';
    } else if (error.code === -32002) {
      errorMessage = '交易请求已在进行中';
    } else if (error.code === -32603) {
      errorMessage = '交易执行失败 - 可能是Gas费用不足、余额不足或网络问题';
    } else if (error.message?.includes('insufficient funds')) {
      errorMessage = '余额不足';
    } else if (error.message?.includes('gas')) {
      errorMessage = 'Gas费用不足';
    } else if (error.message?.includes('network')) {
      errorMessage = '网络错误';
    } else if (error.message?.includes('Transaction failed')) {
      errorMessage = '交易失败 - 请检查余额和Gas费用';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    console.error('详细错误信息:', {
      code: error.code,
      message: error.message,
      data: error.data,
      stack: error.stack,
      name: error.name
    });
    
    alert(`最小转账失败：\n\n错误代码: ${error.code || 'N/A'}\n错误信息: ${errorMessage}\n\n请查看控制台获取详细信息`);
  }
}

async function simpleTransfer() {
  console.log('开始简单转账测试...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  if (!localWallets.value || localWallets.value.length === 0) {
    alert('请先生成一些本地钱包');
    return;
  }
  
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    const testWallet = localWallets.value[0];
    const amount = 0.001; // 测试金额
    
    // 使用最简单的转账方式，不进行Gas估算
    const amountWei = (amount * 1e18).toString();
    const amountHex = `0x${BigInt(amountWei).toString(16)}`;
    
    console.log('=== 简单转账调试信息 ===');
    console.log('发送方地址:', walletStore.connectedAddress);
    console.log('接收方地址:', testWallet.address);
    console.log('转账金额 (ETH):', amount);
    console.log('转账金额 (Wei):', amountWei);
    console.log('转账金额 (Hex):', amountHex);
    
    // 先检查余额
    console.log('检查发送方余额...');
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [walletStore.connectedAddress, 'latest']
    });
    console.log('发送方余额 (Wei):', balance);
    console.log('发送方余额 (ETH):', (parseInt(balance, 16) / 1e18).toFixed(6));
    
    // 检查网络
    console.log('检查当前网络...');
    const chainId = await ethereum.request({ method: 'eth_chainId' });
    console.log('当前链ID:', chainId);
    console.log('期望链ID:', chainStore.selectedChainId);
    
    // 检查余额是否足够
    const balanceWei = BigInt(balance);
    const amountWeiBigInt = BigInt(amountWei);
    if (balanceWei < amountWeiBigInt) {
      throw new Error(`余额不足！当前余额: ${(balanceWei / BigInt(1e18)).toString()} ETH，需要: ${amount} ETH`);
    }
    
    console.log('余额检查通过，开始发送交易...');
    
    // 先尝试获取Gas价格和限制
    console.log('尝试获取Gas信息...');
    let gasPrice, gasLimit;
    
    try {
      gasPrice = await ethereum.request({ method: 'eth_gasPrice' });
      console.log('Gas价格:', gasPrice);
    } catch (e) {
      console.log('无法获取Gas价格，使用默认值');
      gasPrice = '0x3b9aca00'; // 1 gwei
    }
    
    try {
      gasLimit = await ethereum.request({
        method: 'eth_estimateGas',
        params: [{
          from: walletStore.connectedAddress,
          to: testWallet.address,
          value: amountHex,
        }]
      });
      console.log('Gas限制:', gasLimit);
    } catch (e) {
      console.log('无法估算Gas，使用默认值');
      gasLimit = '0x5208'; // 21000
    }
    
    // 尝试不同的交易参数组合
    const transactionParams = {
      from: walletStore.connectedAddress,
      to: testWallet.address,
      value: amountHex,
      gas: gasLimit,
      gasPrice: gasPrice,
    };
    
    console.log('交易参数:', transactionParams);
    
    const txHash = await ethereum.request({
      method: 'eth_sendTransaction',
      params: [transactionParams]
    });
    
    console.log('简单转账成功:', txHash);
    alert(`简单转账成功！\n交易哈希: ${txHash}\n\n请检查钱包是否弹出了授权窗口`);
    
  } catch (error: any) {
    console.error('简单转账失败:', error);
    
    let errorMessage = '未知错误';
    if (error.code === 4001) {
      errorMessage = '用户拒绝了交易';
    } else if (error.code === -32002) {
      errorMessage = '交易请求已在进行中';
    } else if (error.code === -32603) {
      errorMessage = '交易执行失败 - 可能是Gas费用不足、余额不足或网络问题';
    } else if (error.message?.includes('insufficient funds')) {
      errorMessage = '余额不足';
    } else if (error.message?.includes('gas')) {
      errorMessage = 'Gas费用不足';
    } else if (error.message?.includes('network')) {
      errorMessage = '网络错误';
    } else if (error.message?.includes('Transaction failed')) {
      errorMessage = '交易失败 - 请检查余额和Gas费用';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    console.error('详细错误信息:', {
      code: error.code,
      message: error.message,
      data: error.data,
      stack: error.stack,
      name: error.name
    });
    
    alert(`简单转账失败：\n\n错误代码: ${error.code || 'N/A'}\n错误信息: ${errorMessage}\n\n请查看控制台获取详细信息`);
  }
}

async function debugTransfer() {
  console.log('开始调试转账...');
  
  if (!walletStore.connectedAddress) {
    alert('请先连接钱包');
    return;
  }
  
  if (!localWallets.value || localWallets.value.length === 0) {
    alert('请先生成一些本地钱包');
    return;
  }
  
  try {
    // 测试单个转账
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      throw new Error('未找到ethereum provider');
    }
    
    const testWallet = localWallets.value[0];
    const amount = 0.001; // 测试金额
    
    console.log('测试参数:', {
      testWallet: testWallet,
      amount: amount,
      amountType: typeof amount,
      amountString: amount.toString()
    });
    
    // 手动转换金额为十六进制
    const amountWei = (amount * 1e18).toString();
    const amountHex = `0x${BigInt(amountWei).toString(16)}`;
    
    console.log('金额转换:', {
      amountWei: amountWei,
      amountHex: amountHex
    });
    
    // 先估算Gas费用
    console.log('估算Gas费用...');
    console.log('估算参数:', {
      from: walletStore.connectedAddress,
      to: testWallet.address,
      value: amountHex
    });
    
    let gasEstimate;
    try {
      const gasResult = await ethereum.request({
        method: 'eth_estimateGas',
        params: [{
          from: walletStore.connectedAddress,
          to: testWallet.address,
          value: amountHex,
        }]
      });
      console.log('Gas估算原始结果:', gasResult);
      
      if (gasResult && typeof gasResult === 'string') {
        gasEstimate = gasResult;
        console.log('Gas估算成功:', gasEstimate);
      } else {
        throw new Error('Gas估算返回格式不正确');
      }
    } catch (gasError) {
      console.error('Gas估算失败:', gasError);
      // 如果Gas估算失败，使用默认值
      gasEstimate = '0x5208'; // 21000 gas
      console.log('使用默认Gas限制:', gasEstimate);
    }
    
    // 获取当前Gas价格
    let gasPrice;
    try {
      const gasPriceResult = await ethereum.request({
        method: 'eth_gasPrice'
      });
      console.log('Gas价格原始结果:', gasPriceResult);
      
      if (gasPriceResult && typeof gasPriceResult === 'string') {
        gasPrice = gasPriceResult;
        console.log('Gas价格获取成功:', gasPrice);
      } else {
        throw new Error('Gas价格返回格式不正确');
      }
    } catch (priceError) {
      console.error('Gas价格获取失败:', priceError);
      // 使用默认Gas价格
      gasPrice = '0x3b9aca00'; // 1 gwei
      console.log('使用默认Gas价格:', gasPrice);
    }
    
    // 计算总费用
    const totalCost = BigInt(gasEstimate) * BigInt(gasPrice);
    const totalCostEth = formatEther(totalCost);
    
    console.log('预估总费用:', totalCostEth, 'BNB');
    
    // 检查余额
    let balance;
    try {
      balance = await ethereum.request({
        method: 'eth_getBalance',
        params: [walletStore.connectedAddress, 'latest']
      });
      console.log('余额获取成功:', balance);
    } catch (balanceError) {
      console.error('余额获取失败:', balanceError);
      throw new Error('无法获取钱包余额，请检查钱包连接');
    }
    
    const balanceEth = formatEther(BigInt(balance));
    console.log('当前余额:', balanceEth, 'BNB');
    
    const amountWeiBigInt = BigInt(amountWei);
    if (BigInt(balance) < totalCost + amountWeiBigInt) {
      const totalNeeded = formatEther(totalCost + amountWeiBigInt);
      throw new Error(`余额不足！\n当前余额: ${balanceEth} BNB\n转账金额: ${amount} BNB\nGas费用: ${totalCostEth} BNB\n总计需要: ${totalNeeded} BNB`);
    }
    
    console.log('测试转账参数:', {
      from: walletStore.connectedAddress,
      to: testWallet.address,
      value: amountHex,
      gas: gasEstimate,
      gasPrice: gasPrice
    });
    
    const txHash = await ethereum.request({
      method: 'eth_sendTransaction',
      params: [{
        from: walletStore.connectedAddress,
        to: testWallet.address,
        value: amountHex,
        gas: gasEstimate,
        gasPrice: gasPrice
      }]
    });
    
    console.log('调试转账成功:', txHash);
    alert(`调试转账成功！\n交易哈希: ${txHash}\n\nGas费用: ${totalCostEth} BNB\n请检查钱包是否弹出了授权窗口`);
    
  } catch (error: any) {
    console.error('调试转账失败:', error);
    
    let errorMessage = '未知错误';
    if (error.code === 4001) {
      errorMessage = '用户拒绝了交易';
    } else if (error.code === -32002) {
      errorMessage = '交易请求已在进行中';
    } else if (error.code === -32603) {
      errorMessage = '交易执行失败 - 可能是Gas费用不足、余额不足或网络问题';
    } else if (error.message?.includes('insufficient funds')) {
      errorMessage = '余额不足';
    } else if (error.message?.includes('gas')) {
      errorMessage = 'Gas费用不足';
    } else if (error.message?.includes('network')) {
      errorMessage = '网络错误';
    } else if (error.message?.includes('Transaction failed')) {
      errorMessage = '交易失败 - 请检查余额和Gas费用';
    } else if (error.message) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    
    console.error('详细错误信息:', {
      code: error.code,
      message: error.message,
      data: error.data,
      stack: error.stack,
      name: error.name,
      toString: error.toString()
    });
    
    // 显示更详细的错误信息
    const errorDetails = [
      `错误类型: ${error.name || 'Unknown'}`,
      `错误代码: ${error.code || 'N/A'}`,
      `错误信息: ${errorMessage}`,
      `完整错误: ${JSON.stringify(error, null, 2)}`
    ].join('\n');
    
    alert(`调试转账失败：\n\n${errorDetails}\n\n请查看控制台获取更多信息`);
  }
}

function openBatchTransferModal() {
  console.log('点击批量转账按钮');
  console.log('localWallets:', localWallets.value);
  console.log('localWallets.length:', localWallets.value?.length);
  console.log('batchTransferModal:', batchTransferModal);
  
  if (!localWallets.value || localWallets.value.length === 0) {
    alert('请先生成刷单钱包');
    return;
  }
  
  transferAmount.value = 0;
  
  const el = document.getElementById('batchTransferModal');
  if (!el) {
    console.error('找不到batchTransferModal元素');
    alert('Modal元素未找到，请刷新页面重试');
    return;
  }
  
  if (batchTransferModal) {
    console.log('显示批量转账Modal');
    batchTransferModal.show();
  } else {
    console.error('batchTransferModal 未初始化，尝试重新初始化');
    try {
      const Bootstrap = (window as any).bootstrap;
      batchTransferModal = new Bootstrap.Modal(el, {
        backdrop: true,
        keyboard: true,
        focus: true
      });
      batchTransferModal.show();
    } catch (error) {
      console.error('重新初始化batchTransferModal失败:', error);
      alert('Modal初始化失败，请刷新页面重试');
    }
  }
}

async function confirmBatchTransfer() {
  if (!transferAmount.value || transferAmount.value <= 0) {
    alert('请输入有效的转账数量');
    return;
  }

  const confirm = window.confirm(
    `⚠️ 确认批量转账\n\n` +
    `将向 ${localWallets.value.length} 个刷单钱包各转账 ${transferAmount.value} ${currentGovernanceToken.value}\n\n` +
    `总转账数量: ${transferAmount.value * localWallets.value.length} ${currentGovernanceToken.value}\n\n` +
    `确定要继续吗？`
  );

  if (!confirm) {
    return;
  }

  try {
    // 这里调用walletStore的批量转账方法
    const results = await walletStore.batchTransferNative(transferAmount.value);
    
    // 统计成功和失败的数量
    const successCount = results.filter((r: any) => r.success).length;
    const failCount = results.filter((r: any) => !r.success).length;
    
    if (successCount > 0) {
      alert(`批量转账完成！\n成功: ${successCount} 个\n失败: ${failCount} 个\n\n已向每个钱包转账 ${transferAmount.value} ${currentGovernanceToken.value}`);
    } else {
      alert(`批量转账失败！所有 ${failCount} 个转账都失败了。\n\n请检查：\n1. 钱包余额是否足够\n2. 网络连接是否正常\n3. 钱包是否已切换到正确的网络`);
    }
    
    if (batchTransferModal) {
      batchTransferModal.hide();
    }
  } catch (error) {
    console.error('批量转账失败:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    alert(`批量转账失败：${errorMessage}\n\n请检查：\n1. 是否已连接钱包\n2. 钱包余额是否足够\n3. 网络连接是否正常`);
  }
}

async function testContractConnection() {
  console.log('开始测试合约连接...');
  
  try {
    const result = await walletStore.testContractConnection();
    
    if (result.success) {
      alert(`合约连接测试成功！\n\n合约地址: ${result.contractAddress}\n合约余额: ${result.balance} BNB\n代币类型检测: ${result.tokenType === 0 ? '原生代币' : 'ERC20代币'}\n\n${result.message}`);
    } else {
      alert(`合约连接测试失败！\n\n错误: ${result.error}\n\n${result.message}`);
    }
  } catch (error: any) {
    console.error('合约连接测试失败:', error);
    alert(`合约连接测试失败：\n\n${error.message || '未知错误'}`);
  }
}

async function disconnectWallet() {
  await walletStore.disconnectWallet();
}

// 监听网络变化
watch(selectedChainId, (newChainId, oldChainId) => {
  console.log('网络已切换:', { from: oldChainId, to: newChainId });
  console.log('当前治理代币:', chainStore.currentGovernanceToken);
  
  // 更新walletStore的当前链ID
  walletStore.setCurrentChainId(newChainId);
  
  // 如果钱包已连接，提示用户切换网络
  if (walletStore.connectedAddress) {
    console.log('检测到网络切换，钱包需要切换到新网络');
  }
});

onMounted(() => {
  walletStore.init();
  checkWalletAvailability();
  
  // 初始化当前链ID
  walletStore.setCurrentChainId(chainStore.selectedChainId);
  
  // 初始化Modal
  if (typeof window !== 'undefined' && (window as any).bootstrap) {
    try {
      const generateModalEl = document.getElementById('genModal');
      const walletModalEl = document.getElementById('walletModal');
      const batchTransferModalEl = document.getElementById('batchTransferModal');
      
      if (generateModalEl) {
        modal = new (window as any).bootstrap.Modal(generateModalEl, {
          backdrop: true,
          keyboard: true,
          focus: true
        });
      }
      
      if (walletModalEl) {
        walletModal = new (window as any).bootstrap.Modal(walletModalEl, {
          backdrop: true,
          keyboard: true,
          focus: true
        });
      }
      
      if (batchTransferModalEl) {
        batchTransferModal = new (window as any).bootstrap.Modal(batchTransferModalEl, {
          backdrop: true,
          keyboard: true,
          focus: true
        });
      }
      
      console.log('Modal初始化完成:', { modal, walletModal, batchTransferModal });
    } catch (error) {
      console.error('Modal初始化失败:', error);
    }
  }
});
</script>

<style scoped>
.hover-shadow:hover {
  box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.15) !important;
  cursor: pointer;
}

.wallet-option {
  cursor: pointer;
  transition: all 0.2s ease;
}

.wallet-option:hover .border {
  border-color: #0d6efd !important;
  box-shadow: 0 0.5rem 1rem rgba(13, 110, 253, 0.15) !important;
}

.wallet-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: #f8f9fa;
}

/* 修复按钮显示问题 */
.btn {
  white-space: nowrap;
  min-width: fit-content;
}
</style>

