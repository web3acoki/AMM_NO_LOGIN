import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWalletStore } from './walletStore';
import { useDexStore } from './dexStore';
import { createTradingService, resetNonceForAddress as resetTradingNonceForAddress, type TradeParams } from '../services/tradingService';
import { createFourMemeService, FourMemeService, ANTI_SANDWICH_RPC, getPremiumSellRpc, resetNonceForAddress as resetFourMemeNonceForAddress, type FourMemeRoundPrefetchData, type FourMemeTradeParams, type SellPrepareResult } from '../services/fourMemeService';
import { PriceCalculator } from '../utils/priceCalculator';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { bsc, bscTestnet, okc } from 'viem/chains';
import { robinhood } from '../viem/chains/robinhood';
import * as taskApi from '../services/taskApi';
import { ENABLE_LOGIN } from '../config';
import { PONS_V3_POOL_FEE, ROBINHOOD_WETH_ADDRESS } from '../constants';
import { UniswapV3Service, formatV3PriceFraction, getV3SpotPriceFraction } from '../services/uniswapV3Service';
import { readAndValidatePonsLaunchedToken } from '../services/ponsService';
import { withMarketLease, withTransferLease, type TransferLeaseGuard } from '../services/transferLeaseApi';
import {
  checkUnresolvedTransaction,
  markUnresolvedTransaction,
  type UnresolvedTransactionStatus,
} from '../services/unresolvedTransactionGuard';
import { WALLET_PENDING_PREDECESSOR_CODE } from '../services/pendingNonceGuard';

function shouldUseServerMode(): boolean {
  return ENABLE_LOGIN && taskApi.isLoggedIn();
}

function coordinationAuthRequiredError(): Error & { code: string } {
  const error = new Error('登录状态已失效，已停止交易；请重新登录后再执行') as Error & { code: string };
  error.code = 'COORDINATION_AUTH_REQUIRED';
  return error;
}

// 日志条目接口
export interface LogEntry {
  id: string;
  timestamp: number;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  walletAddress?: string;
  txHash?: string;
}

// 任务配置接口
export interface TaskConfig {
  chainId: number;            // 创建任务时的链快照，运行中不跟随全局切链
  dexId: string;              // pancake-v2-mainnet / pancake-v2-testnet / uniswap-v3
  rpcUrl: string;             // 创建任务时的执行 RPC 快照
  launchpadId: 'fourmeme' | 'pons';
  v3FeeTier?: number;         // Robinhood / Pons 固定使用 10000 (1%)
  tokenContract: string;      // 代币合约地址
  targetPrice: number;        // 目标价格
  targetMarketCap?: number;   // 目标市值（任务链原生币）
  amountMin: number;          // 金额区间最小值（任务链原生币）
  amountMax: number;          // 金额区间最大值（任务链原生币）
  stopType: 'none' | 'count' | 'amount' | 'time' | 'price' | 'marketcap';  // 停止类型，none=永不停止
  stopValue: number;          // 停止条件值
  interval: number;           // 交易间隔(秒)
  buyThreadCount: number;     // 买入线程数：每个间隔内同时执行买入的钱包数量
  sellThreadCount: number;    // 卖出线程数：每个间隔内同时执行卖出的钱包数量
  gasPrice?: number;          // 自定义Gas价格 (Gwei)
  gasLimit?: number;          // 自定义Gas上限
  sellAll?: boolean;          // 卖出时是否卖出全部（当 sellThreadCount > 0 时生效）
  marketType: 'inner' | 'outer';  // 盘口类型：inner=内盘(FourMeme), outer=外盘(DEX)
  innerTokenAddress?: string; // 内盘目标代币地址（仅内盘模式使用）
  innerSlippage?: number;     // 内盘滑点百分比（例如: 10 表示 10%）
  antiSandwichRpc?: string;   // 防夹节点 RPC URL（内盘和外盘都使用）
  poolBaseToken?: string;     // 底池基础代币地址（ASTER底池时设置）
  buyUsePremiumRpc?: boolean; // 买入是否也使用高速节点（默认否，仅卖出使用）
}

const DEFAULT_BSC_RPC = 'https://bsc-dataseed.binance.org';
const DEFAULT_BSC_TESTNET_RPC = 'https://bsc-testnet.publicnode.com';
const DEFAULT_OKX_RPC = 'https://exchainrpc.okex.org';
const DEFAULT_ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';

function defaultRpcForChain(chainId: number): string {
  switch (chainId) {
    case 56: return DEFAULT_BSC_RPC;
    case 97: return DEFAULT_BSC_TESTNET_RPC;
    case 66: return DEFAULT_OKX_RPC;
    case 4663: return DEFAULT_ROBINHOOD_RPC;
    default: throw new Error(`不支持的任务链 ID: ${chainId}`);
  }
}

function getTaskChain(chainId: number) {
  switch (chainId) {
    case 56: return bsc;
    case 97: return bscTestnet;
    case 66: return okc;
    case 4663: return robinhood;
    default: throw new Error(`不支持的任务链 ID: ${chainId}`);
  }
}

function normalizeTaskConfig(config: TaskConfig | (Partial<TaskConfig> & Pick<TaskConfig, 'tokenContract' | 'marketType'>)): TaskConfig {
  const chainId = Number(config.chainId ?? 56);
  if (![56, 97, 66, 4663].includes(chainId)) {
    throw new Error(`不支持的任务链 ID: ${chainId}`);
  }

  let dexId = config.dexId || (
    chainId === 4663 ? 'uniswap-v3'
      : chainId === 97 ? 'pancake-v2-testnet'
        : chainId === 66 ? 'okx-swap'
          : 'pancake-v2-mainnet'
  );
  // 后端为兼容旧数据会返回 canonical `pancake-v2`；前端 DEX 注册表
  // 按主网/测试网拆分 ID，在执行前恢复为对应实例。
  if (dexId === 'pancake-v2') {
    dexId = chainId === 97 ? 'pancake-v2-testnet' : 'pancake-v2-mainnet';
  }
  const launchpadId = config.launchpadId || (chainId === 4663 ? 'pons' : 'fourmeme');

  if (chainId === 4663 && (dexId !== 'uniswap-v3' || launchpadId !== 'pons')) {
    throw new Error('Robinhood Chain 任务只允许 Uniswap V3 + Pons');
  }
  if (chainId !== 4663 && (dexId === 'uniswap-v3' || launchpadId === 'pons')) {
    throw new Error('Uniswap V3 / Pons 任务仅支持 Robinhood Chain');
  }

  return {
    ...config,
    chainId,
    dexId,
    launchpadId,
    rpcUrl: config.rpcUrl || defaultRpcForChain(chainId),
    v3FeeTier: chainId === 4663 ? 10000 : config.v3FeeTier,
    poolBaseToken: chainId === 4663 ? undefined : config.poolBaseToken,
  } as TaskConfig;
}

function isFourMemeTask(task: Task): boolean {
  return task.config.chainId !== 4663 && task.config.marketType === 'inner';
}

function taskNativeSymbol(task: Task): string {
  return task.config.chainId === 4663 ? 'ETH' : task.config.chainId === 66 ? 'OKB' : 'BNB';
}

function taskTradeSlippage(task: Task): number {
  if (task.config.chainId !== 4663) return 30;

  const configured = task.config.innerSlippage;
  if (configured === undefined || configured === null) return 30;

  // The existing task UI defines 0 as "no limit". Uniswap V3 represents that
  // as 100% slippage (amountOutMinimum = 0), whereas passing 0 would enforce the
  // quoted output exactly. Keep FourMeme/BSC behavior unchanged.
  return configured <= 0 ? 100 : configured;
}

// 任务统计接口
export interface TaskStats {
  buyCount: number;           // 买入执行次数
  sellCount: number;          // 卖出执行次数
  spentAmount: number;        // 已花费金额
  startTime?: number;         // 开始时间
  elapsedTime: number;        // 已运行时间(秒)
}

// 任务接口
export interface Task {
  _id?: string;                 // 服务端 MongoDB ID
  id: string;
  name: string;
  status: 'running' | 'paused' | 'stopped';
  config: TaskConfig;
  walletAddresses: string[];  // 选中的钱包地址列表
  logs: LogEntry[];
  stats: TaskStats;
  intervalId?: number;        // 定时器ID
  currentBuyWalletIndex: number;  // 买入轮询钱包索引（round-robin）
  currentSellWalletIndex: number; // 卖出轮询钱包索引（round-robin）
  preApprovalDone?: boolean;      // 预授权是否完成（ASTER 池）
}

