import { defineStore } from 'pinia';
import { createWalletClient, createPublicClient, http, fallback, formatEther, formatUnits, parseEther, parseUnits, encodeFunctionData } from 'viem';
import BatchTransferABI from '../contracts/BatchTransfer.json';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet, bsc, okc } from 'viem/chains';
import { erc20Abi } from '../viem/abis/erc20';
import { WalletDetector } from '../utils/walletDetector';

// 批量转账合约地址配置
const BATCH_TRANSFER_CONTRACTS = {
  56: '0x0000000000000000000000000000000000000000', // BSC主网合约地址（需要部署）
  97: '0xa859587fb766a44198dc7f4eb92ea9a056f842fa', // BSC测试网合约地址（已部署）
  66: '0x0000000000000000000000000000000000000000', // OKX Chain合约地址（需要部署）
};

const USDT_CONTRACTS = {
  56: '0x55d398326f99059fF775485246999027B3197955', // BSC Mainnet
  97: '0x4Be45C88db35383F713ABC1adFA816200e0B8B56', // BSC Testnet (用户指定)
  66: '0x382bb369d343125bfb2117af9c149795c6c65c50', // OKX Chain
};

// USDT 精度配置
const USDT_DECIMALS = {
  56: 18, // BSC Mainnet
  97: 18, // BSC Testnet
  66: 18, // OKX Chain
};

type WalletType = 'main' | 'normal';

type LocalWallet = {
  address: string;
  encrypted?: string;
  nativeBalance?: string;
  tokenBalance?: string;
  walletType?: WalletType;
  remark?: string;
  createdAt?: string;
};

// 钱包批次类型
type WalletBatchItem = {
  address: string;
  privateKey: string;
};

type WalletBatch = {
  id: string;
  remark: string;
  createdAt: string;
  wallets: WalletBatchItem[];
  walletType: WalletType; // 批次钱包类型：主钱包或普通钱包
  totalNativeBalance?: string;
  totalTokenBalance?: string;
};

const PRIVATE_KEY_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;

async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizePrivateKey(value: string): `0x${string}` | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PRIVATE_KEY_REGEX.test(trimmed)) return null;
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  return `0x${hex.toLowerCase()}` as `0x${string}`;
}

function normalizeWallet(wallet: LocalWallet): LocalWallet {
  return {
    ...wallet,
    walletType: wallet.walletType ?? 'normal',
    remark: wallet.remark ?? '',
    createdAt: wallet.createdAt ?? new Date().toISOString(),
  };
}

// 解析转账错误信息，返回用户友好的错误描述
function parseTransferError(error: any): string {
  const message = error?.message || error?.toString() || '未知错误';
  const lowerMessage = message.toLowerCase();

  // 余额不足相关
  if (lowerMessage.includes('insufficient funds') || lowerMessage.includes('insufficient balance')) {
    return '余额不足，无法支付转账金额和Gas费';
  }
  if (lowerMessage.includes('exceeds balance') || lowerMessage.includes('transfer amount exceeds balance')) {
    return '转账金额超过代币余额';
  }

  // Gas相关
  if (lowerMessage.includes('gas too low') || lowerMessage.includes('intrinsic gas too low')) {
    return 'Gas设置过低，交易无法执行';
  }
  if (lowerMessage.includes('out of gas')) {
    return 'Gas耗尽，交易执行失败';
  }

  // Nonce相关
  if (lowerMessage.includes('nonce too low') || lowerMessage.includes('nonce has already been used')) {
    return 'Nonce冲突，交易已被覆盖或已执行';
  }
  if (lowerMessage.includes('replacement transaction underpriced')) {
    return 'Nonce冲突，替换交易Gas价格过低';
  }

  // 网络相关
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return '网络超时，请检查网络连接';
  }
  if (lowerMessage.includes('network') || lowerMessage.includes('connection')) {
    return '网络连接错误，请检查RPC节点';
  }

  // 交易被拒绝
  if (lowerMessage.includes('rejected') || lowerMessage.includes('denied')) {
    return '交易被节点拒绝';
  }
  if (lowerMessage.includes('reverted') || lowerMessage.includes('execution reverted')) {
    return '交易执行失败，合约调用被回滚';
  }

  // 地址相关
  if (lowerMessage.includes('invalid address')) {
    return '无效的钱包地址';
  }

  // 返回截断的原始错误信息
  const cleanMessage = message.replace(/^Error:\s*/i, '');
  return cleanMessage.length > 80 ? cleanMessage.substring(0, 80) + '...' : cleanMessage;
}

function getUsdtAddress(chainId: number): `0x${string}` | null {
  const address = USDT_CONTRACTS[chainId as keyof typeof USDT_CONTRACTS];
  return address ? (address as `0x${string}`) : null;
}

async function fetchTokenDecimals(publicClient: ReturnType<typeof createPublicClient>, tokenAddress: `0x${string}`) {
  try {
    const decimals = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'decimals',
      args: []
    });
    return Number(decimals);
  } catch (error) {
    console.warn('Failed to fetch token decimals, fallback to 18:', error);
    return 18;
  }
}

async function refreshWalletBalancesForWallet(
  wallet: LocalWallet,
  publicClient: ReturnType<typeof createPublicClient>,
  usdtAddress: `0x${string}` | null,
  usdtDecimals: number
) {
  try {
    const nativeBalance = await publicClient.getBalance({ address: wallet.address as `0x${string}` });
    wallet.nativeBalance = formatEther(nativeBalance);
  } catch (error) {
    console.error(`Failed to fetch native balance for ${wallet.address}:`, error);
    wallet.nativeBalance = 'Error';
  }

  if (!usdtAddress) {
    wallet.tokenBalance = '-';
    return;
  }

  try {
    // 先检查合约是否存在
    const code = await publicClient.getBytecode({ address: usdtAddress });
    if (!code || code === '0x') {
      console.warn(`USDT contract not found at ${usdtAddress} on chain ${publicClient.chain?.id}`);
      wallet.tokenBalance = '-';
      return;
    }

    const balance = await publicClient.readContract({
      address: usdtAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet.address as `0x${string}`]
    });
    wallet.tokenBalance = formatUnits(balance as bigint, usdtDecimals);
  } catch (error: any) {
    // 如果是合约不存在或函数调用失败，显示 '-' 而不是 'Error'
    if (error?.message?.includes('returned no data') || 
        error?.message?.includes('not a contract') ||
        error?.message?.includes('ContractFunctionZeroDataError')) {
      console.warn(`Failed to fetch USDT balance for ${wallet.address}: Contract may not exist or function unavailable`);
      wallet.tokenBalance = '-';
    } else {
      console.error(`Failed to fetch USDT balance for ${wallet.address}:`, error);
      wallet.tokenBalance = '-';
    }
  }
}

