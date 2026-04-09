/**
 * 迁移自动卖出状态管理
 *
 * 功能：
 * 1. 管理迁移监控生命周期
 * 2. 扫描钱包代币持仓
 * 3. 检测到迁移时自动执行 FourMeme 内盘卖出
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { createPublicClient, http, formatUnits } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { erc20Abi } from '../viem/abis/erc20';
import { useWalletStore } from './walletStore';
import { useChainStore } from './chainStore';
import {
  createFourMemeService,
  getPremiumSellRpc,
  ANTI_SANDWICH_RPC,
  type FourMemeTradeParams
} from '../services/fourMemeService';
import {
  createMigrationService,
  MigrationService,
  type MigrationEvent,
  type MigrationLog
} from '../services/migrationService';

// ==================== 类型定义 ====================

export interface TokenHolding {
  address: string;
  symbol: string;
  decimals: number;
  walletBalances: Map<string, bigint>; // walletAddress → balance
}

export interface SellResult {
  tokenAddress: string;
  walletAddress: string;
  success: boolean;
  txHash?: string;
  error?: string;
  timestamp: number;
}

export interface MigrationConfig {
  sellPercent: number;       // 卖出百分比 (1-100)
  batchSize: number;         // 并发数
  slippage: number;          // 滑点百分比
  gasPrice: number;          // Gas Price (0=自动)
  gasLimit: number;          // Gas Limit (0=自动)
  pollInterval: number;      // 轮询间隔 ms
  autoSellEnabled: boolean;  // 是否自动卖出
}

// 辅助：生成唯一 ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ==================== Store ====================

export const useMigrationStore = defineStore('migration', () => {
  // ==================== 状态 ====================

  const isMonitoring = ref(false);
  const logs = ref<MigrationLog[]>([]);
  const monitoredTokens = ref<Map<string, TokenHolding>>(new Map());
  const migrationEvents = ref<MigrationEvent[]>([]);
  const sellResults = ref<SellResult[]>([]);
  const isScanning = ref(false);
  const isSelling = ref(false);

  // 选择使用的钱包模式
  const walletMode = ref<'selected' | 'batch' | 'all'>('all');
  const selectedBatchId = ref('');

  const config = ref<MigrationConfig>({
    sellPercent: 100,
    batchSize: 5,
    slippage: 0,
    gasPrice: 0,
    gasLimit: 0,
    pollInterval: 3000,
    autoSellEnabled: true,
  });

  // 服务实例
  let migrationService: MigrationService | null = null;

  // 正在卖出的代币（防止同一代币重复触发）
  const sellingTokens = new Set<string>();

  // ==================== 钱包工具方法 ====================

  /**
   * 获取要使用的钱包地址列表
   */
  function getWalletAddresses(): string[] {
    const walletStore = useWalletStore();
    const addresses = new Set<string>();

    if (walletMode.value === 'selected') {
      // 使用已勾选的钱包
      for (const addr of walletStore.selectedWalletAddresses) {
        addresses.add(addr.toLowerCase());
      }
    } else if (walletMode.value === 'batch') {
      // 使用指定批次
      const batch = walletStore.walletBatches.find(b => b.id === selectedBatchId.value);
      if (batch) {
        for (const w of batch.wallets) {
          if (w.privateKey) {
            addresses.add(w.address.toLowerCase());
          }
        }
      }
    } else {
      // 全部钱包
      for (const w of walletStore.localWallets) {
        if (w.encrypted) {
          addresses.add(w.address.toLowerCase());
        }
      }
      for (const batch of walletStore.walletBatches) {
        for (const w of batch.wallets) {
          if (w.privateKey) {
            addresses.add(w.address.toLowerCase());
          }
        }
      }
    }

    return Array.from(addresses);
  }

  /**
   * 获取钱包私钥（复用 taskStore 的模式）
   */
  function getWalletPrivateKey(walletAddress: string): string | null {
    const walletStore = useWalletStore();

    // 1. 检查本地钱包
    const localWallet = walletStore.localWallets.find(
      w => w.address.toLowerCase() === walletAddress.toLowerCase()
    );
    if (localWallet?.encrypted) {
      return localWallet.encrypted;
    }

    // 2. 检查钱包批次
    for (const batch of walletStore.walletBatches) {
      const batchWallet = batch.wallets.find(
        w => w.address.toLowerCase() === walletAddress.toLowerCase()
      );
      if (batchWallet?.privateKey) {
        return batchWallet.privateKey;
      }
    }

    return null;
  }

  // ==================== 代币扫描 ====================

  /**
   * 扫描代币持仓
   * @param tokenAddresses 要扫描的代币地址（可选，不提供则使用已有列表）
   */
  async function scanTokenHoldings(tokenAddresses?: string[]): Promise<void> {
    if (isScanning.value) {
      addLog('warning', '扫描正在进行中，请等待完成');
      return;
    }

    isScanning.value = true;
    addLog('info', '开始扫描代币持仓...');

    try {
      const chainStore = useChainStore();
      const chain = chainStore.selectedChainId === 97 ? bscTestnet : bsc;
      const rpcUrl = chainStore.effectiveRpcUrl;

      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
        batch: { multicall: true }
      });

      const walletAddresses = getWalletAddresses();
      if (walletAddresses.length === 0) {
        addLog('warning', '没有可用的钱包地址');
        isScanning.value = false;
        return;
      }

      // 确定要扫描的代币列表
      const tokensToScan = tokenAddresses
        ? tokenAddresses.map(t => t.toLowerCase())
        : Array.from(monitoredTokens.value.keys());

      if (tokensToScan.length === 0) {
        addLog('warning', '没有需要扫描的代币，请先添加代币地址');
        isScanning.value = false;
        return;
      }

      addLog('info', `扫描 ${tokensToScan.length} 个代币 × ${walletAddresses.length} 个钱包...`);

      // 使用 multicall 批量查询
      const newTokens = new Map<string, TokenHolding>();

      for (const tokenAddr of tokensToScan) {
        try {
          // 查询代币信息
          const [symbol, decimals] = await Promise.all([
            publicClient.readContract({
              address: tokenAddr as `0x${string}`,
              abi: erc20Abi,
              functionName: 'symbol'
            }).catch(() => 'UNKNOWN'),
            publicClient.readContract({
              address: tokenAddr as `0x${string}`,
              abi: erc20Abi,
              functionName: 'decimals'
            }).catch(() => 18)
          ]);

          // 批量查询所有钱包的余额
          const balancePromises = walletAddresses.map(walletAddr =>
            publicClient.readContract({
              address: tokenAddr as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [walletAddr as `0x${string}`]
            }).catch(() => 0n)
          );

          const balances = await Promise.all(balancePromises);

          // 构建余额 Map，只保留有余额的钱包
          const walletBalances = new Map<string, bigint>();
          let hasAnyBalance = false;

          for (let i = 0; i < walletAddresses.length; i++) {
            const balance = balances[i] as bigint;
            if (balance > 0n) {
              walletBalances.set(walletAddresses[i], balance);
              hasAnyBalance = true;
            }
          }

          if (hasAnyBalance) {
            newTokens.set(tokenAddr, {
              address: tokenAddr,
              symbol: symbol as string,
              decimals: Number(decimals),
              walletBalances
            });

            const totalBalance = Array.from(walletBalances.values()).reduce((a, b) => a + b, 0n);
            addLog('info', `${symbol}: ${walletBalances.size} 个钱包有持仓，总余额 ${formatUnits(totalBalance, Number(decimals))}`);
          } else {
            // 保留无余额的代币在列表中（方便监控新买入的代币）
            newTokens.set(tokenAddr, {
              address: tokenAddr,
              symbol: symbol as string,
              decimals: Number(decimals),
              walletBalances: new Map()
            });
            addLog('info', `${symbol}: 所有钱包余额为 0`);
          }
        } catch (error: any) {
          addLog('error', `查询代币 ${tokenAddr.slice(0, 10)}... 失败: ${error.message}`);
        }
      }

      // 更新监控列表
      monitoredTokens.value = newTokens;

      // 如果正在监控，更新服务的代币列表
      if (migrationService) {
        migrationService.updateMonitoredTokens(new Set(newTokens.keys()));
      }

      addLog('success', `扫描完成，共 ${newTokens.size} 个代币`);
    } catch (error: any) {
      addLog('error', `扫描失败: ${error.message}`);
    } finally {
      isScanning.value = false;
    }
  }

  /**
   * 手动添加代币地址
   */
  async function addToken(tokenAddress: string): Promise<boolean> {
    const addr = tokenAddress.trim().toLowerCase();
    if (!addr.match(/^0x[a-fA-F0-9]{40}$/)) {
      addLog('error', '无效的代币地址');
      return false;
    }

    if (monitoredTokens.value.has(addr)) {
      addLog('warning', '该代币已在监控列表中');
      return false;
    }

    // 先添加占位，然后扫描获取详细信息
    monitoredTokens.value.set(addr, {
      address: addr,
      symbol: '...',
      decimals: 18,
      walletBalances: new Map()
    });

    // 扫描这个代币的持仓
    await scanTokenHoldings([addr]);
    return true;
  }

  /**
   * 移除监控代币
   */
  function removeToken(tokenAddress: string): void {
    monitoredTokens.value.delete(tokenAddress.toLowerCase());

    // 更新服务的代币列表
    if (migrationService) {
      migrationService.updateMonitoredTokens(new Set(monitoredTokens.value.keys()));
    }

    addLog('info', `已移除代币 ${tokenAddress.slice(0, 10)}...`);
  }

  // ==================== 监控生命周期 ====================

  async function startMonitoring(): Promise<void> {
    if (isMonitoring.value) {
      addLog('warning', '监控已在运行中');
      return;
    }

    const chainStore = useChainStore();

    // 如果没有代币，提示
    if (monitoredTokens.value.size === 0) {
      addLog('warning', '请先添加要监控的代币地址');
      return;
    }

    // 创建服务
    migrationService = createMigrationService(
      chainStore.selectedChainId,
      chainStore.effectiveRpcUrl,
      config.value.pollInterval
    );

    // 设置回调
    migrationService.setOnMigrationDetected((event) => {
      handleMigration(event);
    });

    migrationService.setOnLog((log) => {
      logs.value.push(log);
      // 限制日志数量
      if (logs.value.length > 500) {
        logs.value = logs.value.slice(-400);
      }
    });

    // 传入监控代币列表
    migrationService.updateMonitoredTokens(new Set(monitoredTokens.value.keys()));

    // 启动
    try {
      await migrationService.start();
      isMonitoring.value = true;
    } catch (error: any) {
      addLog('error', `启动监控失败: ${error.message}`);
      migrationService.destroy();
      migrationService = null;
    }
  }

  function stopMonitoring(): void {
    if (migrationService) {
      migrationService.stop();
      migrationService.destroy();
      migrationService = null;
    }
    isMonitoring.value = false;
  }

  // ==================== 自动卖出 ====================

  /**
   * 处理迁移事件，执行自动卖出
   */
  async function handleMigration(event: MigrationEvent): Promise<void> {
    // 记录事件
    migrationEvents.value.push(event);

    addLog('success', `🔔 检测到迁移事件！代币: ${event.tokenAddress.slice(0, 10)}...，来源: ${event.source}`);

    if (!config.value.autoSellEnabled) {
      addLog('info', '自动卖出已关闭，仅记录事件');
      return;
    }

    const tokenAddr = event.tokenAddress.toLowerCase();

    // 防止同一代币重复触发卖出
    if (sellingTokens.has(tokenAddr)) {
      addLog('warning', `代币 ${event.tokenAddress.slice(0, 10)}... 正在卖出中，跳过重复触发`);
      return;
    }

    sellingTokens.add(tokenAddr);
    isSelling.value = true;

    try {
      await executeBatchSell(event.tokenAddress);
    } finally {
      sellingTokens.delete(tokenAddr);
      if (sellingTokens.size === 0) {
        isSelling.value = false;
      }
    }
  }

  /**
   * 执行批量卖出（复用 taskStore.batchSellForTask 的内盘模式）
   */
  async function executeBatchSell(tokenAddress: string): Promise<void> {
    const tokenAddr = tokenAddress.toLowerCase();
    const tokenInfo = monitoredTokens.value.get(tokenAddr);

    // 获取所有持有该代币的钱包
    const walletAddresses = getWalletAddresses();
    const walletsWithBalance: string[] = [];

    if (tokenInfo && tokenInfo.walletBalances.size > 0) {
      // 使用缓存的余额信息
      for (const addr of walletAddresses) {
        const balance = tokenInfo.walletBalances.get(addr);
        if (balance && balance > 0n) {
          walletsWithBalance.push(addr);
        }
      }
    } else {
      // 没有缓存信息，使用所有钱包（prepareSell 会检查余额）
      walletsWithBalance.push(...walletAddresses);
    }

    if (walletsWithBalance.length === 0) {
      addLog('warning', `代币 ${tokenAddress.slice(0, 10)}... 没有钱包有持仓，跳过卖出`);
      return;
    }

    addLog('info', `开始批量卖出 ${tokenAddress.slice(0, 10)}...，涉及 ${walletsWithBalance.length} 个钱包`);

    const chainStore = useChainStore();
    const chainId = chainStore.selectedChainId;
    const sellRpc = getPremiumSellRpc();

    // 创建 FourMemeService
    const fourMemeService = createFourMemeService(chainId, sellRpc, sellRpc);

    const batchSize = config.value.batchSize || 5;

    // ========== 阶段1: 准备（检查余额 + 授权）==========
    addLog('info', `[阶段1] 准备卖出，检查余额和授权，钱包数: ${walletsWithBalance.length}...`);

    const allPrepareResults: ({ walletAddress: string; privateKey: string; sellAmount: bigint } | null)[] = [];

    for (let i = 0; i < walletsWithBalance.length; i += batchSize) {
      const batch = walletsWithBalance.slice(i, i + batchSize);

      const preparePromises = batch.map(async (walletAddress) => {
        const privateKey = getWalletPrivateKey(walletAddress);
        if (!privateKey) {
          addLog('error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
          return null;
        }

        try {
          const prepareResult = await fourMemeService.prepareSell({
            chainId,
            rpcUrl: sellRpc,
            privateKey,
            walletAddress,
            tokenAddress: tokenAddr,
            amount: 0,
            mode: 'sell',
            gasPrice: config.value.gasPrice,
            gasLimit: config.value.gasLimit,
            sellPercent: config.value.sellPercent,
            slippage: config.value.slippage,
          });

          if (prepareResult.success) {
            if (prepareResult.needsApproval) {
              addLog('info', `${walletAddress.slice(0, 10)}... 授权完成`);
            } else {
              addLog('info', `${walletAddress.slice(0, 10)}... 已授权，准备就绪`);
            }
            return { walletAddress, privateKey, sellAmount: prepareResult.sellAmount };
          } else {
            addLog('error', `${walletAddress.slice(0, 10)}... 准备失败: ${prepareResult.error}`);
            return null;
          }
        } catch (error: any) {
          addLog('error', `${walletAddress.slice(0, 10)}... 准备异常: ${error.message}`);
          return null;
        }
      });

      const batchResults = await Promise.all(preparePromises);
      allPrepareResults.push(...batchResults);

      addLog('info', `[阶段1] 已完成 ${Math.min(i + batchSize, walletsWithBalance.length)}/${walletsWithBalance.length} 个钱包`);
    }

    const readyWallets = allPrepareResults.filter(
      (r): r is { walletAddress: string; privateKey: string; sellAmount: bigint } => r !== null
    );

    if (readyWallets.length === 0) {
      addLog('warning', '没有钱包准备成功，取消批量卖出');
      return;
    }

    // ========== 阶段2: 发送卖出交易 ==========
    addLog('info', `[阶段2] 准备完成，${readyWallets.length} 个钱包分批发送卖出交易（每批 ${batchSize} 个）...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < readyWallets.length; i += batchSize) {
      const batch = readyWallets.slice(i, i + batchSize);

      const sellPromises = batch.map(async ({ walletAddress, privateKey, sellAmount }) => {
        try {
          const result = await fourMemeService.executeSellDirect({
            chainId,
            rpcUrl: sellRpc,
            privateKey,
            walletAddress,
            tokenAddress: tokenAddr,
            amount: 0,
            mode: 'sell',
            gasPrice: config.value.gasPrice,
            gasLimit: config.value.gasLimit,
            slippage: config.value.slippage,
          }, sellAmount);

          const sellResult: SellResult = {
            tokenAddress: tokenAddr,
            walletAddress,
            success: result.success,
            txHash: result.txHash,
            error: result.error,
            timestamp: Date.now()
          };

          sellResults.value.push(sellResult);

          if (result.success) {
            successCount++;
            addLog('success', `[卖出] ${walletAddress.slice(0, 10)}... 成功`, result.txHash);
          } else {
            failCount++;
            addLog('error', `[卖出] ${walletAddress.slice(0, 10)}... 失败: ${result.error}`);
          }
        } catch (error: any) {
          failCount++;
          addLog('error', `[卖出] ${walletAddress.slice(0, 10)}... 异常: ${error.message}`);
        }
      });

      await Promise.allSettled(sellPromises);

      addLog('info', `[阶段2] 已完成 ${Math.min(i + batchSize, readyWallets.length)}/${readyWallets.length} 个钱包`);

      // 批次间等待
      if (i + batchSize < readyWallets.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    addLog('info', `批量卖出完成，成功 ${successCount} 笔，失败 ${failCount} 笔`);
  }

  /**
   * 手动触发卖出（对指定代币）
   */
  async function manualSell(tokenAddress: string): Promise<void> {
    const tokenAddr = tokenAddress.toLowerCase();

    if (sellingTokens.has(tokenAddr)) {
      addLog('warning', '该代币正在卖出中');
      return;
    }

    sellingTokens.add(tokenAddr);
    isSelling.value = true;

    try {
      await executeBatchSell(tokenAddress);
    } finally {
      sellingTokens.delete(tokenAddr);
      if (sellingTokens.size === 0) {
        isSelling.value = false;
      }
    }
  }

  // ==================== 日志管理 ====================

  function addLog(type: MigrationLog['type'], message: string, data?: any): void {
    logs.value.push({
      timestamp: Date.now(),
      type,
      message,
      data
    });

    // 限制日志数量
    if (logs.value.length > 500) {
      logs.value = logs.value.slice(-400);
    }
  }

  function clearLogs(): void {
    logs.value = [];
  }

  // ==================== 返回 ====================

  return {
    // 状态
    isMonitoring,
    logs,
    monitoredTokens,
    migrationEvents,
    sellResults,
    isScanning,
    isSelling,
    config,
    walletMode,
    selectedBatchId,

    // 代币管理
    addToken,
    removeToken,
    scanTokenHoldings,

    // 监控控制
    startMonitoring,
    stopMonitoring,

    // 卖出
    manualSell,

    // 日志
    addLog,
    clearLogs,
  };
});