export const useTaskStore = defineStore('task', () => {
  // 状态
  const tasks = ref<Task[]>([]);
  const activeLogTaskId = ref<string | null>(null);  // 当前查看日志的任务ID

  // 缓存每个任务的 FourMemeService 实例（避免每次执行都重新创建）
  const fourMemeServiceCache = new Map<string, InstanceType<typeof FourMemeService>>();

  // 预授权状态跟踪（ASTER 池任务创建时发起预授权，开始时检查是否完成）
  const preApprovalTracker = new Map<string, {
    promise: Promise<void>;
    completed: boolean;
    generation: number;
  }>();
  const preApprovalGenerations = new Map<string, number>();

  function invalidatePreApprovalRun(taskId: string): void {
    preApprovalGenerations.set(taskId, (preApprovalGenerations.get(taskId) || 0) + 1);
    preApprovalTracker.delete(taskId);
  }

  // 每个任务同一时刻只能执行一轮自动交易。该 Promise 也用于
  // 手工批量卖出在发单前等待已经进入链上写入阶段的轮次收尾。
  const activeRoundPromises = new Map<string, Promise<void>>();

  // 防止同一浏览器内重复点击同一任务的手工批量卖出。
  const activeBatchSellTaskIds = new Set<string>();
  // 不同任务可能包含同一钱包，所以仅按 taskId 防重不足够。
  const activeBatchSellWalletKeys = new Set<string>();
  // 不同钱包交易同一个代币仍会共同改变同一个池/曲线，所以手工批卖
  // 还必须按“链 + 代币”互斥。
  const activeBatchSellMarketKeys = new Set<string>();
  // 同一浏览器内的所有自动/手工任务也必须按钱包串行。服务端租约负责
  // 跨标签页和跨设备，这个队列避免同一页面里的任务互相拿到 LEASE_BUSY。
  const taskWalletOperationLocks = new Map<string, Promise<void>>();
  // 同一页面内按代币市场串行。服务端 MarketLease 负责跨标签页/设备。
  const taskMarketOperationLocks = new Map<string, Promise<void>>();

  class TaskRoundCancelledError extends Error {
    constructor() {
      super('任务已暂停，本轮尚未开始的交易已取消');
      this.name = 'TaskRoundCancelledError';
    }
  }

  function taskWalletLeaseKey(chainId: number, walletAddress: string): string {
    return `${chainId}:${walletAddress.trim().toLowerCase()}`;
  }

  function taskTokenAddress(task: Task): string {
    return (task.config.marketType === 'inner'
      ? (task.config.innerTokenAddress || task.config.tokenContract)
      : task.config.tokenContract
    ).trim();
  }

  function taskMarketLeaseKey(chainId: number, tokenAddress: string): string {
    return `${chainId}:${tokenAddress.trim().toLowerCase()}`;
  }

  function combineLeaseGuards(
    ...guards: Array<TransferLeaseGuard | undefined>
  ): TransferLeaseGuard | undefined {
    const activeGuards = guards.filter((guard): guard is TransferLeaseGuard => !!guard);
    if (activeGuards.length === 0) return undefined;
    return {
      assertActive() {
        for (const guard of activeGuards) guard.assertActive();
      },
      retainUntil(settlement) {
        const completions = activeGuards
          .map(guard => guard.retainUntil?.(settlement))
          .filter((completion): completion is Promise<void> => !!completion);
        return Promise.allSettled(
          completions.length > 0 ? completions : [Promise.resolve(settlement).then(() => undefined)],
        ).then(() => undefined);
      },
    };
  }

  /**
   * Keep the in-page queue closed until the server lease has actually been
   * released. This prevents the next queued trade from racing the DELETE and
   * being falsely rejected as MARKET/TRANSFER_LEASE_BUSY.
   */
  function coordinateLocalAndServerLease(
    localGuard: TransferLeaseGuard,
    serverGuard: TransferLeaseGuard,
  ): TransferLeaseGuard {
    return {
      assertActive() {
        localGuard.assertActive();
        serverGuard.assertActive();
      },
      retainUntil(settlement) {
        const serverReleased = serverGuard.retainUntil?.(settlement)
          ?? Promise.resolve(settlement).then(() => undefined, () => undefined);
        return localGuard.retainUntil?.(serverReleased) ?? serverReleased;
      },
    };
  }

  function runTrackedRound(taskId: string, runner: () => Promise<void>): Promise<void> {
    const existing = activeRoundPromises.get(taskId);
    if (existing) return existing;

    let trackedPromise!: Promise<void>;
    trackedPromise = Promise.resolve()
      .then(runner)
      .finally(() => {
        if (activeRoundPromises.get(taskId) === trackedPromise) {
          activeRoundPromises.delete(taskId);
        }
      });
    activeRoundPromises.set(taskId, trackedPromise);
    return trackedPromise;
  }

  async function withTaskWalletLease<T>(
    chainId: number,
    walletAddress: string,
    callback: (leaseGuard?: TransferLeaseGuard) => Promise<T>,
  ): Promise<T> {
    const key = taskWalletLeaseKey(chainId, walletAddress);
    const previous = taskWalletOperationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    taskWalletOperationLocks.set(key, queued);
    await previous;

    let retainedUntil: Promise<unknown> | null = null;
    let resolveCleanupCompleted!: () => void;
    const cleanupCompleted = new Promise<void>(resolve => {
      resolveCleanupCompleted = resolve;
    });
    const localGuard: TransferLeaseGuard = {
      assertActive() {},
      retainUntil(settlement) {
        const safeSettlement = Promise.resolve(settlement).catch(() => undefined);
        retainedUntil = retainedUntil
          ? Promise.allSettled([retainedUntil, safeSettlement])
          : safeSettlement;
        return cleanupCompleted;
      },
    };
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      release();
      if (taskWalletOperationLocks.get(key) === queued) {
        taskWalletOperationLocks.delete(key);
      }
      resolveCleanupCompleted();
    };

    try {
      if (!ENABLE_LOGIN) return await callback(localGuard);
      if (!taskApi.isLoggedIn()) throw coordinationAuthRequiredError();
      return await withTransferLease(chainId, walletAddress, serverGuard => (
        callback(coordinateLocalAndServerLease(localGuard, serverGuard))
      ));
    } finally {
      const retention = retainedUntil as Promise<unknown> | null;
      if (retention) void retention.finally(cleanup);
      else cleanup();
    }
  }

  async function withTaskMarketLease<T>(
    chainId: number,
    tokenAddress: string,
    callback: (leaseGuard?: TransferLeaseGuard) => Promise<T>,
    shouldAcquire?: () => boolean,
  ): Promise<T> {
    const key = taskMarketLeaseKey(chainId, tokenAddress);
    const previous = taskMarketOperationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    taskMarketOperationLocks.set(key, queued);
    await previous;

    let retainedUntil: Promise<unknown> | null = null;
    let resolveCleanupCompleted!: () => void;
    const cleanupCompleted = new Promise<void>(resolve => {
      resolveCleanupCompleted = resolve;
    });
    const localGuard: TransferLeaseGuard = {
      assertActive() {},
      retainUntil(settlement) {
        const safeSettlement = Promise.resolve(settlement).catch(() => undefined);
        retainedUntil = retainedUntil
          ? Promise.allSettled([retainedUntil, safeSettlement])
          : safeSettlement;
        return cleanupCompleted;
      },
    };
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      release();
      if (taskMarketOperationLocks.get(key) === queued) {
        taskMarketOperationLocks.delete(key);
      }
      resolveCleanupCompleted();
    };

    try {
      // Promise.all 已经排队的自动交易，在前一笔使任务暂停后不得再去
      // 申请服务端锁，更不得继续广播。
      if (shouldAcquire && !shouldAcquire()) throw new TaskRoundCancelledError();
      if (!ENABLE_LOGIN) return await callback(localGuard);
      if (!taskApi.isLoggedIn()) throw coordinationAuthRequiredError();
      return await withMarketLease(chainId, tokenAddress, serverGuard => (
        callback(coordinateLocalAndServerLease(localGuard, serverGuard))
      ));
    } finally {
      const retention = retainedUntil as Promise<unknown> | null;
      if (retention) void retention.finally(cleanup);
      else cleanup();
    }
  }

  function isCoordinationLeaseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code || '')
      : '';
    return /^(TRANSFER|MARKET)_LEASE_(BUSY|LOST)$/.test(code)
      || code === 'COORDINATION_AUTH_REQUIRED'
      || /transfer lease|market lease|TRANSFER_LEASE_BUSY|MARKET_LEASE_BUSY|全局锁|锁定该地址|代币市场|另一个交易任务/i.test(message);
  }

  function markTaskUnresolvedTransaction(
    task: Task,
    walletAddress: string,
    status: UnresolvedTransactionStatus,
    txHash: string | undefined,
    rpcUrl: string,
    receiptRequired = false,
  ): void {
    try {
      markUnresolvedTransaction({
        chainId: task.config.chainId,
        walletAddress,
        status,
        txHash,
        rpcUrl,
        receiptRequired,
      });
    } catch (error) {
      // 节点偶尔会在“提交响应丢失”场景返回非标准 hash。此时宁可
      // 以无 hash 的 unknown 记录继续保护 nonce，也不能让重点击穿守卫。
      if (txHash) {
        try {
          markUnresolvedTransaction({
            chainId: task.config.chainId,
            walletAddress,
            status: 'unknown',
            rpcUrl,
          });
          return;
        } catch {
          // Fall through to the diagnostic log below.
        }
      }
      console.error('记录待确认交易守卫失败:', error);
    }
  }

  async function findBlockedUnresolvedWallet(
    task: Task,
    walletAddresses: string[],
    checkChainNonce = false,
    rpcOverride?: string,
  ): Promise<{
    walletAddress: string;
    message: string;
    txHash?: string;
    code?: string;
  } | undefined> {
    const seen = new Set<string>();
    const uniqueWallets: string[] = [];
    const rpcUrl = rpcOverride || task.config.rpcUrl || defaultRpcForChain(task.config.chainId);
    for (const originalAddress of walletAddresses) {
      const walletAddress = originalAddress.trim();
      const key = walletAddress.toLowerCase();
      if (!walletAddress || seen.has(key)) continue;
      seen.add(key);
      uniqueWallets.push(walletAddress);
      try {
        const check = await checkUnresolvedTransaction({
          chainId: task.config.chainId,
          walletAddress,
          rpcUrl,
        });
        if (check.blocked) {
          return {
            walletAddress,
            message: check.message,
            txHash: check.record.txHash,
          };
        }
        if (check.reason !== 'none') {
          resetTradingNonceForAddress(walletAddress, task.config.chainId);
          resetFourMemeNonceForAddress(walletAddress);
        }
      } catch (error: any) {
        // 守卫自身无法读取/校验时同样 fail closed。
        return {
          walletAddress,
          message: `无法核对上一笔交易状态: ${error?.message || '未知错误'}`,
        };
      }
    }

    if (!checkChainNonce || uniqueWallets.length === 0) return undefined;

    // A previous tab/device can leave a transaction pending without a local
    // unresolved record. Check every participant before the first write so a
    // later wallet's old sell cannot change the pool after earlier wallets have
    // already quoted and broadcast. Use a small pool of ordinary requests:
    // several private/anti-sandwich RPCs reject JSON-RPC batch payloads.
    let nonceClient: ReturnType<typeof createPublicClient>;
    try {
      nonceClient = createPublicClient({
        chain: getTaskChain(task.config.chainId),
        transport: http(rpcUrl, { timeout: 10_000 }),
      });
    } catch (error: any) {
      return {
        walletAddress: uniqueWallets[0],
        message: `无法初始化钱包 pending nonce 预检: ${error?.message || '未知错误'}`,
      };
    }

    const concurrency = 5;
    for (let offset = 0; offset < uniqueWallets.length; offset += concurrency) {
      const chunk = uniqueWallets.slice(offset, offset + concurrency);
      const nonceChecks = await Promise.allSettled(chunk.map(async walletAddress => {
        const address = walletAddress as `0x${string}`;
        const [latestNonce, pendingNonce] = await Promise.all([
          nonceClient.getTransactionCount({ address, blockTag: 'latest' }),
          nonceClient.getTransactionCount({ address, blockTag: 'pending' }),
        ]);
        return { walletAddress, latestNonce, pendingNonce };
      }));

      for (let index = 0; index < nonceChecks.length; index++) {
        const result = nonceChecks[index];
        const walletAddress = chunk[index];
        if (result.status === 'rejected') {
          return {
            walletAddress,
            message: `无法读取钱包 latest/pending nonce，已停止全部发送: ${result.reason?.message || 'RPC 请求失败'}`,
          };
        }
        const { latestNonce, pendingNonce } = result.value;
        if (pendingNonce > latestNonce) {
          return {
            walletAddress,
            code: WALLET_PENDING_PREDECESSOR_CODE,
            message: `钱包已有 ${pendingNonce - latestNonce} 笔链上待确认前序交易，已停止全部发送`,
          };
        }
        if (pendingNonce < latestNonce) {
          return {
            walletAddress,
            message: 'RPC 返回的 pending nonce 小于 latest nonce，状态不一致，已停止全部发送',
          };
        }
      }
    }
    return undefined;
  }

  async function monitorUnresolvedTransaction(
    task: Task,
    walletAddress: string,
    rpcUrl: string,
    txHash?: string,
  ): Promise<void> {
    // 这里只做 receipt/nonce 只读对账，不会发送、替换或重试交易。
    for (;;) {
      try {
        const check = await checkUnresolvedTransaction({
          chainId: task.config.chainId,
          walletAddress,
          rpcUrl,
        });
        if (!check.blocked) {
          if (check.reason !== 'none') {
            resetTradingNonceForAddress(walletAddress, task.config.chainId);
            resetFourMemeNonceForAddress(walletAddress);
          }
          addLog(
            task.id,
            'info',
            `${walletAddress.slice(0, 10)}... 上一笔待确认交易已完成链上对账，相关全局锁现可安全释放`,
            walletAddress,
            txHash,
          );
          return;
        }
      } catch {
        // Fail closed and try the read-only reconciliation again later.
      }
      await new Promise<void>(resolve => {
        const timer = window.setTimeout(resolve, 10_000);
        // Vitest/Node should not stay alive solely for a browser-style background
        // reconciliation timer; browsers simply return a numeric timer ID.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
    }
  }

  function retainLeasesUntilUnresolvedSettles(
    task: Task,
    walletAddress: string,
    rpcUrl: string,
    txHash: string | undefined,
    leaseGuard?: TransferLeaseGuard,
    scope: 'wallet' | 'market' | 'wallet-and-market' = 'wallet-and-market',
  ): void {
    if (!leaseGuard?.retainUntil) return;
    addLog(
      task.id,
      'warning',
      `${walletAddress.slice(0, 10)}... 将持续只读核对回执/nonce；确认前保持${scope === 'wallet' ? '钱包' : scope === 'market' ? '代币市场' : '钱包和代币市场'}全局锁，不会重发交易`,
      walletAddress,
      txHash,
    );
    leaseGuard.retainUntil(monitorUnresolvedTransaction(task, walletAddress, rpcUrl, txHash));
  }

  // 计算属性
  const runningTasks = computed(() => tasks.value.filter(t => t.status === 'running'));
  const pausedTasks = computed(() => tasks.value.filter(t => t.status === 'paused'));
  const taskCount = computed(() => tasks.value.length);

  // 当前查看日志的任务
  const activeLogTask = computed(() => {
    if (!activeLogTaskId.value) return null;
    return tasks.value.find(t => t.id === activeLogTaskId.value) || null;
  });

  // ========== 服务端同步 ==========

  // 统计数据同步的防抖定时器
  const statsSyncTimers = new Map<string, number>();

  // 从服务器加载任务列表
  async function loadFromServer(): Promise<void> {
    if (!shouldUseServerMode()) return;
    try {
      const serverTasks = await taskApi.getTasks();
      tasks.value = serverTasks.map(st => ({
        _id: st._id,
        id: st._id,
        name: st.name,
        status: 'stopped' as const,
        config: normalizeTaskConfig(st.config),
        walletAddresses: st.walletAddresses || [],
        logs: [],
        stats: {
          buyCount: st.stats?.buyCount || 0,
          sellCount: st.stats?.sellCount || 0,
          spentAmount: st.stats?.spentAmount || 0,
          startTime: undefined,
          elapsedTime: st.stats?.elapsedTime || 0
        },
        currentBuyWalletIndex: st.currentBuyWalletIndex || 0,
        currentSellWalletIndex: st.currentSellWalletIndex || 0
      }));
      if (tasks.value.length > 0) {
        activeLogTaskId.value = tasks.value[0].id;
      }
    } catch (error) {
      console.error('从服务器加载任务失败:', error);
    }
  }

  // 调度统计数据同步（30秒防抖）
  function scheduleStatsSync(taskId: string) {
    if (!shouldUseServerMode()) return;
    const task = tasks.value.find(t => t.id === taskId);
    if (!task || !task._id) return;

    const existing = statsSyncTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = window.setTimeout(async () => {
      statsSyncTimers.delete(taskId);
      const t = tasks.value.find(t => t.id === taskId);
      if (!t || !t._id) return;
      try {
        await taskApi.updateTaskStats(t._id, {
          stats: {
            buyCount: t.stats.buyCount,
            sellCount: t.stats.sellCount,
            spentAmount: t.stats.spentAmount,
            elapsedTime: t.stats.elapsedTime
          },
          currentBuyWalletIndex: t.currentBuyWalletIndex,
          currentSellWalletIndex: t.currentSellWalletIndex
        });
      } catch (error) {
        console.error('同步任务统计失败:', error);
      }
    }, 30000);

    statsSyncTimers.set(taskId, timer);
  }

  // 立即刷新统计数据到服务器（任务停止时调用）
  function flushStatsSync(taskId: string) {
    if (!shouldUseServerMode()) return;
    const task = tasks.value.find(t => t.id === taskId);
    if (!task || !task._id) return;

    // 清除待执行的防抖定时器
    const pendingTimer = statsSyncTimers.get(taskId);
    if (pendingTimer) clearTimeout(pendingTimer);
    statsSyncTimers.delete(taskId);

    // 立即发送
    taskApi.updateTaskStats(task._id, {
      stats: {
        buyCount: task.stats.buyCount,
        sellCount: task.stats.sellCount,
        spentAmount: task.stats.spentAmount,
        elapsedTime: task.stats.elapsedTime
      },
      currentBuyWalletIndex: task.currentBuyWalletIndex,
      currentSellWalletIndex: task.currentSellWalletIndex
    }).catch(err => console.error('刷新任务统计失败:', err));
  }

  // ========== 原有逻辑 ==========

  // 获取任务的买入 RPC URL
  function getBuyRpcUrl(config: TaskConfig): string {
    if (config.chainId === 4663) {
      return config.antiSandwichRpc || config.rpcUrl || DEFAULT_ROBINHOOD_RPC;
    }
    if (config.buyUsePremiumRpc) return getPremiumSellRpc();
    return config.antiSandwichRpc || ANTI_SANDWICH_RPC;
  }

  // 获取任务的卖出 RPC URL（始终使用高速节点）
  function getSellRpcUrl(config?: TaskConfig): string {
    if (config?.chainId === 4663) {
      return config.rpcUrl || DEFAULT_ROBINHOOD_RPC;
    }
    return getPremiumSellRpc();
  }

  function getTaskExecutionRpc(task: Task, direction: 'buy' | 'sell'): string {
    if (task.config.chainId === 4663) {
      // Robinhood/Pons uses the task anti-sandwich override for both directions
      // when configured; this must match executeOuterMarketTrade exactly.
      return task.config.antiSandwichRpc
        || task.config.rpcUrl
        || DEFAULT_ROBINHOOD_RPC;
    }
    if (isFourMemeTask(task)) {
      return direction === 'sell'
        ? getSellRpcUrl(task.config)
        : getBuyRpcUrl(task.config);
    }

    // Mirror executeOuterMarketTrade exactly. Its BSC outer-market buy path
    // falls back to the task/default RPC, not the global anti-sandwich RPC.
    if (direction === 'sell' || task.config.buyUsePremiumRpc) {
      return getPremiumSellRpc();
    }
    return task.config.antiSandwichRpc
      || task.config.rpcUrl
      || defaultRpcForChain(task.config.chainId);
  }

  // 生成唯一ID
  function generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // 生成日志ID
  function generateLogId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // 添加日志
  function addLog(taskId: string, type: LogEntry['type'], message: string, walletAddress?: string, txHash?: string) {
    const task = tasks.value.find(t => t.id === taskId);
    if (task) {
      task.logs.push({
        id: generateLogId(),
        timestamp: Date.now(),
        type,
        message,
        walletAddress,
        txHash
      });
      // 限制日志数量，最多保留500条
      if (task.logs.length > 500) {
        task.logs = task.logs.slice(-500);
      }
    }
  }

  // 创建新任务
  async function createTask(
    name: string,
    config: TaskConfig,
    walletAddresses: string[]
  ): Promise<Task> {
    const normalizedConfig = normalizeTaskConfig(config);
    const task: Task = {
      id: generateId(),
      name,
      status: 'stopped',
      config: normalizedConfig,
      walletAddresses,
      logs: [],
      stats: {
        buyCount: 0,
        sellCount: 0,
        spentAmount: 0,
        elapsedTime: 0
      },
      currentBuyWalletIndex: 0,
      currentSellWalletIndex: 0
    };

    // 先同步到服务器获取稳定 ID，再 push 到数组
    // 避免 push 后 ID 变更导致运行时引用失效
    if (shouldUseServerMode()) {
      try {
        const serverTask = await taskApi.createTask({ name, config: normalizedConfig, walletAddresses });
        task._id = serverTask._id;
        task.id = serverTask._id;
      } catch (error) {
        console.error('保存任务到服务器失败:', error);
      }
    }

    tasks.value.push(task);

    // 如果服务器保存失败，提示用户
    if (shouldUseServerMode() && !task._id) {
      addLog(task.id, 'warning', '任务保存到服务器失败，刷新页面后可能丢失');
    }

    // 自动设置为当前查看的任务
    if (!activeLogTaskId.value) {
      activeLogTaskId.value = task.id;
    }

    const buyCount = normalizedConfig.buyThreadCount || 0;
    const sellCount = normalizedConfig.sellThreadCount || 0;
    addLog(task.id, 'info', `任务 "${name}" 已创建，买${buyCount}/卖${sellCount}，钱包数量: ${walletAddresses.length}`);

    // 内盘任务：创建时就预热 RPC 连接（异步，不阻塞）
    // 这样当用户点击"开始"时，RPC 连接已经建立好了
    if (isFourMemeTask(task)) {
      const buyRpc = getBuyRpcUrl(normalizedConfig);
      const sellRpc = getSellRpcUrl(normalizedConfig);

      // 预创建并缓存 FourMemeService 实例（买入用 buyRpc，卖出用 sellRpc）
      const service = createFourMemeService(normalizedConfig.chainId, buyRpc, sellRpc);
      fourMemeServiceCache.set(task.id, service);

      // 异步预热两个 RPC 端点的 TCP/TLS 连接（防夹节点 + Binance 官方节点）
      service.warmupConnections().then(() => {
        addLog(task.id, 'info', 'RPC 连接预热完成，可以开始任务');
      }).catch(() => {});

      // ASTER 池任务：创建时预授权所有钱包（后台异步，不阻塞 UI）
      if (normalizedConfig.poolBaseToken) {
        preApproveWallets(task);
      }
    }

    return task;
  }

  // 预授权所有钱包（ASTER 池任务创建时调用）
  // 同时授权底池代币（ASTER，用于买入）和目标代币（meme token，用于卖出）
  function preApproveWallets(task: Task) {
    const walletStore = useWalletStore();
    const baseTokenAddress = task.config.poolBaseToken;
    if (!baseTokenAddress) return;
    const generation = (preApprovalGenerations.get(task.id) || 0) + 1;
    preApprovalGenerations.set(task.id, generation);
    const isCurrentRun = () => preApprovalGenerations.get(task.id) === generation;
    task.preApprovalDone = false;

    const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as const;
    const buyExecutionRpcUrl = getTaskExecutionRpc(task, 'buy');
    const sellExecutionRpcUrl = getTaskExecutionRpc(task, 'sell');
    const hasBuyDirection = (task.config.buyThreadCount || 0) > 0;
    const hasSellDirection = (task.config.sellThreadCount || 0) > 0;
    // Broadcast approval through an actual trade endpoint so only the other
    // execution endpoint needs a propagation barrier. Prefer buy when the task
    // has buy workers; otherwise use the sell endpoint.
    const approveRpcUrl = hasBuyDirection
      ? buyExecutionRpcUrl
      : hasSellDirection
        ? sellExecutionRpcUrl
        : buyExecutionRpcUrl;
    const rpcKey = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
    const executionRpcUrls = [...new Map(
      [buyExecutionRpcUrl, sellExecutionRpcUrl].map(url => [rpcKey(url), url] as const),
    ).values()];
    const chain = getTaskChain(task.config.chainId);
    const targetTokenAddress = task.config.innerTokenAddress || task.config.tokenContract;

    const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const maxUint128 = BigInt('0xffffffffffffffffffffffffffffffff');

    // 需要授权的代币列表：底池代币（买入用）+ 目标代币（卖出用）
    const tokensToApprove: { address: string; label: string }[] = [
      { address: baseTokenAddress, label: '底池代币(ASTER)' }
    ];
    if (targetTokenAddress) {
      tokensToApprove.push({ address: targetTokenAddress, label: '目标代币' });
    }

    const promise = (async () => {
      try {
        addLog(task.id, 'info', `开始预授权 ${task.walletAddresses.length} 个钱包（底池代币 + 目标代币）...`);

        const allowanceReadClient = createPublicClient({
          chain,
          transport: http(approveRpcUrl, { batch: true }),
          batch: { multicall: true }
        });
        const approvePublicClient = createPublicClient({
          chain,
          transport: http(approveRpcUrl),
        });
        const executionClients = new Map<string, ReturnType<typeof createPublicClient>>();
        for (const rpcUrl of executionRpcUrls) {
          executionClients.set(
            rpcKey(rpcUrl),
            rpcKey(rpcUrl) === rpcKey(approveRpcUrl)
              ? approvePublicClient
              : createPublicClient({ chain, transport: http(rpcUrl) }),
          );
        }

        const verifyAllowancesOnExecutionRpcs = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
          try {
            for (const rpcUrl of executionRpcUrls) {
              const client = executionClients.get(rpcKey(rpcUrl))!;
              const values = await Promise.all(allChecks.map(check => client.readContract({
                address: check.token as `0x${string}`,
                abi: [{
                  type: 'function' as const,
                  name: 'allowance' as const,
                  stateMutability: 'view' as const,
                  inputs: [
                    { name: 'owner' as const, type: 'address' as const },
                    { name: 'spender' as const, type: 'address' as const },
                  ],
                  outputs: [{ name: '' as const, type: 'uint256' as const }],
                }] as const,
                functionName: 'allowance',
                args: [check.addr as `0x${string}`, FOURMEME_CONTRACT],
              })));
              const insufficientIndex = values.findIndex(value => (value as bigint) < maxUint128);
              if (insufficientIndex >= 0) {
                const check = allChecks[insufficientIndex];
                return {
                  ok: false,
                  error: `${check.addr.slice(0, 10)}... ${check.label}在执行节点 ${rpcUrl} 尚未同步足额授权`,
                };
              }
            }
            return { ok: true };
          } catch (error: any) {
            return { ok: false, error: `执行节点授权复核失败: ${error?.message || 'RPC 请求失败'}` };
          }
        };

        const waitForApprovalOnExecutionPeers = async (
          txHash: `0x${string}`,
        ): Promise<{
          status: 'confirmed' | 'pending' | 'unknown';
          reconciliationRpcUrl?: string;
          receiptRequired?: boolean;
          error?: string;
        }> => {
          for (const rpcUrl of executionRpcUrls) {
            if (rpcKey(rpcUrl) === rpcKey(approveRpcUrl)) continue;
            const client = executionClients.get(rpcKey(rpcUrl))!;
            try {
              const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
              if (receipt.status !== 'success') {
                return {
                  status: 'unknown',
                  reconciliationRpcUrl: rpcUrl,
                  receiptRequired: true,
                  error: `授权在广播节点已确认，但执行节点 ${rpcUrl} 返回不一致回执`,
                };
              }
            } catch (error: any) {
              return {
                status: error?.name === 'WaitForTransactionReceiptTimeoutError' ? 'pending' : 'unknown',
                reconciliationRpcUrl: rpcUrl,
                receiptRequired: true,
                error: `授权在广播节点已确认，但执行节点 ${rpcUrl} ${error?.name === 'WaitForTransactionReceiptTimeoutError' ? '同步超时' : `无法读取回执: ${error?.message || '未知错误'}`}`,
              };
            }
          }
          return { status: 'confirmed' };
        };

        // 1. 批量查询所有钱包对所有代币的 allowance（multicall 合并为 1-2 次 RPC）
        const allChecks: { addr: string; token: string; label: string; promise: Promise<bigint> }[] = [];
        for (const token of tokensToApprove) {
          for (const addr of task.walletAddresses) {
            allChecks.push({
              addr,
              token: token.address,
              label: token.label,
              promise: allowanceReadClient.readContract({
                address: token.address as `0x${string}`,
                abi: [{
                  type: 'function' as const,
                  name: 'allowance' as const,
                  stateMutability: 'view' as const,
                  inputs: [
                    { name: 'owner' as const, type: 'address' as const },
                    { name: 'spender' as const, type: 'address' as const }
                  ],
                  outputs: [{ name: '' as const, type: 'uint256' as const }]
                }] as const,
                functionName: 'allowance',
                args: [addr as `0x${string}`, FOURMEME_CONTRACT]
              }).then(val => val as bigint).catch(() => 0n)
            });
          }
        }

        const allowanceValues = await Promise.all(allChecks.map(c => c.promise));

        // 2. 筛出需要授权的 (钱包, 代币) 对
        const needApproval: { addr: string; token: string; label: string }[] = [];
        for (let i = 0; i < allChecks.length; i++) {
          if (allowanceValues[i] < maxUint128) {
            needApproval.push({ addr: allChecks[i].addr, token: allChecks[i].token, label: allChecks[i].label });
          }
        }

        if (needApproval.length === 0) {
          const verification = await verifyAllowancesOnExecutionRpcs();
          if (!isCurrentRun()) return;
          task.preApprovalDone = verification.ok;
          addLog(
            task.id,
            verification.ok ? 'success' : 'warning',
            verification.ok
              ? '所有买入/卖出执行节点均确认已有足够授权，预授权跳过'
              : `${verification.error}；不会启用快速路径`,
          );
          return;
        }

        addLog(task.id, 'info', `${needApproval.length} 笔授权待发送；按钱包锁串行广播并逐笔等待最终回执`);

        let successCount = 0;
        let failCount = 0;
        let pendingCount = 0;
        const unresolvedWallets = new Set<string>();

        for (const { addr, token, label } of needApproval) {
          if (!isCurrentRun()) return;
          const walletKey = addr.toLowerCase();
          if (unresolvedWallets.has(walletKey)) {
            pendingCount++;
            addLog(task.id, 'warning', `${addr.slice(0, 10)}... 上一笔预授权尚未完成对账，跳过该钱包后续授权`, addr);
            continue;
          }

          const privateKey = getWalletPrivateKey(walletStore, addr);
          if (!privateKey) {
            failCount++;
            addLog(task.id, 'warning', `${addr.slice(0, 10)}... 无私钥，${label}预授权未发送`, addr);
            continue;
          }

          try {
            const outcome = await withTaskWalletLease(task.config.chainId, addr, async (leaseGuard) => {
              if (!isCurrentRun()) {
                return { status: 'failed' as const, error: '任务配置已更新，旧预授权已取消' };
              }
              // Task creation can run this background path before startTask.
              // It must therefore enforce the same persisted unresolved-nonce
              // guard itself, including after a page reload or server TTL expiry.
              let unresolvedCheck;
              try {
                unresolvedCheck = await checkUnresolvedTransaction({
                  chainId: task.config.chainId,
                  walletAddress: addr,
                  rpcUrl: approveRpcUrl,
                });
              } catch (error: any) {
                return {
                  status: 'failed' as const,
                  error: `无法核对上一笔交易状态，预授权未发送: ${error?.message || '未知错误'}`,
                };
              }
              if (unresolvedCheck.blocked) {
                return {
                  status: 'pending' as const,
                  txHash: unresolvedCheck.record.txHash,
                  error: unresolvedCheck.message,
                };
              }
              if (unresolvedCheck.reason !== 'none') {
                resetTradingNonceForAddress(addr, task.config.chainId);
                resetFourMemeNonceForAddress(addr);
              }

              const account = (await import('viem/accounts')).privateKeyToAccount(privateKey as `0x${string}`);
              if (account.address.toLowerCase() !== addr.toLowerCase()) {
                throw new Error('私钥与钱包地址不匹配');
              }
              const walletClient = (await import('viem')).createWalletClient({
                account,
                chain,
                transport: http(approveRpcUrl),
              });
              const [latestNonce, pendingNonce] = await Promise.all([
                approvePublicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
                approvePublicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
              ]);
              if (pendingNonce > latestNonce) {
                return {
                  status: 'pending' as const,
                  error: `钱包已有 ${pendingNonce - latestNonce} 笔待确认交易，预授权未发送`,
                };
              }
              if (pendingNonce < latestNonce) {
                return {
                  status: 'failed' as const,
                  error: 'RPC 返回的 pending nonce 小于 latest nonce，预授权未发送',
                };
              }
              const callData = ('0x095ea7b3'
                + FOURMEME_CONTRACT.slice(2).padStart(64, '0')
                + maxUint256.toString(16).padStart(64, '0')) as `0x${string}`;

              leaseGuard?.assertActive();
              if (!isCurrentRun()) {
                return { status: 'failed' as const, error: '任务配置已更新，旧预授权已取消' };
              }
              let txHash: `0x${string}` | undefined;
              try {
                txHash = await walletClient.sendTransaction({
                  account: walletClient.account!,
                  chain: walletClient.chain,
                  to: token as `0x${string}`,
                  data: callData,
                  value: 0n,
                  gas: 100000n,
                });
                addLog(task.id, 'info', `${addr.slice(0, 10)}... ${label}授权已广播，等待链上确认`, addr, txHash);
              } catch (error: any) {
                // sendTransaction 抛错无法证明节点未接收；保守记录 unknown，绝不重发。
                markTaskUnresolvedTransaction(task, addr, 'unknown', undefined, approveRpcUrl);
                retainLeasesUntilUnresolvedSettles(task, addr, approveRpcUrl, undefined, leaseGuard, 'wallet');
                return { status: 'unknown' as const, error: error?.message || '提交响应丢失' };
              }

              try {
                const receipt = await approvePublicClient.waitForTransactionReceipt({
                  hash: txHash,
                  timeout: 120000,
                });
                if (receipt.status !== 'success') {
                  return { status: 'failed' as const, txHash, error: '授权交易已在链上回滚' };
                }

                const peerVisibility = await waitForApprovalOnExecutionPeers(txHash);
                if (peerVisibility.status !== 'confirmed') {
                  const reconciliationRpcUrl = peerVisibility.reconciliationRpcUrl!;
                  markTaskUnresolvedTransaction(
                    task,
                    addr,
                    peerVisibility.status,
                    txHash,
                    reconciliationRpcUrl,
                    peerVisibility.receiptRequired,
                  );
                  retainLeasesUntilUnresolvedSettles(
                    task,
                    addr,
                    reconciliationRpcUrl,
                    txHash,
                    leaseGuard,
                    'wallet',
                  );
                  return {
                    status: peerVisibility.status,
                    txHash,
                    reconciliationRpcUrl,
                    receiptRequired: peerVisibility.receiptRequired,
                    error: peerVisibility.error,
                  };
                }
                return { status: 'confirmed' as const, txHash };
              } catch (error: any) {
                const status = error?.name === 'WaitForTransactionReceiptTimeoutError'
                  ? 'pending' as const
                  : 'unknown' as const;
                markTaskUnresolvedTransaction(task, addr, status, txHash, approveRpcUrl);
                retainLeasesUntilUnresolvedSettles(task, addr, approveRpcUrl, txHash, leaseGuard, 'wallet');
                return { status, txHash, error: error?.message || '无法读取授权回执' };
              }
            });

            if (outcome.status === 'confirmed') {
              successCount++;
            } else if (outcome.status === 'pending' || outcome.status === 'unknown') {
              pendingCount++;
              unresolvedWallets.add(walletKey);
              addLog(task.id, 'warning', `${addr.slice(0, 10)}... ${label}预授权待确认/未知，未重发`, addr, outcome.txHash);
              if (task.status === 'running') pauseTask(task.id);
            } else {
              failCount++;
              addLog(task.id, 'warning', `${addr.slice(0, 10)}... ${label}预授权失败: ${outcome.error}`, addr, outcome.txHash);
            }
          } catch (error: any) {
            failCount++;
            addLog(task.id, 'warning', `${addr.slice(0, 10)}... ${label}预授权异常: ${error.message || '未知错误'}`, addr);
          }
        }

        if (!isCurrentRun()) return;
        if (failCount === 0 && pendingCount === 0) {
          const verification = await verifyAllowancesOnExecutionRpcs();
          if (!verification.ok) {
            failCount++;
            addLog(task.id, 'warning', `${verification.error}；不会启用快速路径`);
          }
        }
        if (!isCurrentRun()) return;
        task.preApprovalDone = failCount === 0 && pendingCount === 0;
        addLog(task.id, task.preApprovalDone ? 'success' : 'warning', `预授权收尾：确认 ${successCount}，待确认/未知 ${pendingCount}，失败 ${failCount}${task.preApprovalDone ? '，所有钱包已就绪' : '；任务将使用完整校验路径'}`);
      } catch (error: any) {
        addLog(task.id, 'warning', `预授权异常: ${error.message}，交易时将使用 inline approve 兜底`);
        if (isCurrentRun()) task.preApprovalDone = false;
      }
    })();

    preApprovalTracker.set(task.id, { promise, completed: false, generation });
    promise.then(() => {
      const tracker = preApprovalTracker.get(task.id);
      if (tracker?.generation === generation && isCurrentRun()) tracker.completed = true;
    });
  }

  // 检查停止条件
  function checkStopCondition(task: Task, currentPrice?: number, currentMarketCap?: number): boolean {
    const { stopType, stopValue } = task.config;
    const { buyCount, sellCount, spentAmount, startTime, elapsedTime } = task.stats;
    const totalExecuted = buyCount + sellCount;

    // none = 永不自动停止，只能手动停止
    if (stopType === 'none') return false;

    switch (stopType) {
      case 'count':
        return totalExecuted >= stopValue;
      case 'amount':
        return spentAmount >= stopValue;
      case 'time':
        return elapsedTime >= stopValue;
      case 'price':
        if (currentPrice === undefined) return false;
        return currentPrice >= stopValue;
      case 'marketcap':
        if (currentMarketCap === undefined) return false;
        return currentMarketCap >= stopValue;
      default:
        return false;
    }
  }

  // 获取钱包私钥（优先本地钱包，其次批次钱包）
  function getWalletPrivateKey(walletStore: ReturnType<typeof useWalletStore>, walletAddress: string): string | null {
    // 1. 首先检查本地钱包
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

  // 执行单个钱包的交易（可传入共享的 FourMemeService 实例避免重复创建）
  async function executeWalletTrade(
    task: Task,
    walletAddress: string,
    tradeDirection: 'buy' | 'sell',
    sharedFourMemeService?: InstanceType<typeof FourMemeService>,
    roundPreflight?: (marketLeaseGuard: TransferLeaseGuard) => Promise<void>,
  ): Promise<boolean> {
    const walletStore = useWalletStore();
    const dexStore = useDexStore();

    // 获取私钥（支持本地钱包和批次钱包）
    const privateKey = getWalletPrivateKey(walletStore, walletAddress);
    if (!privateKey) {
      addLog(task.id, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
      return false;
    }

    try {
      // 获取链配置
      const chainId = task.config.chainId;
      const rpcUrl = task.config.rpcUrl || defaultRpcForChain(chainId);

      // 计算随机金额（在区间内）
      const amountMin = task.config.amountMin || 0;
      const amountMax = task.config.amountMax || amountMin;
      const randomAmount = amountMin + Math.random() * (amountMax - amountMin);
      // 保留8位小数精度（避免 JavaScript 浮点数精度问题）
      // 0.1.toFixed(18) = "0.100000000000000006"（错误）
      // 0.1.toFixed(8) = "0.10000000"（正确）
      const roundedAmount = Number(randomAmount.toFixed(8));

      // 格式化显示金额，避免科学计数法
      const formatAmount = (num: number): string => {
        if (num === 0) return '0';
        return num.toFixed(8).replace(/\.?0+$/, '');
      };

      const marketTypeText = task.config.marketType === 'inner'
        ? (chainId === 4663 ? 'Pons 发射台' : '内盘')
        : '外盘';
      const amountUnit = task.config.poolBaseToken ? 'ASTER' : taskNativeSymbol(task);
      const tokenAddress = taskTokenAddress(task);
      if (!tokenAddress) {
        addLog(task.id, 'error', '未设置代币合约地址', walletAddress);
        return false;
      }
      addLog(task.id, 'info', `开始${tradeDirection === 'buy' ? '买入' : '卖出'}交易 [${marketTypeText}]...`, walletAddress);
      addLog(task.id, 'info', `交易金额: ${formatAmount(roundedAmount)} ${amountUnit} (区间: ${formatAmount(amountMin)}~${formatAmount(amountMax)})`, walletAddress);

      return await withTaskMarketLease(chainId, tokenAddress, async (marketLeaseGuard) => {
        if (task.status !== 'running') throw new TaskRoundCancelledError();
        if (marketLeaseGuard) await roundPreflight?.(marketLeaseGuard);
        if (task.status !== 'running') throw new TaskRoundCancelledError();
        return withTaskWalletLease(chainId, walletAddress, async (walletLeaseGuard) => {
          if (task.status !== 'running') throw new TaskRoundCancelledError();
          const leaseGuard = combineLeaseGuards(marketLeaseGuard, walletLeaseGuard);
          leaseGuard?.assertActive();

          // 市场租约保护报价依赖的池/曲线状态，钱包租约保护 nonce；
          // 两个租约共同覆盖 approve + trade + receipt 的完整生命周期。
          if (isFourMemeTask(task)) {
            return executeInnerMarketTrade(
              task,
              walletAddress,
              privateKey,
              chainId,
              rpcUrl,
              roundedAmount,
              tradeDirection,
              sharedFourMemeService,
              leaseGuard,
              walletLeaseGuard,
            );
          }

          return executeOuterMarketTrade(
            task,
            walletAddress,
            privateKey,
            chainId,
            rpcUrl,
            roundedAmount,
            tradeDirection,
            dexStore,
            leaseGuard,
            walletLeaseGuard,
          );
        });
      }, () => task.status === 'running');

    } catch (error: any) {
      if (error instanceof TaskRoundCancelledError) return false;
      if (isCoordinationLeaseError(error)) {
        addLog(task.id, 'warning', `交易协调锁不可用: ${error.message}；任务已暂停且本轮剩余交易不会发送`, walletAddress);
        if (task.status === 'running') pauseTask(task.id);
        return false;
      }
      addLog(task.id, 'error', `交易异常: ${error.message}`, walletAddress);
      return false;
    }
  }

  // 执行内盘交易（FourMeme）
  async function executeInnerMarketTrade(
    task: Task,
    walletAddress: string,
    privateKey: string,
    chainId: number,
    rpcUrl: string,
    amount: number,
    tradeDirection: 'buy' | 'sell',
    sharedService?: InstanceType<typeof FourMemeService>,
    leaseGuard?: TransferLeaseGuard,
    walletLeaseGuard?: TransferLeaseGuard,
  ): Promise<boolean> {
    // 内盘交易使用配置的节点
    const buyRpc = getBuyRpcUrl(task.config);
    const sellRpc = getSellRpcUrl(task.config);
    const fourMemeService = sharedService || createFourMemeService(chainId, buyRpc, sellRpc);

    // 卖出模式：如果 sellAll 为 true 则卖出100%
    const sellAll = tradeDirection === 'sell' && task.config.sellAll;

    const tradeParams: FourMemeTradeParams & { leaseGuard?: TransferLeaseGuard } = {
      chainId,
      rpcUrl: buyRpc,
      privateKey,
      walletAddress,
      tokenAddress: task.config.innerTokenAddress || task.config.tokenContract,
      amount,
      mode: tradeDirection === 'buy' ? 'buy' : 'sell',
      gasPrice: task.config.gasPrice,
      gasLimit: task.config.gasLimit,
      sellPercent: sellAll ? 100 : undefined,
      slippage: task.config.innerSlippage,
      poolBaseToken: task.config.poolBaseToken,
      leaseGuard,
      onTransactionHash: (txHash, kind) => {
        addLog(
          task.id,
          'info',
          `[内盘] ${kind === 'approval' ? '授权' : '交易'}已广播，等待链上确认`,
          walletAddress,
          txHash,
        );
      },
    };

    leaseGuard?.assertActive();
    const result = await fourMemeService.executeTrade(tradeParams);

    if (result.status === 'pending' || result.status === 'unknown') {
      const reconciliationRpc = result.reconciliationRpcUrl
        || (tradeDirection === 'sell' ? sellRpc : buyRpc);
      markTaskUnresolvedTransaction(
        task,
        walletAddress,
        result.status,
        result.txHash,
        reconciliationRpc,
        result.receiptRequired,
      );
      retainLeasesUntilUnresolvedSettles(
        task,
        walletAddress,
        reconciliationRpc,
        result.txHash,
        result.transactionKind === 'approval' ? walletLeaseGuard : leaseGuard,
        result.transactionKind === 'approval' ? 'wallet' : 'wallet-and-market',
      );
      addLog(
        task.id,
        'warning',
        result.code === WALLET_PENDING_PREDECESSOR_CODE
          ? `[内盘] 检测到链上待确认前序交易，本轮未广播新交易；任务已自动暂停`
          : result.receiptRequired
            ? `[内盘] 交易已在执行节点确认，但另一交易节点尚未同步；任务已自动暂停且不会重发`
            : `[内盘] 交易已广播但${result.status === 'pending' ? '仍在等待确认' : '状态未知'}，任务已自动暂停且不会重发`,
        walletAddress,
        result.txHash,
      );
      if (task.status === 'running') pauseTask(task.id);
      return false;
    } else if (result.success) {
      if (tradeDirection === 'buy') {
        task.stats.buyCount++;
      } else {
        task.stats.sellCount++;
      }
      task.stats.spentAmount += amount;

      const actionText = tradeDirection === 'buy' ? '买入' : '卖出';
      const amountUnit = task.config.poolBaseToken ? 'ASTER' : 'BNB';
      const resultText = result.amountOut
        ? `[内盘] ${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
        : `[内盘] ${actionText}成功，金额: ${amount} ${amountUnit}`;

      addLog(task.id, 'success', resultText, walletAddress, result.txHash);
      return true;
    } else {
      addLog(task.id, 'error', `[内盘] 交易失败: ${result.error}`, walletAddress, result.txHash);
      return false;
    }
  }

  // 快速交易路径（Change 4b）：使用预取数据，跳过冗余 RPC 调用
  async function executeWalletTradeFast(
    task: Task,
    walletAddress: string,
    tradeDirection: 'buy' | 'sell',
    sharedFourMemeService: InstanceType<typeof FourMemeService>,
    prefetchData?: FourMemeRoundPrefetchData,
    roundPreflight?: (marketLeaseGuard: TransferLeaseGuard) => Promise<void>,
  ): Promise<boolean> {
    const walletStore = useWalletStore();
    const privateKey = getWalletPrivateKey(walletStore, walletAddress);
    if (!privateKey) {
      addLog(task.id, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
      return false;
    }

    // multicall 整体失败或某个钱包的任一 balance/allowance 子调用失败时，
    // 禁止把“缺数据”解释为“可以跳过检查”。改走完整读链慢路径，仍受
    // 同一套市场/钱包锁保护，不会直接快发。
    if (!prefetchData) {
      addLog(task.id, 'warning', `${walletAddress.slice(0, 10)}... 预取余额/授权数据缺失，改用完整校验路径`, walletAddress);
      return await executeWalletTrade(
        task,
        walletAddress,
        tradeDirection,
        sharedFourMemeService,
        roundPreflight,
      );
    }

    // 如果预取数据显示 allowance 不足，fallback 到原有慢路径
    // 买入：底池代币（ASTER）未授权给 FourMeme
    // 卖出：目标代币（meme token）未授权给 FourMeme
    const allowanceSufficient = tradeDirection === 'buy'
      ? prefetchData.buyAllowanceSufficient
      : prefetchData.sellAllowanceSufficient;
    if (!allowanceSufficient) {
      addLog(task.id, 'warning', `${walletAddress.slice(0, 10)}... 授权不足，使用慢路径`, walletAddress);
      return await executeWalletTrade(
        task,
        walletAddress,
        tradeDirection,
        sharedFourMemeService,
        roundPreflight,
      );
    }

    try {
      const chainId = task.config.chainId;
      const buyRpcForFast = getBuyRpcUrl(task.config);
      const tokenAddress = taskTokenAddress(task);
      if (!tokenAddress) {
        addLog(task.id, 'error', '未设置代币合约地址', walletAddress);
        return false;
      }

      // 计算随机金额
      const amountMin = task.config.amountMin || 0;
      const amountMax = task.config.amountMax || amountMin;
      const randomAmount = amountMin + Math.random() * (amountMax - amountMin);
      const roundedAmount = Number(randomAmount.toFixed(8));

      const sellAll = tradeDirection === 'sell' && task.config.sellAll;

      const result = await withTaskMarketLease(chainId, tokenAddress, async (marketLeaseGuard) => {
        if (task.status !== 'running') throw new TaskRoundCancelledError();
        if (marketLeaseGuard) await roundPreflight?.(marketLeaseGuard);
        if (task.status !== 'running') throw new TaskRoundCancelledError();
        return withTaskWalletLease(chainId, walletAddress, async (walletLeaseGuard) => {
          if (task.status !== 'running') throw new TaskRoundCancelledError();
          const leaseGuard = combineLeaseGuards(marketLeaseGuard, walletLeaseGuard);
          const tradeParams: FourMemeTradeParams & { leaseGuard?: TransferLeaseGuard } = {
            chainId,
            rpcUrl: buyRpcForFast,
            privateKey,
            walletAddress,
            tokenAddress,
            amount: roundedAmount,
            mode: tradeDirection === 'buy' ? 'buy' : 'sell',
            gasPrice: task.config.gasPrice,
            gasLimit: task.config.gasLimit,
            sellPercent: sellAll ? 100 : undefined,
            slippage: task.config.innerSlippage,
            poolBaseToken: task.config.poolBaseToken,
            leaseGuard,
            onTransactionHash: (txHash, kind) => addLog(
              task.id,
              'info',
              `[内盘-快速] ${kind === 'approval' ? '授权' : '交易'}已广播，等待链上确认`,
              walletAddress,
              txHash,
            ),
          };

          leaseGuard?.assertActive();
          const tradeResult = await sharedFourMemeService.executeTradeFast(
            tradeParams,
            tradeDirection === 'sell' ? prefetchData?.tokenBalance : undefined,
          );
          if (tradeResult.status === 'pending' || tradeResult.status === 'unknown') {
            const reconciliationRpc = tradeResult.reconciliationRpcUrl
              || (tradeDirection === 'sell' ? getSellRpcUrl(task.config) : buyRpcForFast);
            markTaskUnresolvedTransaction(
              task,
              walletAddress,
              tradeResult.status,
              tradeResult.txHash,
              reconciliationRpc,
              tradeResult.receiptRequired,
            );
            retainLeasesUntilUnresolvedSettles(
              task,
              walletAddress,
              reconciliationRpc,
              tradeResult.txHash,
              leaseGuard,
            );
          }
          return tradeResult;
        });
      }, () => task.status === 'running');

      if (result.status === 'pending' || result.status === 'unknown') {
        addLog(
          task.id,
          'warning',
          result.code === WALLET_PENDING_PREDECESSOR_CODE
            ? `[内盘-快速] 检测到链上待确认前序交易，本轮未广播新交易；任务已自动暂停`
            : result.receiptRequired
              ? `[内盘-快速] 交易已在执行节点确认，但另一交易节点尚未同步；任务已自动暂停且不会重发`
              : `[内盘-快速] 交易已广播但${result.status === 'pending' ? '仍在等待确认' : '状态未知'}，任务已自动暂停且不会重发`,
          walletAddress,
          result.txHash,
        );
        if (task.status === 'running') pauseTask(task.id);
        return false;
      } else if (result.success) {
        if (tradeDirection === 'buy') {
          task.stats.buyCount++;
        } else {
          task.stats.sellCount++;
        }
        task.stats.spentAmount += roundedAmount;

        const actionText = tradeDirection === 'buy' ? '买入' : '卖出';
        const amountUnit = task.config.poolBaseToken ? 'ASTER' : 'BNB';
        const resultText = result.amountOut
          ? `[内盘-快速] ${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
          : `[内盘-快速] ${actionText}成功，金额: ${roundedAmount} ${amountUnit}`;

        addLog(task.id, 'success', resultText, walletAddress, result.txHash);
        return true;
      } else {
        addLog(task.id, 'error', `[内盘-快速] 交易失败: ${result.error}`, walletAddress, result.txHash);
        return false;
      }
    } catch (error: any) {
      if (error instanceof TaskRoundCancelledError) return false;
      if (isCoordinationLeaseError(error)) {
        addLog(task.id, 'warning', `[内盘-快速] 交易协调锁不可用: ${error.message}；任务已暂停且本轮剩余交易不会发送`, walletAddress);
        if (task.status === 'running') pauseTask(task.id);
        return false;
      }
      addLog(task.id, 'error', `[内盘-快速] 交易异常: ${error.message}；为避免重复广播，本轮不自动重试`, walletAddress);
      return false;
    }
  }

  // 执行外盘交易（DEX）
  async function executeOuterMarketTrade(
    task: Task,
    walletAddress: string,
    privateKey: string,
    chainId: number,
    rpcUrl: string,
    amount: number,
    tradeDirection: 'buy' | 'sell',
    dexStore: ReturnType<typeof useDexStore>,
    leaseGuard?: TransferLeaseGuard,
    walletLeaseGuard?: TransferLeaseGuard,
  ): Promise<boolean> {
    const taskDex = dexStore.dexConfigs.find(dex => dex.id === task.config.dexId && dex.chainId === chainId);
    const routerAddress = taskDex?.routerAddress || '';
    const resolvedTokenAddress = taskTokenAddress(task);

    if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
      addLog(task.id, 'error', '当前DEX的Router地址未配置', walletAddress);
      return false;
    }
    if (!resolvedTokenAddress) {
      addLog(task.id, 'error', '未设置代币合约地址', walletAddress);
      return false;
    }

    // 外盘交易：卖出走高速节点，买入走防夹节点
    const effectiveRpcUrl = chainId === 4663
      ? (task.config.antiSandwichRpc || task.config.rpcUrl || rpcUrl)
      : (tradeDirection === 'sell'
        ? getSellRpcUrl(task.config)
        : (task.config.buyUsePremiumRpc ? getPremiumSellRpc() : (task.config.antiSandwichRpc || rpcUrl)));
    if (chainId === 4663 && task.config.marketType === 'inner') {
      const validationClient = createPublicClient({ chain: robinhood, transport: http(effectiveRpcUrl) });
      await readAndValidatePonsLaunchedToken(
        validationClient,
        resolvedTokenAddress as `0x${string}`,
      );
    }
    const tradingService = createTradingService(chainId, effectiveRpcUrl, routerAddress);

    // 卖出模式：如果 sellAll 为 true 则卖出100%
    const sellAll = tradeDirection === 'sell' && task.config.sellAll;

    const tradeMode = tradeDirection === 'buy' ? 'pump' : 'dump';

    // 判断是使用 ASTER 还是 BNB
    // 如果设置了 poolBaseToken，说明是 ASTER 底池，直接用 ASTER 交易
    const useAster = !!task.config.poolBaseToken;
    const spendToken = useAster ? 'ASTER' : (chainId === 4663 ? 'ETH' : 'BNB');
    const amountUnit = useAster ? 'ASTER' : taskNativeSymbol(task);

    const tradeParams: TradeParams & { leaseGuard?: TransferLeaseGuard } = {
      chainId,
      rpcUrl: effectiveRpcUrl,
      routerAddress,
      privateKey,
      walletAddress,
      tokenAddress: resolvedTokenAddress,
      spendToken,
      amount,
      amountType: 'amount',
      mode: tradeMode,
      slippage: taskTradeSlippage(task),
      gasPrice: task.config.gasPrice,
      gasLimit: task.config.gasLimit,
      balancePercent: sellAll ? 100 : undefined,
      targetBnbAmount: tradeDirection === 'sell' && !sellAll ? amount : undefined,
      v3FeeTier: task.config.v3FeeTier,
      leaseGuard,
      onTransactionHash: (txHash, kind) => {
        addLog(
          task.id,
          'info',
          `[${chainId === 4663 ? 'Pons' : '外盘'}] ${kind === 'approval' ? '授权' : '交易'}已广播，等待链上确认`,
          walletAddress,
          txHash,
        );
      },
      // ASTER 底池时不需要 intermediateToken，直接 ASTER <-> Token
    };

    leaseGuard?.assertActive();
    const result = await tradingService.executeTrade(tradeParams);

    if (result.status === 'pending' || result.status === 'unknown') {
      markTaskUnresolvedTransaction(
        task,
        walletAddress,
        result.status,
        result.txHash,
        effectiveRpcUrl,
      );
      retainLeasesUntilUnresolvedSettles(
        task,
        walletAddress,
        effectiveRpcUrl,
        result.txHash,
        result.transactionKind === 'approval' ? walletLeaseGuard : leaseGuard,
        result.transactionKind === 'approval' ? 'wallet' : 'wallet-and-market',
      );
      const tradeSourceText = chainId === 4663 && task.config.marketType === 'inner'
        ? 'Pons'
        : '外盘';
      addLog(
        task.id,
        'warning',
        result.code === WALLET_PENDING_PREDECESSOR_CODE
          ? `[${tradeSourceText}] 检测到链上待确认前序交易，本轮未广播新交易；任务已自动暂停`
          : `[${tradeSourceText}] 交易已广播但${result.status === 'pending' ? '仍在等待确认' : '状态未知'}，任务已自动暂停且不会重发`,
        walletAddress,
        result.txHash,
      );
      if (task.status === 'running') pauseTask(task.id);
      return false;
    } else if (result.success) {
      if (tradeDirection === 'buy') {
        task.stats.buyCount++;
      } else {
        task.stats.sellCount++;
      }
      task.stats.spentAmount += amount;

      const actionText = tradeDirection === 'buy' ? '买入' : '卖出';
      const tradeSourceText = chainId === 4663 && task.config.marketType === 'inner'
        ? 'Pons'
        : '外盘';
      const resultText = result.amountOut
        ? `[${tradeSourceText}] ${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
        : `[${tradeSourceText}] ${actionText}成功，金额: ${amount} ${amountUnit}`;

      addLog(task.id, 'success', resultText, walletAddress, result.txHash);
      return true;
    } else {
      const tradeSourceText = chainId === 4663 && task.config.marketType === 'inner'
        ? 'Pons'
        : '外盘';
      addLog(task.id, 'error', `[${tradeSourceText}] 交易失败: ${result.error}`, walletAddress, result.txHash);
      return false;
    }
  }

  // 获取当前池子市值（BNB）
  async function getCurrentMarketCap(task: Task): Promise<number | undefined> {
    try {
      const dexStore = useDexStore();

      const chainId = task.config.chainId;
      const rpcUrl = task.config.rpcUrl || defaultRpcForChain(chainId);
      const taskDex = dexStore.dexConfigs.find(dex => dex.id === task.config.dexId && dex.chainId === chainId);
      const factoryAddress = taskDex?.factoryAddress || '';
      const baseTokens = taskDex?.baseTokens || [];

      if (chainId === 4663) {
        const publicClient = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
        const v3 = new UniswapV3Service(publicClient, { defaultFee: task.config.v3FeeTier ?? PONS_V3_POOL_FEE });
        const token = task.config.innerTokenAddress || task.config.tokenContract;
        const pool = await v3.getPool(
          token as `0x${string}`,
          ROBINHOOD_WETH_ADDRESS,
          task.config.v3FeeTier ?? PONS_V3_POOL_FEE,
        );
        if (!pool || pool.liquidity <= 0n) return undefined;
        const metadata = pool.token0.toLowerCase() === token.toLowerCase()
          ? pool.token0Metadata
          : pool.token1Metadata;
        const fraction = getV3SpotPriceFraction(pool, token as `0x${string}`, ROBINHOOD_WETH_ADDRESS);
        const price = Number(formatV3PriceFraction(fraction, 30));
        const supply = Number(formatUnits(metadata.totalSupply, metadata.decimals));
        return price * supply;
      }

      if (!factoryAddress || !baseTokens || baseTokens.length === 0) {
        return undefined;
      }

      // 使用第一个baseToken（通常是WBNB）
      const baseToken = baseTokens[0];

      if (!baseToken) {
        return undefined;
      }

      // 创建价格计算器
      const calculator = new PriceCalculator(rpcUrl, factoryAddress, baseTokens);

      // 查找交易对
      const pairInfo = await calculator.findTokenPair(task.config.tokenContract, baseToken);

      if (!pairInfo) {
        return undefined;
      }

      // 计算市值：对于BNB池，市值 = BNB储备量 * 2（因为池子中BNB和代币价值相等）
      // 这里需要判断哪个是BNB储备
      // 判断哪个储备是BNB（通过比较地址）
      // 简化处理：假设baseToken是BNB，那么需要找到对应的储备
      const isToken0Base = pairInfo.token0.toLowerCase() === baseToken.toLowerCase();
      const bnbReserve = isToken0Base ? pairInfo.reserve0 : pairInfo.reserve1;

      // 获取BNB精度（18）
      const bnbAmount = Number(formatEther(bnbReserve));

      // 市值 = 池子中BNB储备量（与资金池查询保持一致）
      return bnbAmount;

    } catch (error) {
      console.error('获取市值失败:', error);
      return undefined;
    }
  }

  async function getCurrentPrice(task: Task): Promise<number | undefined> {
    try {
      const dexStore = useDexStore();
      const chainId = task.config.chainId;
      const rpcUrl = task.config.rpcUrl || defaultRpcForChain(chainId);
      const taskDex = dexStore.dexConfigs.find(dex => dex.id === task.config.dexId && dex.chainId === chainId);
      const baseToken = taskDex?.baseTokens?.[0];
      if (!taskDex || !baseToken) return undefined;

      if (chainId === 4663) {
        const token = task.config.innerTokenAddress || task.config.tokenContract;
        const publicClient = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
        const v3 = new UniswapV3Service(publicClient, { defaultFee: task.config.v3FeeTier ?? PONS_V3_POOL_FEE });
        const pool = await v3.getPool(token as `0x${string}`, ROBINHOOD_WETH_ADDRESS, task.config.v3FeeTier ?? PONS_V3_POOL_FEE);
        if (!pool || pool.liquidity <= 0n) return undefined;
        const fraction = getV3SpotPriceFraction(pool, token as `0x${string}`, ROBINHOOD_WETH_ADDRESS);
        return Number(formatV3PriceFraction(fraction, 30));
      }

      const calculator = new PriceCalculator(rpcUrl, taskDex.factoryAddress, taskDex.baseTokens, taskDex.routerAddress, chainId);
      const pair = await calculator.findTokenPair(task.config.tokenContract, baseToken);
      return pair?.price;
    } catch (error) {
      console.error('获取价格失败:', error);
      return undefined;
    }
  }

  // 执行一轮交易（round-robin + 买卖线程数）
  async function executeRound(task: Task): Promise<void> {
    if (task.status !== 'running') return;

    // DEX/Pons 任务在发单前检查价格类停止条件；FourMeme 内盘没有可比 DEX 池。
    if (!isFourMemeTask(task) && (task.config.stopType === 'price' || task.config.stopType === 'marketcap')) {
      const currentPrice = task.config.stopType === 'price' ? await getCurrentPrice(task) : undefined;
      const currentMarketCap = task.config.stopType === 'marketcap' ? await getCurrentMarketCap(task) : undefined;
      const metric = task.config.stopType === 'price' ? currentPrice : currentMarketCap;
      if (metric !== undefined) {
        const unit = taskNativeSymbol(task);
        addLog(task.id, 'info', `当前${task.config.stopType === 'price' ? '价格' : '市值'}: ${metric.toFixed(8)} ${unit}, 目标: ${task.config.stopValue} ${unit} [>=目标停止]`);
        if (checkStopCondition(task, currentPrice, currentMarketCap)) {
          stopTask(task.id, '已达到停止条件');
          return;
        }
      }
    }

    const wallets = task.walletAddresses;
    const buyThreadCount = task.config.buyThreadCount || 0;
    const sellThreadCount = task.config.sellThreadCount || 0;

    if (wallets.length === 0) {
      addLog(task.id, 'warning', '没有钱包参与交易');
      return;
    }

    if (buyThreadCount === 0 && sellThreadCount === 0) {
      addLog(task.id, 'warning', '买入和卖出线程数都为0，没有交易需要执行');
      return;
    }

    // 内盘模式：使用缓存的 FourMemeService 实例
    let sharedFourMemeService: InstanceType<typeof FourMemeService> | undefined;
    if (isFourMemeTask(task)) {
      sharedFourMemeService = fourMemeServiceCache.get(task.id);
      if (!sharedFourMemeService) {
        const buyRpc = getBuyRpcUrl(task.config);
        const sellRpc = getSellRpcUrl(task.config);
        sharedFourMemeService = createFourMemeService(task.config.chainId, buyRpc, sellRpc);
        fourMemeServiceCache.set(task.id, sharedFourMemeService);
        // 新建的 service 连接是冷的，立即预热（不阻塞当前轮次，下一轮受益）
        sharedFourMemeService.warmupConnections().catch(() => {});
      }
    }

    // 确定本轮参与的买入和卖出钱包
    const buyWallets: string[] = [];
    const sellWallets: string[] = [];

    if (buyThreadCount > 0) {
      for (let i = 0; i < buyThreadCount; i++) {
        const walletIndex = (task.currentBuyWalletIndex + i) % wallets.length;
        buyWallets.push(wallets[walletIndex]);
      }
      task.currentBuyWalletIndex = (task.currentBuyWalletIndex + buyThreadCount) % wallets.length;
    }

    if (sellThreadCount > 0) {
      for (let i = 0; i < sellThreadCount; i++) {
        const walletIndex = (task.currentSellWalletIndex + i) % wallets.length;
        sellWallets.push(wallets[walletIndex]);
      }
      task.currentSellWalletIndex = (task.currentSellWalletIndex + sellThreadCount) % wallets.length;
    }

    // Group participants by the exact RPC that will broadcast their direction.
    // The first queued market operation performs this once while holding the
    // market lease, before any wallet approval/trade write in the round.
    const preflightGroups = new Map<string, Map<string, string>>();
    const addPreflightGroup = (direction: 'buy' | 'sell', addresses: string[]) => {
      if (addresses.length === 0) return;
      const rpcUrl = getTaskExecutionRpc(task, direction);
      const group = preflightGroups.get(rpcUrl) ?? new Map<string, string>();
      for (const walletAddress of addresses) {
        group.set(walletAddress.toLowerCase(), walletAddress);
      }
      preflightGroups.set(rpcUrl, group);
    };
    addPreflightGroup('buy', buyWallets);
    addPreflightGroup('sell', sellWallets);

    let roundPreflightPromise: Promise<void> | undefined;
    const ensureRoundPreflight = (marketLeaseGuard: TransferLeaseGuard): Promise<void> => {
      if (!roundPreflightPromise) {
        roundPreflightPromise = (async () => {
          for (const [rpcUrl, group] of preflightGroups) {
            marketLeaseGuard.assertActive();
            const blockedWallet = await findBlockedUnresolvedWallet(
              task,
              [...group.values()],
              true,
              rpcUrl,
            );
            if (!blockedWallet) continue;

            if (blockedWallet.code === WALLET_PENDING_PREDECESSOR_CODE) {
              await withTaskWalletLease(
                task.config.chainId,
                blockedWallet.walletAddress,
                async walletLeaseGuard => {
                  const combinedGuard = combineLeaseGuards(marketLeaseGuard, walletLeaseGuard);
                  markTaskUnresolvedTransaction(
                    task,
                    blockedWallet.walletAddress,
                    'pending',
                    undefined,
                    rpcUrl,
                  );
                  retainLeasesUntilUnresolvedSettles(
                    task,
                    blockedWallet.walletAddress,
                    rpcUrl,
                    undefined,
                    combinedGuard,
                    'wallet-and-market',
                  );
                },
              );
            }

            addLog(
              task.id,
              'warning',
              `${blockedWallet.walletAddress.slice(0, 10)}... ${blockedWallet.message}；本轮权威预检未通过，0 笔发送`,
              blockedWallet.walletAddress,
              blockedWallet.txHash,
            );
            if (task.status === 'running') pauseTask(task.id);
            throw new TaskRoundCancelledError();
          }
        })();
      }
      return roundPreflightPromise;
    };

    // ===== ASTER 池内盘快速路径（两阶段执行） =====
    const isAsterInner = isFourMemeTask(task) && !!task.config.poolBaseToken && task.preApprovalDone;

    if (isAsterInner && sharedFourMemeService) {
      const allWallets = [...new Set([...buyWallets, ...sellWallets])];

      addLog(task.id, 'info', `[快速路径] 批量预取数据，钱包数: ${allWallets.length}`);

      // 阶段1：只预取不会参与最终 nonce 决策的数据。nonce 必须在
      // 钱包/市场锁内同时读取 latest+pending，锁外预取会过期并污染状态。
      const tokenAddress = task.config.innerTokenAddress || task.config.tokenContract;
      const baseTokenAddress = task.config.poolBaseToken!;

      const [prefetchData] = await Promise.all([
        // 批量获取余额 + allowance（通过 multicall 合约）
        sharedFourMemeService.batchPrepareRound({
          tokenAddress,
          baseTokenAddress,
          buyWalletAddresses: buyWallets,
          sellWalletAddresses: sellWallets
        }),
        // 并行预热防夹节点连接（Phase 2 发交易要用，确保 TCP/TLS 已建立）
        sharedFourMemeService.warmupTradeRpc()
      ]);

      // 阶段2：创建本轮工作项；实际广播由同市场/同钱包锁逐笔串行。
      const allPromises: Promise<boolean>[] = [];

      if (buyWallets.length > 0) {
        addLog(task.id, 'info', `买入: ${buyWallets.length} 个钱包 [快速]`);
        for (const addr of buyWallets) {
          const data = prefetchData.get(addr.toLowerCase());
          allPromises.push(executeWalletTradeFast(
            task,
            addr,
            'buy',
            sharedFourMemeService,
            data,
            ensureRoundPreflight,
          ));
        }
      }

      if (sellWallets.length > 0) {
        addLog(task.id, 'info', `卖出: ${sellWallets.length} 个钱包 [快速]`);
        for (const addr of sellWallets) {
          const data = prefetchData.get(addr.toLowerCase());
          allPromises.push(executeWalletTradeFast(
            task,
            addr,
            'sell',
            sharedFourMemeService,
            data,
            ensureRoundPreflight,
          ));
        }
      }

      await Promise.allSettled(allPromises);

    } else {
      // ===== 非 ASTER 池 / 外盘 / 预授权未完成：走原有路径 =====
      const allPromises: Promise<boolean>[] = [];

      if (buyWallets.length > 0) {
        addLog(task.id, 'info', `买入: ${buyWallets.length} 个钱包`);
        for (const addr of buyWallets) {
          allPromises.push(executeWalletTrade(
            task,
            addr,
            'buy',
            sharedFourMemeService,
            ensureRoundPreflight,
          ));
        }
      }

      if (sellWallets.length > 0) {
        addLog(task.id, 'info', `卖出: ${sellWallets.length} 个钱包`);
        for (const addr of sellWallets) {
          allPromises.push(executeWalletTrade(
            task,
            addr,
            'sell',
            sharedFourMemeService,
            ensureRoundPreflight,
          ));
        }
      }

      await Promise.allSettled(allPromises);
    }

    // 执行后检查停止条件（内盘模式不检查市值，因为没有 DEX 交易对）
    if (!isFourMemeTask(task)) {
      const currentPrice = task.config.stopType === 'price' ? await getCurrentPrice(task) : undefined;
      const currentMarketCap = task.config.stopType === 'marketcap' ? await getCurrentMarketCap(task) : undefined;
      if (checkStopCondition(task, currentPrice, currentMarketCap)) {
        stopTask(task.id, '已达到停止条件');
      }
    } else {
      // 内盘模式：只检查非市值相关的停止条件
      if (checkStopCondition(task, undefined, undefined)) {
        stopTask(task.id, '已达到停止条件');
      }
    }

    // 防抖同步统计数据到服务器
    scheduleStatsSync(task.id);
  }

  // 开始任务
  async function startTask(taskId: string): Promise<boolean> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    const overlapsActiveBatchSell = task.walletAddresses.some(walletAddress =>
      activeBatchSellWalletKeys.has(taskWalletLeaseKey(task.config.chainId, walletAddress)),
    );
    const tokenAddress = taskTokenAddress(task);
    const overlapsActiveBatchMarket = tokenAddress
      ? activeBatchSellMarketKeys.has(taskMarketLeaseKey(task.config.chainId, tokenAddress))
      : false;
    if (activeBatchSellTaskIds.has(taskId) || overlapsActiveBatchSell || overlapsActiveBatchMarket) {
      addLog(task.id, 'warning', '手工批量卖出正在独占该任务的钱包或代币市场，完成前不能启动或恢复自动任务');
      return false;
    }

    if (task.walletAddresses.length === 0) {
      addLog(task.id, 'error', '没有选中任何钱包，无法开始任务');
      return false;
    }

    const unresolvedWallet = await findBlockedUnresolvedWallet(task, task.walletAddresses);
    if (unresolvedWallet) {
      addLog(
        task.id,
        'warning',
        `${unresolvedWallet.walletAddress.slice(0, 10)}... ${unresolvedWallet.message}；任务未启动且不会重发`,
        unresolvedWallet.walletAddress,
        unresolvedWallet.txHash,
      );
      return false;
    }

    // 内盘任务：确保 FourMemeService 实例存在（创建任务时已预热）
    if (isFourMemeTask(task) && !fourMemeServiceCache.has(taskId)) {
      const buyRpc = getBuyRpcUrl(task.config);
      const sellRpc = getSellRpcUrl(task.config);
      const service = createFourMemeService(task.config.chainId, buyRpc, sellRpc);
      fourMemeServiceCache.set(taskId, service);
      // 预热连接（异步，不阻塞）- 停止后重启时 service 是新创建的，连接需要重新建立
      service.warmupConnections().catch(() => {});
    }

    // 立即设置状态为运行中（必须在 await 之前，否则 UI 不更新）
    task.status = 'running';
    task.stats.startTime = Date.now();
    task.currentBuyWalletIndex = 0;
    task.currentSellWalletIndex = 0;

    const buyThreadCount = task.config.buyThreadCount || 0;
    const sellThreadCount = task.config.sellThreadCount || 0;
    addLog(task.id, 'info', `任务开始执行，间隔: ${task.config.interval}秒，买${buyThreadCount}/卖${sellThreadCount}，钱包数: ${task.walletAddresses.length}`);

    try {
      // 首轮（包含可能的预授权等待）必须先完整收尾，再开始计时下一轮。
      // 这样 interval 再短也不会和首轮争用同一钱包。
      await runTrackedRound(taskId, async () => {
        // ASTER 池预授权守卫：等待预授权完成（最多 30 秒）
        if (isFourMemeTask(task) && task.config.poolBaseToken && !task.preApprovalDone) {
          const tracker = preApprovalTracker.get(taskId);
          if (tracker && !tracker.completed) {
            addLog(task.id, 'info', '等待预授权完成...');
            try {
              await Promise.race([
                tracker.promise,
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error('预授权超时')), 30000)),
              ]);
            } catch {
              addLog(task.id, 'warning', '预授权跨节点确认超时，任务已暂停且不会发送交易');
              if (task.status === 'running') pauseTask(task.id);
              return;
            }
          }

          // preApproveWallets may have discovered a source/peer receipt that
          // still needs reconciliation after startTask's initial guard check.
          // Recheck before entering the first market lease or sending anything.
          const blockedAfterPreApproval = await findBlockedUnresolvedWallet(task, task.walletAddresses);
          if (blockedAfterPreApproval) {
            addLog(
              task.id,
              'warning',
              `${blockedAfterPreApproval.walletAddress.slice(0, 10)}... ${blockedAfterPreApproval.message}；预授权未完成跨节点对账，任务已暂停且 0 笔发送`,
              blockedAfterPreApproval.walletAddress,
              blockedAfterPreApproval.txHash,
            );
            if (task.status === 'running') pauseTask(task.id);
            return;
          }
        }

        if (task.status === 'running') {
          await executeRound(task);
        }
      });
    } catch (error: any) {
      addLog(task.id, 'error', `任务轮次执行异常: ${error.message || '未知错误'}`);
      if (task.status === 'running') task.status = 'paused';
      return false;
    }

    // 首轮期间可能被手工暂停或批量卖出暂停，此时不再安排新轮次。
    if (task.status !== 'running') return true;

    // 使用 setTimeout 递归调用，而不是 setInterval
    // 这样每次执行时都能获取最新的任务配置（包括 interval）
    function scheduleNextRound() {
      // 每次调度时重新获取最新的任务对象
      const currentTask = tasks.value.find(t => t.id === taskId);
      if (!currentTask || currentTask.status !== 'running') return;

      // 使用最新的 interval 配置
      const intervalMs = currentTask.config.interval * 1000;

      currentTask.intervalId = window.setTimeout(async () => {
        // 再次获取最新的任务对象
        const latestTask = tasks.value.find(t => t.id === taskId);
        if (!latestTask || latestTask.status !== 'running') return;

        // 更新运行时间
        if (latestTask.stats.startTime) {
          latestTask.stats.elapsedTime = Math.floor((Date.now() - latestTask.stats.startTime) / 1000);
        }

        try {
          await runTrackedRound(taskId, () => executeRound(latestTask));
        } catch (error: any) {
          addLog(taskId, 'error', `任务轮次执行异常: ${error.message || '未知错误'}`);
          if (latestTask.status === 'running') latestTask.status = 'paused';
          latestTask.intervalId = undefined;
          return;
        }

        // 递归调度下一轮
        if (latestTask.status === 'running') scheduleNextRound();
      }, intervalMs);
    }

    // 开始调度
    scheduleNextRound();

    return true;
  }

  // 暂停任务
  function pauseTask(taskId: string): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return false;

    task.status = 'paused';

    if (task.intervalId) {
      clearTimeout(task.intervalId);  // 使用 clearTimeout
      task.intervalId = undefined;
    }

    addLog(task.id, 'warning', '任务已暂停');
    return true;
  }

  // 继续任务
  async function resumeTask(taskId: string): Promise<boolean> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task || task.status !== 'paused') return false;

    return startTask(taskId);
  }

  // 停止任务
  function stopTask(taskId: string, reason?: string): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    task.status = 'stopped';

    if (task.intervalId) {
      clearTimeout(task.intervalId);  // 使用 clearTimeout
      task.intervalId = undefined;
    }

    // 清理缓存的 FourMemeService 实例
    fourMemeServiceCache.delete(taskId);
    // 清理预授权追踪
    invalidatePreApprovalRun(taskId);

    // 立即刷新统计数据到服务器
    flushStatsSync(taskId);

    addLog(task.id, 'info', `任务已停止${reason ? `，原因: ${reason}` : ''}`);
    return true;
  }

  // 删除任务
  async function deleteTask(taskId: string): Promise<boolean> {
    const taskIndex = tasks.value.findIndex(t => t.id === taskId);
    if (taskIndex === -1) return false;

    const task = tasks.value[taskIndex];

    // 同步到服务器
    if (shouldUseServerMode() && task._id) {
      try {
        await taskApi.deleteTask(task._id);
      } catch (error) {
        console.error('从服务器删除任务失败:', error);
      }
    }

    // 清理缓存的 FourMemeService 实例
    fourMemeServiceCache.delete(taskId);
    // 清理预授权追踪
    invalidatePreApprovalRun(taskId);

    // 先停止任务
    if (task.status === 'running') {
      stopTask(taskId);
    }

    tasks.value.splice(taskIndex, 1);

    // 如果删除的是当前查看的任务，切换到另一个
    if (activeLogTaskId.value === taskId) {
      activeLogTaskId.value = tasks.value.length > 0 ? tasks.value[0].id : null;
    }

    return true;
  }

  // 更新任务配置
  async function updateTask(
    taskId: string,
    updates: {
      name?: string;
      config?: Partial<TaskConfig>;
      walletAddresses?: string[];
    }
  ): Promise<boolean> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    // 只有暂停或停止状态的任务才能编辑
    if (task.status === 'running') {
      console.error('运行中的任务不能编辑');
      return false;
    }

    const tradingRuntimeChanged = updates.config !== undefined || updates.walletAddresses !== undefined;
    if (tradingRuntimeChanged) {
      // Invalidate before mutating so an older background pre-approval cannot
      // broadcast for stale wallets/tokens/endpoints or write preApprovalDone.
      task.preApprovalDone = false;
      invalidatePreApprovalRun(taskId);
      fourMemeServiceCache.delete(taskId);
    }

    // 更新任务名称
    if (updates.name !== undefined) {
      task.name = updates.name;
    }

    // 更新任务配置
    if (updates.config) {
      task.config = normalizeTaskConfig({ ...task.config, ...updates.config });
    }

    // 更新钱包地址列表
    if (updates.walletAddresses !== undefined) {
      task.walletAddresses = updates.walletAddresses;
    }

    if (tradingRuntimeChanged && isFourMemeTask(task) && task.config.poolBaseToken) {
      preApproveWallets(task);
    }

    // 同步到服务器
    if (shouldUseServerMode() && task._id) {
      try {
        await taskApi.updateTask(task._id, {
          name: task.name,
          config: task.config,
          walletAddresses: task.walletAddresses
        });
      } catch (error) {
        console.error('同步任务更新到服务器失败:', error);
        addLog(taskId, 'warning', '任务更新同步到服务器失败');
      }
    }

    addLog(taskId, 'info', `任务配置已更新`);
    return true;
  }

  // 批量更改代币地址（仅内盘任务，仅停止/暂停状态）
  async function batchUpdateTokenAddress(taskIds: string[], newTokenAddress: string): Promise<number> {
    let updatedCount = 0;
    for (const taskId of taskIds) {
      const task = tasks.value.find(t => t.id === taskId);
      if (!task) continue;
      // 只更新内盘任务
      if (task.config.marketType !== 'inner') continue;
      // 只有停止或暂停状态的任务才能更新
      if (task.status === 'running') continue;

      task.preApprovalDone = false;
      invalidatePreApprovalRun(taskId);
      fourMemeServiceCache.delete(taskId);

      task.config.tokenContract = newTokenAddress;
      task.config.innerTokenAddress = newTokenAddress;
      if (isFourMemeTask(task) && task.config.poolBaseToken) {
        preApproveWallets(task);
      }
      updatedCount++;
      addLog(taskId, 'info', `代币地址已更新为: ${newTokenAddress}`);
    }

    // 同步到服务器
    if (shouldUseServerMode() && updatedCount > 0) {
      const serverIds = tasks.value
        .filter(t => taskIds.includes(t.id) && t._id && t.config.marketType === 'inner')
        .map(t => t._id!);
      if (serverIds.length > 0) {
        try {
          await taskApi.batchUpdateTokenAddress(serverIds, newTokenAddress);
        } catch (error) {
          console.error('批量更新代币地址到服务器失败:', error);
        }
      }
    }

    return updatedCount;
  }

  // 切换日志视图
  function setActiveLogTask(taskId: string | null) {
    activeLogTaskId.value = taskId;
  }

  // 清空任务日志
  function clearTaskLogs(taskId: string) {
    const task = tasks.value.find(t => t.id === taskId);
    if (task) {
      task.logs = [];
      addLog(task.id, 'info', '日志已清空');
    }
  }

  // 清空所有任务（页面刷新时调用）
  async function clearAllTasks() {
    // 同步到服务器
    if (shouldUseServerMode()) {
      try {
        await taskApi.clearAllTasks();
      } catch (error) {
        console.error('清空服务器任务失败:', error);
      }
    }

    // 停止所有运行中的任务
    tasks.value.forEach(task => {
      if (task.intervalId) {
        clearTimeout(task.intervalId);  // 使用 clearTimeout
      }
      invalidatePreApprovalRun(task.id);
      fourMemeServiceCache.delete(task.id);
    });
    tasks.value = [];
    activeLogTaskId.value = null;
  }

  // 批量删除任务（一次性删除，避免多次触发Vue响应式更新导致渲染问题）
  async function deleteMultipleTasks(taskIds: string[]): Promise<number> {
    if (taskIds.length === 0) return 0;

    // 同步到服务器
    if (shouldUseServerMode()) {
      const serverIds = tasks.value
        .filter(t => taskIds.includes(t.id) && t._id)
        .map(t => t._id!);
      if (serverIds.length > 0) {
        try {
          await taskApi.deleteTasks(serverIds);
        } catch (error) {
          console.error('批量删除服务器任务失败:', error);
        }
      }
    }

    // 先停止所有运行中的任务
    for (const taskId of taskIds) {
      const task = tasks.value.find(t => t.id === taskId);
      if (task) {
        if (task.intervalId) {
          clearTimeout(task.intervalId);
          task.intervalId = undefined;
        }
        task.status = 'stopped';
        invalidatePreApprovalRun(taskId);
        fourMemeServiceCache.delete(taskId);
      }
    }

    // 记录删除前的数量
    const originalLength = tasks.value.length;

    // 创建要删除的ID集合（用于快速查找）
    const taskIdSet = new Set(taskIds);

    // 一次性过滤掉所有要删除的任务（只触发一次响应式更新）
    tasks.value = tasks.value.filter(t => !taskIdSet.has(t.id));

    // 计算实际删除数量
    const deletedCount = originalLength - tasks.value.length;

    // 如果删除的任务包含当前查看日志的任务，切换到另一个
    if (activeLogTaskId.value && taskIdSet.has(activeLogTaskId.value)) {
      activeLogTaskId.value = tasks.value.length > 0 ? tasks.value[0].id : null;
    }

    return deletedCount;
  }

  // 查询任务所有钱包的代币余额
  async function queryTaskTokenBalances(taskId: string): Promise<{ address: string; balance: string; rawBalance: bigint }[]> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return [];

    const chainId = task.config.chainId;
    const rpcUrl = task.config.rpcUrl || defaultRpcForChain(chainId);
    const chain = getTaskChain(chainId);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl)
    });

    const tokenAddress = task.config.marketType === 'inner'
      ? (task.config.innerTokenAddress || task.config.tokenContract)
      : task.config.tokenContract;

    if (!tokenAddress) {
      addLog(taskId, 'error', '未设置代币合约地址');
      return [];
    }

    // 获取代币精度
    let decimals = 18;
    try {
      decimals = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: [{
          name: 'decimals',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: '', type: 'uint8' }]
        }],
        functionName: 'decimals'
      }) as number;
    } catch { /* use default 18 */ }

    const results: { address: string; balance: string; rawBalance: bigint }[] = [];
    let totalBalance = 0n;

    addLog(taskId, 'info', `开始查询 ${task.walletAddresses.length} 个钱包的代币余额...`);

    for (const addr of task.walletAddresses) {
      try {
        const balance = await publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: [{
            name: 'balanceOf',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }]
          }],
          functionName: 'balanceOf',
          args: [addr as `0x${string}`]
        }) as bigint;

        const formatted = formatUnits(balance, decimals);
        results.push({ address: addr, balance: formatted, rawBalance: balance });
        totalBalance += balance;

        if (balance > 0n) {
          addLog(taskId, 'info', `${addr.slice(0, 10)}... 余额: ${formatted}`);
        }
      } catch (error: any) {
        results.push({ address: addr, balance: '查询失败', rawBalance: 0n });
        addLog(taskId, 'error', `查询 ${addr.slice(0, 10)}... 余额失败: ${error.message}`);
      }
    }

    const totalFormatted = formatUnits(totalBalance, decimals);
    addLog(taskId, 'success', `查询完成，总余额: ${totalFormatted}，有余额的钱包: ${results.filter(r => r.rawBalance > 0n).length}/${results.length}`);

    return results;
  }

  // 手工卖出任务所有钱包的代币。执行前会暂停同一任务的自动轮次，
  // 并等待已进入交易生命周期的当前轮次收尾。
  async function batchSellForTask(taskId: string): Promise<void> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return;

    const uniqueWalletMap = new Map<string, string>();
    for (const originalAddress of task.walletAddresses) {
      const walletAddress = originalAddress.trim();
      if (walletAddress) uniqueWalletMap.set(walletAddress.toLowerCase(), walletAddress);
    }
    const walletAddresses = [...uniqueWalletMap.values()];
    const duplicateCount = task.walletAddresses.length - walletAddresses.length;
    const tokenAddress = taskTokenAddress(task);
    if (!tokenAddress) {
      addLog(taskId, 'error', '未设置代币合约地址');
      return;
    }
    const batchWalletKeys = walletAddresses.map(walletAddress =>
      taskWalletLeaseKey(task.config.chainId, walletAddress),
    );
    const batchMarketKey = taskMarketLeaseKey(task.config.chainId, tokenAddress);
    const overlapsAnotherBatchSell = batchWalletKeys.some(key => activeBatchSellWalletKeys.has(key))
      || activeBatchSellMarketKeys.has(batchMarketKey);

    if (activeBatchSellTaskIds.has(taskId) || overlapsAnotherBatchSell) {
      addLog(taskId, 'warning', '该任务、其中的钱包或同一代币市场已在执行手工批量卖出，本次重复操作未发送任何交易');
      return;
    }
    if (walletAddresses.length === 0) {
      addLog(taskId, 'warning', '任务中没有可执行的钱包地址');
      return;
    }

    const unresolvedWallet = await findBlockedUnresolvedWallet(task, walletAddresses);
    if (unresolvedWallet) {
      addLog(
        taskId,
        'warning',
        `[批量卖出] ${unresolvedWallet.walletAddress.slice(0, 10)}... ${unresolvedWallet.message}；本次未发送任何交易`,
        unresolvedWallet.walletAddress,
        unresolvedWallet.txHash,
      );
      return;
    }

    activeBatchSellTaskIds.add(taskId);
    batchWalletKeys.forEach(key => activeBatchSellWalletKeys.add(key));
    activeBatchSellMarketKeys.add(batchMarketKey);
    try {
      if (duplicateCount > 0) {
        addLog(taskId, 'warning', `已去除 ${duplicateCount} 个重复钱包地址，每个钱包本次最多卖出一次`);
      }

      const batchWalletKeySet = new Set(batchWalletKeys);
      // 已经点过“暂停”的任务，其当前轮次仍可能正在等待链上回执。
      // 因此不能只看 status=running；只要有 activeRound 就必须排空。
      const conflictingTasks = tasks.value.filter(candidate => {
        if (candidate.config.chainId !== task.config.chainId) return false;
        const sharesWallet = candidate.walletAddresses.some(walletAddress =>
          batchWalletKeySet.has(taskWalletLeaseKey(candidate.config.chainId, walletAddress)),
        );
        const candidateToken = taskTokenAddress(candidate);
        const sharesMarket = !!candidateToken
          && taskMarketLeaseKey(candidate.config.chainId, candidateToken) === batchMarketKey;
        return (sharesWallet || sharesMarket)
          && (candidate.status === 'running' || activeRoundPromises.has(candidate.id));
      });
      const conflictingRunningTasks = conflictingTasks.filter(candidate => candidate.status === 'running');

      for (const conflictingTask of conflictingRunningTasks) {
        pauseTask(conflictingTask.id);
      }
      if (conflictingTasks.length > 0) {
        addLog(
          taskId,
          'warning',
          `检测到 ${conflictingTasks.length} 个同链且共用钱包或同一代币市场的任务仍在运行/收尾，已暂停新轮次并等待当前轮次完成`,
        );
      }

      await Promise.all(conflictingTasks.map(async (conflictingTask) => {
        const activeRound = activeRoundPromises.get(conflictingTask.id);
        if (activeRound) {
          try {
            await activeRound;
          } catch (error: any) {
            addLog(
              taskId,
              'warning',
              `冲突任务 "${conflictingTask.name}" 的当前轮次以异常结束: ${error.message || '未知错误'}`,
            );
          }
        }
        // 对于本次批卖主动暂停或此前已暂停的任务，收尾后不自动恢复。
        // 原本已停止的任务保持 stopped。
        if (conflictingTask.status !== 'stopped') conflictingTask.status = 'paused';
      }));
      if (conflictingTasks.length > 0) {
        addLog(taskId, 'info', '所有冲突自动轮次已收尾，手工批量卖出开始独占相关钱包和代币市场');
      }

      const walletStore = useWalletStore();
      const dexStore = useDexStore();
      const chainId = task.config.chainId;
      const rpcUrl = task.config.rpcUrl || defaultRpcForChain(chainId);
      const authoritativeSellRpc = isFourMemeTask(task)
        ? getSellRpcUrl(task.config)
        : chainId === 4663
          ? (task.config.antiSandwichRpc || task.config.rpcUrl || rpcUrl)
          : getSellRpcUrl(task.config);

      // 一个市场租约覆盖整批：本批每个钱包仍在前一笔最终确认后重新
      // 读取余额/池状态并报价，同时阻止其他页面/设备通过本系统改变同池状态。
      await withTaskMarketLease(chainId, tokenAddress, async (marketLeaseGuard) => {
        marketLeaseGuard?.assertActive();

        // This is the authoritative whole-batch check: it runs after all local
        // conflicting rounds have drained and while the global market lease is
        // held, but before the first approval or sell write.
        const blockedWallet = await findBlockedUnresolvedWallet(
          task,
          walletAddresses,
          true,
          authoritativeSellRpc,
        );
        if (blockedWallet) {
          if (blockedWallet.code === WALLET_PENDING_PREDECESSOR_CODE) {
            await withTaskWalletLease(chainId, blockedWallet.walletAddress, async walletLeaseGuard => {
              const combinedGuard = combineLeaseGuards(marketLeaseGuard, walletLeaseGuard);
              markTaskUnresolvedTransaction(
                task,
                blockedWallet.walletAddress,
                'pending',
                undefined,
                authoritativeSellRpc,
              );
              retainLeasesUntilUnresolvedSettles(
                task,
                blockedWallet.walletAddress,
                authoritativeSellRpc,
                undefined,
                combinedGuard,
                'wallet-and-market',
              );
            });
          }
          addLog(
            taskId,
            'warning',
            `[批量卖出] ${blockedWallet.walletAddress.slice(0, 10)}... ${blockedWallet.message}；权威预检未通过，本批 0 笔发送`,
            blockedWallet.walletAddress,
            blockedWallet.txHash,
          );
          return;
        }

      // 手工 FourMeme 批卖也按钱包串行：一个租约完整覆盖该钱包的
      // 余额/授权检查、可能的 approve、sell 广播以及最终回执。
      if (isFourMemeTask(task)) {
        // 卖出始终使用专用高速节点；buyUsePremiumRpc/antiSandwichRpc 只影响买入。
        const buyRpc = getBuyRpcUrl(task.config);
        const sellRpc = authoritativeSellRpc;
        const sharedFourMemeService = createFourMemeService(chainId, buyRpc, sellRpc);
        let confirmedCount = 0;
        let pendingCount = 0;
        let failCount = 0;
        let unsentCount = 0;

        addLog(taskId, 'info', `开始 FourMeme 手工批量卖出，去重后钱包数: ${walletAddresses.length}，按钱包逐笔确认`);
        for (let index = 0; index < walletAddresses.length; index++) {
          const walletAddress = walletAddresses[index];
          const privateKey = getWalletPrivateKey(walletStore, walletAddress);
          if (!privateKey) {
            failCount++;
            addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 没有私钥，未发送交易`, walletAddress);
            addLog(taskId, 'info', `已完成 ${index + 1}/${walletAddresses.length} 个钱包`);
            continue;
          }

          let stopReason: string | undefined;
          try {
            const broadcastHashes = new Set<string>();
            const outcome: {
              status: 'confirmed' | 'pending' | 'unknown' | 'failed';
              code?: string;
              transactionKind?: 'approval' | 'trade';
              hash?: string;
              error?: string;
            } = await withTaskWalletLease(chainId, walletAddress, async (walletLeaseGuard) => {
              const leaseGuard = combineLeaseGuards(marketLeaseGuard, walletLeaseGuard);
              const onTransactionHash = (txHash: string, kind: 'approval' | 'trade') => {
                if (!txHash || broadcastHashes.has(txHash)) return;
                broadcastHashes.add(txHash);
                addLog(
                  taskId,
                  'info',
                  `[批量卖出] ${walletAddress.slice(0, 10)}... ${kind === 'approval' ? '授权' : '卖出'}交易已广播，等待链上确认`,
                  walletAddress,
                  txHash,
                );
              };
              const commonParams: FourMemeTradeParams = {
                chainId,
                rpcUrl: sellRpc,
                privateKey,
                walletAddress,
                tokenAddress,
                amount: 0,
                mode: 'sell',
                gasPrice: task.config.gasPrice,
                gasLimit: task.config.gasLimit,
                sellPercent: 100,
                slippage: task.config.innerSlippage,
                leaseGuard,
                onTransactionHash,
              };

              leaseGuard?.assertActive();
              const prepareResult = await sharedFourMemeService.prepareSell(commonParams);
              if (
                prepareResult.status === 'pending' || prepareResult.status === 'unknown'
              ) {
                const prepareReconciliationRpc = prepareResult.reconciliationRpcUrl || sellRpc;
                markTaskUnresolvedTransaction(
                  task,
                  walletAddress,
                  prepareResult.status,
                  prepareResult.txHash,
                  prepareReconciliationRpc,
                  prepareResult.receiptRequired,
                );
                retainLeasesUntilUnresolvedSettles(
                  task,
                  walletAddress,
                  prepareReconciliationRpc,
                  prepareResult.txHash,
                  prepareResult.transactionKind === 'approval' ? walletLeaseGuard : leaseGuard,
                  prepareResult.transactionKind === 'approval' ? 'wallet' : 'wallet-and-market',
                );
                return {
                  status: prepareResult.status,
                  code: prepareResult.code,
                  transactionKind: prepareResult.transactionKind,
                  hash: prepareResult.txHash,
                  error: prepareResult.error || '授权交易确认状态未知',
                };
              }
              if (!prepareResult.success) {
                return {
                  status: 'failed' as const,
                  hash: prepareResult.txHash,
                  error: prepareResult.error || '准备卖出失败',
                };
              }
              addLog(
                taskId,
                'info',
                `${walletAddress.slice(0, 10)}... ${prepareResult.needsApproval ? '授权已确认' : '已有足够授权'}`,
                walletAddress,
              );

              leaseGuard?.assertActive();
              const sendResult = await sharedFourMemeService.executeSellDirect(commonParams, prepareResult.sellAmount);
              const sendStatus = sendResult.status || (sendResult.success ? 'confirmed' : 'failed');
              // executeSellDirect is a distinct write. A hashless trade-unknown
              // must never inherit the already-confirmed approval hash.
              const sendHash = sendResult.txHash;
              if (sendStatus === 'pending' || sendStatus === 'unknown') {
                const sendReconciliationRpc = sendResult.reconciliationRpcUrl || sellRpc;
                markTaskUnresolvedTransaction(
                  task,
                  walletAddress,
                  sendStatus,
                  sendHash,
                  sendReconciliationRpc,
                  sendResult.receiptRequired,
                );
                retainLeasesUntilUnresolvedSettles(
                  task,
                  walletAddress,
                  sendReconciliationRpc,
                  sendHash,
                  leaseGuard,
                );
              }
              return {
                status: sendStatus,
                code: sendResult.code,
                transactionKind: sendResult.transactionKind || 'trade',
                hash: sendHash,
                error: sendResult.error || (sendResult.success ? undefined : '卖出交易失败'),
              };
            });

            if (outcome.status === 'confirmed') {
              confirmedCount++;
              addLog(taskId, 'success', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出已确认`, walletAddress, outcome.hash);
            } else if (outcome.status === 'pending' || outcome.status === 'unknown') {
              pendingCount++;
              const isPendingPredecessor = outcome.code === WALLET_PENDING_PREDECESSOR_CODE;
              const approvalOnly = outcome.transactionKind === 'approval' && !isPendingPredecessor;
              if (!approvalOnly) {
                stopReason = isPendingPredecessor
                  ? '钱包已有链上待确认前序交易'
                  : '前一笔卖出仍在待确认或状态未知';
              }
              addLog(
                taskId,
                'warning',
                isPendingPredecessor
                  ? `[批量卖出] ${walletAddress.slice(0, 10)}... 检测到链上待确认前序交易，本次未广播新交易；为避免 nonce 或池状态冲突，已停止后续钱包`
                  : approvalOnly
                    ? `[批量卖出] ${walletAddress.slice(0, 10)}... 授权${outcome.status === 'pending' ? '仍在等待另一执行节点同步' : '确认状态未知'}，不会重发该钱包；授权不改变曲线，继续处理后续钱包`
                    : `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出${outcome.status === 'pending' ? '仍在等待确认/节点同步' : '当前确认状态未知'}，不会自动重发；为避免池状态冲突，已停止后续钱包`,
                walletAddress,
                outcome.hash,
              );
            } else {
              failCount++;
              addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出失败: ${outcome.error || '未知错误'}`, walletAddress, outcome.hash);
            }
          } catch (error: any) {
            failCount++;
            addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 异常: ${error.message || '未知错误'}`, walletAddress);
            if (isCoordinationLeaseError(error)) {
              stopReason = '交易协调锁已丢失或被其他操作占用';
              addLog(taskId, 'warning', '为避免跨页面交易改变曲线状态或钱包 nonce，已停止本批后续钱包');
            }
          }

          addLog(taskId, 'info', `已完成 ${index + 1}/${walletAddresses.length} 个钱包`);
          if (stopReason) {
            const unsentWallets = walletAddresses.slice(index + 1);
            unsentCount = unsentWallets.length;
            for (const unsentWallet of unsentWallets) {
              addLog(taskId, 'warning', `[批量卖出] ${unsentWallet.slice(0, 10)}... 未发送：${stopReason}`, unsentWallet);
            }
            break;
          }
        }

        addLog(taskId, 'info', `FourMeme 批量卖出完成，确认 ${confirmedCount} 笔，待确认/未知 ${pendingCount} 笔，失败 ${failCount} 笔，未发送 ${unsentCount} 笔`);
        return;
      }

      // Robinhood / 外盘：一个钱包的 approve + trade 全部收尾后，再读取最新池状态
      // 为下一个钱包报价。这样不会用本批卖出前的旧价格同时构建所有 minOut。
      const effectiveRpcUrl = authoritativeSellRpc;
      const useAster = !!task.config.poolBaseToken;
      const spendToken = useAster ? 'ASTER' : (chainId === 4663 ? 'ETH' : 'BNB');
      const taskDex = dexStore.dexConfigs.find(dex => dex.id === task.config.dexId && dex.chainId === chainId);
      const routerAddress = taskDex?.routerAddress || '';
      let confirmedCount = 0;
      let pendingCount = 0;
      let failCount = 0;
      let unsentCount = 0;

      addLog(taskId, 'info', `开始手工批量卖出，去重后钱包数: ${walletAddresses.length}，底池: ${spendToken}，按钱包动态报价并确认`);
      if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
        failCount = walletAddresses.length;
        addLog(taskId, 'error', `当前 DEX 的 Router 地址未配置，${failCount} 个钱包均未发送交易`);
        addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔`);
        return;
      }

      if (chainId === 4663 && task.config.marketType === 'inner') {
        try {
          const validationClient = createPublicClient({ chain: robinhood, transport: http(effectiveRpcUrl) });
          await readAndValidatePonsLaunchedToken(validationClient, tokenAddress as `0x${string}`);
        } catch (error: any) {
          failCount = walletAddresses.length;
          addLog(taskId, 'error', `Pons 代币校验失败: ${error.message || '未知错误'}，${failCount} 个钱包均未发送交易`);
          addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔`);
          return;
        }
      }

      let tradingService: ReturnType<typeof createTradingService>;
      try {
        tradingService = createTradingService(chainId, effectiveRpcUrl, routerAddress);
      } catch (error: any) {
        failCount = walletAddresses.length;
        addLog(taskId, 'error', `交易服务初始化失败: ${error.message || '未知错误'}，${failCount} 个钱包均未发送交易`);
        addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔`);
        return;
      }

      for (let index = 0; index < walletAddresses.length; index++) {
        const walletAddress = walletAddresses[index];
        const privateKey = getWalletPrivateKey(walletStore, walletAddress);
        if (!privateKey) {
          failCount++;
          addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 没有私钥，未发送交易`, walletAddress);
          addLog(taskId, 'info', `已完成 ${index + 1}/${walletAddresses.length} 个钱包`);
          continue;
        }

        let stopReason: string | undefined;
        try {
           const broadcastHashes = new Set<string>();
           let latestBroadcastHash: string | undefined;
           const result = await withTaskWalletLease(chainId, walletAddress, async (walletLeaseGuard) => {
            const leaseGuard = combineLeaseGuards(marketLeaseGuard, walletLeaseGuard);
            const onTransactionHash = (txHash: string, kind: 'approval' | 'trade') => {
              if (!txHash || broadcastHashes.has(txHash)) return;
               broadcastHashes.add(txHash);
               latestBroadcastHash = txHash;
              addLog(
                taskId,
                'info',
                `[批量卖出] ${walletAddress.slice(0, 10)}... ${kind === 'approval' ? '授权' : '卖出'}交易已广播，等待链上确认`,
                walletAddress,
                txHash,
              );
            };
            const tradeParams: TradeParams = {
              chainId,
              rpcUrl: effectiveRpcUrl,
              routerAddress,
              privateKey,
              walletAddress,
              tokenAddress,
              spendToken,
              amount: 0,
              amountType: 'amount',
              mode: 'dump',
              slippage: taskTradeSlippage(task),
              gasPrice: task.config.gasPrice,
              gasLimit: task.config.gasLimit,
              balancePercent: 100,
              v3FeeTier: task.config.v3FeeTier,
              leaseGuard,
              onTransactionHash,
            };

            leaseGuard?.assertActive();
            const tradeResult = await tradingService.executeTrade(tradeParams);
            const tradeStatus = tradeResult.status;
            // The result identifies the currently ambiguous write. Do not use
            // an older approval callback as the hash for a hashless trade.
            const tradeHash = tradeResult.txHash;
            if (tradeStatus === 'pending' || tradeStatus === 'unknown') {
              markTaskUnresolvedTransaction(
                task,
                walletAddress,
                tradeStatus,
                tradeHash,
                effectiveRpcUrl,
              );
              retainLeasesUntilUnresolvedSettles(
                task,
                walletAddress,
                effectiveRpcUrl,
                tradeHash,
                 tradeResult.transactionKind === 'approval' ? walletLeaseGuard : leaseGuard,
                 tradeResult.transactionKind === 'approval' ? 'wallet' : 'wallet-and-market',
               );
            }
            return tradeResult;
          }) as Awaited<ReturnType<typeof tradingService.executeTrade>> & {
            status?: 'confirmed' | 'pending' | 'unknown' | 'failed' | 'not_sent';
          };

          const resultHash = result.status === 'pending' || result.status === 'unknown'
            ? result.txHash
            : (result.txHash || latestBroadcastHash);
          if (result.status === 'pending' || result.status === 'unknown') {
            pendingCount++;
            const isPendingPredecessor = result.code === WALLET_PENDING_PREDECESSOR_CODE;
            const approvalOnly = result.transactionKind === 'approval' && !isPendingPredecessor;
            if (!approvalOnly) {
              stopReason = isPendingPredecessor
                ? '钱包已有链上待确认前序交易'
                : '前一笔卖出仍在待确认/未知状态';
            }
            addLog(
              taskId,
              'warning',
              isPendingPredecessor
                ? `[批量卖出] ${walletAddress.slice(0, 10)}... 检测到链上待确认前序交易，本次未广播新交易；已停止后续钱包`
                : approvalOnly
                  ? `[批量卖出] ${walletAddress.slice(0, 10)}... 授权${result.status === 'pending' ? '仍在等待确认/节点同步' : '当前确认状态未知'}，不会重发该钱包；继续处理后续钱包`
                  : `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出${result.status === 'pending' ? '仍在等待确认/节点同步' : '当前确认状态未知'}，不会自动重发；已停止后续钱包`,
              walletAddress,
              resultHash,
            );
          } else if (result.success) {
            confirmedCount++;
            addLog(taskId, 'success', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出已确认`, walletAddress, resultHash);
          } else {
            failCount++;
            addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出失败: ${result.error || '未知错误'}`, walletAddress, resultHash);
          }
        } catch (error: any) {
          failCount++;
          addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 异常: ${error.message || '未知错误'}`, walletAddress);
          if (isCoordinationLeaseError(error)) {
            stopReason = '交易协调锁已丢失或被其他操作占用';
            addLog(taskId, 'warning', '为避免跨页面交易改变池状态或钱包 nonce，已停止本批后续钱包');
          }
        }

        addLog(taskId, 'info', `已完成 ${index + 1}/${walletAddresses.length} 个钱包`);
        if (stopReason) {
          const unsentWallets = walletAddresses.slice(index + 1);
          unsentCount = unsentWallets.length;
          for (const unsentWallet of unsentWallets) {
            addLog(taskId, 'warning', `[批量卖出] ${unsentWallet.slice(0, 10)}... 未发送：${stopReason}`, unsentWallet);
          }
          break;
        }
      }

      addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔，未发送 ${unsentCount} 笔`);
      });
    } catch (error: any) {
      if (isCoordinationLeaseError(error)) {
        addLog(taskId, 'warning', `无法取得或维持代币市场全局锁: ${error.message || '未知错误'}；本次没有继续发送交易`);
      } else {
        addLog(taskId, 'error', `批量卖出异常: ${error.message || '未知错误'}；本次没有继续发送交易`);
      }
    } finally {
      activeBatchSellTaskIds.delete(taskId);
      batchWalletKeys.forEach(key => activeBatchSellWalletKeys.delete(key));
      activeBatchSellMarketKeys.delete(batchMarketKey);
    }
  }

  // 获取任务的停止条件描述
  function getStopConditionText(task: Task): string {
    const { stopType, stopValue } = task.config;
    switch (stopType) {
      case 'none':
        return '手动停止';
      case 'count':
        return `执行 ${stopValue} 次`;
      case 'amount':
        return `花费 ${stopValue} ${taskNativeSymbol(task)}`;
      case 'time':
        return `运行 ${stopValue} 秒`;
      case 'price':
        return `价格达到 ${stopValue}`;
      case 'marketcap':
        return `市值达到 ${stopValue} ${taskNativeSymbol(task)}`;
      default:
        return '未知';
    }
  }

  // 获取任务进度
  function getTaskProgress(task: Task): number {
    const { stopType, stopValue } = task.config;
    const { buyCount, sellCount, spentAmount, elapsedTime } = task.stats;
    const totalExecuted = buyCount + sellCount;

    if (stopType === 'none') return 0;

    switch (stopType) {
      case 'count':
        return Math.min((totalExecuted / stopValue) * 100, 100);
      case 'amount':
        return Math.min((spentAmount / stopValue) * 100, 100);
      case 'time':
        return Math.min((elapsedTime / stopValue) * 100, 100);
      case 'price':
        return 0; // 价格条件无法计算进度
      case 'marketcap':
        return 0; // 市值条件无法计算进度（需要实时查询）
      default:
        return 0;
    }
  }

  return {
    // 状态
    tasks,
    activeLogTaskId,

    // 计算属性
    runningTasks,
    pausedTasks,
    taskCount,
    activeLogTask,

    // 方法
    loadFromServer,
    createTask,
    startTask,
    pauseTask,
    resumeTask,
    stopTask,
    deleteTask,
    deleteMultipleTasks,
    updateTask,
    batchUpdateTokenAddress,
    setActiveLogTask,
    clearTaskLogs,
    clearAllTasks,
    addLog,
    getStopConditionText,
    getTaskProgress,
    checkStopCondition,
    queryTaskTokenBalances,
    batchSellForTask
  };
});