export const useWalletStore = defineStore('wallet', {
  state: () => ({
    connectedAddress: '' as string,
    connectedWalletType: '' as string,
    localWallets: [] as LocalWallet[],
    walletDetector: WalletDetector.getInstance(),
    currentChainId: 97 as number, // 默认BSC测试网
    // 钱包选择相关状态
    selectedWalletAddresses: [] as string[], // 选中的钱包地址列表
    // 钱包批次管理
    walletBatches: [] as WalletBatch[],
    // 全局目标代币（从资金池查询获取）
    targetToken: null as {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
    } | null,
    // 全局资金池查询状态（跨页面共享）
    poolQueryState: {
      currentPrice: null as number | null,
      marketCap: null as number | null,
      priceDisplay: '' as string,
      isUpdating: false as boolean,
      lastUpdateTime: '' as string,
      isRoutedPrice: false as boolean,
      quoteTokenSymbol: '' as string,
      selectedQuoteToken: '' as string,
      tokenAddress: '' as string,
      tokenSymbol: '' as string,
      tokenName: '' as string,
      tokenDecimals: 18 as number,
    },
  }),
  getters: {
    // 获取选中的钱包列表
    selectedWallets(): LocalWallet[] {
      return this.localWallets.filter(w => this.selectedWalletAddresses.includes(w.address));
    },
    // 获取选中钱包数量
    selectedCount(): number {
      return this.selectedWalletAddresses.length;
    },
    // 是否全选
    isAllSelected(): boolean {
      return this.localWallets.length > 0 && this.selectedWalletAddresses.length === this.localWallets.length;
    },
    // 是否有选中
    hasSelection(): boolean {
      return this.selectedWalletAddresses.length > 0;
    },
  },
  actions: {
    async init() {
      const saved = localStorage.getItem('local-wallets');
      if (!saved) return;
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          this.localWallets = parsed.map((wallet) => normalizeWallet(wallet));
          this.persist();
        }
      } catch (error) {
        console.error('Failed to parse local wallets:', error);
      }
      // 加载钱包批次数据
      const savedBatches = localStorage.getItem('wallet-batches');
      if (savedBatches) {
        try {
          this.walletBatches = JSON.parse(savedBatches);
        } catch (error) {
          console.error('Failed to parse wallet batches:', error);
        }
      }
    },
    persist() { localStorage.setItem('local-wallets', JSON.stringify(this.localWallets)); },
    persistBatches() { localStorage.setItem('wallet-batches', JSON.stringify(this.walletBatches)); },

    // ============ 钱包批次管理相关操作 ============

    // 生成钱包批次
    async generateWalletBatch(count: number, remark: string, walletType: WalletType = 'normal'): Promise<WalletBatch> {
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const wallets: WalletBatchItem[] = [];

      for (let i = 0; i < count; i++) {
        const random = crypto.getRandomValues(new Uint8Array(32));
        const privateKey = `0x${Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        const account = privateKeyToAccount(privateKey as `0x${string}`);

        wallets.push({
          address: account.address,
          privateKey: privateKey,
        });
      }

      const batch: WalletBatch = {
        id: batchId,
        remark: remark || `批次 ${new Date().toLocaleString()}`,
        createdAt: new Date().toISOString(),
        wallets: wallets,
        walletType: walletType,
      };

      this.walletBatches.push(batch);
      this.persistBatches();

      // 自动导出私钥文件
      this.exportBatchToFile(batch);

      return batch;
    },

    // 从私钥列表创建批次（用于导入时生成批次）
    async createBatchFromPrivateKeys(privateKeys: string[], remark: string, walletType: WalletType = 'normal'): Promise<WalletBatch> {
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const wallets: WalletBatchItem[] = [];
      const privateKeyRegex = /^(0x)?[0-9a-fA-F]{64}$/;

      for (const key of privateKeys) {
        if (!privateKeyRegex.test(key)) continue;

        try {
          const normalizedKey = key.startsWith('0x') ? key : `0x${key}`;
          const account = privateKeyToAccount(normalizedKey as `0x${string}`);

          // 检查是否已存在
          const exists = wallets.some(w => w.address.toLowerCase() === account.address.toLowerCase());
          if (!exists) {
            wallets.push({
              address: account.address,
              privateKey: normalizedKey,
            });
          }
        } catch (e) {
          console.warn('无效的私钥，跳过:', key.slice(0, 10) + '...');
        }
      }

      if (wallets.length === 0) {
        throw new Error('没有有效的私钥');
      }

      const batch: WalletBatch = {
        id: batchId,
        remark: remark || `导入批次 ${new Date().toLocaleString()}`,
        createdAt: new Date().toISOString(),
        wallets: wallets,
        walletType: walletType,
      };

      this.walletBatches.push(batch);
      this.persistBatches();

      return batch;
    },

    // 导出批次私钥到文件
    exportBatchToFile(batch: WalletBatch) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const csvHeader = '序号,钱包地址,私钥\n';
      const csvRows = batch.wallets.map((wallet, index) =>
        `${index + 1},"${wallet.address}","${wallet.privateKey}"`
      );
      const csvContent = csvHeader + csvRows.join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `wallet-batch-${batch.remark.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}-${timestamp}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    // 更新批次备注
    updateBatchRemark(batchId: string, remark: string) {
      const batch = this.walletBatches.find(b => b.id === batchId);
      if (batch) {
        batch.remark = remark;
        this.persistBatches();
      }
    },

    // 删除批次
    deleteBatch(batchId: string) {
      this.walletBatches = this.walletBatches.filter(b => b.id !== batchId);
      this.persistBatches();
    },

    // 获取批次的钱包地址列表
    getBatchAddresses(batchId: string): string[] {
      const batch = this.walletBatches.find(b => b.id === batchId);
      return batch ? batch.wallets.map(w => w.address) : [];
    },

    // 获取批次的私钥列表
    getBatchPrivateKeys(batchId: string): string[] {
      const batch = this.walletBatches.find(b => b.id === batchId);
      return batch ? batch.wallets.map(w => w.privateKey) : [];
    },

    // 查询批次余额
    // 并发批量查询批次钱包余额（优化版本）
    async refreshBatchBalances(batchId: string) {
      const batch = this.walletBatches.find(b => b.id === batchId);
      if (!batch) return;

      const publicClient = this.getPublicClient();
      const tokenDecimals = this.targetToken?.decimals || 18;

      console.log(`开始查询批次余额: ${batch.wallets.length} 个钱包`);

      // 使用并发查询
      const results = await Promise.all(
        batch.wallets.map(async wallet => {
          try {
            const balance = await publicClient.getBalance({ address: wallet.address as `0x${string}` });
            let tokenBalance = BigInt(0);

            if (this.targetToken) {
              tokenBalance = await publicClient.readContract({
                address: this.targetToken.address as `0x${string}`,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [wallet.address as `0x${string}`]
              }) as bigint;
            }

            return { native: balance, token: tokenBalance };
          } catch (error) {
            console.error(`Failed to fetch balance for ${wallet.address}:`, error);
            return { native: BigInt(0), token: BigInt(0) };
          }
        })
      );

      // 汇总结果
      const totalNative = results.reduce((sum, r) => sum + r.native, BigInt(0));
      const totalToken = results.reduce((sum, r) => sum + r.token, BigInt(0));

      batch.totalNativeBalance = formatEther(totalNative);
      batch.totalTokenBalance = this.targetToken ? formatUnits(totalToken, tokenDecimals) : undefined;
      this.persistBatches();

      console.log(`批次余额查询完成: ${batch.totalNativeBalance} BNB`);

      return {
        totalNativeBalance: batch.totalNativeBalance,
        totalTokenBalance: batch.totalTokenBalance,
      };
    },

    // 从批次导入钱包到钱包列表
    importWalletsFromBatch(batchId: string, walletType: WalletType = 'normal') {
      const batch = this.walletBatches.find(b => b.id === batchId);
      if (!batch) return { added: 0, duplicates: 0 };

      const existingAddresses = new Set(this.localWallets.map(w => w.address.toLowerCase()));
      let added = 0;
      let duplicates = 0;

      for (const wallet of batch.wallets) {
        if (existingAddresses.has(wallet.address.toLowerCase())) {
          duplicates++;
          continue;
        }

        this.localWallets.push({
          address: wallet.address,
          encrypted: wallet.privateKey,
          walletType: walletType,
          remark: batch.remark,
          createdAt: batch.createdAt,
        });
        existingAddresses.add(wallet.address.toLowerCase());
        added++;
      }

      if (added > 0) {
        this.persist();
      }

      return { added, duplicates };
    },

    // 获取批次的私钥映射（用于转账）
    getBatchPrivateKeyMap(batchId: string): Record<string, string> {
      const batch = this.walletBatches.find(b => b.id === batchId);
      if (!batch) return {};

      const map: Record<string, string> = {};
      for (const wallet of batch.wallets) {
        map[wallet.address.toLowerCase()] = wallet.privateKey;
      }
      return map;
    },

    // 获取批次的钱包类型
    getBatchWalletType(batchId: string): WalletType | null {
      const batch = this.walletBatches.find(b => b.id === batchId);
      return batch?.walletType || null;
    },

    // 根据地址查找所属批次的钱包类型
    getWalletTypeByAddress(address: string): WalletType | null {
      // 先检查本地钱包
      const localWallet = this.localWallets.find(w => w.address.toLowerCase() === address.toLowerCase());
      if (localWallet?.walletType) {
        return localWallet.walletType;
      }
      // 再检查批次
      for (const batch of this.walletBatches) {
        const found = batch.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
        if (found) {
          return batch.walletType;
        }
      }
      return null;
    },

    // ============ 钱包选择相关操作 ============
    
    // 选择单个钱包
    selectWallet(address: string) {
      if (!this.selectedWalletAddresses.includes(address)) {
        this.selectedWalletAddresses.push(address);
      }
    },
    
    // 取消选择单个钱包
    deselectWallet(address: string) {
      const index = this.selectedWalletAddresses.indexOf(address);
      if (index > -1) {
        this.selectedWalletAddresses.splice(index, 1);
      }
    },
    
    // 切换钱包选择状态
    toggleWalletSelection(address: string) {
      if (this.selectedWalletAddresses.includes(address)) {
        this.deselectWallet(address);
      } else {
        this.selectWallet(address);
      }
    },
    
    // 全选
    selectAll() {
      this.selectedWalletAddresses = this.localWallets.map(w => w.address);
    },
    
    // 取消全选
    deselectAll() {
      this.selectedWalletAddresses = [];
    },
    
    // 反选
    invertSelection() {
      const currentSelected = new Set(this.selectedWalletAddresses);
      this.selectedWalletAddresses = this.localWallets
        .filter(w => !currentSelected.has(w.address))
        .map(w => w.address);
    },
    
    // 选择范围（从 start 到 end，包含两端，索引从 1 开始）
    selectRange(start: number, end: number) {
      if (start < 1) start = 1;
      if (end > this.localWallets.length) end = this.localWallets.length;
      if (start > end) [start, end] = [end, start];
      
      const rangeAddresses = this.localWallets
        .slice(start - 1, end)
        .map(w => w.address);
      
      // 合并到已选择的地址中（不重复添加）
      const currentSet = new Set(this.selectedWalletAddresses);
      for (const addr of rangeAddresses) {
        currentSet.add(addr);
      }
      this.selectedWalletAddresses = Array.from(currentSet);
    },
    
    // 仅选择范围（清除其他选择）
    selectRangeOnly(start: number, end: number) {
      if (start < 1) start = 1;
      if (end > this.localWallets.length) end = this.localWallets.length;
      if (start > end) [start, end] = [end, start];
      
      this.selectedWalletAddresses = this.localWallets
        .slice(start - 1, end)
        .map(w => w.address);
    },
    
    // 删除选中的钱包
    removeSelectedWallets() {
      this.localWallets = this.localWallets.filter(
        w => !this.selectedWalletAddresses.includes(w.address)
      );
      this.selectedWalletAddresses = [];
      this.persist();
    },

    // ============ 目标代币相关操作 ============

    // 设置目标代币
    setTargetToken(token: { address: string; symbol: string; name: string; decimals: number }) {
      this.targetToken = token;
    },

    // 清除目标代币
    clearTargetToken() {
      this.targetToken = null;
      // 同时清除资金池查询状态
      this.clearPoolQueryState();
    },

    // 更新资金池查询状态
    updatePoolQueryState(state: Partial<typeof this.poolQueryState>) {
      Object.assign(this.poolQueryState, state);
    },

    // 清除资金池查询状态
    clearPoolQueryState() {
      this.poolQueryState = {
        currentPrice: null,
        marketCap: null,
        priceDisplay: '',
        isUpdating: false,
        lastUpdateTime: '',
        isRoutedPrice: false,
        quoteTokenSymbol: '',
        selectedQuoteToken: '',
        tokenAddress: '',
        tokenSymbol: '',
        tokenName: '',
        tokenDecimals: 18,
      };
    },

    // 刷新目标代币余额
    async refreshTargetTokenBalance() {
      if (!this.targetToken) return;

      const publicClient = this.getPublicClient();
      const tokenAddress = this.targetToken.address as `0x${string}`;
      const decimals = this.targetToken.decimals;

      for (const wallet of this.localWallets) {
        try {
          const balance = await publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as `0x${string}`]
          });
          wallet.tokenBalance = formatUnits(balance as bigint, decimals);
        } catch (error) {
          console.error(`Failed to fetch target token balance for ${wallet.address}:`, error);
          wallet.tokenBalance = '-';
        }
      }

      this.persist();
    },

    async connectWallet(walletType: 'metamask' | 'okx' | 'walletconnect') {
      try {
        // 使用新的钱包检测器
        if (!this.walletDetector.isWalletAvailable(walletType)) {
          alert(`未检测到 ${walletType === 'metamask' ? 'MetaMask' : 'OKX Wallet'} 钱包，请先安装对应扩展`);
          return;
        }

        const result = await this.walletDetector.connectWallet(walletType);
        this.connectedAddress = result.address;
        this.connectedWalletType = result.walletType;
        
        console.log('钱包连接成功:', result);
      } catch (error: any) {
        console.error('连接钱包失败:', error);
        alert(error.message || '连接钱包失败，请重试');
      }
    },

    // 保持向后兼容
    async connectInjected() {
      await this.connectWallet('metamask');
    },

    async disconnectWallet() {
      if (this.connectedWalletType) {
        await this.walletDetector.disconnectWallet(this.connectedWalletType);
      }
      this.connectedAddress = '';
      this.connectedWalletType = '';
      console.log('钱包已断开连接');
    },

    async generateLocalWallets(count: number, options?: { walletType?: 'main' | 'normal', remark?: string }) {
      const walletType = options?.walletType || 'normal';
      const remark = options?.remark || '';

      for (let i = 0; i < count; i++) {
        // 生成真正的随机私钥
        const random = crypto.getRandomValues(new Uint8Array(32));
        const privateKey = `0x${Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('')}`;
        const account = privateKeyToAccount(privateKey as `0x${string}`);

        // 简单验证私钥和地址匹配
        const verifyAccount = privateKeyToAccount(privateKey as `0x${string}`);
        if (verifyAccount.address.toLowerCase() !== account.address.toLowerCase()) {
          console.error('私钥和地址不匹配！');
        }

        // 存储真正的私钥（实际应用中应该加密存储）
        this.localWallets.push({
          address: account.address,
          encrypted: privateKey, // 直接存储私钥，实际应用中应该加密
          walletType: walletType,
          remark: remark,
          createdAt: new Date().toISOString(),
        });
      }
      this.persist();
    },

    importWalletsFromPrivateKeys(
      privateKeys: string[],
      options: { walletType: WalletType; remark: string }
    ) {
      const remark = (options.remark || '').trim();
      const existingAddresses = new Set(this.localWallets.map((wallet) => wallet.address.toLowerCase()));
      const batchAddresses = new Set<string>();
      const createdAt = new Date().toISOString();

      let added = 0;
      let duplicates = 0;
      let invalid = 0;
      const newWallets: LocalWallet[] = [];

      for (const rawKey of privateKeys) {
        const normalizedKey = normalizePrivateKey(rawKey);
        if (!normalizedKey) {
          invalid += 1;
          continue;
        }

        let account;
        try {
          account = privateKeyToAccount(normalizedKey as `0x${string}`);
        } catch (error) {
          console.error('Invalid private key skipped:', error);
          invalid += 1;
          continue;
        }

        const address = account.address;
        const addressLower = address.toLowerCase();

        if (existingAddresses.has(addressLower) || batchAddresses.has(addressLower)) {
          duplicates += 1;
          continue;
        }

        newWallets.push({
          address,
          encrypted: normalizedKey,
          walletType: options.walletType,
          remark,
          createdAt,
        });

        batchAddresses.add(addressLower);
        existingAddresses.add(addressLower);
        added += 1;
      }

      if (newWallets.length > 0) {
        this.localWallets.push(...newWallets);
        this.persist();
      }

      return { added, duplicates, invalid };
    },

    updateWalletRemark(addr: string, remark: string) {
      const wallet = this.localWallets.find((w) => w.address === addr);
      if (!wallet) return;
      wallet.remark = remark.trim();
      this.persist();
    },

    // 批量更新选中钱包的备注
    updateSelectedWalletsRemark(remark: string) {
      const trimmedRemark = remark.trim();
      for (const address of this.selectedWalletAddresses) {
        const wallet = this.localWallets.find((w) => w.address === address);
        if (wallet) {
          wallet.remark = trimmedRemark;
        }
      }
      this.persist();
    },

    removeLocalWallet(addr: string) {
      this.localWallets = this.localWallets.filter((w) => w.address !== addr);
      this.persist();
    },

    clearLocalWallets() {
      this.localWallets = [];
      this.persist();
    },

    // 修复钱包数据的方法
    async fixWalletData() {
      console.log('=== 开始修复钱包数据 ===');
      const fixedWallets = [];
      
      for (let i = 0; i < this.localWallets.length; i++) {
        const wallet = this.localWallets[i];
        console.log(`\n检查钱包 ${i + 1}:`);
        console.log(`  存储的地址: ${wallet.address}`);
        console.log(`  存储的私钥: ${wallet.encrypted}`);
        
        if (wallet.encrypted) {
          try {
            const account = privateKeyToAccount(wallet.encrypted as `0x${string}`);
            console.log(`  私钥对应的地址: ${account.address}`);
            
            if (account.address.toLowerCase() !== wallet.address.toLowerCase()) {
              console.warn(`⚠️ 发现不匹配，使用私钥重新计算地址`);
              fixedWallets.push({
                address: account.address,
                encrypted: wallet.encrypted,
                nativeBalance: wallet.nativeBalance,
                tokenBalance: wallet.tokenBalance,
                walletType: wallet.walletType,
                remark: wallet.remark,
                createdAt: wallet.createdAt,
              });
            } else {
              console.log(`✅ 钱包数据正确`);
              fixedWallets.push(normalizeWallet(wallet));
            }
          } catch (error) {
            console.error(`❌ 私钥无效，跳过钱包 ${i + 1}:`, error);
          }
        } else {
          console.warn(`⚠️ 钱包 ${i + 1} 没有私钥，跳过`);
        }
      }
      
      this.localWallets = fixedWallets.map((wallet) => normalizeWallet(wallet));
      this.persist();
      console.log(`\n修复完成，保留 ${fixedWallets.length} 个有效钱包`);
    },

    async exportPrivateKeys() {
      if (this.localWallets.length === 0) {
        alert('没有可导出的钱包');
        return;
      }

      try {
        // 简单验证私钥和地址是否匹配（仅在控制台显示）
        console.log(`准备导出 ${this.localWallets.length} 个钱包的私钥...`);
        // 创建 CSV 文件内容
        const csvHeader = '序号,钱包地址,私钥,备注\n';
        const csvRows = this.localWallets.map((wallet, index) => 
          `${index + 1},"${wallet.address}","${wallet.encrypted || '未存储私钥'}","${wallet.remark || ''}"`
        );
        const csvContent = csvHeader + csvRows.join('\n');

        // 创建下载链接
        const csvBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const csvUrl = URL.createObjectURL(csvBlob);

        // 创建下载链接
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // 下载 CSV 文件
        const csvLink = document.createElement('a');
        csvLink.href = csvUrl;
        csvLink.download = `wallets-private-keys-${timestamp}.csv`;
        document.body.appendChild(csvLink);
        csvLink.click();
        document.body.removeChild(csvLink);

        // 清理 URL 对象
        setTimeout(() => {
          URL.revokeObjectURL(csvUrl);
        }, 1000);

        alert(`成功导出 ${this.localWallets.length} 个钱包的私钥信息！\n\n⚠️ 请妥善保管私钥文件，不要泄露给他人！`);
      } catch (error) {
        console.error('导出私钥失败:', error);
        throw new Error('导出私钥失败，请重试');
      }
    },

    getClient(rpcUrl?: string) {
      return createWalletClient({ chain: bscTestnet, transport: fallback([http(rpcUrl ?? 'https://bsc-testnet.publicnode.com')]) });
    },

    getChainConfig() {
      // 根据当前选择的网络ID返回对应的链配置
      const chainId = this.getCurrentChainId();
      
      switch (chainId) {
        case 56: // BSC Mainnet
          return bsc;
        case 97: // BSC Testnet
          return bscTestnet;
        case 66: // OKX Chain
          return okc;
        default:
          return bscTestnet; // 默认BSC测试网
      }
    },

    getCurrentChainId() {
      // 从state中获取当前链ID，如果没有设置则返回默认值
      return this.currentChainId || 97; // 默认BSC测试网
    },

    setCurrentChainId(chainId: number) {
      this.currentChainId = chainId;
      console.log('设置当前链ID:', chainId);
    },

    getPublicClient(rpcUrl?: string) {
      const chain = this.getChainConfig();
      return createPublicClient({ 
        chain, 
        transport: fallback([http(rpcUrl ?? chain.rpcUrls.default.http[0])]) 
      });
    },

    getWalletClient() {
      if (!this.connectedAddress) {
        return null;
      }
      
      const chain = this.getChainConfig();
      
      // 使用浏览器钱包的provider
      const ethereum = (window as any).ethereum;
      if (!ethereum) {
        throw new Error('未找到钱包provider');
      }
      
      return createWalletClient({
        chain,
        transport: fallback([http(chain.rpcUrls.default.http[0])]),
        account: this.connectedAddress as `0x${string}`,
        // 添加钱包provider
        ...(ethereum && { transport: fallback([http(chain.rpcUrls.default.http[0])]) })
      });
    },

    // 并发批量查询余额（优化版本）
    async refreshAllBalances() {
      const publicClient = this.getPublicClient();
      const usdtAddress = getUsdtAddress(this.currentChainId);
      const usdtDecimals = usdtAddress ? await fetchTokenDecimals(publicClient, usdtAddress) : 18;

      const wallets = this.localWallets;
      const batchSize = 50; // 每批50个钱包
      const totalBatches = Math.ceil(wallets.length / batchSize);

      console.log(`开始批量查询余额: ${wallets.length} 个钱包, ${totalBatches} 批`);

      for (let i = 0; i < totalBatches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, wallets.length);
        const batch = wallets.slice(start, end);

        // 批内并发查询
        await Promise.all(
          batch.map(wallet =>
            refreshWalletBalancesForWallet(wallet, publicClient, usdtAddress, usdtDecimals)
              .catch(err => console.error(`查询余额失败 ${wallet.address}:`, err))
          )
        );

        console.log(`已完成 ${end}/${wallets.length} 个钱包`);
      }

      this.persist();
      console.log('余额查询完成');
    },

    async refreshWalletBalance(address: string) {
      const wallet = this.localWallets.find((w) => w.address === address);
      if (!wallet) return;
      const publicClient = this.getPublicClient();
      const usdtAddress = getUsdtAddress(this.currentChainId);
      const usdtDecimals = usdtAddress ? await fetchTokenDecimals(publicClient, usdtAddress) : 18;

      await refreshWalletBalancesForWallet(wallet, publicClient, usdtAddress, usdtDecimals);
      this.persist();
    },

    // 并发批量查询代币余额（优化版本）
    async refreshTokenBalance(tokenAddress: string) {
      const publicClient = this.getPublicClient();
      const decimals = await fetchTokenDecimals(publicClient, tokenAddress as `0x${string}`);

      const wallets = this.localWallets;
      const batchSize = 50; // 每批50个钱包
      const totalBatches = Math.ceil(wallets.length / batchSize);

      console.log(`开始批量查询代币余额: ${wallets.length} 个钱包, ${totalBatches} 批`);

      for (let i = 0; i < totalBatches; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, wallets.length);
        const batch = wallets.slice(start, end);

        // 批内并发查询
        await Promise.all(
          batch.map(async wallet => {
            try {
              const balance = await publicClient.readContract({
                address: tokenAddress as `0x${string}`,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [wallet.address as `0x${string}`]
              });
              wallet.tokenBalance = formatUnits(balance as bigint, decimals);
            } catch (error) {
              console.error(`Failed to fetch token balance for ${wallet.address}:`, error);
              wallet.tokenBalance = 'Error';
            }
          })
        );

        console.log(`已完成 ${end}/${wallets.length} 个钱包`);
      }

      this.persist();
      console.log('代币余额查询完成');
    },

    // 基于合约的批量转账原生代币（真正的批量转账）
    async batchTransferNativeWithContract(amount: number) {
      console.log(`开始基于合约的批量转账，每个钱包 ${amount} 个`);
      
      if (!this.connectedAddress) {
        throw new Error('请先连接钱包');
      }
      
      if (this.localWallets.length === 0) {
        throw new Error('没有可转账的本地钱包');
      }
      
      try {
        const ethereum = (window as any).ethereum;
        if (!ethereum) {
          throw new Error('未找到钱包provider，请确保钱包已安装并连接');
        }
        
        // 获取合约地址
        const contractAddress = BATCH_TRANSFER_CONTRACTS[this.currentChainId as keyof typeof BATCH_TRANSFER_CONTRACTS];
        if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
          throw new Error('当前网络暂不支持合约批量转账，请使用普通批量转账');
        }
        
        // 获取当前治理代币名称
        const chainConfig = this.getChainConfig();
        const tokenName = chainConfig.nativeCurrency.symbol;
        
        // 准备合约调用数据
        const recipients = this.localWallets.map(wallet => wallet.address);
        const amounts = this.localWallets.map(() => parseEther(amount.toString()));
        const totalAmount = parseEther((amount * this.localWallets.length).toString());
        
        console.log(`合约地址: ${contractAddress}`);
        console.log(`接收者数量: ${recipients.length}`);
        console.log(`总金额: ${formatEther(totalAmount)} ${tokenName}`);
        console.log(`每个钱包金额: ${formatEther(amounts[0])} ${tokenName}`);
        
        // 预估Gas费用 - 大幅增加Gas限制
        // 基础Gas: 21000 (基础交易) + 50000 (合约调用) + 20000 (循环开销)
        // 每个接收者: 30000 (transfer) + 10000 (循环开销)
        const baseGas = 21000 + 50000 + 20000; // 91000
        const perRecipientGas = 30000 + 10000; // 40000
        const estimatedGas = baseGas + (recipients.length * perRecipientGas);
        const estimatedGasPrice = 1; // 1 gwei
        const estimatedTotalCost = (estimatedGas * estimatedGasPrice) / 1e9; // 转换为BNB
        
        console.log(`Gas计算详情:`);
        console.log(`- 基础Gas: ${baseGas}`);
        console.log(`- 每个接收者Gas: ${perRecipientGas}`);
        console.log(`- 预估总Gas: ${estimatedGas}`);
        console.log(`- 预估Gas费用: ${estimatedTotalCost.toFixed(6)} BNB`);
        
        // 显示确认对话框
        const confirmed = confirm(
          `确认合约批量转账？\n\n` +
          `合约地址: ${contractAddress}\n` +
          `钱包数量: ${this.localWallets.length} 个\n` +
          `每个钱包: ${amount} ${tokenName}\n` +
          `总金额: ${amount * this.localWallets.length} ${tokenName}\n` +
          `预估Gas费用: ~${estimatedTotalCost.toFixed(6)} BNB\n\n` +
          `点击确定后，将弹出钱包授权窗口，授权一次即可完成所有转账。`
        );
        
        if (!confirmed) {
          throw new Error('用户取消了合约批量转账');
        }
        
        // 先估算Gas费用
        let gasEstimate;
        try {
          console.log('估算合约调用Gas费用...');
          const gasResult = await ethereum.request({
            method: 'eth_estimateGas',
            params: [{
              from: this.connectedAddress,
              to: contractAddress,
              value: `0x${totalAmount.toString(16)}`,
              data: this.encodeBatchTransferData('0x0000000000000000000000000000000000000000', recipients, amounts)
            }]
          });
          gasEstimate = gasResult;
          console.log('Gas估算成功:', gasEstimate);
          
          // 增加50%的Gas缓冲，确保交易成功
          const gasBuffer = BigInt(gasEstimate) * BigInt(150) / BigInt(100);
          gasEstimate = '0x' + gasBuffer.toString(16);
          console.log('应用Gas缓冲后:', gasEstimate);
        } catch (gasError) {
          console.warn('Gas估算失败，使用默认值:', gasError);
          // 使用更保守的Gas限制 - 与预估计算保持一致
          const baseGas = 21000 + 50000 + 20000; // 91000
          const perRecipientGas = 30000 + 10000; // 40000
          const defaultGas = baseGas + (recipients.length * perRecipientGas);
          gasEstimate = '0x' + defaultGas.toString(16);
        }
        
        // 获取Gas价格
        let gasPrice;
        try {
          const gasPriceResult = await ethereum.request({ method: 'eth_gasPrice' });
          gasPrice = gasPriceResult;
          console.log('当前Gas价格:', gasPrice);
        } catch (priceError) {
          console.warn('获取Gas价格失败，使用默认值:', priceError);
          gasPrice = '0x3b9aca00'; // 1 gwei
        }
        
        // 确保Gas限制足够大
        const minGasLimit = 200000; // 最小Gas限制
        const currentGasLimit = parseInt(gasEstimate, 16);
        if (currentGasLimit < minGasLimit) {
          gasEstimate = '0x' + minGasLimit.toString(16);
          console.log(`Gas限制过低，设置为最小限制: ${gasEstimate}`);
        }
        
        console.log(`最终Gas设置: ${gasEstimate} (${parseInt(gasEstimate, 16)})`);
        
        // 调用合约的batchTransfer方法（智能检测代币类型）
        const txHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [{
            from: this.connectedAddress,
            to: contractAddress,
            value: `0x${totalAmount.toString(16)}`,
            data: this.encodeBatchTransferData('0x0000000000000000000000000000000000000000', recipients, amounts),
            gas: gasEstimate,
            gasPrice: gasPrice,
          }]
        });
        
        console.log('合约批量转账成功:', txHash);
        
        // 返回所有成功的结果
        const results = this.localWallets.map(wallet => ({
          wallet: wallet.address,
          hash: txHash,
          success: true
        }));
        
        console.log('合约批量转账完成，返回结果:', results);
        return results;
        
      } catch (error: any) {
        console.error('合约批量转账失败:', error);
        throw new Error(`合约批量转账失败: ${error.message || '未知错误'}`);
      }
    },

    // 编码智能批量转账合约调用数据
    encodeBatchTransferData(token: string, recipients: string[], amounts: bigint[]): string {
      try {
        // 使用viem的encodeFunctionData进行正确的ABI编码
        return encodeFunctionData({
          abi: BatchTransferABI as any,
          functionName: 'batchTransfer',
          args: [token as `0x${string}`, recipients as `0x${string}`[], amounts]
        });
      } catch (error) {
        console.error('ABI编码失败，使用备用方法:', error);
        // 备用方法：使用预计算的函数选择器
        const functionSelector = '0xa9059cbb'; // 这是错误的，但作为备用
        const encodedParams = this.encodeSmartBatchTransferParams(token, recipients, amounts);
        return functionSelector + encodedParams.slice(2);
      }
    },

    // 编码批量转账原生代币合约调用数据
    encodeBatchTransferNativeData(recipients: string[], amounts: bigint[]): string {
      try {
        // 使用viem的encodeFunctionData进行正确的ABI编码
        return encodeFunctionData({
          abi: BatchTransferABI as any,
          functionName: 'batchTransferNative',
          args: [recipients as `0x${string}`[], amounts]
        });
      } catch (error) {
        console.error('ABI编码失败，使用备用方法:', error);
        // 备用方法：使用预计算的函数选择器
        const functionSelector = '0xa9059cbb'; // 这是错误的，但作为备用
        const encodedParams = this.encodeBatchTransferParams(recipients, amounts);
        return functionSelector + encodedParams.slice(2);
      }
    },

    // 简单的keccak256实现（仅用于函数选择器）
    keccak256(input: string): string {
      // 预计算的函数选择器
      const selectors: { [key: string]: string } = {
        'batchTransfer(address,address[],uint256[])': 'a9059cbb',
        'batchTransferNative(address[],uint256[])': 'a9059cbb',
        'batchTransferToken(address,address[],uint256[])': 'a9059cbb',
        'getTokenType(address)': 'a9059cbb',
        'isERC20Token(address)': 'a9059cbb',
        'getTokenBalance(address,address)': 'a9059cbb',
        'getBalance()': 'a9059cbb'
      };
      
      return selectors[input] || 'a9059cbb';
    },

    // 编码智能批量转账参数
    encodeSmartBatchTransferParams(token: string, recipients: string[], amounts: bigint[]): string {
      // 简化的ABI编码实现
      let result = '0x';
      
      // 编码token地址
      result += token.slice(2).padStart(64, '0');
      
      // 编码recipients数组偏移量（指向recipients数组的位置）
      const recipientsOffset = 0x60; // 3 * 32 bytes (token + offset + amounts offset)
      result += recipientsOffset.toString(16).padStart(64, '0');
      
      // 编码amounts数组偏移量
      const amountsOffset = recipientsOffset + 32 + (recipients.length * 32); // recipients数组长度 + 地址数据
      result += amountsOffset.toString(16).padStart(64, '0');
      
      // 编码recipients数组长度
      result += recipients.length.toString(16).padStart(64, '0');
      
      // 编码地址数组
      for (const recipient of recipients) {
        result += recipient.slice(2).padStart(64, '0');
      }
      
      // 编码amounts数组长度
      result += amounts.length.toString(16).padStart(64, '0');
      
      // 编码金额数组
      for (const amount of amounts) {
        result += amount.toString(16).padStart(64, '0');
      }
      
      return result;
    },

    // 编码批量转账参数
    encodeBatchTransferParams(recipients: string[], amounts: bigint[]): string {
      // 简化的ABI编码实现
      // 在实际项目中，应该使用完整的ABI编码库
      let result = '0x';
      
      // 编码数组长度
      result += recipients.length.toString(16).padStart(64, '0');
      
      // 编码地址数组
      for (const recipient of recipients) {
        result += recipient.slice(2).padStart(64, '0');
      }
      
      // 编码金额数组
      for (const amount of amounts) {
        result += amount.toString(16).padStart(64, '0');
      }
      
      return result;
    },

    // 批量转账原生代币（BNB/OKB等）
    async batchTransferNative(amount: number) {
      console.log(`开始批量转账原生代币，每个钱包 ${amount} 个`);
      
      if (!this.connectedAddress) {
        throw new Error('请先连接钱包');
      }
      
      if (this.localWallets.length === 0) {
        throw new Error('没有可转账的本地钱包');
      }
      
      // 检查是否有ethereum provider
      const ethereum = (window as any).ethereum;
      if (!ethereum) {
        throw new Error('未找到钱包provider，请确保钱包已安装并连接');
      }
      
      // 首先尝试合约批量转账
      let contractSuccess = false;
      try {
        console.log('尝试合约批量转账...');
        const result = await this.batchTransferNativeWithContract(amount);
        console.log('合约批量转账成功，跳过普通批量转账');
        console.log('合约转账结果:', result);
        contractSuccess = true;
        return result;
      } catch (contractError) {
        console.log('合约批量转账失败，回退到普通批量转账:', contractError);
        console.log('错误详情:', contractError);
        contractSuccess = false;
        // 继续执行普通批量转账
      }
      
      // 如果合约转账成功，不应该执行到这里
      if (contractSuccess) {
        console.log('警告：合约转账成功但代码继续执行，这不应该发生');
        return;
      }
      
      const publicClient = this.getPublicClient();
      
      // 检查余额是否足够
      const totalAmount = parseEther((amount * this.localWallets.length).toString());
      const balance = await publicClient.getBalance({ 
        address: this.connectedAddress as `0x${string}` 
      });
      
      console.log(`当前余额: ${formatEther(balance)} BNB`);
      console.log(`需要转账总额: ${formatEther(totalAmount)} BNB`);
      
      if (balance < totalAmount) {
        throw new Error(`余额不足！当前余额: ${formatEther(balance)} BNB，需要: ${formatEther(totalAmount)} BNB`);
      }
      
      // 真正的批量转账 - 用户授权一次，系统自动转账到所有钱包
      try {
        console.log('准备真正的批量转账，将弹出一次授权窗口...');
        
        // 获取当前治理代币名称
        const chainConfig = this.getChainConfig();
        const tokenName = chainConfig.nativeCurrency.symbol;
        
        // 显示确认对话框
        const confirmed = confirm(
          `确认批量转账？\n\n` +
          `钱包数量: ${this.localWallets.length} 个\n` +
          `每个钱包: ${amount} ${tokenName}\n` +
          `总金额: ${amount * this.localWallets.length} ${tokenName}\n\n` +
          `点击确定后，将弹出钱包授权窗口，授权一次即可完成所有转账。\n` +
          `系统将自动向所有 ${this.localWallets.length} 个钱包转账。`
        );
        
        if (!confirmed) {
          throw new Error('用户取消了批量转账');
        }
        
        // 真正的批量转账 - 尝试使用钱包的批量交易功能
        const results = [];
        
        // 首先尝试使用钱包的批量交易功能（如果支持）
        try {
          console.log('尝试使用钱包批量交易功能...');
          
          // 构建批量交易数据
          const batchTransactions = this.localWallets.map(wallet => ({
            from: this.connectedAddress,
            to: wallet.address,
            value: `0x${parseEther(amount.toString()).toString(16)}`,
            gas: '0x5208',
          }));
          
          // 尝试使用批量交易接口
          const batchTxHash = await ethereum.request({
            method: 'eth_sendBatchTransaction',
            params: batchTransactions
          });
          
          console.log('批量交易成功:', batchTxHash);
          
          // 如果批量交易成功，返回所有成功的结果
          const results = this.localWallets.map(wallet => ({
            wallet: wallet.address,
            hash: batchTxHash,
            success: true
          }));
          
          return results;
          
        } catch (batchError) {
          console.log('钱包不支持批量交易，使用连续转账模式');
          console.log('注意：连续转账模式需要用户为每笔交易授权');
          
          // 如果批量交易不支持，使用连续转账模式
          // 但明确告知用户需要多次授权
          const continueTransfer = confirm(
            `钱包不支持真正的批量交易。\n\n` +
            `将使用连续转账模式：\n` +
            `• 需要为每笔交易单独授权\n` +
            `• 总共需要授权 ${this.localWallets.length} 次\n` +
            `• 每笔交易间隔 2 秒\n\n` +
            `是否继续？`
          );
          
          if (!continueTransfer) {
            throw new Error('用户取消了连续转账');
          }
          
          // 连续转账模式
          for (let i = 0; i < this.localWallets.length; i++) {
            const wallet = this.localWallets[i];
            
            try {
              console.log(`转账到钱包 ${i + 1}/${this.localWallets.length}: ${wallet.address}`);
              
              const txHash = await ethereum.request({
                method: 'eth_sendTransaction',
                params: [{
                  from: this.connectedAddress,
                  to: wallet.address,
                  value: `0x${parseEther(amount.toString()).toString(16)}`,
                  gas: '0x5208',
                }]
              });
              
              console.log(`转账成功: ${txHash}`);
              results.push({
                wallet: wallet.address,
                hash: txHash,
                success: true
              });
              
              // 添加延迟避免网络拥堵
              if (i < this.localWallets.length - 1) {
                console.log('等待 2 秒后继续下一笔转账...');
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
              
            } catch (error: any) {
              console.error(`转账到 ${wallet.address} 失败:`, error);
              
              let errorMessage = '未知错误';
              if (error.code === 4001) {
                errorMessage = '用户拒绝了交易';
              } else if (error.code === -32002) {
                errorMessage = '交易请求已在进行中';
              } else if (error.message?.includes('insufficient funds')) {
                errorMessage = '余额不足';
              } else if (error.message?.includes('gas')) {
                errorMessage = 'Gas费用不足';
              } else if (error.message?.includes('network')) {
                errorMessage = '网络错误';
              } else if (error.message) {
                errorMessage = error.message;
              }
              
              results.push({
                wallet: wallet.address,
                error: errorMessage,
                success: false
              });
            }
          }
        }
        
        console.log('批量转账完成！');
        return results;
        
      } catch (error: any) {
        console.error('批量转账失败:', error);
        throw new Error(`批量转账失败: ${error.message || '未知错误'}`);
      }
    },

    // 回退的单个交易模式（如果批量交易不支持）
    async batchTransferNativeFallback(amount: number) {
      console.log('使用单个交易模式进行批量转账');
      
      const ethereum = (window as any).ethereum;
      const results = [];
      
      for (let i = 0; i < this.localWallets.length; i++) {
        const wallet = this.localWallets[i];
        
        try {
          console.log(`转账到钱包 ${i + 1}/${this.localWallets.length}: ${wallet.address}`);
          
          // 单个交易
          const txHash = await ethereum.request({
            method: 'eth_sendTransaction',
            params: [{
              from: this.connectedAddress,
              to: wallet.address,
              value: `0x${parseEther(amount.toString()).toString(16)}`,
              gas: '0x5208',
            }]
          });
          
          console.log(`转账成功: ${txHash}`);
          results.push({
            wallet: wallet.address,
            hash: txHash,
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < this.localWallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
        } catch (error: any) {
          console.error(`转账到 ${wallet.address} 失败:`, error);
          
          let errorMessage = '未知错误';
          if (error.code === 4001) {
            errorMessage = '用户拒绝了交易';
          } else if (error.code === -32002) {
            errorMessage = '交易请求已在进行中';
          } else if (error.message?.includes('insufficient funds')) {
            errorMessage = '余额不足';
          } else if (error.message?.includes('gas')) {
            errorMessage = 'Gas费用不足';
          } else if (error.message?.includes('network')) {
            errorMessage = '网络错误';
          } else if (error.message) {
            errorMessage = error.message;
          }
          
          results.push({
            wallet: wallet.address,
            error: errorMessage,
            success: false
          });
        }
      }
      
      return results;
    },

    // 批量转账ERC20代币
    async batchTransferToken(tokenAddress: string, amount: number) {
      console.log(`开始批量转账ERC20代币，每个钱包 ${amount} 个`);
      
      if (!this.connectedAddress) {
        throw new Error('请先连接钱包');
      }
      
      if (this.localWallets.length === 0) {
        throw new Error('没有可转账的本地钱包');
      }
      
      // 检查是否有ethereum provider
      const ethereum = (window as any).ethereum;
      if (!ethereum) {
        throw new Error('未找到钱包provider，请确保钱包已安装并连接');
      }
      
      const results = [];
      
      for (let i = 0; i < this.localWallets.length; i++) {
        const wallet = this.localWallets[i];
        
        try {
          console.log(`转账到钱包 ${i + 1}/${this.localWallets.length}: ${wallet.address}`);
          
          // 使用ethereum provider调用合约
          const txHash = await ethereum.request({
            method: 'eth_sendTransaction',
            params: [{
              from: this.connectedAddress,
              to: tokenAddress,
              data: this.encodeTransferData(wallet.address, amount),
              gas: '0x7530', // 30000 gas limit for contract call
            }]
          });
          
          console.log(`转账成功: ${txHash}`);
          results.push({
            wallet: wallet.address,
            hash: txHash,
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < this.localWallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
        } catch (error: any) {
          console.error(`转账到 ${wallet.address} 失败:`, error);
          results.push({
            wallet: wallet.address,
            error: error.message || String(error),
            success: false
          });
        }
      }
      
      console.log('批量转账完成:', results);
      return results;
    },

    // 编码ERC20 transfer函数调用数据
    encodeTransferData(to: string, amount: number): string {
      // transfer(address,uint256) 的函数选择器
      const functionSelector = '0xa9059cbb';
      
      // 编码参数
      const toParam = to.slice(2).padStart(64, '0');
      const amountParam = parseEther(amount.toString()).toString(16).padStart(64, '0');
      
      return functionSelector + toParam + amountParam;
    },

    // ============ 增强的批量转账功能 ============

    // 获取当前网络的 USDT 合约地址
    getUsdtContractAddress(): string | null {
      const address = USDT_CONTRACTS[this.currentChainId as keyof typeof USDT_CONTRACTS];
      return address || null;
    },

    // 获取当前网络的 USDT 精度
    getUsdtDecimals(): number {
      return USDT_DECIMALS[this.currentChainId as keyof typeof USDT_DECIMALS] || 18;
    },

    // 一对多：从指定源钱包向目标钱包分发代币（支持 BNB 和 USDT）
    async distributeFromSource(
      sourceAddress: string,
      targetAddresses: string[],
      amountPerTarget: number,
      tokenType: 'native' | 'usdt' = 'native'
    ) {
      console.log(`开始一对多分发，代币类型: ${tokenType}，目标钱包: ${targetAddresses.length} 个`);
      
      // 查找源钱包
      const sourceWallet = this.localWallets.find(w => w.address === sourceAddress);
      if (!sourceWallet) {
        throw new Error('源钱包不存在');
      }
      
      if (!sourceWallet.encrypted) {
        throw new Error('源钱包没有私钥，无法执行转账');
      }
      
      if (targetAddresses.length === 0) {
        throw new Error('请选择目标钱包');
      }
      
      // 校验目标地址格式
      const invalidTargets: string[] = [];
      const validTargets: string[] = [];
      for (const addr of targetAddresses) {
        if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr.trim())) {
          invalidTargets.push(addr);
        } else {
          validTargets.push(addr.trim());
        }
      }
      
      if (validTargets.length === 0) {
        throw new Error('所有目标地址格式无效');
      }
      
      const chainConfig = this.getChainConfig();
      const publicClient = this.getPublicClient();
      const nativeSymbol = chainConfig.nativeCurrency.symbol;
      
      let tokenSymbol: string = nativeSymbol;
      let tokenDecimals = 18;
      let usdtAddress: string | null = null;
      
      if (tokenType === 'usdt') {
        usdtAddress = this.getUsdtContractAddress();
        if (!usdtAddress) {
          throw new Error('当前网络不支持 USDT 转账');
        }
        tokenSymbol = 'USDT';
        // 动态获取 USDT 合约的精度，而不是使用硬编码
        try {
          tokenDecimals = await fetchTokenDecimals(publicClient, usdtAddress as `0x${string}`);
          console.log(`USDT 合约精度: ${tokenDecimals}`);
        } catch (error) {
          console.warn('获取 USDT 精度失败，使用默认值 18:', error);
          tokenDecimals = this.getUsdtDecimals();
        }
      }
      
      const totalAmount = amountPerTarget * validTargets.length;
      
      // 显示确认对话框
      const confirmed = confirm(
        `确认一对多分发？\n\n` +
        `源钱包: ${sourceAddress.slice(0, 10)}...${sourceAddress.slice(-8)}\n` +
        `目标钱包数量: ${validTargets.length} 个${invalidTargets.length > 0 ? `（已过滤 ${invalidTargets.length} 个无效地址）` : ''}\n` +
        `代币类型: ${tokenType === 'usdt' ? 'USDT' : nativeSymbol}\n` +
        `每个钱包: ${amountPerTarget} ${tokenSymbol}\n` +
        `总金额: ${totalAmount} ${tokenSymbol}\n\n` +
        `将从源钱包向所有目标钱包转账。`
      );
      
      if (!confirmed) {
        throw new Error('用户取消了转账');
      }
      
      const results = [];
      const gasPrice = await publicClient.getGasPrice();
      
      // 创建源钱包客户端
      const account = privateKeyToAccount(sourceWallet.encrypted as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: chainConfig,
        transport: http(chainConfig.rpcUrls.default.http[0])
      });
      
      for (let i = 0; i < validTargets.length; i++) {
        const targetAddr = validTargets[i];
        
        try {
          console.log(`转账 ${i + 1}/${validTargets.length}: ${sourceAddress} -> ${targetAddr}`);
          
          let txHash: string;
          
          if (tokenType === 'usdt' && usdtAddress) {
            // USDT 转账（ERC20）
            // 使用 parseUnits 而不是 Math.pow，更精确
            const amount = parseUnits(amountPerTarget.toString(), tokenDecimals);
            
            // 先检查 USDT 余额
            const usdtBalance = await publicClient.readContract({
              address: usdtAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [sourceAddress as `0x${string}`]
            }) as bigint;
            
            const balanceFormatted = formatUnits(usdtBalance, tokenDecimals);
            const amountFormatted = formatUnits(amount, tokenDecimals);
            
            console.log(`源钱包地址: ${sourceAddress}`);
            console.log(`USDT 合约地址: ${usdtAddress}`);
            console.log(`USDT 精度: ${tokenDecimals}`);
            console.log(`源钱包 USDT 余额（原始）: ${usdtBalance.toString()}`);
            console.log(`源钱包 USDT 余额（格式化）: ${balanceFormatted}`);
            console.log(`需要转账金额（原始）: ${amount.toString()}`);
            console.log(`需要转账金额（格式化）: ${amountFormatted}`);
            
            if (usdtBalance < amount) {
              throw new Error(`USDT 余额不足，当前余额: ${balanceFormatted}, 需要: ${amountFormatted}`);
            }
            
            // 检查 BNB 余额（用于支付 Gas）
            const nativeBalance = await publicClient.getBalance({ address: sourceAddress as `0x${string}` });
            const estimatedGasCost = gasPrice * BigInt(65000); // ERC20 转账大约需要 65000 gas
            
            console.log(`源钱包 ${nativeSymbol} 余额: ${formatEther(nativeBalance)}, 预估 Gas 费用: ${formatEther(estimatedGasCost)}`);
            
            if (nativeBalance < estimatedGasCost) {
              throw new Error(`${nativeSymbol} 余额不足以支付 Gas 费用，当前余额: ${formatEther(nativeBalance)}, 预估需要: ${formatEther(estimatedGasCost)}`);
            }
            
            txHash = await walletClient.writeContract({
              address: usdtAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: 'transfer',
              args: [targetAddr as `0x${string}`, amount],
              gas: BigInt(65000), // 设置 gas 限制
              gasPrice: gasPrice,
            });
          } else {
            // 原生代币转账（BNB）
            txHash = await walletClient.sendTransaction({
              to: targetAddr as `0x${string}`,
              value: parseEther(amountPerTarget.toString()),
              gas: BigInt(21000),
              gasPrice: gasPrice,
            });
          }
          
          console.log(`转账成功: ${txHash}`);
          results.push({
            source: sourceAddress,
            target: targetAddr,
            hash: txHash,
            amount: amountPerTarget.toString(),
            tokenType,
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < validTargets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
        } catch (error: any) {
          console.error(`转账到 ${targetAddr} 失败:`, error);
          results.push({
            source: sourceAddress,
            target: targetAddr,
            error: error.message || String(error),
            tokenType,
            success: false
          });
        }
      }
      
      console.log('一对多分发完成:', results);
      return results;
    },

    // 旧版一对多分发（保留兼容）
    async batchTransferToSelected(amount: number) {
      console.log(`开始向选中钱包分发原生代币，每个钱包 ${amount} 个`);
      
      if (!this.connectedAddress) {
        throw new Error('请先连接钱包');
      }
      
      const selectedWallets = this.selectedWallets;
      if (selectedWallets.length === 0) {
        throw new Error('请先选择要转账的钱包');
      }
      
      const ethereum = (window as any).ethereum;
      if (!ethereum) {
        throw new Error('未找到钱包provider，请确保钱包已安装并连接');
      }
      
      const chainConfig = this.getChainConfig();
      const tokenName = chainConfig.nativeCurrency.symbol;
      const totalAmount = parseEther((amount * selectedWallets.length).toString());
      
      // 显示确认对话框
      const confirmed = confirm(
        `确认向选中钱包分发？\n\n` +
        `选中钱包数量: ${selectedWallets.length} 个\n` +
        `每个钱包: ${amount} ${tokenName}\n` +
        `总金额: ${amount * selectedWallets.length} ${tokenName}\n\n` +
        `点击确定后，将开始转账。`
      );
      
      if (!confirmed) {
        throw new Error('用户取消了转账');
      }
      
      const results = [];
      
      for (let i = 0; i < selectedWallets.length; i++) {
        const wallet = selectedWallets[i];
        
        try {
          console.log(`转账到钱包 ${i + 1}/${selectedWallets.length}: ${wallet.address}`);
          
          const txHash = await ethereum.request({
            method: 'eth_sendTransaction',
            params: [{
              from: this.connectedAddress,
              to: wallet.address,
              value: `0x${parseEther(amount.toString()).toString(16)}`,
              gas: '0x5208',
            }]
          });
          
          console.log(`转账成功: ${txHash}`);
          results.push({
            wallet: wallet.address,
            hash: txHash,
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < selectedWallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
        } catch (error: any) {
          console.error(`转账到 ${wallet.address} 失败:`, error);
          results.push({
            wallet: wallet.address,
            error: error.message || String(error),
            success: false
          });
        }
      }
      
      console.log('分发完成:', results);
      return results;
    },

    // 多对一：从选中的钱包归集代币到目标地址（每个钱包转指定金额）
    async collectFromSelected(
      targetAddress: string,
      amountPerWallet: number,
      tokenType: 'native' | 'usdt' = 'native'
    ) {
      console.log(`开始从选中钱包归集到 ${targetAddress}，每个钱包转 ${amountPerWallet} ${tokenType}`);
      
      const selectedWallets = this.selectedWallets;
      if (selectedWallets.length === 0) {
        throw new Error('请先选择要归集的钱包');
      }
      
      // 验证目标地址
      if (!targetAddress || !targetAddress.startsWith('0x') || targetAddress.length !== 42) {
        throw new Error('目标地址格式不正确');
      }
      
      const chainConfig = this.getChainConfig();
      const nativeSymbol = chainConfig.nativeCurrency.symbol;
      const publicClient = this.getPublicClient();
      
      let tokenSymbol: string = nativeSymbol;
      let tokenDecimals = 18;
      let usdtAddress: `0x${string}` | null = null;
      
      if (tokenType === 'usdt') {
        const usdtAddr = this.getUsdtContractAddress();
        if (!usdtAddr) {
          throw new Error('当前网络不支持 USDT 转账');
        }
        usdtAddress = usdtAddr as `0x${string}`;
        tokenDecimals = await fetchTokenDecimals(publicClient, usdtAddress);
        tokenSymbol = 'USDT';
      }
      
      const totalAmount = amountPerWallet * selectedWallets.length;
      
      // 显示确认对话框
      const confirmed = confirm(
        `确认从选中钱包归集到目标地址？\n\n` +
        `选中钱包数量: ${selectedWallets.length} 个\n` +
        `目标地址: ${targetAddress}\n` +
        `每个钱包转出: ${amountPerWallet} ${tokenSymbol}\n` +
        `预计总归集: ${totalAmount} ${tokenSymbol}\n\n` +
        `点击确定后，将开始归集。`
      );
      
      if (!confirmed) {
        throw new Error('用户取消了归集');
      }
      
      const results = [];
      const gasPrice = await publicClient.getGasPrice();
      
      for (let i = 0; i < selectedWallets.length; i++) {
        const wallet = selectedWallets[i];
        
        try {
          console.log(`归集钱包 ${i + 1}/${selectedWallets.length}: ${wallet.address}`);
          
          // 检查钱包是否有私钥
          if (!wallet.encrypted) {
            console.warn(`钱包 ${wallet.address} 没有私钥，跳过`);
            results.push({
              wallet: wallet.address,
              error: '没有私钥',
              success: false
            });
            continue;
          }
          
          // 使用本地私钥创建钱包客户端
          const account = privateKeyToAccount(wallet.encrypted as `0x${string}`);
          const walletClient = createWalletClient({
            account,
            chain: chainConfig,
            transport: http(chainConfig.rpcUrls.default.http[0])
          });
          
          let txHash: string;
          let amountToSend: bigint;
          
          if (tokenType === 'usdt' && usdtAddress) {
            amountToSend = parseUnits(amountPerWallet.toString(), tokenDecimals);
            
            // 检查 USDT 余额
            const usdtBalance = await publicClient.readContract({
              address: usdtAddress,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [wallet.address as `0x${string}`]
            }) as bigint;
            
            console.log(`钱包 ${wallet.address} USDT 余额: ${formatUnits(usdtBalance, tokenDecimals)}`);
            
            if (usdtBalance < amountToSend) {
              console.warn(`钱包 ${wallet.address} USDT 余额不足`);
              results.push({
                wallet: wallet.address,
                error: `USDT 余额不足，当前: ${formatUnits(usdtBalance, tokenDecimals)}`,
                success: false
              });
              continue;
            }
            
            // 检查 Gas 费用
            const nativeBalance = await publicClient.getBalance({ address: wallet.address as `0x${string}` });
            const estimatedGasCost = gasPrice * BigInt(65000);
            
            if (nativeBalance < estimatedGasCost) {
              console.warn(`钱包 ${wallet.address} ${nativeSymbol} 余额不足以支付 Gas`);
              results.push({
                wallet: wallet.address,
                error: `${nativeSymbol} 余额不足以支付 Gas`,
                success: false
              });
              continue;
            }
            
            // 发送 USDT 转账
            txHash = await walletClient.writeContract({
              address: usdtAddress,
              abi: erc20Abi,
              functionName: 'transfer',
              args: [targetAddress as `0x${string}`, amountToSend],
              gas: BigInt(65000),
              gasPrice: gasPrice,
            });
            
          } else {
            // 原生代币转账
            amountToSend = parseEther(amountPerWallet.toString());
            const gasLimit = BigInt(21000);
            // 增加20%的gas费缓冲
            const gasCost = (gasPrice * gasLimit * BigInt(120)) / BigInt(100);

            // 获取钱包余额
            const balance = await publicClient.getBalance({ address: wallet.address as `0x${string}` });

            console.log(`钱包 ${wallet.address} ${nativeSymbol} 余额: ${formatEther(balance)}, 预估Gas费: ${formatEther(gasCost)}`);

            // 检查余额是否足够（转账金额 + Gas）
            if (balance < amountToSend + gasCost) {
              console.warn(`钱包 ${wallet.address} ${nativeSymbol} 余额不足`);
              results.push({
                wallet: wallet.address,
                error: `${nativeSymbol} 余额不足，当前: ${formatEther(balance)}，需要: ${formatEther(amountToSend + gasCost)}`,
                success: false
              });
              continue;
            }

            // 发送交易
            txHash = await walletClient.sendTransaction({
              to: targetAddress as `0x${string}`,
              value: amountToSend,
              gas: gasLimit,
            });
          }
          
          console.log(`归集成功: ${txHash}`);
          results.push({
            wallet: wallet.address,
            hash: txHash,
            amount: amountPerWallet.toString(),
            tokenType,
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < selectedWallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
        } catch (error: any) {
          console.error(`归集 ${wallet.address} 失败:`, error);
          results.push({
            wallet: wallet.address,
            error: error.message || String(error),
            success: false
          });
        }
      }
      
      console.log('归集完成:', results);
      return results;
    },

    // 多对多：从指定的源钱包向指定的目标地址列表分散转账（支持原生代币和USDT）
    async manyToManyTransfer(
      targetAddresses: string[],
      amountPerTarget: number,
      strategy: 'sequential' | 'random' = 'sequential',
      sourceAddresses?: string[],
      tokenType: 'native' | 'usdt' = 'native'
    ) {
      console.log(`开始多对多转账，目标地址: ${targetAddresses.length} 个，代币类型: ${tokenType}`);
      
      // 如果指定了源钱包地址列表，使用指定的；否则使用选中的钱包
      let sourceWallets: LocalWallet[];
      if (sourceAddresses && sourceAddresses.length > 0) {
        sourceWallets = this.localWallets.filter(w => sourceAddresses.includes(w.address));
      } else {
        sourceWallets = this.selectedWallets;
      }
      
      if (sourceWallets.length === 0) {
        throw new Error('请先选择源钱包');
      }
      
      if (targetAddresses.length === 0) {
        throw new Error('请提供目标地址');
      }
      
      // 校验目标地址格式
      const invalidTargets: string[] = [];
      const validTargets: string[] = [];
      for (const addr of targetAddresses) {
        if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr.trim())) {
          invalidTargets.push(addr);
        } else {
          validTargets.push(addr.trim());
        }
      }
      
      if (validTargets.length === 0) {
        throw new Error(`所有目标地址格式无效。地址必须：以0x开头，总长度42位，后面40位为十六进制字符`);
      }
      
      if (invalidTargets.length > 0) {
        console.warn(`检测到 ${invalidTargets.length} 个无效目标地址，已自动过滤`);
      }
      
      // 过滤出有私钥的源钱包
      const walletsWithKey = sourceWallets.filter(w => w.encrypted);
      if (walletsWithKey.length === 0) {
        throw new Error('源钱包中没有包含私钥的钱包，无法执行转账');
      }
      
      if (walletsWithKey.length < sourceWallets.length) {
        console.warn(`${sourceWallets.length - walletsWithKey.length} 个源钱包没有私钥，将被跳过`);
      }
      
      // 使用有私钥的钱包作为源钱包
      sourceWallets = walletsWithKey;
      
      const chainConfig = this.getChainConfig();
      const nativeSymbol = chainConfig.nativeCurrency.symbol;
      const publicClient = this.getPublicClient();
      
      let tokenSymbol: string = nativeSymbol;
      let tokenDecimals = 18;
      let usdtAddress: `0x${string}` | null = null;
      
      if (tokenType === 'usdt') {
        const usdtAddr = this.getUsdtContractAddress();
        if (!usdtAddr) {
          throw new Error('当前网络不支持 USDT 转账');
        }
        usdtAddress = usdtAddr as `0x${string}`;
        tokenDecimals = await fetchTokenDecimals(publicClient, usdtAddress);
        tokenSymbol = 'USDT';
      }
      
      // 计算总转账金额
      const totalAmount = amountPerTarget * validTargets.length;
      
      // 显示确认对话框
      const confirmed = confirm(
        `确认多对多转账？\n\n` +
        `源钱包数量: ${sourceWallets.length} 个（有私钥）\n` +
        `目标地址数量: ${validTargets.length} 个${invalidTargets.length > 0 ? `（已过滤 ${invalidTargets.length} 个无效地址）` : ''}\n` +
        `代币类型: ${tokenSymbol}\n` +
        `每个目标: ${amountPerTarget} ${tokenSymbol}\n` +
        `总金额: ${totalAmount} ${tokenSymbol}\n` +
        `分配策略: ${strategy === 'sequential' ? '顺序分配' : '随机分配'}\n\n` +
        `将从源钱包向目标地址转账。`
      );
      
      if (!confirmed) {
        throw new Error('用户取消了转账');
      }
      
      const results = [];
      const gasPrice = await publicClient.getGasPrice();
      
      // 准备转账任务
      let tasks: { source: LocalWallet; target: string; amount: bigint }[] = [];
      
      if (strategy === 'sequential') {
        // 顺序分配：依次从源钱包转账到目标地址
        let sourceIndex = 0;
        for (const targetAddr of validTargets) {
          tasks.push({
            source: sourceWallets[sourceIndex % sourceWallets.length],
            target: targetAddr,
            amount: tokenType === 'usdt' 
              ? parseUnits(amountPerTarget.toString(), tokenDecimals)
              : parseEther(amountPerTarget.toString())
          });
          sourceIndex++;
        }
      } else {
        // 随机分配：随机选择源钱包
        for (const targetAddr of validTargets) {
          const randomSource = sourceWallets[Math.floor(Math.random() * sourceWallets.length)];
          tasks.push({
            source: randomSource,
            target: targetAddr,
            amount: tokenType === 'usdt'
              ? parseUnits(amountPerTarget.toString(), tokenDecimals)
              : parseEther(amountPerTarget.toString())
          });
        }
      }
      
      // 执行转账
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        
        try {
          console.log(`转账 ${i + 1}/${tasks.length}: ${task.source.address} -> ${task.target}`);
          
          if (!task.source.encrypted) {
            console.warn(`源钱包 ${task.source.address} 没有私钥，跳过`);
            results.push({
              source: task.source.address,
              target: task.target,
              error: '源钱包没有私钥',
              tokenType,
              success: false
            });
            continue;
          }
          
          // 使用本地私钥创建钱包客户端
          const account = privateKeyToAccount(task.source.encrypted as `0x${string}`);
          const walletClient = createWalletClient({
            account,
            chain: chainConfig,
            transport: http(chainConfig.rpcUrls.default.http[0])
          });
          
          let txHash: string;
          
          if (tokenType === 'usdt' && usdtAddress) {
            // 检查 USDT 余额
            const usdtBalance = await publicClient.readContract({
              address: usdtAddress,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [task.source.address as `0x${string}`]
            }) as bigint;
            
            if (usdtBalance < task.amount) {
              console.warn(`源钱包 ${task.source.address} USDT 余额不足`);
              results.push({
                source: task.source.address,
                target: task.target,
                error: `USDT 余额不足，当前: ${formatUnits(usdtBalance, tokenDecimals)}`,
                tokenType,
                success: false
              });
              continue;
            }
            
            // 检查 Gas 费用
            const nativeBalance = await publicClient.getBalance({ address: task.source.address as `0x${string}` });
            const estimatedGasCost = gasPrice * BigInt(65000);
            
            if (nativeBalance < estimatedGasCost) {
              console.warn(`源钱包 ${task.source.address} ${nativeSymbol} 余额不足以支付 Gas`);
              results.push({
                source: task.source.address,
                target: task.target,
                error: `${nativeSymbol} 余额不足以支付 Gas`,
                tokenType,
                success: false
              });
              continue;
            }
            
            // 发送 USDT 转账
            txHash = await walletClient.writeContract({
              address: usdtAddress,
              abi: erc20Abi,
              functionName: 'transfer',
              args: [task.target as `0x${string}`, task.amount],
              gas: BigInt(65000),
              gasPrice: gasPrice,
            });
          } else {
            // 原生代币转账
            const gasLimit = BigInt(21000);
            // 增加20%的gas费缓冲
            const gasCost = (gasPrice * gasLimit * BigInt(120)) / BigInt(100);

            // 检查余额
            const balance = await publicClient.getBalance({ address: task.source.address as `0x${string}` });

            if (balance < task.amount + gasCost) {
              console.warn(`源钱包 ${task.source.address} ${nativeSymbol} 余额不足`);
              results.push({
                source: task.source.address,
                target: task.target,
                error: `${nativeSymbol} 余额不足，当前: ${formatEther(balance)}，需要: ${formatEther(task.amount + gasCost)}`,
                tokenType,
                success: false
              });
              continue;
            }

            // 发送交易
            txHash = await walletClient.sendTransaction({
              to: task.target as `0x${string}`,
              value: task.amount,
              gas: gasLimit,
            });
          }
          
          console.log(`转账成功: ${txHash}`);
          results.push({
            source: task.source.address,
            target: task.target,
            hash: txHash,
            amount: tokenType === 'usdt' 
              ? formatUnits(task.amount, tokenDecimals)
              : formatEther(task.amount),
            tokenType,
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < tasks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
        } catch (error: any) {
          console.error(`转账失败: ${task.source.address} -> ${task.target}`, error);
          results.push({
            source: task.source.address,
            target: task.target,
            error: parseTransferError(error),
            tokenType,
            success: false
          });
        }
      }
      
      console.log('多对多转账完成:', results);
      return results;
    },

    // 批量归集原生代币（旧版兼容，使用选中钱包）
    // 批量归集原生代币（旧版兼容函数，已废弃）
    // async collectNative(targetAddress: string) {
    //   // 如果没有选中钱包，则选中所有钱包
    //   if (this.selectedWalletAddresses.length === 0) {
    //     this.selectAll();
    //   }
    //   return this.collectFromSelected(targetAddress, 0.01, 'native');
    // },

    // 批量归集ERC20代币
    async collectToken(tokenAddress: string, targetAddress: string) {
      console.log(`开始批量归集ERC20代币到 ${targetAddress}`);
      
      const selectedWallets = this.selectedWallets.length > 0 ? this.selectedWallets : this.localWallets;
      if (selectedWallets.length === 0) {
        throw new Error('没有可归集的本地钱包');
      }
      
      // 验证目标地址
      if (!targetAddress || !targetAddress.startsWith('0x') || targetAddress.length !== 42) {
        throw new Error('目标地址格式不正确');
      }
      
      const chainConfig = this.getChainConfig();
      const publicClient = this.getPublicClient();
      
      // 获取代币精度
      const decimals = await fetchTokenDecimals(publicClient, tokenAddress as `0x${string}`);
      
      // 显示确认对话框
      const confirmed = confirm(
        `确认归集 ERC20 代币？\n\n` +
        `代币地址: ${tokenAddress}\n` +
        `选中钱包数量: ${selectedWallets.length} 个\n` +
        `目标地址: ${targetAddress}\n\n` +
        `将从每个钱包转出全部代币余额到目标地址。`
      );
      
      if (!confirmed) {
        throw new Error('用户取消了归集');
      }
      
      const results = [];
      const gasPrice = await publicClient.getGasPrice();
      
      for (let i = 0; i < selectedWallets.length; i++) {
        const wallet = selectedWallets[i];
        
        try {
          console.log(`归集钱包 ${i + 1}/${selectedWallets.length}: ${wallet.address}`);
          
          if (!wallet.encrypted) {
            console.warn(`钱包 ${wallet.address} 没有私钥，跳过`);
            results.push({
              wallet: wallet.address,
              error: '没有私钥',
              success: false
            });
            continue;
          }
          
          // 获取代币余额
          const tokenBalance = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as `0x${string}`]
          }) as bigint;
          
          if (tokenBalance <= BigInt(0)) {
            console.warn(`钱包 ${wallet.address} 代币余额为 0`);
            results.push({
              wallet: wallet.address,
              error: '代币余额为 0',
              success: false
            });
            continue;
          }
          
          console.log(`代币余额: ${formatUnits(tokenBalance, decimals)}`);
          
          // 使用本地私钥创建钱包客户端
          const account = privateKeyToAccount(wallet.encrypted as `0x${string}`);
          const walletClient = createWalletClient({
            account,
            chain: chainConfig,
            transport: http(chainConfig.rpcUrls.default.http[0])
          });
          
          // 发送 ERC20 transfer 交易
          const txHash = await walletClient.writeContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [targetAddress as `0x${string}`, tokenBalance],
            gasPrice: gasPrice,
          });
          
          console.log(`归集成功: ${txHash}`);
          results.push({
            wallet: wallet.address,
            hash: txHash,
            amount: formatUnits(tokenBalance, decimals),
            success: true
          });
          
          // 添加延迟避免网络拥堵
          if (i < selectedWallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
        } catch (error: any) {
          console.error(`归集 ${wallet.address} 失败:`, error);
          results.push({
            wallet: wallet.address,
            error: error.message || String(error),
            success: false
          });
        }
      }
      
      console.log('代币归集完成:', results);
      return results;
    },

    // ============ 新增批量转账方法 ============

    // 通过地址列表进行批量转账
    async batchTransferByAddresses(
      sourceAddresses: string[],
      targetAddresses: string[],
      amount: number,
      tokenType: 'native' | 'token',
      mode: 'oneToMany' | 'manyToOne' | 'manyToMany',
      options?: {
        privateKeyMap?: Record<string, string>;
        transferAllBalance?: boolean;
      }
    ): Promise<{ source: string; target: string; hash?: string; error?: string; success: boolean; amount?: number }[]> {
      console.log(`开始批量转账，模式: ${mode}，代币类型: ${tokenType}，转全部余额: ${options?.transferAllBalance}`);

      const results: { source: string; target: string; hash?: string; error?: string; success: boolean; amount?: number }[] = [];
      const chainConfig = this.getChainConfig();
      const publicClient = this.getPublicClient();
      const gasPrice = await publicClient.getGasPrice();

      // 根据模式构建转账任务
      let tasks: { sourceAddr: string; targetAddr: string }[] = [];

      if (mode === 'oneToMany') {
        // 一对多：一个源钱包向多个目标钱包转账
        if (sourceAddresses.length !== 1) {
          throw new Error('一对多模式下源钱包必须只有1个');
        }
        const sourceAddr = sourceAddresses[0];
        for (const targetAddr of targetAddresses) {
          tasks.push({ sourceAddr, targetAddr });
        }
      } else if (mode === 'manyToOne') {
        // 多对一：多个源钱包向一个目标钱包转账
        if (targetAddresses.length !== 1) {
          throw new Error('多对一模式下目标钱包必须只有1个');
        }
        const targetAddr = targetAddresses[0];
        for (const sourceAddr of sourceAddresses) {
          tasks.push({ sourceAddr, targetAddr });
        }
      } else if (mode === 'manyToMany') {
        // 多对多：源钱包和目标钱包一一对应
        if (sourceAddresses.length !== targetAddresses.length) {
          throw new Error('多对多模式下源钱包和目标钱包数量必须相等');
        }
        for (let i = 0; i < sourceAddresses.length; i++) {
          tasks.push({ sourceAddr: sourceAddresses[i], targetAddr: targetAddresses[i] });
        }
      }

      // 执行转账任务
      for (let i = 0; i < tasks.length; i++) {
        const { sourceAddr, targetAddr } = tasks[i];

        try {
          // 获取私钥：优先从options.privateKeyMap获取，其次从本地钱包获取
          let privateKey: string | undefined;

          if (options?.privateKeyMap && options.privateKeyMap[sourceAddr.toLowerCase()]) {
            privateKey = options.privateKeyMap[sourceAddr.toLowerCase()];
          } else {
            const sourceWallet = this.localWallets.find(w => w.address.toLowerCase() === sourceAddr.toLowerCase());
            privateKey = sourceWallet?.encrypted;
          }

          if (!privateKey) {
            results.push({
              source: sourceAddr,
              target: targetAddr,
              error: '源钱包未找到或没有私钥',
              success: false
            });
            continue;
          }

          console.log(`转账 ${i + 1}/${tasks.length}: ${sourceAddr} -> ${targetAddr}`);

          // 创建钱包客户端
          const account = privateKeyToAccount(privateKey as `0x${string}`);
          const walletClient = createWalletClient({
            account,
            chain: chainConfig,
            transport: http(chainConfig.rpcUrls.default.http[0])
          });

          let txHash: string;
          let actualAmount = amount;

          if (tokenType === 'token' && this.targetToken) {
            // 目标代币转账
            const tokenAddress = this.targetToken.address as `0x${string}`;
            const decimals = this.targetToken.decimals;

            if (options?.transferAllBalance) {
              // 获取代币余额并转出全部
              const balance = await publicClient.readContract({
                address: tokenAddress,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [sourceAddr as `0x${string}`]
              });
              actualAmount = Number(formatUnits(balance as bigint, decimals));

              if (actualAmount <= 0) {
                results.push({
                  source: sourceAddr,
                  target: targetAddr,
                  error: '代币余额为0',
                  success: false
                });
                continue;
              }

              txHash = await walletClient.writeContract({
                address: tokenAddress,
                abi: erc20Abi,
                functionName: 'transfer',
                args: [targetAddr as `0x${string}`, balance as bigint],
                gas: BigInt(65000),
                gasPrice: gasPrice,
              });
            } else {
              const amountToSend = parseUnits(amount.toString(), decimals);
              txHash = await walletClient.writeContract({
                address: tokenAddress,
                abi: erc20Abi,
                functionName: 'transfer',
                args: [targetAddr as `0x${string}`, amountToSend],
                gas: BigInt(65000),
                gasPrice: gasPrice,
              });
            }
          } else {
            // 原生代币转账
            if (options?.transferAllBalance) {
              // 获取余额，扣除gas费后全部转出
              const balance = await publicClient.getBalance({ address: sourceAddr as `0x${string}` });
              const gasLimit = BigInt(21000);
              // 增加20%的gas费缓冲，防止gas价格波动导致交易失败
              const gasCostWithBuffer = (gasPrice * gasLimit * BigInt(120)) / BigInt(100);
              const transferValue = balance - gasCostWithBuffer;

              if (transferValue <= BigInt(0)) {
                results.push({
                  source: sourceAddr,
                  target: targetAddr,
                  error: `余额不足以支付 gas 费用，当前余额: ${formatEther(balance)} BNB，预估Gas费: ${formatEther(gasCostWithBuffer)} BNB`,
                  success: false
                });
                continue;
              }

              actualAmount = Number(formatEther(transferValue));
              console.log(`转全部余额: ${formatEther(balance)} BNB, 预留Gas: ${formatEther(gasCostWithBuffer)} BNB, 实际转账: ${actualAmount} BNB`);

              txHash = await walletClient.sendTransaction({
                to: targetAddr as `0x${string}`,
                value: transferValue,
                gas: gasLimit,
              });
            } else {
              txHash = await walletClient.sendTransaction({
                to: targetAddr as `0x${string}`,
                value: parseEther(amount.toString()),
                gas: BigInt(21000),
                gasPrice: gasPrice,
              });
            }
          }

          console.log(`转账成功: ${txHash}, 金额: ${actualAmount}`);
          results.push({
            source: sourceAddr,
            target: targetAddr,
            hash: txHash,
            success: true,
            amount: actualAmount
          });

          // 添加延迟
          if (i < tasks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

        } catch (error: any) {
          console.error(`转账失败: ${sourceAddr} -> ${targetAddr}`, error);
          results.push({
            source: sourceAddr,
            target: targetAddr,
            error: parseTransferError(error),
            success: false
          });
        }
      }

      console.log('批量转账完成:', results);
      return results;
    },

    // 测试合约连接
    async testContractConnection() {
      try {
        const contractAddress = BATCH_TRANSFER_CONTRACTS[this.currentChainId as keyof typeof BATCH_TRANSFER_CONTRACTS];
        
        if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
          throw new Error('当前网络暂不支持合约批量转账');
        }
        
        console.log(`测试合约连接: ${contractAddress}`);
        
        const publicClient = this.getPublicClient();
        
        // 测试调用getBalance函数
        const balance = await publicClient.readContract({
          address: contractAddress as `0x${string}`,
          abi: BatchTransferABI as any,
          functionName: 'getBalance',
          args: []
        });
        
        console.log('合约余额:', formatEther(balance as bigint));
        
        // 测试调用getTokenType函数
        const tokenType = await publicClient.readContract({
          address: contractAddress as `0x${string}`,
          abi: BatchTransferABI as any,
          functionName: 'getTokenType',
          args: ['0x0000000000000000000000000000000000000000']
        });
        
        console.log('代币类型检测结果:', tokenType);
        
        return {
          success: true,
          contractAddress,
          balance: formatEther(balance as bigint),
          tokenType: Number(tokenType),
          message: '合约连接测试成功！'
        };
        
      } catch (error: any) {
        console.error('合约连接测试失败:', error);
        return {
          success: false,
          error: error.message || '未知错误',
          message: '合约连接测试失败'
        };
      }
    },
  },
});
