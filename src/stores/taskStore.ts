import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWalletStore } from './walletStore';
import { useDexStore } from './dexStore';
import {
  createTradingService,
  resetNonceForAddress as resetTradingNonceForAddress,
  ZERO_TOKEN_BALANCE_CODE,
  type TradeParams,
} from '../services/tradingService';
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
import { withTransferLease, type TransferLeaseGuard } from '../services/transferLeaseApi';
import {
  RobinhoodSellBroadcastBarrier,
  registerRobinhoodTaskBroadcastCohort,
  type RobinhoodSellBroadcastParticipant,
  type RobinhoodTaskBroadcastRegistration,
} from '../services/robinhoodSellBroadcastBarrier';
import {
  createRuntimeId,
  getClientInstanceId,
  getTaskRuntimeStatus,
  heartbeatTaskRuntime,
  isTaskRuntimeBusy,
  isTaskRuntimeRevoked,
  startTaskRuntime,
  stopTaskRuntime,
} from '../services/taskRuntimeApi';
import { isCurrentClientBuild } from '../services/clientBuildGuard';
import {
  checkUnresolvedTransaction,
  getUnresolvedTransaction,
  markUnresolvedTransaction,
  type UnresolvedTransactionStatus,
} from '../services/unresolvedTransactionGuard';
import { WALLET_PENDING_PREDECESSOR_CODE } from '../services/pendingNonceGuard';
import { getRuntimeRobinhoodRpcUrl } from '../services/robinhoodRpcConfig';
import {
  allocateRobinhoodTaskDirections,
  type TaskDirectionAllocation,
} from '../services/taskRoundAllocator';

function shouldUseServerMode(): boolean {
  return ENABLE_LOGIN && taskApi.isLoggedIn();
}

function coordinationAuthRequiredError(): Error & { code: string } {
  const error = new Error('登录状态已失效，已停止交易；请重新登录后再执行') as Error & { code: string };
  error.code = 'COORDINATION_AUTH_REQUIRED';
  return error;
}

/**
 * A cross-tab revoke is authoritative only for the exact runtime identity it
 * names. Legacy messages without an ID, and delayed messages for a replaced
 * runtime, are hints at most and must not stop the current task.
 */
export function taskRuntimeRevocationMatches(
  messageRuntimeId: string | undefined,
  currentLocalRuntimeId: string | undefined,
  knownRemoteRuntimeId: string | undefined,
): boolean {
  if (!messageRuntimeId) return false;
  if (currentLocalRuntimeId && currentLocalRuntimeId !== messageRuntimeId) return false;
  if (
    !currentLocalRuntimeId
    && knownRemoteRuntimeId
    && knownRemoteRuntimeId !== messageRuntimeId
  ) {
    return false;
  }
  return true;
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
function defaultRpcForChain(chainId: number): string {
  switch (chainId) {
    case 56: return DEFAULT_BSC_RPC;
    case 97: return DEFAULT_BSC_TESTNET_RPC;
    case 66: return DEFAULT_OKX_RPC;
    case 4663: return getRuntimeRobinhoodRpcUrl();
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
    rpcUrl: chainId === 4663
      ? getRuntimeRobinhoodRpcUrl()
      : (config.rpcUrl || defaultRpcForChain(chainId)),
    antiSandwichRpc: chainId === 4663 ? undefined : config.antiSandwichRpc,
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

/**
 * Calculate a fixed-rate, non-overlapping task delay. The time already spent
 * executing/confirming the previous round counts toward the configured interval.
 */
export function calculateNextRoundDelayMs(
  previousRoundStartedAt: number,
  intervalSeconds: number,
  now = Date.now(),
): number {
  const intervalMs = Math.max(0, intervalSeconds * 1000);
  return Math.max(0, previousRoundStartedAt + intervalMs - now);
}

export function calculateTaskRuntimeHeartbeatRetryDelayMs(
  consecutiveFailures: number,
  heartbeatIntervalMs: number,
  leaseRemainingMs: number,
): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const normalInterval = Math.max(250, Math.floor(heartbeatIntervalMs));
  const remaining = Math.max(0, Math.floor(leaseRemainingMs));
  const exponential = Math.min(normalInterval, 500 * (2 ** (failures - 1)));
  // Leave a small window for the response to arrive before the local guard
  // reaches the authoritative lease expiry.
  return Math.max(0, Math.min(exponential, Math.max(0, remaining - 250)));
}

// 任务统计接口
export interface TaskStats {
  buyCount: number;           // 买入执行次数
  sellCount: number;          // 卖出执行次数
  spentAmount: number;        // 已花费金额
  startTime?: number;         // 开始时间
  elapsedTime: number;        // 已运行时间(秒)
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

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
  intervalId?: TimerHandle;   // 定时器ID
  currentBuyWalletIndex: number;  // 买入轮询钱包索引（round-robin）
  currentSellWalletIndex: number; // 卖出轮询钱包索引（round-robin）
  preApprovalDone?: boolean;      // 预授权是否完成（ASTER 池）
  remoteRuntimeActive?: boolean;  // 服务端仍有运行实例（本页可强制停止/删除）
  remoteRuntimeId?: string;       // 最近一次确认仍有效的服务端运行实例
}

function isPureSellAllTask(task: Task): boolean {
  // The wallet-by-wallet balance reconciliation below is currently implemented
  // by the Robinhood V3 trading service. Keep legacy BSC/OKX stop semantics
  // unchanged until their execution paths expose the same authoritative
  // post-settlement balance hook.
  return task.config.chainId === 4663
    && (task.config.buyThreadCount || 0) === 0
    && (task.config.sellThreadCount || 0) > 0
    && task.config.sellAll === true;
}

export const useTaskStore = defineStore('task', () => {
  // 状态
  const tasks = ref<Task[]>([]);
  const activeLogTaskId = ref<string | null>(null);  // 当前查看日志的任务ID

  // 缓存每个任务的 FourMemeService 实例（避免每次执行都重新创建）
  const fourMemeServiceCache = new Map<string, InstanceType<typeof FourMemeService>>();
  // 外盘服务也必须按任务/RPC/Router 复用。Robinhood 的池校验、代币精度和
  // HTTP transport 都是整批不变量；过去每个钱包新建一个实例，会让五线程
  // 重复执行同一组 RPC 预热和池校验。
  const tradingServiceCache = new Map<
    string,
    Map<string, ReturnType<typeof createTradingService>>
  >();
  // Pons launch metadata and the selected DEX configuration are immutable for
  // a launched token.  Re-reading both contracts before every one-second round
  // created a serial RPC barrier without adding nonce or slippage safety.
  const ponsValidationCache = new Map<string, Promise<void>>();

  function clearTradingServiceCache(taskId: string): void {
    tradingServiceCache.delete(taskId);
    for (const key of ponsValidationCache.keys()) {
      if (key.startsWith(`${taskId}:`)) ponsValidationCache.delete(key);
    }
  }

  function validatePonsTaskOnce(task: Task, tokenAddress: string, rpcUrl: string): Promise<void> {
    const key = `${task.id}:${rpcUrl}:${tokenAddress.toLowerCase()}`;
    const cached = ponsValidationCache.get(key);
    if (cached) return cached;

    const validation = (async () => {
      const client = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
      await readAndValidatePonsLaunchedToken(client, tokenAddress as `0x${string}`);
    })();
    ponsValidationCache.set(key, validation);
    void validation.catch(() => {
      if (ponsValidationCache.get(key) === validation) ponsValidationCache.delete(key);
    });
    return validation;
  }

  function getOrCreateTradingService(
    task: Task,
    rpcUrl: string,
    routerAddress: string,
  ): ReturnType<typeof createTradingService> {
    const signature = `${task.config.chainId}:${rpcUrl}:${routerAddress.toLowerCase()}`;
    const taskCache = tradingServiceCache.get(task.id) ?? new Map();
    let service = taskCache.get(signature);
    if (!service) {
      service = createTradingService(task.config.chainId, rpcUrl, routerAddress);
      taskCache.set(signature, service);
      tradingServiceCache.set(task.id, taskCache);
      // Pay the cold DNS/TLS cost while allowance, Pons metadata and other
      // startup reads are preparing. The warmup is read-only and intentionally
      // does not block task startup if an endpoint is temporarily unavailable.
      void service.warmupConnections().catch(() => {});
    }
    return service;
  }

  // 预授权状态跟踪（ASTER 池任务创建时发起预授权，开始时检查是否完成）
  const preApprovalTracker = new Map<string, {
    promise: Promise<void>;
    completed: boolean;
    generation: number;
  }>();
  const preApprovalGenerations = new Map<string, number>();

  // Robinhood/Pons sell tasks pre-authorize at task creation time. This moves
  // the unavoidable on-chain approval confirmation out of the sell button's
  // latency budget while preserving the all-wallet startup barrier.
  const robinhoodSellPreparationTracker = new Map<string, {
    promise: Promise<void>;
    completed: boolean;
    generation: number;
  }>();
  const robinhoodSellPreparationGenerations = new Map<string, number>();

  function invalidatePreApprovalRun(taskId: string): void {
    preApprovalGenerations.set(taskId, (preApprovalGenerations.get(taskId) || 0) + 1);
    preApprovalTracker.delete(taskId);
  }

  function invalidateRobinhoodSellPreparation(taskId: string): void {
    robinhoodSellPreparationGenerations.set(
      taskId,
      (robinhoodSellPreparationGenerations.get(taskId) || 0) + 1,
    );
    robinhoodSellPreparationTracker.delete(taskId);
  }

  // A fixed-rate Robinhood scheduler may have more than one round preparing
  // different wallets at the same time.  Track every round so pause/manual
  // sell can still wait for all writes that already entered the pipeline.
  const activeRoundPromises = new Map<string, Set<Promise<void>>>();
  // Known-hash trades that have been accepted by the RPC but are still being
  // confirmed. These are admission reservations only: they can pause new
  // rounds at a finite budget, but they never satisfy a permanent stop
  // condition until settlement confirms.
  const pendingTaskTrades = new Map<string, { count: number; amount: number }>();
  const mixedDirectionOffsets = new Map<string, number>();
  type MixedDirectionState = {
    generation: number;
    sellDeficit: number;
    sellEligibleWalletKeys: Set<string>;
    buyPreparingWalletKeys: Set<string>;
    buyInFlightWalletKeys: Set<string>;
    recoverySellReservedWalletKeys: Set<string>;
  };
  const mixedDirectionStates = new Map<string, MixedDirectionState>();
  // A task object survives pause/edit/resume, while confirmations from the
  // previous run may still arrive in the background. Fence every run so an
  // old settlement can never mutate the new token/wallet coverage or stats.
  const taskExecutionGenerations = new Map<string, number>();

  type PureSellCoverageState = {
    taskSignature: string;
    generation: number;
    orderedWallets: string[];
    walletKeys: Set<string>;
    clearedWalletKeys: Set<string>;
    preparationFailures: Map<string, number>;
    retryAfterByWallet: Map<string, number>;
    cycleStartedAt: number;
  };

  const pureSellCoverageStates = new Map<string, PureSellCoverageState>();

  function currentTaskExecutionGeneration(taskId: string): number {
    return taskExecutionGenerations.get(taskId) ?? 0;
  }

  function advanceTaskExecutionGeneration(taskId: string): number {
    const next = currentTaskExecutionGeneration(taskId) + 1;
    taskExecutionGenerations.set(taskId, next);
    return next;
  }

  function isTaskExecutionCurrent(task: Task, generation: number): boolean {
    return (
      currentTaskExecutionGeneration(task.id) === generation
      && tasks.value.find(candidate => candidate.id === task.id) === task
      && task.status === 'running'
    );
  }

  function mixedDirectionStateFor(
    task: Task,
    generation = currentTaskExecutionGeneration(task.id),
  ): MixedDirectionState {
    const current = mixedDirectionStates.get(task.id);
    if (current?.generation === generation) return current;
    const next: MixedDirectionState = {
      generation,
      sellDeficit: 0,
      sellEligibleWalletKeys: new Set<string>(),
      buyPreparingWalletKeys: new Set<string>(),
      buyInFlightWalletKeys: new Set<string>(),
      recoverySellReservedWalletKeys: new Set<string>(),
    };
    mixedDirectionStates.set(task.id, next);
    return next;
  }

  function recordMixedDirectionSuccess(
    task: Task,
    walletAddress: string,
    direction: 'buy' | 'sell',
    generation: number,
  ): void {
    if (
      currentTaskExecutionGeneration(task.id) !== generation
      || (task.config.buyThreadCount || 0) <= 0
      || (task.config.sellThreadCount || 0) <= 0
    ) {
      return;
    }
    const state = mixedDirectionStateFor(task, generation);
    const walletKey = walletAddress.toLowerCase();
    if (direction === 'buy') {
      state.buyInFlightWalletKeys.delete(walletKey);
      state.sellEligibleWalletKeys.add(walletKey);
      return;
    }
    const completedRecovery = state.recoverySellReservedWalletKeys.delete(walletKey);
    if (task.config.chainId !== 4663 || completedRecovery) {
      state.sellDeficit = Math.max(0, state.sellDeficit - 1);
    }
    if (task.config.sellAll) state.sellEligibleWalletKeys.delete(walletKey);
  }

  function recordMixedBuyInFlight(
    task: Task,
    walletAddress: string,
    generation: number,
  ): void {
    if (
      currentTaskExecutionGeneration(task.id) !== generation
      || (task.config.buyThreadCount || 0) <= 0
      || (task.config.sellThreadCount || 0) <= 0
    ) {
      return;
    }
    mixedDirectionStateFor(task, generation).buyInFlightWalletKeys
      .add(walletAddress.toLowerCase());
  }

  function recordMixedBuyPreparing(
    task: Task,
    walletAddress: string,
    generation: number,
  ): void {
    if (
      currentTaskExecutionGeneration(task.id) !== generation
      || (task.config.buyThreadCount || 0) <= 0
      || (task.config.sellThreadCount || 0) <= 0
    ) {
      return;
    }
    mixedDirectionStateFor(task, generation).buyPreparingWalletKeys
      .add(walletAddress.toLowerCase());
  }

  function clearMixedBuyPreparing(
    task: Task,
    walletAddress: string,
    generation: number,
  ): void {
    const state = mixedDirectionStates.get(task.id);
    if (state?.generation !== generation) return;
    state.buyPreparingWalletKeys.delete(walletAddress.toLowerCase());
  }

  function clearMixedBuyInFlight(
    task: Task,
    walletAddress: string,
    generation: number,
  ): void {
    const state = mixedDirectionStates.get(task.id);
    if (state?.generation !== generation) return;
    state.buyInFlightWalletKeys.delete(walletAddress.toLowerCase());
  }

  function recordMixedSellDeficit(
    task: Task,
    walletAddress: string,
    generation: number,
  ): void {
    if (
      currentTaskExecutionGeneration(task.id) !== generation
      || (task.config.buyThreadCount || 0) <= 0
      || (task.config.sellThreadCount || 0) <= 0
    ) {
      return;
    }
    const state = mixedDirectionStateFor(task, generation);
    state.sellEligibleWalletKeys.delete(walletAddress.toLowerCase());
    if (state.recoverySellReservedWalletKeys.delete(walletAddress.toLowerCase())) {
      // A recovery slot that found no balance did not create a new missing
      // sell; it merely failed to repay the existing debt.
      return;
    }
    state.sellDeficit = Math.min(
      Math.max(1, task.config.sellThreadCount || 0),
      state.sellDeficit + 1,
    );
  }

  type MixedDirectionAllocation = TaskDirectionAllocation & {
    recoverySellCount: number;
  };

  function applyMixedSellDeficit(
    task: Task,
    allocation: TaskDirectionAllocation,
    generation: number,
  ): MixedDirectionAllocation {
    const state = mixedDirectionStates.get(task.id);
    const availableDeficit = state?.generation === generation
      ? Math.max(0, state.sellDeficit - state.recoverySellReservedWalletKeys.size)
      : 0;
    if (
      state?.generation !== generation
      || availableDeficit <= 0
      || (
        state.sellEligibleWalletKeys.size === 0
        && state.buyPreparingWalletKeys.size === 0
        && state.buyInFlightWalletKeys.size === 0
      )
      || allocation.buyCount <= 0
    ) {
      return { ...allocation, recoverySellCount: 0 };
    }
    const shiftedSlots = Math.min(availableDeficit, allocation.buyCount);
    return {
      ...allocation,
      buyCount: allocation.buyCount - shiftedSlots,
      sellCount: allocation.sellCount + shiftedSlots,
      recoverySellCount: shiftedSlots,
    };
  }

  function reserveMixedRecoverySell(
    task: Task,
    walletAddress: string,
    generation: number,
  ): boolean {
    const state = mixedDirectionStates.get(task.id);
    if (
      state?.generation !== generation
      || state.sellDeficit <= state.recoverySellReservedWalletKeys.size
    ) {
      return false;
    }
    const walletKey = walletAddress.toLowerCase();
    if (state.recoverySellReservedWalletKeys.has(walletKey)) return false;
    state.recoverySellReservedWalletKeys.add(walletKey);
    return true;
  }

  function releaseMixedRecoverySell(
    task: Task,
    walletAddress: string,
    generation: number,
  ): void {
    const state = mixedDirectionStates.get(task.id);
    if (state?.generation !== generation) return;
    state.recoverySellReservedWalletKeys.delete(walletAddress.toLowerCase());
  }

  function pendingTaskTradeKey(taskId: string, generation: number): string {
    return `${taskId}:${generation}`;
  }

  function addPendingTaskTrade(taskId: string, amount: number, generation: number): void {
    const key = pendingTaskTradeKey(taskId, generation);
    const totals = pendingTaskTrades.get(key) ?? { count: 0, amount: 0 };
    totals.count++;
    totals.amount += amount;
    pendingTaskTrades.set(key, totals);
  }

  function removePendingTaskTrade(taskId: string, amount: number, generation: number): void {
    const key = pendingTaskTradeKey(taskId, generation);
    const totals = pendingTaskTrades.get(key);
    if (!totals) return;
    totals.count = Math.max(0, totals.count - 1);
    totals.amount = Math.max(0, totals.amount - amount);
    if (totals.count === 0) pendingTaskTrades.delete(key);
  }

  function uniqueTaskWallets(task: Task): string[] {
    return [...new Map(
      task.walletAddresses
        .filter(Boolean)
        .map(address => [address.trim().toLowerCase(), address.trim()] as const),
    ).values()];
  }

  function pureSellTaskSignature(task: Task, orderedWallets: string[]): string {
    return [
      task.config.chainId,
      taskTokenAddress(task).toLowerCase(),
      orderedWallets.map(address => address.toLowerCase()).sort().join('|'),
    ].join('::');
  }

  function resetPureSellCoverage(task: Task): PureSellCoverageState | undefined {
    pureSellCoverageStates.delete(task.id);
    if (!isPureSellAllTask(task)) return undefined;
    const orderedWallets = uniqueTaskWallets(task);
    const state: PureSellCoverageState = {
      taskSignature: pureSellTaskSignature(task, orderedWallets),
      generation: currentTaskExecutionGeneration(task.id),
      orderedWallets,
      walletKeys: new Set(orderedWallets.map(address => address.toLowerCase())),
      clearedWalletKeys: new Set<string>(),
      preparationFailures: new Map<string, number>(),
      retryAfterByWallet: new Map<string, number>(),
      cycleStartedAt: Date.now(),
    };
    pureSellCoverageStates.set(task.id, state);
    return state;
  }

  function pureSellCoverageFor(task: Task): PureSellCoverageState | undefined {
    if (!isPureSellAllTask(task)) return undefined;
    const orderedWallets = uniqueTaskWallets(task);
    const signature = pureSellTaskSignature(task, orderedWallets);
    const current = pureSellCoverageStates.get(task.id);
    if (
      current?.taskSignature === signature
      && current.generation === currentTaskExecutionGeneration(task.id)
    ) {
      return current;
    }
    return resetPureSellCoverage(task);
  }

  function markPureSellWalletCleared(
    task: Task,
    walletAddress: string,
    reason: 'zero-balance' | 'confirmed-zero',
    expectedCoverage?: PureSellCoverageState,
  ): void {
    const coverage = expectedCoverage ?? pureSellCoverageFor(task);
    if (!coverage) return;
    if (
      expectedCoverage
      && pureSellCoverageStates.get(task.id) !== expectedCoverage
    ) {
      return;
    }
    const key = walletAddress.toLowerCase();
    if (!coverage.walletKeys.has(key)) return;
    if (coverage.clearedWalletKeys.has(key)) return;
    coverage.clearedWalletKeys.add(key);
    coverage.preparationFailures.delete(key);
    coverage.retryAfterByWallet.delete(key);
    addLog(
      task.id,
      'success',
      reason === 'zero-balance'
        ? `清仓覆盖：${walletAddress.slice(0, 10)}... 当前代币余额为 0，已完成`
        : `清仓覆盖：${walletAddress.slice(0, 10)}... 卖出已确认且余额复核为 0`,
      walletAddress,
    );
  }

  function pureSellCoverageComplete(
    task: Task,
    expectedCoverage?: PureSellCoverageState,
  ): boolean {
    const coverage = expectedCoverage ?? pureSellCoverageFor(task);
    if (
      !coverage
      || (
        expectedCoverage
        && pureSellCoverageStates.get(task.id) !== expectedCoverage
      )
    ) {
      return false;
    }
    return Boolean(
      coverage.orderedWallets.length > 0
      && coverage.orderedWallets.every(address => (
        coverage.clearedWalletKeys.has(address.toLowerCase())
      )),
    );
  }

  function recordPureSellPreparationFailure(
    task: Task,
    walletAddress?: string,
    expectedCoverage?: PureSellCoverageState,
  ): void {
    if (!walletAddress || task.status !== 'running' || !isPureSellAllTask(task)) return;
    const coverage = expectedCoverage ?? pureSellCoverageFor(task);
    if (!coverage) return;
    if (
      expectedCoverage
      && pureSellCoverageStates.get(task.id) !== expectedCoverage
    ) {
      return;
    }
    const key = walletAddress.toLowerCase();
    if (coverage.clearedWalletKeys.has(key)) return;

    const failureCount = (coverage.preparationFailures.get(key) || 0) + 1;
    coverage.preparationFailures.set(key, failureCount);
    const retryDelayMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, failureCount - 1)));
    coverage.retryAfterByWallet.set(key, Date.now() + retryDelayMs);
    addLog(
      task.id,
      failureCount >= 5 ? 'error' : 'warning',
      `清仓准备失败：${walletAddress.slice(0, 10)}... 已连续失败 ${failureCount} 次；本轮整批 0 广播，该钱包 ${retryDelayMs / 1000} 秒后重试`,
      walletAddress,
    );

    if (failureCount >= 5 && task.status === 'running') {
      addLog(
        task.id,
        'error',
        `纯卖出任务已暂停：钱包 ${walletAddress} 连续 5 个原子批次无法完成报价/nonce/签名准备。其他钱包未被误记为清仓，请处理该钱包日志后恢复任务`,
        walletAddress,
      );
      pauseTask(task.id);
    }
  }

  function clearPureSellPreparationFailure(
    task: Task,
    walletAddress: string,
    expectedCoverage?: PureSellCoverageState,
  ): void {
    const coverage = expectedCoverage ?? pureSellCoverageFor(task);
    if (!coverage) return;
    if (
      expectedCoverage
      && pureSellCoverageStates.get(task.id) !== expectedCoverage
    ) {
      return;
    }
    const key = walletAddress.toLowerCase();
    coverage.preparationFailures.delete(key);
    coverage.retryAfterByWallet.delete(key);
  }

  async function finishPureSellCoverageIfComplete(
    task: Task,
    expectedCoverage?: PureSellCoverageState,
  ): Promise<boolean> {
    if (!pureSellCoverageComplete(task, expectedCoverage)) return false;
    const coverage = expectedCoverage ?? pureSellCoverageStates.get(task.id)!;
    if (
      task.status !== 'running'
      || pureSellCoverageStates.get(task.id) !== coverage
      || coverage.generation !== currentTaskExecutionGeneration(task.id)
    ) {
      return false;
    }

    const tokenAddress = taskTokenAddress(task);
    const taskDex = useDexStore().dexConfigs.find(
      dex => dex.id === task.config.dexId && dex.chainId === task.config.chainId,
    );
    const routerAddress = taskDex?.routerAddress || '';
    if (
      !tokenAddress
      || !routerAddress
      || routerAddress === '0x0000000000000000000000000000000000000000'
    ) {
      return false;
    }

    const executionGeneration = coverage.generation;
    const rpcUrl = getTaskExecutionRpc(task, 'sell');
    const tradingService = getOrCreateTradingService(task, rpcUrl, routerAddress);
    const runtimeGuard = runtimeGuardForTask(task);
    const isCurrentFinalization = () => (
      task.status === 'running'
      && currentTaskExecutionGeneration(task.id) === executionGeneration
      && pureSellCoverageStates.get(task.id) === coverage
      && pureSellCoverageComplete(task, coverage)
    );
    const assertCurrentFinalization = () => {
      if (!isCurrentFinalization()) throw new TaskRoundCancelledError();
      runtimeGuard?.assertActive();
    };

    try {
      return await withAvailableTaskWalletLeases(
        task.config.chainId,
        coverage.orderedWallets,
        async (walletGuards, busyWalletAddresses) => {
          if (
            busyWalletAddresses.length > 0
            || walletGuards.size !== coverage.orderedWallets.length
          ) {
            for (const walletAddress of busyWalletAddresses) {
              coverage.retryAfterByWallet.set(
                walletAddress.toLowerCase(),
                Math.max(
                  coverage.retryAfterByWallet.get(walletAddress.toLowerCase()) || 0,
                  Date.now() + 1_000,
                ),
              );
            }
            return false;
          }

          assertCurrentFinalization();
          for (const guard of walletGuards.values()) guard.assertActive();

          // Coverage markers are deliberately monotonic during ordinary sell
          // rounds, but another task may buy into a wallet after it was marked
          // zero. Before declaring the whole batch complete, hold every target
          // wallet lease at once and establish one authoritative all-zero
          // linearization point.
          const blockedPredecessor = await findBlockedUnresolvedWallet(
            task,
            coverage.orderedWallets,
            true,
            rpcUrl,
          );
          assertCurrentFinalization();
          for (const guard of walletGuards.values()) guard.assertActive();
          if (blockedPredecessor) {
            const walletKey = blockedPredecessor.walletAddress.toLowerCase();
            coverage.clearedWalletKeys.delete(walletKey);
            coverage.retryAfterByWallet.set(walletKey, Date.now() + 1_000);
            if (blockedPredecessor.code === WALLET_PENDING_PREDECESSOR_CODE) {
              markTaskUnresolvedTransaction(
                task,
                blockedPredecessor.walletAddress,
                'pending',
                undefined,
                rpcUrl,
              );
            }
            const unresolved = getUnresolvedTransaction(
              task.config.chainId,
              blockedPredecessor.walletAddress,
            );
            const walletGuard = walletGuards.get(walletKey);
            if (unresolved && walletGuard) {
              retainLeasesUntilUnresolvedSettles(
                task,
                blockedPredecessor.walletAddress,
                unresolved.rpcUrl,
                unresolved.txHash,
                walletGuard,
              );
            }
            return false;
          }

          const balanceResults = await Promise.allSettled(
            coverage.orderedWallets.map(async walletAddress => ({
              walletAddress,
              balance: await tradingService.readTokenBalance(
                tokenAddress as `0x${string}`,
                walletAddress as `0x${string}`,
              ),
            })),
          );
          assertCurrentFinalization();
          for (const guard of walletGuards.values()) guard.assertActive();

          let allZero = true;
          for (let index = 0; index < balanceResults.length; index++) {
            const result = balanceResults[index];
            const walletAddress = coverage.orderedWallets[index];
            const walletKey = walletAddress.toLowerCase();
            if (result.status === 'rejected') {
              allZero = false;
              coverage.retryAfterByWallet.set(walletKey, Date.now() + 1_000);
              continue;
            }
            if (result.value.balance > 0n) {
              allZero = false;
              // Re-open this wallet so the next round actually sells the
              // balance that arrived after its earlier zero observation.
              coverage.clearedWalletKeys.delete(walletKey);
              coverage.retryAfterByWallet.delete(walletKey);
              addLog(
                task.id,
                'warning',
                `清仓终检：${walletAddress.slice(0, 10)}... 在整批归零前收到新代币，已重新加入卖出队列`,
                walletAddress,
              );
            }
          }
          if (!allZero) return false;

          assertCurrentFinalization();
          addLog(
            task.id,
            'success',
            `纯卖出清仓完成：${coverage.orderedWallets.length}/${coverage.orderedWallets.length} 个钱包已在同一钱包租约屏障内确认归零`,
          );
          // Stop while every target wallet lease is still held. Any later buy
          // is ordered strictly after this task's completed all-zero point.
          stopTask(task.id, '所有目标钱包均已在整批终检中确认清仓');
          return true;
        },
        isCurrentFinalization,
        walletAddress => !activeBatchSellWalletKeys.has(
          taskWalletLeaseKey(task.config.chainId, walletAddress),
        ),
      );
    } catch (error: any) {
      if (
        error instanceof TaskRoundCancelledError
        || isRecoverableWalletLeaseBusy(error)
        || !isCurrentFinalization()
      ) {
        return false;
      }
      addLog(
        task.id,
        'warning',
        `清仓整批终检暂时失败，将在下一轮重试：${error?.message || '未知错误'}`,
      );
      return false;
    }
  }

  function schedulePureSellCoverageFinalization(
    task: Task,
    expectedCoverage: PureSellCoverageState,
  ): void {
    if (!pureSellCoverageComplete(task, expectedCoverage)) return;

    // Reconciliation normally runs while the just-confirmed sell still owns
    // its wallet lease. Trying to acquire the whole cohort inline therefore
    // observes that same wallet as busy and leaves a completed clear-all task
    // running until the next configured interval. Wait in the background for
    // the current wallet operations to release, then establish the atomic
    // all-wallet zero point immediately.
    const currentOperations = activeLocalWalletOperations(
      task.config.chainId,
      expectedCoverage.orderedWallets,
    );
    void Promise.allSettled(currentOperations)
      .then(async () => {
        if (!pureSellCoverageComplete(task, expectedCoverage)) return;
        await finishPureSellCoverageIfComplete(task, expectedCoverage);
      })
      .catch(() => {
        // finishPureSellCoverageIfComplete is fail-closed and logs unexpected
        // verification errors. This catch only prevents a detached observer
        // from becoming an unhandled rejection.
      });
  }

  // 防止同一浏览器内重复点击同一任务的手工批量卖出。
  const activeBatchSellTaskIds = new Set<string>();
  // Close the synchronous window before acquireTaskRuntime() resolves. Without
  // this latch, a double click can enter two start flows while status is still
  // stopped/paused and both flows later create their own scheduler.
  const startingTaskIds = new Set<string>();
  // 不同任务可能包含同一钱包，所以仅按 taskId 防重不足够。
  const activeBatchSellWalletKeys = new Set<string>();
  // 同一浏览器内的所有自动/手工任务也必须按钱包串行。服务端租约负责
  // 跨标签页和跨设备，这个队列避免同一页面里的任务互相拿到 LEASE_BUSY。
  const taskWalletOperationLocks = new Map<string, Promise<void>>();

  interface ActiveTaskRuntime {
    serverTaskId?: string;
    runtimeId: string;
    runtimeToken?: string;
    expiresAtMs: number;
    heartbeatIntervalMs: number;
    heartbeatTimer?: TimerHandle;
    consecutiveHeartbeatFailures?: number;
    lostError?: Error;
  }

  interface TaskRuntimeGuard extends TransferLeaseGuard {
    readonly runtimeState: ActiveTaskRuntime;
  }

  interface RevokeTaskRuntimeOptions {
    broadcast?: boolean;
    callServer?: boolean;
    forceServer?: boolean;
    expectedState?: ActiveTaskRuntime | null;
  }

  const taskRuntimeStates = new Map<string, ActiveTaskRuntime>();
  const taskRuntimeAcquisitionTails = new Map<string, Promise<void>>();
  // Fence delayed runtime status/lease responses against newer cross-tab
  // identities learned while those requests are in flight.
  const remoteRuntimeIdentityRevisions = new Map<string, number>();
  const clientInstanceId = getClientInstanceId();
  let buildMonitorTimer: TimerHandle | undefined;
  let buildIsStale = false;
  const runtimeChannel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('amm-task-runtime-v3')
    : undefined;

  class TaskRoundCancelledError extends Error {
    constructor() {
      super('任务已暂停，本轮尚未开始的交易已取消');
      this.name = 'TaskRoundCancelledError';
    }
  }

  class TaskWalletTemporarilyBusyError extends Error {
    readonly code = 'TRANSFER_LEASE_BUSY';

    constructor(walletAddress: string) {
      super(`钱包 ${walletAddress} 正在执行其他本地或手工操作，本轮暂时跳过`);
      this.name = 'TaskWalletTemporarilyBusyError';
    }
  }

  class TaskRuntimeLostError extends Error {
    code = 'TASK_RUNTIME_REVOKED';

    constructor(message = '任务运行权已被停止、删除、过期或旧版本撤销') {
      super(message);
      this.name = 'TaskRuntimeLostError';
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

  function combineLeaseGuards(
    ...guards: Array<TransferLeaseGuard | undefined>
  ): TransferLeaseGuard | undefined {
    const activeGuards = guards.filter((guard): guard is TransferLeaseGuard => !!guard);
    if (activeGuards.length === 0) return undefined;
    const nonceCoordinator = activeGuards.find(
      guard => guard.getNonceState && guard.commitBroadcast,
    );
    return {
      assertActive() {
        for (const guard of activeGuards) guard.assertActive();
      },
      getNonceState: nonceCoordinator?.getNonceState
        ? () => nonceCoordinator.getNonceState!()
        : undefined,
      commitBroadcast: nonceCoordinator?.commitBroadcast
        ? (nonce, txHash) => nonceCoordinator.commitBroadcast!(nonce, txHash)
        : undefined,
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
   * being falsely rejected as TRANSFER_LEASE_BUSY.
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
      getNonceState: serverGuard.getNonceState
        ? () => serverGuard.getNonceState!()
        : undefined,
      commitBroadcast: serverGuard.commitBroadcast
        ? (nonce, txHash) => serverGuard.commitBroadcast!(nonce, txHash)
        : undefined,
      retainUntil(settlement) {
        const serverReleased = serverGuard.retainUntil?.(settlement)
          ?? Promise.resolve(settlement).then(() => undefined, () => undefined);
        return localGuard.retainUntil?.(serverReleased) ?? serverReleased;
      },
    };
  }

  function runTrackedRound(taskId: string, runner: () => Promise<void>): Promise<void> {
    const active = activeRoundPromises.get(taskId) ?? new Set<Promise<void>>();
    activeRoundPromises.set(taskId, active);
    let trackedPromise!: Promise<void>;
    trackedPromise = Promise.resolve()
      .then(runner)
      .finally(() => {
        active.delete(trackedPromise);
        if (active.size === 0 && activeRoundPromises.get(taskId) === active) {
          activeRoundPromises.delete(taskId);
        }
      });
    active.add(trackedPromise);
    return trackedPromise;
  }

  function activeRoundsForTask(taskId: string): Promise<void>[] {
    return [...(activeRoundPromises.get(taskId) ?? [])];
  }

  function broadcastRuntimeRevocation(
    taskId: string,
    reason: string,
    runtimeId?: string,
  ): void {
    runtimeChannel?.postMessage({
      type: 'revoke',
      taskId,
      reason,
      runtimeId,
      clientInstanceId,
    });
  }

  function broadcastRuntimeStarted(taskId: string, runtimeId: string): void {
    runtimeChannel?.postMessage({
      type: 'started',
      taskId,
      runtimeId,
      clientInstanceId,
    });
  }

  function noteRemoteRuntime(task: Task | undefined, runtimeId: string): void {
    if (!task) return;
    if (task.remoteRuntimeActive && task.remoteRuntimeId === runtimeId) return;
    task.remoteRuntimeActive = true;
    task.remoteRuntimeId = runtimeId;
    remoteRuntimeIdentityRevisions.set(
      task.id,
      (remoteRuntimeIdentityRevisions.get(task.id) || 0) + 1,
    );
  }

  function clearRemoteRuntimeIfMatching(
    task: Task | undefined,
    runtimeId?: string,
  ): boolean {
    if (!task) return false;
    if (
      runtimeId
      && task.remoteRuntimeId
      && task.remoteRuntimeId !== runtimeId
    ) {
      return false;
    }
    if (!task.remoteRuntimeActive && !task.remoteRuntimeId) return true;
    task.remoteRuntimeActive = false;
    task.remoteRuntimeId = undefined;
    remoteRuntimeIdentityRevisions.set(
      task.id,
      (remoteRuntimeIdentityRevisions.get(task.id) || 0) + 1,
    );
    return true;
  }

  function markRuntimeLost(
    taskId: string,
    reason: string,
    expectedState?: ActiveTaskRuntime,
  ): boolean {
    const state = expectedState ?? taskRuntimeStates.get(taskId);
    if (!state) return false;
    state.lostError = new TaskRuntimeLostError(reason);
    if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer);
    state.heartbeatTimer = undefined;
    if (taskRuntimeStates.get(taskId) !== state) return false;
    taskRuntimeStates.delete(taskId);
    const task = tasks.value.find(candidate => candidate.id === taskId);
    clearRemoteRuntimeIfMatching(
      task,
      state.serverTaskId ? state.runtimeId : undefined,
    );
    return true;
  }

  async function revokeTaskRuntime(
    taskId: string,
    reason: string,
    options: RevokeTaskRuntimeOptions = {},
  ): Promise<void> {
    const task = tasks.value.find(candidate => candidate.id === taskId);
    const remoteRuntimeIdAtInvocation = task?.remoteRuntimeId;
    const hasExpectedState = Object.prototype.hasOwnProperty.call(options, 'expectedState');
    const runtimeState = hasExpectedState
      ? options.expectedState ?? undefined
      : taskRuntimeStates.get(taskId);
    const serverTaskId = runtimeState?.serverTaskId ?? task?._id;
    // Local-mode runtimes also have a unique identity. Always scope channel
    // revocations so an unversioned/legacy message cannot revoke a replacement.
    const stateRuntimeId = runtimeState?.runtimeId;
    if (runtimeState) {
      markRuntimeLost(taskId, reason, runtimeState);
    } else if (!hasExpectedState) {
      markRuntimeLost(taskId, reason);
    }
    const shouldBroadcast = options.broadcast !== false;
    let broadcastSent = false;
    let serverRuntimeRevoked = false;
    let serverRuntimeAbsent = false;
    let serverStopUnconfirmed = false;
    let attemptedServerRuntimeId: string | undefined;

    if (shouldBroadcast && runtimeState) {
      broadcastRuntimeRevocation(
        taskId,
        reason,
        stateRuntimeId,
      );
      broadcastSent = true;
    } else if (shouldBroadcast && options.forceServer && remoteRuntimeIdAtInvocation) {
      broadcastRuntimeRevocation(taskId, reason, remoteRuntimeIdAtInvocation);
      broadcastSent = true;
    }

    if (
      options.callServer !== false
      && shouldUseServerMode()
      && serverTaskId
    ) {
      try {
        if (runtimeState?.serverTaskId && runtimeState.runtimeToken) {
          attemptedServerRuntimeId = runtimeState.runtimeId;
          serverRuntimeRevoked = await stopTaskRuntime(runtimeState.serverTaskId, {
            runtimeId: runtimeState.runtimeId,
            runtimeToken: runtimeState.runtimeToken,
          });
        }

        if (options.forceServer && !serverRuntimeRevoked) {
          const forceTargetRuntimeId = remoteRuntimeIdAtInvocation ?? stateRuntimeId;
          if (
            forceTargetRuntimeId
            && forceTargetRuntimeId !== attemptedServerRuntimeId
          ) {
            attemptedServerRuntimeId = forceTargetRuntimeId;
            serverRuntimeRevoked = await stopTaskRuntime(serverTaskId, {
              runtimeId: forceTargetRuntimeId,
              force: true,
            });
          }
        }

        if (options.forceServer && !serverRuntimeRevoked) {
          const statusIdentityRevision = remoteRuntimeIdentityRevisions.get(taskId) || 0;
          const status = await getTaskRuntimeStatus(serverTaskId);
          const observedRuntimeId = status.running
            ? status.runtime?.runtimeId
            : undefined;
          const identityChangedWhileReading = (
            (remoteRuntimeIdentityRevisions.get(taskId) || 0) !== statusIdentityRevision
          );
          if (observedRuntimeId) {
            // Refresh only. The user did not explicitly observe this identity
            // when the stop intent was created, so a delayed old request must
            // never acquire authority to delete it. The still-visible force
            // button lets the user confirm a second stop against this exact ID.
            if (
              !identityChangedWhileReading
              || task?.remoteRuntimeId === observedRuntimeId
            ) {
              noteRemoteRuntime(task, observedRuntimeId);
            }
            if (observedRuntimeId !== attemptedServerRuntimeId) {
              addLog(
                taskId,
                'warning',
                '远端运行实例在停止期间已变化；旧停止请求未撤销新实例，请确认后再次点击强制停止',
              );
            }
          } else if (!identityChangedWhileReading) {
            serverRuntimeAbsent = true;
          }
        }
      } catch (error: any) {
        // A concurrent delete or another tab may already have removed the task
        // or runtime. Both outcomes mean the desired revocation is effective.
        if (error?.status === 404 || error?.code === 'TASK_NOT_FOUND') {
          serverRuntimeAbsent = true;
        } else {
          serverStopUnconfirmed = true;
          console.error('撤销任务运行权失败:', error);
        }
      }
    }
    // Never emit an unscoped revoke. Without an exact runtime identity a
    // delayed/legacy message has no authority over a replacement instance.
    const currentLocalState = taskRuntimeStates.get(taskId);
    if (currentLocalState?.serverTaskId) {
      noteRemoteRuntime(task, currentLocalState.runtimeId);
    } else if (
      serverStopUnconfirmed
      && !task?.remoteRuntimeId
      && (remoteRuntimeIdAtInvocation || stateRuntimeId)
    ) {
      // Keep the retry affordance visible when the server never confirmed the
      // stop. Do not overwrite a newer B identity learned while A was pending.
      noteRemoteRuntime(task, remoteRuntimeIdAtInvocation || stateRuntimeId!);
    } else if (serverRuntimeRevoked) {
      clearRemoteRuntimeIfMatching(
        task,
        attemptedServerRuntimeId ?? stateRuntimeId,
      );
    } else if (
      serverRuntimeAbsent
      && (
        attemptedServerRuntimeId
          ? task?.remoteRuntimeId === attemptedServerRuntimeId
          : !task?.remoteRuntimeId
      )
    ) {
      clearRemoteRuntimeIfMatching(task, attemptedServerRuntimeId);
    }
  }

  function runtimeGuardForTask(task: Task, allowStoppedTask = false): TaskRuntimeGuard {
    const state = taskRuntimeStates.get(task.id);
    if (!state) throw new TaskRuntimeLostError();
    return {
      runtimeState: state,
      assertActive() {
        if (state.lostError) throw state.lostError;
        if (taskRuntimeStates.get(task.id) !== state) throw new TaskRuntimeLostError();
        if (buildIsStale) throw new TaskRuntimeLostError('客户端已更新，旧页面运行权已撤销');
        if (Date.now() >= state.expiresAtMs) throw new TaskRuntimeLostError('任务运行权心跳已过期');
        if (!allowStoppedTask && task.status !== 'running') throw new TaskRoundCancelledError();
      },
    };
  }

  function scheduleRuntimeHeartbeat(
    task: Task,
    state: ActiveTaskRuntime,
    delayMs = state.heartbeatIntervalMs,
  ): void {
    if (!state.serverTaskId || !state.runtimeToken) return;
    if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer);
    state.heartbeatTimer = globalThis.setTimeout(async () => {
      if (taskRuntimeStates.get(task.id) !== state || state.lostError) return;
      try {
        const heartbeat = await heartbeatTaskRuntime(
          state.serverTaskId!,
          state.runtimeId,
          state.runtimeToken!,
        );
        if (taskRuntimeStates.get(task.id) !== state) return;
        state.expiresAtMs = Date.parse(heartbeat.expiresAt);
        state.consecutiveHeartbeatFailures = 0;
        scheduleRuntimeHeartbeat(task, state);
      } catch (error: any) {
        // A pause/resume can replace this runtime while an older heartbeat is
        // still in flight. Its late response must never stop the replacement.
        if (taskRuntimeStates.get(task.id) !== state || state.lostError) return;
        const reason = error?.message || '任务运行权心跳失败';
        if (isTaskRuntimeRevoked(error)) {
          if (!markRuntimeLost(task.id, reason, state)) return;
          stopTask(task.id, `运行权已撤销：${reason}`, {
            broadcast: false,
            callServer: false,
          });
          return;
        }

        const remainingMs = state.expiresAtMs - Date.now();
        if (remainingMs <= 250) {
          if (!markRuntimeLost(task.id, reason, state)) return;
          stopTask(task.id, `运行权心跳已过期：${reason}`, {
            broadcast: false,
            callServer: false,
          });
          return;
        }

        state.consecutiveHeartbeatFailures = (state.consecutiveHeartbeatFailures || 0) + 1;
        const retryDelay = calculateTaskRuntimeHeartbeatRetryDelayMs(
          state.consecutiveHeartbeatFailures,
          state.heartbeatIntervalMs,
          remainingMs,
        );
        addLog(
          task.id,
          'warning',
          `任务运行权心跳临时失败，将在 ${retryDelay}ms 后重试；原租约仍有效，未停止后续钱包：${reason}`,
        );
        scheduleRuntimeHeartbeat(task, state, retryDelay);
      }
    }, Math.max(0, delayMs));
    (state.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function ensureCurrentBuild(task?: Task): Promise<boolean> {
    if (!shouldUseServerMode()) return true;
    try {
      const current = await isCurrentClientBuild();
      if (current) return true;
      buildIsStale = true;
      const runningIds = [...taskRuntimeStates.keys()];
      for (const taskId of runningIds) {
        stopTask(taskId, '检测到新版本，旧页面已停止并交还运行权');
      }
      task && addLog(task.id, 'error', '检测到系统已发布新版本，请刷新页面后再启动任务');
      return false;
    } catch (error: any) {
      task && addLog(task.id, 'error', `无法确认客户端版本，已拒绝启动交易: ${error?.message || '未知错误'}`);
      return false;
    }
  }

  function startBuildMonitor(): void {
    if (!shouldUseServerMode() || buildMonitorTimer || buildIsStale) return;
    const poll = async () => {
      buildMonitorTimer = undefined;
      await ensureCurrentBuild();
      if (!buildIsStale && taskRuntimeStates.size > 0) {
        buildMonitorTimer = globalThis.setTimeout(poll, 30_000);
        (buildMonitorTimer as unknown as { unref?: () => void }).unref?.();
      }
    };
    buildMonitorTimer = globalThis.setTimeout(poll, 30_000);
    (buildMonitorTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function acquireTaskRuntime(
    task: Task,
    options: {
      forceTakeover?: boolean;
      shouldContinue?: () => boolean;
    } = {},
  ): Promise<TaskRuntimeGuard> {
    const previous = taskRuntimeAcquisitionTails.get(task.id) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>(resolve => {
      releaseTurn = resolve;
    });
    const queuedTail = previous.then(() => turn, () => turn);
    taskRuntimeAcquisitionTails.set(task.id, queuedTail);
    await previous.catch(() => undefined);
    try {
      return await acquireTaskRuntimeUnlocked(task, options);
    } finally {
      releaseTurn();
      if (taskRuntimeAcquisitionTails.get(task.id) === queuedTail) {
        taskRuntimeAcquisitionTails.delete(task.id);
      }
    }
  }

  async function acquireTaskRuntimeUnlocked(
    task: Task,
    options: {
      forceTakeover?: boolean;
      shouldContinue?: () => boolean;
    } = {},
  ): Promise<TaskRuntimeGuard> {
    const acquisitionIsCurrent = () => options.shouldContinue?.() !== false;
    if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();
    const existing = taskRuntimeStates.get(task.id);
    if (existing && !existing.lostError && Date.now() < existing.expiresAtMs) {
      return runtimeGuardForTask(task, true);
    }

    if (buildIsStale || !(await ensureCurrentBuild(task))) {
      throw new TaskRuntimeLostError('客户端版本已过期，请刷新页面');
    }
    if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();

    if (!shouldUseServerMode()) {
      taskRuntimeStates.set(task.id, {
        runtimeId: createRuntimeId(),
        expiresAtMs: Number.POSITIVE_INFINITY,
        heartbeatIntervalMs: 0,
      });
      return runtimeGuardForTask(task, true);
    }
    if (!task._id) throw new TaskRuntimeLostError('任务尚未保存到服务器，不能取得运行权');

    const runtimeId = createRuntimeId();
    const releaseReturnedLease = async (
      candidate: Awaited<ReturnType<typeof startTaskRuntime>>,
    ): Promise<void> => {
      try {
        await stopTaskRuntime(task._id!, {
          runtimeId: candidate.runtimeId,
          runtimeToken: candidate.runtimeToken,
        });
      } catch {
        // The conditional stop is identity/token fenced and therefore cannot
        // revoke a replacement. A short-lived stale candidate will also expire.
      }
    };
    const verifyReturnedLease = async (
      candidate: Awaited<ReturnType<typeof startTaskRuntime>>,
      requestIdentityRevision: number,
    ): Promise<Awaited<ReturnType<typeof startTaskRuntime>>> => {
      const supersededByKnownRuntime = () => (
        (remoteRuntimeIdentityRevisions.get(task.id) || 0) !== requestIdentityRevision
        && Boolean(task.remoteRuntimeId)
        && task.remoteRuntimeId !== candidate.runtimeId
      );
      if (!acquisitionIsCurrent() || supersededByKnownRuntime()) {
        await releaseReturnedLease(candidate);
        throw new TaskRoundCancelledError();
      }

      // The POST may have completed at the server long before its HTTP response
      // reached this tab. Verify the exact ID+one-time token immediately, before
      // installing local state or permitting the first transaction.
      let verified;
      try {
        verified = await heartbeatTaskRuntime(
          task._id!,
          candidate.runtimeId,
          candidate.runtimeToken,
        );
      } catch (error) {
        await releaseReturnedLease(candidate);
        throw error;
      }
      if (verified.runtimeId !== candidate.runtimeId) {
        await releaseReturnedLease(candidate);
        throw new TaskRuntimeLostError('任务运行权验证返回了不同的运行实例，已取消启动');
      }
      if (!acquisitionIsCurrent() || supersededByKnownRuntime()) {
        await releaseReturnedLease(candidate);
        throw new TaskRoundCancelledError();
      }
      return {
        ...candidate,
        expiresAt: verified.expiresAt,
        runtimeDurationMs: verified.runtimeDurationMs,
      };
    };
    let lease;
    try {
      const requestIdentityRevision = remoteRuntimeIdentityRevisions.get(task.id) || 0;
      const candidate = await startTaskRuntime(task._id, runtimeId, clientInstanceId);
      lease = await verifyReturnedLease(candidate, requestIdentityRevision);
    } catch (error) {
      if (!isTaskRuntimeBusy(error)) throw error;
      if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();
      const concurrentLocalRuntime = taskRuntimeStates.get(task.id);
      if (
        concurrentLocalRuntime
        && !concurrentLocalRuntime.lostError
        && Date.now() < concurrentLocalRuntime.expiresAtMs
      ) {
        return runtimeGuardForTask(task, true);
      }
      // Creation-time/background preparation is not an ownership action. It
      // must never evict an actively running tab merely to warm allowances.
      if (!options.forceTakeover) throw error;
      // Starting a task is an explicit ownership action. It revokes an
      // abandoned/other-tab runtime for this same task, then acquires a fresh
      // token. The takeover is fenced to the runtime ID we actually observed,
      // so a reordered force request cannot delete a newer replacement.
      const current = await getTaskRuntimeStatus(task._id);
      if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();
      const observedRuntimeId = current.running
        ? current.runtime?.runtimeId
        : undefined;
      if (observedRuntimeId) {
        const revoked = await stopTaskRuntime(task._id, {
          runtimeId: observedRuntimeId,
          force: true,
        });
        if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();
        if (!revoked) {
          const refreshIdentityRevision = remoteRuntimeIdentityRevisions.get(task.id) || 0;
          const refreshed = await getTaskRuntimeStatus(task._id);
          if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();
          const identityChangedWhileReading = (
            (remoteRuntimeIdentityRevisions.get(task.id) || 0) !== refreshIdentityRevision
          );
          if (refreshed.running && refreshed.runtime?.runtimeId) {
            if (
              !identityChangedWhileReading
              || task.remoteRuntimeId === refreshed.runtime.runtimeId
            ) {
              noteRemoteRuntime(task, refreshed.runtime.runtimeId);
            }
            throw new TaskRuntimeLostError('远端运行实例在接管期间已变化，请再次启动以确认接管');
          }
          if (identityChangedWhileReading) {
            throw new TaskRuntimeLostError('远端运行实例在接管状态查询期间已变化，请再次启动以确认接管');
          }
        }
        clearRemoteRuntimeIfMatching(task, observedRuntimeId);
        broadcastRuntimeRevocation(
          task.id,
          '另一页面正在接管该任务，原运行实例已停止',
          observedRuntimeId,
        );
      }
      if (!acquisitionIsCurrent()) throw new TaskRoundCancelledError();
      const requestIdentityRevision = remoteRuntimeIdentityRevisions.get(task.id) || 0;
      const candidate = await startTaskRuntime(task._id, runtimeId, clientInstanceId);
      lease = await verifyReturnedLease(candidate, requestIdentityRevision);
    }

    if (!acquisitionIsCurrent()) {
      try {
        await stopTaskRuntime(task._id, {
          runtimeId: lease.runtimeId,
          runtimeToken: lease.runtimeToken,
        });
      } catch {
        // The lease is short-lived and the conditional stop cannot touch any
        // replacement. The stale start flow must still exit immediately.
      }
      throw new TaskRoundCancelledError();
    }

    const state: ActiveTaskRuntime = {
      serverTaskId: task._id,
      runtimeId: lease.runtimeId,
      runtimeToken: lease.runtimeToken,
      expiresAtMs: Date.parse(lease.expiresAt),
      heartbeatIntervalMs: lease.heartbeatIntervalMs,
    };
    taskRuntimeStates.set(task.id, state);
    noteRemoteRuntime(task, state.runtimeId);
    broadcastRuntimeStarted(task.id, state.runtimeId);
    scheduleRuntimeHeartbeat(task, state);
    startBuildMonitor();
    return runtimeGuardForTask(task, true);
  }

  runtimeChannel && (runtimeChannel.onmessage = (event: MessageEvent) => {
    const message = event.data as {
      type?: string;
      taskId?: string;
      reason?: string;
      runtimeId?: string;
      clientInstanceId?: string;
    };
    if (!message.taskId || message.clientInstanceId === clientInstanceId) return;
    if (message.type === 'started') {
      const task = tasks.value.find(candidate => candidate.id === message.taskId);
      // Legacy/unscoped hints cannot establish ownership of a new protocol
      // runtime. Exact IDs are required for every subsequent revoke fence.
      if (task && message.runtimeId) noteRemoteRuntime(task, message.runtimeId);
      return;
    }
    if (message.type !== 'revoke') return;
    const task = tasks.value.find(candidate => candidate.id === message.taskId);
    const currentState = taskRuntimeStates.get(message.taskId);
    // An old tab may still emit the pre-v3 schema without runtimeId. It has no
    // authority to revoke a current exact runtime or hide a known remote one.
    if (!taskRuntimeRevocationMatches(
      message.runtimeId,
      currentState?.runtimeId,
      task?.remoteRuntimeId,
    )) {
      return;
    }
    if (!markRuntimeLost(
      message.taskId,
      message.reason || '另一页面已停止该任务',
      currentState,
    ) && currentState) {
      return;
    }
    clearRemoteRuntimeIfMatching(task, message.runtimeId);
    stopTask(message.taskId, message.reason || '另一页面已停止该任务', {
      broadcast: false,
      callServer: false,
    });
  });

  async function withTaskWalletLease<T>(
    chainId: number,
    walletAddress: string,
    callback: (leaseGuard?: TransferLeaseGuard) => Promise<T>,
    shouldAcquire?: () => boolean,
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
      if (shouldAcquire && !shouldAcquire()) throw new TaskRoundCancelledError();
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

  async function withAvailableTaskWalletLeases<T>(
    chainId: number,
    walletAddresses: string[],
    callback: (
      guards: Map<string, TransferLeaseGuard>,
      busyWalletAddresses: string[],
    ) => Promise<T>,
    shouldAcquire?: () => boolean,
    isWalletAvailable?: (walletAddress: string) => boolean,
    busyRetryAttempt = 0,
  ): Promise<T> {
    const uniqueAddresses = [...new Map(
      walletAddresses
        .filter(address => Boolean(address?.trim()))
        .map(address => [address.trim().toLowerCase(), address.trim()] as const),
    ).values()];
    if (uniqueAddresses.length === 0) return callback(new Map(), []);
    const initiallyLockedWalletKeys = new Set(
      uniqueAddresses
        .map(address => taskWalletLeaseKey(chainId, address))
        .filter(key => taskWalletOperationLocks.has(key)),
    );
    const hasImmediatelyAvailableLocalWallet = uniqueAddresses.some(address => (
      !initiallyLockedWalletKeys.has(taskWalletLeaseKey(chainId, address))
      && (!isWalletAvailable || isWalletAvailable(address))
    ));

    // Acquire every source wallet independently. The server batch endpoint is
    // intentionally all-or-none, which meant one remotely busy wallet could
    // permanently pin the same scheduler tail and prevent otherwise free
    // wallets from ever entering a sell round. Each successful callback waits
    // on this gate so all acquired leases remain active while the caller forms
    // the atomic Robinhood broadcast cohort.
    let releaseAcquiredCallbacks!: () => void;
    const acquiredCallbacksReleased = new Promise<void>(resolve => {
      releaseAcquiredCallbacks = resolve;
    });

    type ReadyOutcome =
      | { address: string; guard: TransferLeaseGuard }
      | { address: string; error: unknown };

    const entries = uniqueAddresses.map(address => {
      const localLeaseKey = taskWalletLeaseKey(chainId, address);
      if (
        (isWalletAvailable && !isWalletAvailable(address))
        || (
          hasImmediatelyAvailableLocalWallet
          && initiallyLockedWalletKeys.has(localLeaseKey)
        )
      ) {
        const outcome: ReadyOutcome = {
          address,
          error: new TaskWalletTemporarilyBusyError(address),
        };
        return {
          address,
          ready: Promise.resolve(outcome),
          operation: Promise.resolve(),
          getLateFailure: () => undefined as { error: unknown } | undefined,
        };
      }

      let readyReported = false;
      let lateFailure: { error: unknown } | undefined;
      let reportReady!: (outcome: ReadyOutcome) => void;
      const ready = new Promise<ReadyOutcome>(resolve => {
        reportReady = resolve;
      });
      const reportOnce = (outcome: ReadyOutcome) => {
        if (readyReported) return;
        readyReported = true;
        reportReady(outcome);
      };

      const operation = withTaskWalletLease(
        chainId,
        address,
        async guard => {
          if (!guard) throw new Error(`钱包租约缺少地址 ${address}`);
          if (isWalletAvailable && !isWalletAvailable(address)) {
            throw new TaskWalletTemporarilyBusyError(address);
          }
          reportOnce({ address, guard });
          await acquiredCallbacksReleased;
        },
        shouldAcquire,
      ).catch(error => {
        if (!readyReported) {
          reportOnce({ address, error });
          return;
        }
        // Acquisition was already reported to the central cohort. Preserve
        // any later heartbeat/release error for propagation after the cohort
        // releases its hold. Keep this promise fulfilled until the central
        // callback attaches its final observer, avoiding an unhandled
        // rejection while a large batch is still preparing/broadcasting.
        lateFailure = { error };
      });

      return {
        address,
        ready,
        operation,
        getLateFailure: () => lateFailure,
      };
    });

    const outcomes = await Promise.all(entries.map(entry => entry.ready));
    const fatalOutcome = outcomes.find(
      (outcome): outcome is Extract<ReadyOutcome, { error: unknown }> => (
        'error' in outcome && !isRecoverableWalletLeaseBusy(outcome.error)
      ),
    );
    if (fatalOutcome) {
      releaseAcquiredCallbacks();
      await Promise.allSettled(entries.map(entry => entry.operation));
      throw fatalOutcome.error;
    }
    if (shouldAcquire && !shouldAcquire()) {
      releaseAcquiredCallbacks();
      await Promise.allSettled(entries.map(entry => entry.operation));
      throw new TaskRoundCancelledError();
    }

    const guards = new Map<string, TransferLeaseGuard>();
    const busyWalletAddresses: string[] = [];
    for (const outcome of outcomes) {
      if ('guard' in outcome) guards.set(outcome.address.toLowerCase(), outcome.guard);
      else busyWalletAddresses.push(outcome.address);
    }

    // If every wallet is remotely busy there is no useful partial cohort to
    // broadcast. Keep this one round queued with bounded backoff so a task in
    // another tab/device can hand the wallet directly to us instead of making
    // the user wait for the full configured task interval.
    if (
      guards.size === 0
      && busyWalletAddresses.length === uniqueAddresses.length
      && (!shouldAcquire || shouldAcquire())
    ) {
      releaseAcquiredCallbacks();
      await Promise.all(entries.map(entry => entry.operation));
      const retryDelayMs = Math.min(1_000, 100 * (2 ** Math.min(busyRetryAttempt, 4)));
      await new Promise<void>(resolve => globalThis.setTimeout(resolve, retryDelayMs));
      if (shouldAcquire && !shouldAcquire()) throw new TaskRoundCancelledError();
      return withAvailableTaskWalletLeases(
        chainId,
        uniqueAddresses,
        callback,
        shouldAcquire,
        isWalletAvailable,
        busyRetryAttempt + 1,
      );
    }

    let callbackResult!: T;
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      callbackResult = await callback(guards, busyWalletAddresses);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    } finally {
      releaseAcquiredCallbacks();
    }

    await Promise.all(entries.map(entry => entry.operation));
    if (callbackFailed) throw callbackError;
    const lateFailure = entries
      .map(entry => entry.getLateFailure())
      .find((failure): failure is { error: unknown } => failure !== undefined);
    if (lateFailure) throw lateFailure.error;
    return callbackResult;
  }

  function activeLocalWalletOperations(chainId: number, walletAddresses: string[]): Promise<void>[] {
    const uniqueOperations = new Set<Promise<void>>();
    for (const walletAddress of walletAddresses) {
      const operation = taskWalletOperationLocks.get(taskWalletLeaseKey(chainId, walletAddress));
      if (operation) uniqueOperations.add(operation);
    }
    return [...uniqueOperations];
  }

  function isCoordinationLeaseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code || '')
      : '';
    return /^(TRANSFER|MARKET)_LEASE_(BUSY|LOST)$/.test(code)
      || /^TASK_RUNTIME_(BUSY|REVOKED)$/.test(code)
      || code === 'COORDINATION_AUTH_REQUIRED'
      || /transfer lease|market lease|TRANSFER_LEASE_BUSY|MARKET_LEASE_BUSY|全局锁|锁定该地址|代币市场|另一个交易任务/i.test(message);
  }

  function isRecoverableWalletLeaseBusy(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code || '')
      : '';
    const message = error instanceof Error ? error.message : String(error ?? '');
    return code === 'TRANSFER_LEASE_BUSY'
      || /\bTRANSFER_LEASE_BUSY\b|transfer lease.+busy|钱包.+(?:正被|正在).+(?:任务|操作)/i.test(message);
  }

  function markTaskUnresolvedTransaction(
    task: Task,
    walletAddress: string,
    status: UnresolvedTransactionStatus,
    txHash: string | undefined,
    rpcUrl: string,
    receiptRequired = false,
    executionChainId = task.config.chainId,
  ): void {
    try {
      markUnresolvedTransaction({
        chainId: executionChainId,
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
            chainId: executionChainId,
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
    executionChainId = task.config.chainId,
  ): Promise<void> {
    // 这里只做 receipt/nonce 只读对账，不会发送、替换或重试交易。
    for (;;) {
      try {
        const check = await checkUnresolvedTransaction({
          chainId: executionChainId,
          walletAddress,
          rpcUrl,
        });
        if (!check.blocked) {
          if (check.reason !== 'none') {
            resetTradingNonceForAddress(walletAddress, executionChainId);
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
        const timer = globalThis.setTimeout(resolve, 10_000);
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
    _scope: 'wallet' = 'wallet',
    executionChainId = task.config.chainId,
  ): void {
    if (!leaseGuard?.retainUntil) return;
    addLog(
      task.id,
      'warning',
      `${walletAddress.slice(0, 10)}... 将持续只读核对回执/nonce；确认前只保持该源钱包锁，不会锁住代币市场，也不会重发交易`,
      walletAddress,
      txHash,
    );
    leaseGuard.retainUntil(monitorUnresolvedTransaction(
      task,
      walletAddress,
      rpcUrl,
      txHash,
      executionChainId,
    ));
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
  const statsSyncTimers = new Map<string, TimerHandle>();

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
        currentSellWalletIndex: st.currentSellWalletIndex || 0,
        remoteRuntimeActive: Boolean(st.runtimeActive),
        remoteRuntimeId: st.runtimeActive ? st.runtimeId : undefined,
      }));
      if (tasks.value.length > 0) {
        activeLogTaskId.value = tasks.value[0].id;
      }
      // Read-only Robinhood pool/approval warmup starts as soon as persisted
      // tasks are visible. It never acquires a runtime or wallet lease and
      // never signs a transaction, so the Start click can reuse completed or
      // still-in-flight reads without creating a background task lock.
      for (const task of tasks.value) warmupLoadedRobinhoodTask(task);
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

    const timer = globalThis.setTimeout(async () => {
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
      return getRuntimeRobinhoodRpcUrl();
    }
    if (config.buyUsePremiumRpc) return getPremiumSellRpc();
    return config.antiSandwichRpc || ANTI_SANDWICH_RPC;
  }

  // 获取任务的卖出 RPC URL（始终使用高速节点）
  function getSellRpcUrl(config?: TaskConfig): string {
    if (config?.chainId === 4663) {
      return getRuntimeRobinhoodRpcUrl();
    }
    return getPremiumSellRpc();
  }

  function getTaskExecutionRpc(task: Task, direction: 'buy' | 'sell'): string {
    if (task.config.chainId === 4663) {
      return getRuntimeRobinhoodRpcUrl();
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

    // Pons tokens can be approved even while the wallet balance is zero.
    // Start this immediately after explicit sell-task creation so the later
    // Start click only has to perform the synchronized live sell wave.
    if (normalizedConfig.chainId === 4663 && sellCount > 0) {
      preApproveRobinhoodSellWallets(task);
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
      let preparationRuntime: TaskRuntimeGuard | undefined;
      try {
        preparationRuntime = await acquireTaskRuntime(task);
        preparationRuntime.assertActive();
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
            const outcome = await withTaskWalletLease(task.config.chainId, addr, async (walletLeaseGuard) => {
              const leaseGuard = combineLeaseGuards(preparationRuntime, walletLeaseGuard);
              leaseGuard?.assertActive();
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
            }, () => isCurrentRun() && !activeBatchSellWalletKeys.has(
              taskWalletLeaseKey(task.config.chainId, addr),
            ));

            if (!isCurrentRun()) return;
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
      } finally {
        // A foreground Start may deliberately reuse this preparation runtime.
        // Keep it alive throughout the stopped -> running handoff window; once
        // Start owns the synchronous latch it is responsible for revocation.
        if (task.status !== 'running' && !startingTaskIds.has(task.id)) {
          await revokeTaskRuntime(task.id, '后台预授权已结束', {
            broadcast: false,
            expectedState: preparationRuntime?.runtimeState ?? null,
          });
        }
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
    const totalConfirmed = buyCount + sellCount;

    // A pure sell-all task is complete only when every selected wallet has
    // either started at zero or has a confirmed sell followed by a zero-balance
    // reconciliation. Count/amount are not reliable completion proxies for a
    // wallet-clearing task. Explicit time/price/market-cap stops remain honored.
    if (
      isPureSellAllTask(task)
      && (stopType === 'none' || stopType === 'count' || stopType === 'amount')
    ) {
      // Completion is asynchronous: finishPureSellCoverageIfComplete() must
      // first acquire the whole wallet cohort and re-read every balance under
      // that barrier. A sticky per-wallet coverage snapshot alone is not a
      // safe stop condition when another task can buy into a cleared wallet.
      return false;
    }

    // none = 永不自动停止，只能手动停止
    if (stopType === 'none') return false;

    switch (stopType) {
      case 'count':
        return totalConfirmed >= stopValue;
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

  function stopBudgetReserved(task: Task): boolean {
    if (isPureSellAllTask(task)) return false;
    const pending = pendingTaskTrades.get(
      pendingTaskTradeKey(task.id, currentTaskExecutionGeneration(task.id)),
    ) ?? { count: 0, amount: 0 };
    if (task.config.stopType === 'count') {
      return task.stats.buyCount + task.stats.sellCount + pending.count >= task.config.stopValue;
    }
    if (task.config.stopType === 'amount') {
      return task.stats.spentAmount + pending.amount >= task.config.stopValue;
    }
    return false;
  }

  function remainingCountAdmissionSlots(task: Task): number | undefined {
    if (isPureSellAllTask(task) || task.config.stopType !== 'count') return undefined;
    const pending = pendingTaskTrades.get(
      pendingTaskTradeKey(task.id, currentTaskExecutionGeneration(task.id)),
    )?.count ?? 0;
    return Math.max(
      0,
      Math.ceil(task.config.stopValue - task.stats.buyCount - task.stats.sellCount - pending),
    );
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

  async function ensureRobinhoodSellTaskReady(
    task: Task,
    tokenAddress: string,
    walletAddresses = task.walletAddresses,
    options?: {
      allowStoppedTask?: boolean;
      generation?: number;
      executionGeneration?: number;
      expectedCoverage?: PureSellCoverageState;
      background?: boolean;
    },
  ): Promise<boolean> {
    if (task.config.chainId !== 4663 || (task.config.sellThreadCount || 0) <= 0) return true;

    const walletStore = useWalletStore();
    const dexStore = useDexStore();
    const taskDex = dexStore.dexConfigs.find(
      dex => dex.id === task.config.dexId && dex.chainId === task.config.chainId,
    );
    const routerAddress = taskDex?.routerAddress || '';
    if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
      addLog(task.id, 'error', '卖出预授权失败：当前 DEX Router 地址未配置');
      return false;
    }

    const rpcUrl = getTaskExecutionRpc(task, 'sell');
    const tradingService = getOrCreateTradingService(task, rpcUrl, routerAddress);
    const isCurrentPreparation = () => (
      (
        options?.generation === undefined
        || robinhoodSellPreparationGenerations.get(task.id) === options.generation
      )
      && (
        options?.executionGeneration === undefined
        || currentTaskExecutionGeneration(task.id) === options.executionGeneration
      )
      && (
        !options?.expectedCoverage
        || pureSellCoverageStates.get(task.id) === options.expectedCoverage
      )
      && (Boolean(options?.allowStoppedTask) || task.status === 'running')
    );
    addLog(
      task.id,
      'info',
      options?.background
        ? `卖出后台准备：提前核对 ${walletAddresses.length} 个钱包的 Router 授权并预热池数据`
        : `卖出启动屏障：批量核对 ${walletAddresses.length} 个可用钱包的 Router 授权`,
    );

    const metadataWarmup = tradingService.warmupV3SellPreparation(
      tokenAddress as `0x${string}`,
      task.config.v3FeeTier ?? 10000,
    );

    type ApprovalOutcome = {
      walletAddress: string;
      ready: boolean;
      deferredBusy?: boolean;
      error?: string;
      txHash?: string;
    };
    // Balance and allowance are independent read-only checks. A zero-balance
    // wallet is already cleared and must not be forced to spend gas on an
    // approval merely to let a pure sell batch start. Read failures are never
    // interpreted as zero.
    const [approvalChecks, balanceChecks] = await Promise.all([
      Promise.allSettled(walletAddresses.map(async walletAddress => ({
        walletAddress,
        ...(await tradingService.checkV3SellApproval(
          tokenAddress as `0x${string}`,
          walletAddress as `0x${string}`,
        )),
      }))),
      Promise.allSettled(walletAddresses.map(async walletAddress => ({
        walletAddress,
        balance: await tradingService.readTokenBalance(
          tokenAddress as `0x${string}`,
          walletAddress as `0x${string}`,
        ),
      }))),
      metadataWarmup,
    ]);
    if (!isCurrentPreparation()) return false;

    const approvalByWallet = new Map(
      approvalChecks
        .filter((result): result is PromiseFulfilledResult<{
          walletAddress: string;
          ready: boolean;
          allowance?: bigint;
        }> => result.status === 'fulfilled')
        .map(result => [result.value.walletAddress.toLowerCase(), result.value] as const),
    );
    const approvalErrorByWallet = new Map(
      approvalChecks
        .map((result, index) => ({ result, walletAddress: walletAddresses[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, walletAddress }) => [
          walletAddress.toLowerCase(),
          (result as PromiseRejectedResult).reason,
        ] as const),
    );
    const balanceByWallet = new Map(
      balanceChecks
        .filter((result): result is PromiseFulfilledResult<{
          walletAddress: string;
          balance: bigint;
        }> => result.status === 'fulfilled')
        .map(result => [result.value.walletAddress.toLowerCase(), result.value.balance] as const),
    );
    const balanceErrorByWallet = new Map(
      balanceChecks
        .map((result, index) => ({ result, walletAddress: walletAddresses[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, walletAddress }) => [
          walletAddress.toLowerCase(),
          (result as PromiseRejectedResult).reason,
        ] as const),
    );

    const deferPureSellWallet = (walletAddress: string): void => {
      const coverage = options?.expectedCoverage ?? pureSellCoverageFor(task);
      const walletKey = walletAddress.toLowerCase();
      if (
        coverage
        && pureSellCoverageStates.get(task.id) === coverage
        && coverage.walletKeys.has(walletKey)
        && !coverage.clearedWalletKeys.has(walletKey)
      ) {
        coverage.retryAfterByWallet.set(
          walletKey,
          Math.max(coverage.retryAfterByWallet.get(walletKey) || 0, Date.now() + 1_000),
        );
      }
    };

    // An unlocked latest=0 read is only a hint. Another task holding this
    // wallet's lease may have a buy/transfer in flight that will increase the
    // token balance. Re-read every pure-sell zero while holding the wallet
    // lease; a busy wallet remains in coverage and is retried later.
    const busyZeroBalanceWallets = new Map<string, string>();
    const clearedZeroBalanceWalletKeys = new Set<string>();
    if (isPureSellAllTask(task)) {
      const initiallyZeroWallets = walletAddresses.filter(
        walletAddress => balanceByWallet.get(walletAddress.toLowerCase()) === 0n,
      );
      const zeroVerifications = await Promise.all(initiallyZeroWallets.map(async walletAddress => {
        const leaseKey = taskWalletLeaseKey(task.config.chainId, walletAddress);
        if (
          taskWalletOperationLocks.has(leaseKey)
          || activeBatchSellWalletKeys.has(leaseKey)
        ) {
          return {
            walletAddress,
            status: 'busy' as const,
            error: '钱包正在执行其他本地或手工任务',
          };
        }
        try {
          return await withTaskWalletLease(
            task.config.chainId,
            walletAddress,
            async walletLeaseGuard => {
              const leaseGuard = combineLeaseGuards(
                runtimeGuardForTask(task, Boolean(options?.allowStoppedTask)),
                {
                  assertActive() {
                    if (!isCurrentPreparation()) throw new TaskRoundCancelledError();
                  },
                },
                walletLeaseGuard,
              )!;
              leaseGuard.assertActive();
              // A zero token balance is final only when this wallet has no
              // earlier chain write still pending. A crashed tab/device may
              // have lost the transaction hash while its buy remains in the
              // mempool; checking latest/pending nonce inside the wallet lease
              // prevents that stale zero from clearing sell-all coverage.
              const blockedPredecessor = await findBlockedUnresolvedWallet(
                task,
                [walletAddress],
                true,
                rpcUrl,
              );
              leaseGuard.assertActive();
              if (blockedPredecessor) {
                if (blockedPredecessor.code === WALLET_PENDING_PREDECESSOR_CODE) {
                  markTaskUnresolvedTransaction(
                    task,
                    walletAddress,
                    'pending',
                    undefined,
                    rpcUrl,
                  );
                }
                const unresolved = getUnresolvedTransaction(
                  task.config.chainId,
                  walletAddress,
                );
                if (unresolved) {
                  retainLeasesUntilUnresolvedSettles(
                    task,
                    walletAddress,
                    unresolved.rpcUrl,
                    unresolved.txHash,
                    walletLeaseGuard,
                  );
                }
                deferPureSellWallet(walletAddress);
                return {
                  walletAddress,
                  status: 'busy' as const,
                  error: blockedPredecessor.message,
                };
              }
              const verifiedBalance = await tradingService.readTokenBalance(
                tokenAddress as `0x${string}`,
                walletAddress as `0x${string}`,
              );
              leaseGuard.assertActive();
              if (verifiedBalance === 0n) {
                // The balance re-read and coverage transition must share the
                // same wallet-lease linearization point. Otherwise another
                // task can buy after the lease is released but before this
                // wallet is marked cleared, letting an obsolete zero snapshot
                // complete the sell-all task.
                markPureSellWalletCleared(
                  task,
                  walletAddress,
                  'zero-balance',
                  options?.expectedCoverage,
                );
                leaseGuard.assertActive();
                return {
                  walletAddress,
                  status: 'cleared' as const,
                };
              }
              return {
                walletAddress,
                status: 'verified' as const,
                balance: verifiedBalance,
              };
            },
            () => isCurrentPreparation()
              && !activeBatchSellWalletKeys.has(
                taskWalletLeaseKey(task.config.chainId, walletAddress),
              ),
          );
        } catch (error: any) {
          if (isRecoverableWalletLeaseBusy(error)) {
            return {
              walletAddress,
              status: 'busy' as const,
              error: error?.message || '钱包正在执行其他任务',
            };
          }
          return {
            walletAddress,
            status: 'failed' as const,
            error: error?.message || '零余额租约内复核失败',
          };
        }
      }));
      if (!isCurrentPreparation()) return false;

      for (const verification of zeroVerifications) {
        const key = verification.walletAddress.toLowerCase();
        if (verification.status === 'verified') {
          balanceByWallet.set(key, verification.balance);
        } else if (verification.status === 'cleared') {
          clearedZeroBalanceWalletKeys.add(key);
        } else if (verification.status === 'busy') {
          busyZeroBalanceWallets.set(key, verification.error);
          deferPureSellWallet(verification.walletAddress);
        } else {
          balanceByWallet.delete(key);
          balanceErrorByWallet.set(key, new Error(verification.error));
        }
      }
    }

    const outcomes: ApprovalOutcome[] = [];
    const needsApproval: Array<{
      walletAddress: string;
      ready: boolean;
      allowance?: bigint;
    }> = [];

    for (const walletAddress of walletAddresses) {
      const key = walletAddress.toLowerCase();
      const busyZeroError = busyZeroBalanceWallets.get(key);
      if (busyZeroError) {
        outcomes.push({
          walletAddress,
          ready: false,
          deferredBusy: true,
          error: busyZeroError,
        });
        continue;
      }
      if (clearedZeroBalanceWalletKeys.has(key)) {
        outcomes.push({ walletAddress, ready: true });
        continue;
      }
      const balance = balanceByWallet.get(key);
      if (balance === undefined) {
        const error = balanceErrorByWallet.get(key);
        outcomes.push({
          walletAddress,
          ready: false,
          error: `代币余额读取失败：${error?.message || String(error || '状态未知')}`,
        });
        continue;
      }
      if (balance === 0n && isPureSellAllTask(task)) {
        markPureSellWalletCleared(
          task,
          walletAddress,
          'zero-balance',
          options?.expectedCoverage,
        );
        outcomes.push({ walletAddress, ready: true });
        continue;
      }

      const privateKey = getWalletPrivateKey(walletStore, walletAddress);
      if (!privateKey) {
        outcomes.push({ walletAddress, ready: false, error: '没有私钥' });
        continue;
      }

      const approval = approvalByWallet.get(key);
      if (!approval) {
        const error = approvalErrorByWallet.get(key);
        outcomes.push({
          walletAddress,
          ready: false,
          error: `授权读取失败：${error?.message || String(error || '状态未知')}`,
        });
        continue;
      }
      if (approval.ready) outcomes.push({ walletAddress, ready: true });
      else needsApproval.push(approval);
    }

    outcomes.push(...await Promise.all(needsApproval.map(async check => {
      const walletAddress = check.walletAddress;
      const privateKey = getWalletPrivateKey(walletStore, walletAddress);
      if (!privateKey) {
        return { walletAddress, ready: false, error: '没有私钥' };
      }

      try {
        return await withTaskWalletLease(task.config.chainId, walletAddress, async walletLeaseGuard => {
          const leaseGuard = combineLeaseGuards(
            runtimeGuardForTask(task, Boolean(options?.allowStoppedTask)),
            {
              assertActive() {
                if (!isCurrentPreparation()) throw new TaskRoundCancelledError();
                if (!options?.allowStoppedTask && task.status !== 'running') {
                  throw new TaskRoundCancelledError();
                }
              },
            },
            walletLeaseGuard,
          );
          const result = await tradingService.ensureV3SellApproval({
            chainId: task.config.chainId,
            rpcUrl,
            routerAddress,
            privateKey,
            walletAddress,
            tokenAddress,
            spendToken: 'ETH',
            amount: 0,
            amountType: 'amount',
            mode: 'dump',
            slippage: taskTradeSlippage(task),
            v3FeeTier: task.config.v3FeeTier,
            leaseGuard,
            onTransactionHash: (txHash) => {
              addLog(task.id, 'info', '[Pons] 卖出授权已广播，首轮卖出将在授权确认后开始', walletAddress, txHash);
            },
          }, check.allowance);

          if (result.status === 'pending' || result.status === 'unknown') {
            markTaskUnresolvedTransaction(task, walletAddress, result.status, result.txHash, rpcUrl);
            retainLeasesUntilUnresolvedSettles(
              task,
              walletAddress,
              rpcUrl,
              result.txHash,
              walletLeaseGuard,
              'wallet',
            );
          }

          return {
            walletAddress,
            ready: result.success && result.status === 'confirmed',
            error: result.error,
            txHash: result.txHash,
          };
        }, () => isCurrentPreparation()
          && (Boolean(options?.allowStoppedTask) || task.status === 'running')
          && !activeBatchSellWalletKeys.has(taskWalletLeaseKey(task.config.chainId, walletAddress)));
      } catch (error: any) {
        if (!isCurrentPreparation()) {
          return { walletAddress, ready: false, error: '任务配置已更新' };
        }
        if (error instanceof TaskRoundCancelledError) {
          return { walletAddress, ready: false, error: '任务已暂停' };
        }
        if (isRecoverableWalletLeaseBusy(error)) {
          // A remote lease holder is temporary coordination state, not an
          // approval failure. Keep the wallet in clear-all coverage and leave
          // a short gap before the scheduler retries it.
          deferPureSellWallet(walletAddress);
          return {
            walletAddress,
            ready: false,
            deferredBusy: true,
            error: error?.message || '钱包正在执行其他任务',
          };
        }
        return { walletAddress, ready: false, error: error?.message || '卖出授权核对失败' };
      }
    })));
    if (!isCurrentPreparation()) return false;

    const deferredBusy = outcomes.filter(outcome => outcome.deferredBusy);
    for (const deferred of deferredBusy.slice(0, 5)) {
      addLog(
        task.id,
        'warning',
        `${deferred.walletAddress.slice(0, 10)}... 当前不可安全认定清仓：${deferred.error || '钱包正在执行其他任务或存在链上待确认前序交易'}；保留在清仓队列并于后续轮次重试`,
        deferred.walletAddress,
      );
    }
    if (deferredBusy.length > 5) {
      addLog(task.id, 'warning', `另有 ${deferredBusy.length - 5} 个暂缓钱包保留在清仓队列等待重新核对`);
    }

    const failures = outcomes.filter(outcome => !outcome.ready && !outcome.deferredBusy);
    if (failures.length > 0) {
      for (const failure of failures.slice(0, 5)) {
        addLog(
          task.id,
          'warning',
          `${failure.walletAddress.slice(0, 10)}... 卖出授权未就绪：${failure.error || '状态未知'}`,
          failure.walletAddress,
          failure.txHash,
        );
      }
      if (failures.length > 5) {
        addLog(task.id, 'warning', `另有 ${failures.length - 5} 个钱包的卖出授权未就绪`);
      }
      if (isPureSellAllTask(task)) {
        addLog(
          task.id,
          'error',
          '纯卖出清仓要求所有有余额钱包先通过私钥、余额和授权检查；本次首轮 0 笔卖出，修复失败项后可恢复任务',
        );
        return false;
      }
      addLog(task.id, 'warning', '混合买卖任务仅跳过未就绪卖出钱包；买入和其他钱包继续');
      return true;
    }

    addLog(
      task.id,
      'success',
      deferredBusy.length > 0
        ? `卖出启动屏障通过：当前可用钱包已确认授权；${deferredBusy.length} 个暂缓钱包保留在清仓队列等待后续重试`
        : '卖出启动屏障通过：所有当前可用钱包已确认最大授权，后续轮次不再重复读取 allowance',
    );
    return true;
  }

  function warmupLoadedRobinhoodTask(task: Task): void {
    const tokenAddress = taskTokenAddress(task);
    if (
      task.config.chainId !== 4663
      || !tokenAddress
      || task.walletAddresses.length === 0
    ) {
      return;
    }

    const dexStore = useDexStore();
    const taskDex = dexStore.dexConfigs.find(
      dex => dex.id === task.config.dexId && dex.chainId === task.config.chainId,
    );
    const routerAddress = taskDex?.routerAddress || '';
    if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
      return;
    }

    const service = getOrCreateTradingService(
      task,
      getRuntimeRobinhoodRpcUrl(),
      routerAddress,
    );
    const warmups: Promise<unknown>[] = [
      service.warmupV3SellPreparation(
        tokenAddress as `0x${string}`,
        task.config.v3FeeTier ?? 10000,
      ),
    ];
    if ((task.config.sellThreadCount || 0) > 0) {
      warmups.push(...task.walletAddresses.map(walletAddress => (
        service.checkV3SellApproval(
          tokenAddress as `0x${string}`,
          walletAddress as `0x${string}`,
        )
      )));
    }
    void Promise.allSettled(warmups);
  }

  function preApproveRobinhoodSellWallets(task: Task): void {
    const tokenAddress = taskTokenAddress(task);
    if (
      task.config.chainId !== 4663
      || (task.config.sellThreadCount || 0) <= 0
      || !tokenAddress
      || task.walletAddresses.length === 0
    ) return;

    const generation = (robinhoodSellPreparationGenerations.get(task.id) || 0) + 1;
    robinhoodSellPreparationGenerations.set(task.id, generation);
    const tracker = {
      promise: Promise.resolve(),
      completed: false,
      generation,
    };
    const promise = (async () => {
      let preparationRuntime: TaskRuntimeGuard | undefined;
      preparationRuntime = await acquireTaskRuntime(task);
      try {
        await ensureRobinhoodSellTaskReady(
          task,
          tokenAddress,
          task.walletAddresses,
          {
            allowStoppedTask: true,
            generation,
            background: true,
          },
        );
      } finally {
        // Do not revoke a runtime that foreground Start has already adopted
        // but has not yet synchronously transitioned to `running`.
        if (task.status !== 'running' && !startingTaskIds.has(task.id)) {
          await revokeTaskRuntime(task.id, '卖出后台准备已结束', {
            broadcast: false,
            expectedState: preparationRuntime.runtimeState,
          });
        }
      }
    })().catch((error: any) => {
      if (isCoordinationLeaseError(error)) {
        addLog(task.id, 'warning', `卖出后台准备暂未完成：${error.message}`);
        return;
      }
      if (!(error instanceof TaskRoundCancelledError)) {
        addLog(task.id, 'warning', `卖出后台准备失败，启动时将重新核对：${error?.message || '未知错误'}`);
      }
    }).finally(() => {
      const current = robinhoodSellPreparationTracker.get(task.id);
      if (current === tracker) current.completed = true;
    });
    tracker.promise = promise;
    robinhoodSellPreparationTracker.set(task.id, tracker);
  }

  // 执行单个钱包的交易（可传入共享的 FourMemeService 实例避免重复创建）
  async function executeWalletTrade(
    task: Task,
    walletAddress: string,
    tradeDirection: 'buy' | 'sell',
    operationGuard: TransferLeaseGuard,
    isCurrentExecution: () => boolean,
    sharedFourMemeService?: InstanceType<typeof FourMemeService>,
    sharedTradingService?: ReturnType<typeof createTradingService>,
    broadcastParticipant?: RobinhoodSellBroadcastParticipant,
    preAcquiredWalletLeaseGuard?: TransferLeaseGuard,
  ): Promise<boolean> {
    if (!isCurrentExecution()) {
      broadcastParticipant?.fail();
      return false;
    }
    const walletStore = useWalletStore();
    const dexStore = useDexStore();

    // 获取私钥（支持本地钱包和批次钱包）
    const privateKey = getWalletPrivateKey(walletStore, walletAddress);
    if (!privateKey) {
      addLog(task.id, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
      // This return happens before the main try/finally below. Always account
      // for the strict sell participant immediately so already-signed sibling
      // transactions are cancelled instead of waiting for the timeout.
      broadcastParticipant?.fail();
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

      operationGuard.assertActive();
      const executeWithWalletLease = async (walletLeaseGuard?: TransferLeaseGuard) => {
        if (!isCurrentExecution()) throw new TaskRoundCancelledError();
        const leaseGuard = combineLeaseGuards(operationGuard, walletLeaseGuard);
        leaseGuard?.assertActive();

        // 自动任务只按钱包独占 nonce；轮次守卫负责在任务暂停后阻止尚未
        // 开始的交易。这样同一轮和不同任务的不同钱包都可以真正并发。
        if (isFourMemeTask(task)) {
          return executeInnerMarketTrade(
            task,
            walletAddress,
            privateKey,
            chainId,
            rpcUrl,
            roundedAmount,
            tradeDirection,
            isCurrentExecution,
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
          sharedTradingService,
          broadcastParticipant,
        );
      };

      if (preAcquiredWalletLeaseGuard) {
        return await executeWithWalletLease(preAcquiredWalletLeaseGuard);
      }
      return await withTaskWalletLease(
        chainId,
        walletAddress,
        executeWithWalletLease,
        () => isCurrentExecution()
          && !activeBatchSellWalletKeys.has(taskWalletLeaseKey(chainId, walletAddress)),
      );

    } catch (error: any) {
      if (error instanceof TaskRoundCancelledError) return false;
      if (!isCurrentExecution()) return false;
      if (isRecoverableWalletLeaseBusy(error)) {
        addLog(
          task.id,
          'warning',
          `钱包正在执行另一个任务，本轮暂时跳过并在下一轮自动重试: ${error.message}`,
          walletAddress,
        );
        return false;
      }
      if (isCoordinationLeaseError(error)) {
        addLog(task.id, 'warning', `交易协调锁不可用: ${error.message}；任务已暂停且本轮剩余交易不会发送`, walletAddress);
        if (task.status === 'running') pauseTask(task.id);
        return false;
      }
      addLog(task.id, 'error', `交易异常: ${error.message}`, walletAddress);
      return false;
    } finally {
      // If preparation failed before this wallet reached the sell barrier, mark
      // the participant complete so other prepared wallets cannot deadlock.
      broadcastParticipant?.fail();
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
    isCurrentExecution: () => boolean,
    sharedService?: InstanceType<typeof FourMemeService>,
    leaseGuard?: TransferLeaseGuard,
    walletLeaseGuard?: TransferLeaseGuard,
  ): Promise<boolean> {
    const executionGeneration = currentTaskExecutionGeneration(task.id);
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
    const resultNeedsReconciliation = result.status === 'pending' || result.status === 'unknown';
    if (!resultNeedsReconciliation && !isCurrentExecution()) {
      if (result.txHash) {
        addLog(
          task.id,
          'warning',
          `${walletAddress.slice(0, 10)}... 旧运行批次交易已返回，但任务配置/运行代次已变化；未计入当前任务统计`,
          walletAddress,
          result.txHash,
        );
      }
      return false;
    }

    if (
      tradeDirection === 'sell'
      && result.code === ZERO_TOKEN_BALANCE_CODE
      && !isPureSellAllTask(task)
    ) {
      recordMixedSellDeficit(task, walletAddress, executionGeneration);
      addLog(
        task.id,
        'warning',
        `${walletAddress.slice(0, 10)}... 当前代币余额为 0，本轮未产生卖出；后续轮次优先使用已确认买入的钱包`,
        walletAddress,
      );
      return false;
    }

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
        chainId,
      );
      retainLeasesUntilUnresolvedSettles(
        task,
        walletAddress,
        reconciliationRpc,
        result.txHash,
        result.transactionKind === 'approval' ? walletLeaseGuard : leaseGuard,
        'wallet',
        chainId,
      );
      if (!isCurrentExecution()) {
        addLog(
          task.id,
          'warning',
          `${walletAddress.slice(0, 10)}... 旧运行批次仍有待确认交易；已继续保护原链钱包，但未写入当前任务统计`,
          walletAddress,
          result.txHash,
        );
        return false;
      }
      addLog(
        task.id,
        'warning',
        result.code === WALLET_PENDING_PREDECESSOR_CODE
          ? `[内盘] 检测到链上待确认前序交易，本轮未广播新交易；只跳过该钱包，其他钱包继续`
          : result.receiptRequired
            ? `[内盘] 交易已在执行节点确认，但另一交易节点尚未同步；只保护该钱包且不会重发，其他钱包继续`
            : `[内盘] 交易已广播但${result.status === 'pending' ? '仍在等待确认' : '状态未知'}；只保护该钱包且不会重发，其他钱包继续`,
        walletAddress,
        result.txHash,
      );
      return false;
    } else if (result.success) {
      if (tradeDirection === 'buy') {
        task.stats.buyCount++;
      } else {
        task.stats.sellCount++;
      }
      if (tradeDirection === 'buy') task.stats.spentAmount += amount;
      recordMixedDirectionSuccess(
        task,
        walletAddress,
        tradeDirection,
        executionGeneration,
      );

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
    operationGuard: TransferLeaseGuard,
    isCurrentExecution: () => boolean,
    sharedFourMemeService: InstanceType<typeof FourMemeService>,
    prefetchData?: FourMemeRoundPrefetchData,
  ): Promise<boolean> {
    if (!isCurrentExecution()) return false;
    const executionGeneration = currentTaskExecutionGeneration(task.id);
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
        operationGuard,
        isCurrentExecution,
        sharedFourMemeService,
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
        operationGuard,
        isCurrentExecution,
        sharedFourMemeService,
      );
    }

    try {
      const chainId = task.config.chainId;
      const buyRpcForFast = getBuyRpcUrl(task.config);
      const sellRpcForFast = getSellRpcUrl(task.config);
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

      operationGuard.assertActive();
      const result = await withTaskWalletLease(chainId, walletAddress, async (walletLeaseGuard) => {
        if (!isCurrentExecution()) throw new TaskRoundCancelledError();
        const leaseGuard = combineLeaseGuards(operationGuard, walletLeaseGuard);
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
            || (tradeDirection === 'sell' ? sellRpcForFast : buyRpcForFast);
          markTaskUnresolvedTransaction(
            task,
            walletAddress,
            tradeResult.status,
            tradeResult.txHash,
            reconciliationRpc,
            tradeResult.receiptRequired,
            chainId,
          );
          retainLeasesUntilUnresolvedSettles(
            task,
            walletAddress,
            reconciliationRpc,
            tradeResult.txHash,
            leaseGuard,
            'wallet',
            chainId,
          );
        }
        return tradeResult;
      }, () => isCurrentExecution()
        && !activeBatchSellWalletKeys.has(taskWalletLeaseKey(chainId, walletAddress)));

      if (!isCurrentExecution()) {
        if (result.txHash) {
          addLog(
            task.id,
            'warning',
            `${walletAddress.slice(0, 10)}... 旧运行批次快速交易已返回；原链待确认保护保留，但未写入当前任务统计`,
            walletAddress,
            result.txHash,
          );
        }
        return false;
      }
      if (
        tradeDirection === 'sell'
        && result.code === ZERO_TOKEN_BALANCE_CODE
        && !isPureSellAllTask(task)
      ) {
        recordMixedSellDeficit(task, walletAddress, executionGeneration);
        addLog(
          task.id,
          'warning',
          `${walletAddress.slice(0, 10)}... 当前代币余额为 0，本轮未产生卖出；后续轮次优先使用已确认买入的钱包`,
          walletAddress,
        );
        return false;
      }
      if (result.status === 'pending' || result.status === 'unknown') {
        addLog(
          task.id,
          'warning',
          result.code === WALLET_PENDING_PREDECESSOR_CODE
            ? `[内盘-快速] 检测到链上待确认前序交易，本轮未广播新交易；只跳过该钱包，其他钱包继续`
            : result.receiptRequired
              ? `[内盘-快速] 交易已在执行节点确认，但另一交易节点尚未同步；只保护该钱包且不会重发，其他钱包继续`
              : `[内盘-快速] 交易已广播但${result.status === 'pending' ? '仍在等待确认' : '状态未知'}；只保护该钱包且不会重发，其他钱包继续`,
          walletAddress,
          result.txHash,
        );
        return false;
      } else if (result.success) {
        if (tradeDirection === 'buy') {
          task.stats.buyCount++;
        } else {
          task.stats.sellCount++;
        }
        if (tradeDirection === 'buy') task.stats.spentAmount += roundedAmount;
        recordMixedDirectionSuccess(
          task,
          walletAddress,
          tradeDirection,
          executionGeneration,
        );

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
      if (!isCurrentExecution()) return false;
      if (isRecoverableWalletLeaseBusy(error)) {
        addLog(
          task.id,
          'warning',
          `[内盘-快速] 钱包正在执行另一个任务，本轮暂时跳过并在下一轮自动重试: ${error.message}`,
          walletAddress,
        );
        return false;
      }
      if (isCoordinationLeaseError(error)) {
        addLog(task.id, 'warning', `[内盘-快速] 交易协调锁不可用: ${error.message}；任务已暂停且本轮剩余交易不会发送`, walletAddress);
        if (task.status === 'running') pauseTask(task.id);
        return false;
      }
      addLog(task.id, 'error', `[内盘-快速] 交易异常: ${error.message}；为避免重复广播，本轮不自动重试`, walletAddress);
      return false;
    }
  }

  async function reconcilePureSellWalletBalance(
    task: Task,
    walletAddress: string,
    tokenAddress: string,
    tradingService: ReturnType<typeof createTradingService>,
    expectedCoverage?: PureSellCoverageState,
    executionGeneration = currentTaskExecutionGeneration(task.id),
  ): Promise<boolean> {
    if (!expectedCoverage) return true;
    const isCurrentExecution = () => (
      currentTaskExecutionGeneration(task.id) === executionGeneration
      && pureSellCoverageStates.get(task.id) === expectedCoverage
    );
    if (!isCurrentExecution()) return false;
    try {
      const balance = await tradingService.readTokenBalance(
        tokenAddress as `0x${string}`,
        walletAddress as `0x${string}`,
      );
      if (!isCurrentExecution()) return false;
      if (balance === 0n) {
        markPureSellWalletCleared(
          task,
          walletAddress,
          'confirmed-zero',
          expectedCoverage,
        );
        if (expectedCoverage) {
          schedulePureSellCoverageFinalization(task, expectedCoverage);
        }
        return true;
      }
      addLog(
        task.id,
        'warning',
        `清仓覆盖：${walletAddress.slice(0, 10)}... 交易已确认但仍有代币余额，保留在后续轮次重试`,
        walletAddress,
      );
      return false;
    } catch (error: any) {
      if (!isCurrentExecution()) return false;
      addLog(
        task.id,
        'warning',
        `清仓覆盖：${walletAddress.slice(0, 10)}... 确认后余额复核失败，未计为清仓完成并将在后续轮次重试：${error?.message || '未知错误'}`,
        walletAddress,
      );
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
    sharedTradingService?: ReturnType<typeof createTradingService>,
    broadcastParticipant?: RobinhoodSellBroadcastParticipant,
  ): Promise<boolean> {
    const taskDex = dexStore.dexConfigs.find(dex => dex.id === task.config.dexId && dex.chainId === chainId);
    const routerAddress = taskDex?.routerAddress || '';
    const resolvedTokenAddress = taskTokenAddress(task);
    const executionGeneration = currentTaskExecutionGeneration(task.id);
    const pureSellCoverageSnapshot = (
      tradeDirection === 'sell' && isPureSellAllTask(task)
    )
      ? pureSellCoverageFor(task)
      : undefined;
    const sellAllForExecution = tradeDirection === 'sell' && Boolean(task.config.sellAll);
    const isCurrentExecution = () => (
      currentTaskExecutionGeneration(task.id) === executionGeneration
    );

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
      ? getRuntimeRobinhoodRpcUrl()
      : (tradeDirection === 'sell'
        ? getSellRpcUrl(task.config)
        : (task.config.buyUsePremiumRpc ? getPremiumSellRpc() : (task.config.antiSandwichRpc || rpcUrl)));
    const tradingService = sharedTradingService
      ?? getOrCreateTradingService(task, effectiveRpcUrl, routerAddress);

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
      // Once Robinhood returns a deterministic hash, confirmation is handled
      // by the retained wallet lease in the background.  Manual batch sells
      // deliberately keep the default blocking behavior.
      awaitConfirmation: chainId !== 4663,
      robinhoodBroadcastParticipant: chainId === 4663
        ? broadcastParticipant
        : undefined,
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
    if (
      tradeDirection === 'sell'
      && pureSellCoverageSnapshot
      && isCurrentExecution()
      && (result.status === 'broadcast' || result.success)
    ) {
      clearPureSellPreparationFailure(
        task,
        walletAddress,
        pureSellCoverageSnapshot,
      );
    }

    const tradeSourceText = chainId === 4663 && task.config.marketType === 'inner'
      ? 'Pons'
      : '外盘';
    const recordConfirmedTrade = (): boolean => {
      if (!isCurrentExecution()) {
        addLog(
          task.id,
          'warning',
          `${walletAddress.slice(0, 10)}... 旧运行批次交易已确认，但任务配置/运行代次已变化；未计入当前任务统计或清仓覆盖`,
          walletAddress,
          result.txHash,
        );
        return false;
      }
      if (tradeDirection === 'buy') task.stats.buyCount++;
      else task.stats.sellCount++;
      if (tradeDirection === 'buy') task.stats.spentAmount += amount;
      recordMixedDirectionSuccess(
        task,
        walletAddress,
        tradeDirection,
        executionGeneration,
      );

      const actionText = tradeDirection === 'buy' ? '买入' : '卖出';
      const resultText = result.amountOut
        ? `[${tradeSourceText}] ${actionText}确认成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
        : `[${tradeSourceText}] ${actionText}确认成功，金额: ${amount} ${amountUnit}`;
      addLog(task.id, 'success', resultText, walletAddress, result.txHash);
      scheduleStatsSync(task.id);
      if (
        !isPureSellAllTask(task)
        && (task.config.stopType === 'count' || task.config.stopType === 'amount')
        && checkStopCondition(task)
        && task.status === 'running'
      ) {
        stopTask(task.id, '已达到链上确认的停止条件');
      }
      return true;
    };

    if (
      tradeDirection === 'sell'
      && !pureSellCoverageSnapshot
      && result.code === ZERO_TOKEN_BALANCE_CODE
    ) {
      // This sell slot did not produce a real sell. Keep a bounded directional
      // debt so a finite mixed task cannot fill its remaining count entirely
      // with buys; the debt is used only once a confirmed buyer is available.
      broadcastParticipant?.skip();
      if (isCurrentExecution()) {
        recordMixedSellDeficit(task, walletAddress, executionGeneration);
      }
      addLog(
        task.id,
        'warning',
        `${walletAddress.slice(0, 10)}... 当前代币余额为 0，本轮未产生卖出；后续轮次优先使用已确认买入的钱包补足卖出方向`,
        walletAddress,
      );
      return false;
    }

    if (
      tradeDirection === 'sell'
      && pureSellCoverageSnapshot
      && result.code === ZERO_TOKEN_BALANCE_CODE
    ) {
      // TradingService reads balance before it reserves/checks the wallet
      // nonce. Reconcile in the safe order here: pending/latest nonce first,
      // then a fresh token balance while the same wallet lease is still held.
      // Otherwise a buy broadcast by a crashed page can confirm immediately
      // after the stale zero read and leave this wallet falsely "cleared".
      broadcastParticipant?.skip();
      if (!isCurrentExecution()) return false;

      const blockedPredecessor = await findBlockedUnresolvedWallet(
        task,
        [walletAddress],
        true,
        effectiveRpcUrl,
      );
      if (!isCurrentExecution()) return false;
      if (blockedPredecessor) {
        if (blockedPredecessor.code === WALLET_PENDING_PREDECESSOR_CODE) {
          markTaskUnresolvedTransaction(
            task,
            walletAddress,
            'pending',
            undefined,
            effectiveRpcUrl,
            false,
            chainId,
          );
        }
        const unresolved = getUnresolvedTransaction(chainId, walletAddress);
        if (unresolved) {
          retainLeasesUntilUnresolvedSettles(
            task,
            walletAddress,
            unresolved.rpcUrl,
            unresolved.txHash,
            walletLeaseGuard,
            'wallet',
            chainId,
          );
        }
        addLog(
          task.id,
          'warning',
          `${walletAddress.slice(0, 10)}... 当前余额为 0，但钱包仍有未决前序交易或 nonce 无法权威核对；未计为清仓完成`,
          walletAddress,
        );
        return false;
      }

      return reconcilePureSellWalletBalance(
        task,
        walletAddress,
        resolvedTokenAddress,
        tradingService,
        pureSellCoverageSnapshot,
        executionGeneration,
      );
    }

    if (result.status === 'broadcast') {
      if (!result.txHash || !result.settlement || !leaseGuard?.retainUntil) {
        // A known-hash background result without a settlement/lease retention
        // path would allow the same nonce wallet to be reused unsafely.  Treat
        // this impossible contract violation as unresolved and stop fail-closed.
        markTaskUnresolvedTransaction(
          task,
          walletAddress,
          'unknown',
          result.txHash,
          effectiveRpcUrl,
          !!result.txHash,
          chainId,
        );
        if (!isCurrentExecution()) {
          addLog(
            task.id,
            'warning',
            `[${tradeSourceText}] 旧运行批次返回了缺少确认守卫的广播结果；已保护原链钱包，但未暂停当前新运行`,
            walletAddress,
            result.txHash,
          );
          return false;
        }
        addLog(task.id, 'error', `[${tradeSourceText}] 广播结果缺少后台确认守卫，任务已暂停`, walletAddress, result.txHash);
        if (task.status === 'running') pauseTask(task.id);
        return false;
      }

      // Count reservations include either direction, but an amount stop is a
      // spend budget and therefore reserves only pending buys. A pending sell
      // must not temporarily consume the remaining buy budget.
      const pendingSpendAmount = tradeDirection === 'buy' ? amount : 0;
      if (tradeDirection === 'buy' && isCurrentExecution()) {
        recordMixedBuyInFlight(task, walletAddress, executionGeneration);
      }
      addPendingTaskTrade(task.id, pendingSpendAmount, executionGeneration);
      const completion = result.settlement.then(async finality => {
        if (finality.status === 'confirmed') {
          const recordedForCurrentRun = recordConfirmedTrade();
          if (recordedForCurrentRun && sellAllForExecution) {
            await reconcilePureSellWalletBalance(
              task,
              walletAddress,
              resolvedTokenAddress,
              tradingService,
              pureSellCoverageSnapshot,
              executionGeneration,
            );
          }
          return;
        }
        if (finality.status === 'failed') {
          addLog(
            task.id,
            'error',
            `[${tradeSourceText}] 交易已上链但执行回滚: ${finality.error || '链上回滚'}`,
            walletAddress,
            result.txHash,
          );
          return;
        }

        markTaskUnresolvedTransaction(
          task,
          walletAddress,
          finality.status,
          result.txHash,
          effectiveRpcUrl,
          true,
          chainId,
        );
        addLog(
          task.id,
          'warning',
          `[${tradeSourceText}] 已广播交易暂时无法确认；只保护该钱包并后台只读对账，其他钱包继续`,
          walletAddress,
          result.txHash,
        );
        await monitorUnresolvedTransaction(
          task,
          walletAddress,
          effectiveRpcUrl,
          result.txHash,
          chainId,
        );
      }).catch(async error => {
        markTaskUnresolvedTransaction(
          task,
          walletAddress,
          'unknown',
          result.txHash,
          effectiveRpcUrl,
          true,
          chainId,
        );
        addLog(
          task.id,
          'warning',
          `[${tradeSourceText}] 后台确认异常；只保护该钱包并进入只读对账，其他钱包继续: ${error?.message || '未知错误'}`,
          walletAddress,
          result.txHash,
        );
        await monitorUnresolvedTransaction(
          task,
          walletAddress,
          effectiveRpcUrl,
          result.txHash,
          chainId,
        );
      }).finally(() => {
        if (tradeDirection === 'buy') {
          clearMixedBuyInFlight(task, walletAddress, executionGeneration);
        }
        removePendingTaskTrade(task.id, pendingSpendAmount, executionGeneration);
        scheduleStatsSync(task.id);
      });

      // The RPC-accepted nonce/hash was committed while the short wallet lease
      // was still held. Release that lease now so another running task can
      // reserve the next nonce; finality remains a read-only background job.
      // Unknown/hashless submissions still use the fail-closed retention path
      // below and therefore cannot open a nonce hole.
      return true;
    }

    if (result.status === 'pending' || result.status === 'unknown') {
      markTaskUnresolvedTransaction(
        task,
        walletAddress,
        result.status,
        result.txHash,
        effectiveRpcUrl,
        false,
        chainId,
      );
      retainLeasesUntilUnresolvedSettles(
        task,
        walletAddress,
        effectiveRpcUrl,
        result.txHash,
        result.transactionKind === 'approval' ? walletLeaseGuard : leaseGuard,
        'wallet',
        chainId,
      );
      addLog(
        task.id,
        'warning',
        result.code === WALLET_PENDING_PREDECESSOR_CODE
          ? `[${tradeSourceText}] 检测到链上待确认前序交易，本轮未广播新交易；只跳过该钱包，其他钱包继续`
          : `[${tradeSourceText}] 交易已广播但${result.status === 'pending' ? '仍在等待确认' : '状态未知'}；只保护该钱包且不会重发，其他钱包继续`,
        walletAddress,
        result.txHash,
      );
      return false;
    } else if (result.success) {
      const recordedForCurrentRun = recordConfirmedTrade();
      if (recordedForCurrentRun && sellAllForExecution) {
        await reconcilePureSellWalletBalance(
          task,
          walletAddress,
          resolvedTokenAddress,
          tradingService,
          pureSellCoverageSnapshot,
          executionGeneration,
        );
      }
      return true;
    } else {
      addLog(task.id, 'error', `[${tradeSourceText}] 交易失败: ${result.error}`, walletAddress, result.txHash);
      return false;
    }
  }

  // 获取当前池子市值（BNB）
  async function getCurrentMarketCap(task: Task): Promise<number | undefined> {
    try {
      const dexStore = useDexStore();

      const chainId = task.config.chainId;
      const rpcUrl = defaultRpcForChain(chainId);
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
  async function executeRound(
    task: Task,
    broadcastRegistration?: RobinhoodTaskBroadcastRegistration,
    executionGeneration = currentTaskExecutionGeneration(task.id),
  ): Promise<void> {
    const isCurrentExecution = () => isTaskExecutionCurrent(task, executionGeneration);
    if (!isCurrentExecution()) return;

    // Count/amount/time conditions use confirmed statistics only. Check them
    // before admitting a new round as well as after settlement, so a resumed
    // task cannot submit one extra cohort from already-persisted statistics.
    if (
      task.config.stopType !== 'price'
      && task.config.stopType !== 'marketcap'
      && checkStopCondition(task)
    ) {
      stopTask(task.id, '已达到停止条件');
      return;
    }

    // DEX/Pons 任务在发单前检查价格类停止条件；FourMeme 内盘没有可比 DEX 池。
    if (!isFourMemeTask(task) && (task.config.stopType === 'price' || task.config.stopType === 'marketcap')) {
      const currentPrice = task.config.stopType === 'price' ? await getCurrentPrice(task) : undefined;
      const currentMarketCap = task.config.stopType === 'marketcap' ? await getCurrentMarketCap(task) : undefined;
      if (!isCurrentExecution()) return;
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

    if (await finishPureSellCoverageIfComplete(task)) return;
    if (stopBudgetReserved(task)) {
      // Hashes already accepted by the RPC reserve the remaining finite budget.
      // Keep the task running until settlement decides whether those
      // reservations become confirmed successes or return to the scheduler.
      return;
    }

    // 线程代表“同时参与本轮的不同钱包”。旧逻辑在线程数大于钱包数时会
    // 通过取模把同一个地址重复塞进一轮，随后又被 nonce 锁串行，表面上
    // 就变成了“5 线程但几秒一单”。这里先按地址去重并限制并行度。
    const coverage = pureSellCoverageFor(task);
    const selectionTime = Date.now();
    const coverageCandidates = coverage
      ? coverage.orderedWallets.filter(
          address => {
            const key = address.toLowerCase();
            return !coverage.clearedWalletKeys.has(key)
              && (coverage.retryAfterByWallet.get(key) || 0) <= selectionTime;
          },
        )
      : uniqueTaskWallets(task);
    const wallets = coverageCandidates.filter(
      address => !getUnresolvedTransaction(task.config.chainId, address),
    );
    const buyThreadCount = task.config.buyThreadCount || 0;
    const sellThreadCount = task.config.sellThreadCount || 0;

    if (wallets.length === 0) {
      // A background reconciliation loop will clear terminal records. Keep
      // the task alive so the next scheduler tick can reuse those wallets;
      // do not flood the log on every one-second tick while all are pending.
      if (task.walletAddresses.length === 0) addLog(task.id, 'warning', '没有钱包参与交易');
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

    // Prefer wallets that are immediately free. If every Robinhood wallet is
    // already in another task's short critical section, queue this one round
    // behind that section instead of starving a same-wallet task until its
    // configured interval elapses. The per-task active-round fence below
    // prevents duplicate queued rounds.
    const reservedThisRound = new Set<string>();
    const currentlyFreeWalletCount = wallets.filter(walletAddress => {
      const leaseKey = taskWalletLeaseKey(task.config.chainId, walletAddress);
      return !taskWalletOperationLocks.has(leaseKey)
        && !activeBatchSellWalletKeys.has(leaseKey);
    }).length;
    const queueSharedRobinhoodWallets = (
      task.config.chainId === 4663
      && currentlyFreeWalletCount === 0
    );
    const robinhoodDirectionCapacity = queueSharedRobinhoodWallets
      ? wallets.filter(walletAddress => (
          !activeBatchSellWalletKeys.has(
            taskWalletLeaseKey(task.config.chainId, walletAddress),
          )
        )).length
      : currentlyFreeWalletCount;

    const remainingCountSlots = remainingCountAdmissionSlots(task);
    const directionCapacity = task.config.chainId === 4663
      ? Math.min(
          robinhoodDirectionCapacity,
          remainingCountSlots ?? Number.POSITIVE_INFINITY,
        )
      : Math.min(
          buyThreadCount + sellThreadCount,
          remainingCountSlots ?? Number.POSITIVE_INFINITY,
        );
    const directionStartOffset = mixedDirectionOffsets.get(task.id) ?? 0;
    const baseDirectionAllocation = allocateRobinhoodTaskDirections(
      buyThreadCount,
      sellThreadCount,
      directionCapacity,
      directionStartOffset,
    );
    // Robinhood reserves recovery sells only after the remotely acquired
    // wallet cohort is known. Reserving during this preliminary selection
    // would either double-reserve on the post-acquisition allocation or strand
    // debt behind a remotely busy wallet.
    const directionAllocation = task.config.chainId === 4663
      ? { ...baseDirectionAllocation, recoverySellCount: 0 }
      : applyMixedSellDeficit(task, baseDirectionAllocation, executionGeneration);
    // Robinhood performs the final direction allocation only after remote
    // wallet leases are known. Advancing here would count a remotely-busy sell
    // slot as executed and could turn a finite 3:1 task into buy-only.
    if (task.config.chainId !== 4663) {
      mixedDirectionOffsets.set(task.id, directionAllocation.nextOffset);
    }

    const selectAvailableWallets = (
      requested: number,
      startIndex: number,
      preferredWalletKeys?: Set<string>,
    ): { selected: string[]; nextIndex: number } => {
      const available: Array<{
        walletAddress: string;
        normalized: string;
        index: number;
      }> = [];
      let cursor = startIndex % wallets.length;
      let scanned = 0;
      const robinhoodFixedRate = task.config.chainId === 4663;
      while (scanned < wallets.length) {
        const walletAddress = wallets[cursor];
        const normalized = walletAddress.toLowerCase();
        const leaseKey = taskWalletLeaseKey(task.config.chainId, walletAddress);
        const unavailable = (
          activeBatchSellWalletKeys.has(leaseKey)
          || (
            !queueSharedRobinhoodWallets
            && taskWalletOperationLocks.has(leaseKey)
          )
          || (robinhoodFixedRate && reservedThisRound.has(normalized))
        );
        if (!unavailable) {
          available.push({ walletAddress, normalized, index: cursor });
        }
        cursor = (cursor + 1) % wallets.length;
        scanned++;
      }
      const preferred = preferredWalletKeys
        ? available.filter(candidate => preferredWalletKeys.has(candidate.normalized))
        : [];
      const fallback = preferredWalletKeys
        ? available.filter(candidate => !preferredWalletKeys.has(candidate.normalized))
        : available;
      const selectedEntries = [...preferred, ...fallback].slice(0, requested);
      if (robinhoodFixedRate) {
        for (const selected of selectedEntries) {
          reservedThisRound.add(selected.normalized);
        }
      }
      return {
        selected: selectedEntries.map(candidate => candidate.walletAddress),
        nextIndex: selectedEntries.length > 0
          ? (selectedEntries[selectedEntries.length - 1].index + 1) % wallets.length
          : cursor,
      };
    };

    // Reserve sell wallets first. With initially empty wallets, the old
    // buy-first order made the sell cursor perpetually chase untouched wallets.
    // Confirmed buyers are preferred, so the next round can actually sell what
    // the preceding round bought instead of merely invoking a zero-balance path.
    const mixedState = mixedDirectionStates.get(task.id);
    const preferredSellWalletKeys = mixedState?.generation === executionGeneration
      ? mixedState.sellEligibleWalletKeys
      : undefined;
    const sellSelection = selectAvailableWallets(
      Math.min(directionAllocation.sellCount, wallets.length),
      task.currentSellWalletIndex,
      preferredSellWalletKeys,
    );
    const sellWallets = sellSelection.selected;
    task.currentSellWalletIndex = sellSelection.nextIndex;

    const buySelection = selectAvailableWallets(
      Math.min(directionAllocation.buyCount, wallets.length),
      task.currentBuyWalletIndex,
    );
    const buyWallets = buySelection.selected;
    task.currentBuyWalletIndex = buySelection.nextIndex;

    if (buyWallets.length === 0 && sellWallets.length === 0) {
      // All wallets are still protected by a known in-flight write.  This is a
      // normal scheduler tick, not an error and not a reason to pause/retry a
      // transaction.  The next fixed-rate tick will check availability again.
      return;
    }

    // Group participants by the exact RPC that will broadcast their direction.
    // The task runtime performs this once before wallet approval/trade writes
    // in the round; it does not serialize the token market.
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

    const runRoundPreflight = async (operationGuard: TransferLeaseGuard): Promise<Set<string>> => {
      const blockedWalletKeys = new Set<string>();
      for (const [rpcUrl, group] of preflightGroups) {
        operationGuard.assertActive();
        // A shared wallet is skipped for this round instead of making every
        // other wallet wait behind its nonce/receipt lifecycle.
        let candidates = [...group.values()].filter(walletAddress => {
          const key = taskWalletLeaseKey(task.config.chainId, walletAddress);
          return !taskWalletOperationLocks.has(key) && !activeBatchSellWalletKeys.has(key);
        });
        while (candidates.length > 0) {
          const blockedWallet = await findBlockedUnresolvedWallet(
            task,
            candidates,
            true,
            rpcUrl,
          );
          operationGuard.assertActive();
          if (!blockedWallet) break;

          const walletKey = blockedWallet.walletAddress.toLowerCase();
          blockedWalletKeys.add(walletKey);
          candidates = candidates.filter(address => address.toLowerCase() !== walletKey);

          if (blockedWallet.code === WALLET_PENDING_PREDECESSOR_CODE) {
            await withTaskWalletLease(
              task.config.chainId,
              blockedWallet.walletAddress,
              async walletLeaseGuard => {
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
                  walletLeaseGuard,
                  'wallet',
                );
              },
            );
            operationGuard.assertActive();
          }

          addLog(
            task.id,
            'warning',
            `${blockedWallet.walletAddress.slice(0, 10)}... ${blockedWallet.message}；本轮只跳过该钱包，其他钱包继续`,
            blockedWallet.walletAddress,
            blockedWallet.txHash,
          );
        }
      }
      return blockedWalletKeys;
    };

    const tokenAddress = taskTokenAddress(task);
    if (!tokenAddress) {
      addLog(task.id, 'error', '未设置代币合约地址');
      return;
    }

    // 外盘同一任务复用 TradingService。Robinhood 的买卖 RPC 相同，因此
    // 五个钱包会共享同一份池校验/metadata promise，而不是各自冷启动。
    const outerTradingServices: Partial<Record<'buy' | 'sell', ReturnType<typeof createTradingService>>> = {};
    if (!isFourMemeTask(task)) {
      const dexStore = useDexStore();
      const taskDex = dexStore.dexConfigs.find(
        dex => dex.id === task.config.dexId && dex.chainId === task.config.chainId,
      );
      const routerAddress = taskDex?.routerAddress || '';
      if (routerAddress && routerAddress !== '0x0000000000000000000000000000000000000000') {
        if (buyWallets.length > 0) {
          outerTradingServices.buy = getOrCreateTradingService(
            task,
            getTaskExecutionRpc(task, 'buy'),
            routerAddress,
          );
        }
        if (sellWallets.length > 0) {
          outerTradingServices.sell = getOrCreateTradingService(
            task,
            getTaskExecutionRpc(task, 'sell'),
            routerAddress,
          );
        }
      }
    }

    // 自动任务之间不再按“链 + 代币”锁住整个市场。AMM 本身允许不同钱包
    // 同时交易同一代币，市场级互斥会让第二个任务在第一个任务等待回执时
    // 无谓排队，跨页面时甚至直接被 MARKET_LEASE_BUSY 暂停。
    //
    // nonce 安全仍由 withTaskWalletLease / 服务端 TransferLease 按源钱包保证：
    // 不同钱包可真正并行；两个任务复用同一钱包时，只串行该钱包的交易。
    const automaticRoundGuard = combineLeaseGuards(
      runtimeGuardForTask(task),
      {
        assertActive() {
          if (!isCurrentExecution()) throw new TaskRoundCancelledError();
        },
      },
    )!;
    await (async (operationGuard: TransferLeaseGuard) => {
      operationGuard.assertActive();
      // Robinhood TradingService performs an authoritative latest/pending
      // nonce check immediately before every write while holding the wallet
      // lease.  Repeating the same two reads for every wallet here doubled the
      // RPC load and, for 30 wallets, introduced six serialized preflight
      // waves before the first broadcast.  Other chains keep the legacy round
      // guard until their execution paths are migrated independently.
      const blockedRoundWallets = task.config.chainId !== 4663
        ? await runRoundPreflight(operationGuard)
        : new Set<string>();
      operationGuard.assertActive();
      const executableBuyWallets = buyWallets.filter(
        address => !blockedRoundWallets.has(address.toLowerCase()),
      );
      const executableSellWallets = sellWallets.filter(
        address => !blockedRoundWallets.has(address.toLowerCase()),
      );
      if (executableBuyWallets.length === 0 && executableSellWallets.length === 0) return;

      // Pons 发射台状态是整轮不变量，只读一次即可。旧实现每个钱包在发单前
      // 都重复读取，进一步拉长了 Robinhood 多线程任务的启动时间。
      if (task.config.chainId === 4663 && task.config.marketType === 'inner') {
        operationGuard.assertActive();
        const validationRpc = getTaskExecutionRpc(task, executableBuyWallets.length > 0 ? 'buy' : 'sell');
        await validatePonsTaskOnce(task, tokenAddress, validationRpc);
        operationGuard.assertActive();
      }

      // ===== ASTER 池内盘快速路径（两阶段执行） =====
      const isAsterInner = isFourMemeTask(task) && !!task.config.poolBaseToken && task.preApprovalDone;
      if (isAsterInner && sharedFourMemeService) {
        const allWallets = [...new Set([...executableBuyWallets, ...executableSellWallets])];
        addLog(task.id, 'info', `[快速路径] 批量预取数据，钱包数: ${allWallets.length}`);

        const baseTokenAddress = task.config.poolBaseToken!;
        const [prefetchData] = await Promise.all([
          sharedFourMemeService.batchPrepareRound({
            tokenAddress,
            baseTokenAddress,
            buyWalletAddresses: executableBuyWallets,
            sellWalletAddresses: executableSellWallets,
          }),
          sharedFourMemeService.warmupTradeRpc(),
        ]);
        operationGuard.assertActive();

        const allPromises: Promise<boolean>[] = [];
        if (executableBuyWallets.length > 0) {
          addLog(task.id, 'info', `买入: ${executableBuyWallets.length} 个钱包 [快速并发]`);
          for (const addr of executableBuyWallets) {
            allPromises.push(executeWalletTradeFast(
              task,
              addr,
              'buy',
              operationGuard,
              isCurrentExecution,
              sharedFourMemeService,
              prefetchData.get(addr.toLowerCase()),
            ));
          }
        }
        if (executableSellWallets.length > 0) {
          addLog(task.id, 'info', `卖出: ${executableSellWallets.length} 个钱包 [快速并发]`);
          for (const addr of executableSellWallets) {
            allPromises.push(executeWalletTradeFast(
              task,
              addr,
              'sell',
              operationGuard,
              isCurrentExecution,
              sharedFourMemeService,
              prefetchData.get(addr.toLowerCase()),
            ));
          }
        }
        await Promise.allSettled(allPromises);
        return;
      }

      // Robinhood prepares one server-side lease batch for the whole task
      // round, then holds every prepared buy/sell at a two-phase task cohort.
      // Concurrently started tasks contribute to one shared JSON-RPC submit,
      // so neither direction can leak into separate sequencer waves.
      if (task.config.chainId === 4663) {
        const roundWallets = [...new Map(
          [...executableBuyWallets, ...executableSellWallets]
            .map(address => [address.toLowerCase(), address] as const),
        ).values()];
        const roundRecoverySellWallets = new Set<string>();

        try {
          await withAvailableTaskWalletLeases(
            task.config.chainId,
            roundWallets,
            async (walletGuards, busyWalletAddresses) => {
            operationGuard.assertActive();
            if (busyWalletAddresses.length > 0) {
              const preview = busyWalletAddresses
                .slice(0, 3)
                .map(address => `${address.slice(0, 10)}...`)
                .join('、');
              addLog(
                task.id,
                'warning',
                `本轮跳过 ${busyWalletAddresses.length} 个正被其他任务使用的钱包（${preview}${busyWalletAddresses.length > 3 ? ' 等' : ''}）；其余空闲钱包继续，忙钱包后续轮次自动重试`,
              );
            }

            const acquiredRoundWallets = roundWallets.filter(
              address => walletGuards.has(address.toLowerCase()),
            );
            const acquiredDirectionAllocation = applyMixedSellDeficit(
              task,
              allocateRobinhoodTaskDirections(
                buyThreadCount,
                sellThreadCount,
                acquiredRoundWallets.length,
                directionStartOffset,
              ),
              executionGeneration,
            );
            mixedDirectionOffsets.set(
              task.id,
              acquiredDirectionAllocation.nextOffset,
            );
            const acquiredKeys = new Set(
              acquiredRoundWallets.map(address => address.toLowerCase()),
            );
            const uniqueInOrder = (addresses: string[]): string[] => [...new Map(
              addresses
                .filter(address => acquiredKeys.has(address.toLowerCase()))
                .map(address => [address.toLowerCase(), address] as const),
            ).values()];
            const eligibleAcquiredSellers = acquiredRoundWallets.filter(
              address => preferredSellWalletKeys?.has(address.toLowerCase()),
            );
            const sellPriority = uniqueInOrder([
              ...sellWallets,
              ...eligibleAcquiredSellers,
              ...acquiredRoundWallets,
            ]);
            const acquiredSellWallets = sellPriority.slice(
              0,
              acquiredDirectionAllocation.sellCount,
            );
            const recoverySellWallets = acquiredSellWallets.slice(
              Math.max(
                0,
                acquiredSellWallets.length - acquiredDirectionAllocation.recoverySellCount,
              ),
            );
            for (const walletAddress of recoverySellWallets) {
              if (reserveMixedRecoverySell(task, walletAddress, executionGeneration)) {
                roundRecoverySellWallets.add(walletAddress);
              }
            }
            const acquiredSellKeys = new Set(
              acquiredSellWallets.map(address => address.toLowerCase()),
            );
            const buyPriority = uniqueInOrder([
              ...buyWallets,
              ...acquiredRoundWallets,
            ]).filter(address => !acquiredSellKeys.has(address.toLowerCase()));
            const acquiredBuyWallets = buyPriority.slice(
              0,
              acquiredDirectionAllocation.buyCount,
            );
            if (acquiredRoundWallets.length === 0) {
              broadcastRegistration?.fail();
              return;
            }

            const broadcastBarrier = acquiredRoundWallets.length > 0
              ? new RobinhoodSellBroadcastBarrier(
                  acquiredRoundWallets.length,
                  broadcastRegistration,
                  {
                    abortOnParticipantFailure: isPureSellAllTask(task),
                    preparationTimeoutMs: isPureSellAllTask(task)
                      ? Math.min(120_000, Math.max(30_000, acquiredRoundWallets.length * 3_000))
                      : undefined,
                    onParticipantFailure: isPureSellAllTask(task)
                      ? participantId => recordPureSellPreparationFailure(
                          task,
                          participantId,
                          coverage,
                        )
                      : undefined,
                  },
                )
              : undefined;
            const broadcastParticipants = new Map<string, RobinhoodSellBroadcastParticipant>();
            if (broadcastBarrier) {
              for (const address of acquiredRoundWallets) {
                broadcastParticipants.set(
                  address.toLowerCase(),
                  broadcastBarrier.createParticipant(address),
                );
              }
            }

            const allPromises: Promise<boolean>[] = [];
            for (const address of acquiredBuyWallets) {
              recordMixedBuyPreparing(task, address, executionGeneration);
              allPromises.push(
                executeWalletTrade(
                  task,
                  address,
                  'buy',
                  operationGuard,
                  isCurrentExecution,
                  sharedFourMemeService,
                  outerTradingServices.buy,
                  broadcastParticipants.get(address.toLowerCase()),
                  walletGuards.get(address.toLowerCase()),
                ).finally(() => {
                  clearMixedBuyPreparing(task, address, executionGeneration);
                }),
              );
            }
            for (const address of acquiredSellWallets) {
              allPromises.push(executeWalletTrade(
                task,
                address,
                'sell',
                operationGuard,
                isCurrentExecution,
                sharedFourMemeService,
                outerTradingServices.sell,
                broadcastParticipants.get(address.toLowerCase()),
                walletGuards.get(address.toLowerCase()),
              ));
            }
              await Promise.allSettled(allPromises);
            },
            () => isCurrentExecution(),
            address => !activeBatchSellWalletKeys.has(
              taskWalletLeaseKey(task.config.chainId, address),
            ),
          );
        } catch (error) {
          broadcastRegistration?.fail();
          if (!(error instanceof TaskRoundCancelledError)) throw error;
        } finally {
          // withAvailableTaskWalletLeases does not return until every retained
          // unresolved wallet lease has settled. Keeping the recovery
          // reservation until this point prevents later overlapping ticks from
          // shifting another buy slot for the same outstanding sell debt.
          for (const walletAddress of roundRecoverySellWallets) {
            releaseMixedRecoverySell(task, walletAddress, executionGeneration);
          }
        }
        return;
      }

      // ===== 非 ASTER 池 / 外盘 / 预授权未完成 =====
      const allPromises: Promise<boolean>[] = [];
      if (executableBuyWallets.length > 0) {
        addLog(task.id, 'info', `买入: ${executableBuyWallets.length} 个钱包 [并发]`);
        for (const addr of executableBuyWallets) {
          allPromises.push(executeWalletTrade(
            task,
            addr,
            'buy',
            operationGuard,
            isCurrentExecution,
            sharedFourMemeService,
            outerTradingServices.buy,
          ));
        }
      }
      if (executableSellWallets.length > 0) {
        addLog(task.id, 'info', `卖出: ${executableSellWallets.length} 个钱包 [并发]`);
        for (const addr of executableSellWallets) {
          allPromises.push(executeWalletTrade(
            task,
            addr,
            'sell',
            operationGuard,
            isCurrentExecution,
            sharedFourMemeService,
            outerTradingServices.sell,
          ));
        }
      }
      await Promise.allSettled(allPromises);
    })(automaticRoundGuard);

    // A sell settlement may finish the pure-sell coverage and stop the task
    // while the rest of this round is unwinding. Avoid duplicate stop logs and
    // price/stat reads after that terminal transition.
    if (!isCurrentExecution()) return;

    // 执行后检查停止条件（内盘模式不检查市值，因为没有 DEX 交易对）
    if (!isFourMemeTask(task)) {
      const currentPrice = task.config.stopType === 'price' ? await getCurrentPrice(task) : undefined;
      const currentMarketCap = task.config.stopType === 'marketcap' ? await getCurrentMarketCap(task) : undefined;
      if (!isCurrentExecution()) return;
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
    if (isCurrentExecution()) scheduleStatsSync(task.id);
  }

  // 开始任务
  async function startTask(taskId: string): Promise<boolean> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;
    if (task.status === 'running') return false;

    const tokenAddress = taskTokenAddress(task);
    if (activeBatchSellTaskIds.has(taskId)) {
      addLog(task.id, 'warning', '该任务正在执行手工批量卖出，完成前不能重复启动同一个任务');
      return false;
    }

    if (task.walletAddresses.length === 0) {
      addLog(task.id, 'error', '没有选中任何钱包，无法开始任务');
      return false;
    }

    if (startingTaskIds.has(taskId)) {
      addLog(task.id, 'warning', '任务正在启动校验中，已忽略重复启动请求');
      return false;
    }
    startingTaskIds.add(taskId);
    const startRequestGeneration = currentTaskExecutionGeneration(taskId);
    const startRequestStatus = task.status;

    // Register before the first await. Concurrent startTask calls therefore
    // join the same cohort even when one task's runtime/allowance preparation
    // finishes seconds later than another task.
    // Pure sell-all uses its own fail-closed wallet barrier and an adaptive
    // preparation window. The cross-task registration cohort has a fixed
    // 30-second deadline, so routing a large clear-all batch through it would
    // negate that adaptive window. Successful pure-sell barriers still join
    // the shared broadcast wave directly.
    //
    // A task that overlaps an already starting/running task on the same wallet
    // must not join that task's first-round cohort: the wallet queue is
    // intentionally serial, so making the first holder wait for the queued
    // holder would deadlock the cohort. It still joins the ordinary short
    // broadcast wave after it acquires the wallet.
    const taskWalletKeys = new Set(
      task.walletAddresses.map(address => taskWalletLeaseKey(task.config.chainId, address)),
    );
    const overlapsActiveTaskWallet = tasks.value.some(candidate => (
      candidate.id !== task.id
      && candidate.config.chainId === task.config.chainId
      && (candidate.status === 'running' || startingTaskIds.has(candidate.id))
      && candidate.walletAddresses.some(
        address => taskWalletKeys.has(taskWalletLeaseKey(candidate.config.chainId, address)),
      )
    ));
    let firstRoundBroadcastRegistration: RobinhoodTaskBroadcastRegistration | undefined;
    try {
      firstRoundBroadcastRegistration = (
        task.config.chainId === 4663
        && !isPureSellAllTask(task)
        && !overlapsActiveTaskWallet
      )
        ? registerRobinhoodTaskBroadcastCohort(getRuntimeRobinhoodRpcUrl())
        : undefined;
    } catch (error: any) {
      startingTaskIds.delete(taskId);
      addLog(task.id, 'error', `首轮广播协调失败，任务未启动: ${error?.message || '未知错误'}`);
      return false;
    }

    let startRuntimeGuard: TaskRuntimeGuard;
    try {
      startRuntimeGuard = await acquireTaskRuntime(task, {
        forceTakeover: true,
        shouldContinue: () => (
          startingTaskIds.has(taskId)
          && currentTaskExecutionGeneration(taskId) === startRequestGeneration
          && tasks.value.find(candidate => candidate.id === taskId) === task
          && task.status === startRequestStatus
        ),
      });
    } catch (error: any) {
      startingTaskIds.delete(taskId);
      firstRoundBroadcastRegistration?.fail();
      addLog(task.id, 'error', `无法取得任务运行权，未启动任何交易: ${error?.message || '未知错误'}`);
      return false;
    }
    if (
      currentTaskExecutionGeneration(taskId) !== startRequestGeneration
      || tasks.value.find(candidate => candidate.id === taskId) !== task
      || task.status !== startRequestStatus
    ) {
      firstRoundBroadcastRegistration?.fail();
      await revokeTaskRuntime(taskId, '启动期间任务配置或状态已变化', {
        broadcast: false,
        expectedState: startRuntimeGuard.runtimeState,
      });
      startingTaskIds.delete(taskId);
      return false;
    }

    try {
      // acquireTaskRuntime may have reused a background-preparation state.
      // Revalidate that exact state immediately before the synchronous handoff
      // to `running`, so a completed background cleanup cannot leave a newly
      // started task holding a dead guard.
      startRuntimeGuard.assertActive();
    } catch (error: any) {
      firstRoundBroadcastRegistration?.fail();
      startingTaskIds.delete(taskId);
      addLog(task.id, 'error', `任务运行权在启动交接期间失效，未启动任何交易: ${error?.message || '未知错误'}`);
      return false;
    }

    // 取得服务端运行权后再切换 UI。若其他任务正在使用同一钱包，当前
    // 任务只跳过该钱包并继续使用其余钱包，不影响同代币的不同钱包任务。
    const executionGeneration = advanceTaskExecutionGeneration(task.id);
    task.status = 'running';
    startingTaskIds.delete(taskId);
    task.stats.startTime = Date.now();
    task.currentBuyWalletIndex = 0;
    task.currentSellWalletIndex = 0;
    mixedDirectionOffsets.set(task.id, 0);
    mixedDirectionStates.set(task.id, {
      generation: executionGeneration,
      sellDeficit: 0,
      sellEligibleWalletKeys: new Set<string>(),
      buyPreparingWalletKeys: new Set<string>(),
      buyInFlightWalletKeys: new Set<string>(),
      recoverySellReservedWalletKeys: new Set<string>(),
    });
    const startupCoverage = resetPureSellCoverage(task);
    const isCurrentStart = () => isTaskExecutionCurrent(task, executionGeneration);

    const buyThreadCount = task.config.buyThreadCount || 0;
    const sellThreadCount = task.config.sellThreadCount || 0;
    addLog(task.id, 'info', `任务开始执行，间隔: ${task.config.interval}秒，买${buyThreadCount}/卖${sellThreadCount}，钱包数: ${task.walletAddresses.length}`);
    const uniqueWalletCount = new Set(task.walletAddresses.map(address => address.toLowerCase())).size;
    if (sellThreadCount > uniqueWalletCount) {
      addLog(
        task.id,
        'warning',
        `卖出线程数为 ${sellThreadCount}，但仅有 ${uniqueWalletCount} 个唯一钱包；同一秒最多只能安全广播 ${uniqueWalletCount} 笔卖出。若要达到 ${sellThreadCount} 笔，需要至少 ${sellThreadCount} 个不同钱包`,
      );
    }

    const queuedWalletOperationCount = activeLocalWalletOperations(
      task.config.chainId,
      task.walletAddresses,
    ).length;
    if (queuedWalletOperationCount > 0) {
      addLog(
        task.id,
        'info',
        `检测到 ${queuedWalletOperationCount} 个共用钱包正在执行其他任务；当前任务将先使用其他空闲钱包，共用钱包确认后自动恢复可用`,
      );
      // Every chain now skips only the retained wallet lease. Non-overlapping
      // legacy rounds remain serialized at the round scheduler level, while
      // unrelated wallets are no longer forced to wait for this one.
    }

    const startupBlockedWalletKeys = new Set<string>();
    let startupCandidates = [...new Map(
      task.walletAddresses.map(address => [address.toLowerCase(), address] as const),
    ).values()];
    while (startupCandidates.length > 0) {
      const unresolvedWallet = await findBlockedUnresolvedWallet(task, startupCandidates);
      if (!isCurrentStart()) {
        firstRoundBroadcastRegistration?.fail();
        return false;
      }
      if (!unresolvedWallet) break;
      const walletKey = unresolvedWallet.walletAddress.toLowerCase();
      if (startupBlockedWalletKeys.has(walletKey)) break;
      startupBlockedWalletKeys.add(walletKey);
      startupCandidates = startupCandidates.filter(address => address.toLowerCase() !== walletKey);
      addLog(
        task.id,
        'warning',
        `${unresolvedWallet.walletAddress.slice(0, 10)}... ${unresolvedWallet.message}；只暂时跳过该钱包，任务继续使用其他钱包`,
        unresolvedWallet.walletAddress,
        unresolvedWallet.txHash,
      );

      const record = getUnresolvedTransaction(task.config.chainId, unresolvedWallet.walletAddress);
      if (record) {
        void monitorUnresolvedTransaction(
          task,
          unresolvedWallet.walletAddress,
          record.rpcUrl,
          record.txHash,
        );
      }
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

    try {
      // Pons contract/DEX metadata is validated once at startup and then held
      // in the task-scoped cache.  A failed validation still stops before the
      // first write; successful one-second rounds do not repeat these reads.
      if (task.config.chainId === 4663 && task.config.marketType === 'inner' && tokenAddress) {
        await validatePonsTaskOnce(
          task,
          tokenAddress,
          getTaskExecutionRpc(task, buyThreadCount > 0 ? 'buy' : 'sell'),
        );
        if (!isCurrentStart()) throw new TaskRoundCancelledError();
      }

      if (task.config.chainId === 4663 && tokenAddress && sellThreadCount > 0) {
        const backgroundPreparation = robinhoodSellPreparationTracker.get(task.id);
        if (backgroundPreparation && !backgroundPreparation.completed) {
          addLog(task.id, 'info', '卖出后台预授权仍在确认，复用该任务而不重复检查或重复广播');
          await backgroundPreparation.promise;
          if (!isCurrentStart()) throw new TaskRoundCancelledError();
        }
        const sellReady = await ensureRobinhoodSellTaskReady(
          task,
          tokenAddress,
          task.walletAddresses.filter(address => !startupBlockedWalletKeys.has(address.toLowerCase())),
          {
            executionGeneration,
            expectedCoverage: startupCoverage,
          },
        );
        if (!isCurrentStart()) throw new TaskRoundCancelledError();
        if (!sellReady) {
          firstRoundBroadcastRegistration?.fail();
          addLog(task.id, 'error', '卖出授权未全部确认，任务已暂停且首轮 0 笔卖出；请先按日志处理待确认交易');
          if (task.status === 'running') pauseTask(task.id);
          return false;
        }
        if (await finishPureSellCoverageIfComplete(task, startupCoverage)) {
          firstRoundBroadcastRegistration?.fail();
          return true;
        }
      }

      // ASTER fast-path readiness is global, but an unresolved approval is
      // wallet-local. Keep the fast path disabled and let the standard path
      // continue with other wallets instead of pausing the whole task.
      if (isFourMemeTask(task) && task.config.poolBaseToken && !task.preApprovalDone) {
        const tracker = preApprovalTracker.get(taskId);
        if (tracker && !tracker.completed) {
          addLog(task.id, 'info', '等待预授权完成...');
          await Promise.race([
            tracker.promise,
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('预授权超时')), 30000)),
          ]);
          if (!isCurrentStart()) throw new TaskRoundCancelledError();
        }

        const blockedAfterPreApproval = await findBlockedUnresolvedWallet(task, task.walletAddresses);
        if (!isCurrentStart()) throw new TaskRoundCancelledError();
        if (blockedAfterPreApproval) {
          addLog(
            task.id,
            'warning',
            `${blockedAfterPreApproval.walletAddress.slice(0, 10)}... ${blockedAfterPreApproval.message}；预授权快速路径保持关闭，只跳过该钱包，其他钱包继续`,
            blockedAfterPreApproval.walletAddress,
            blockedAfterPreApproval.txHash,
          );
        }
      }
    } catch (error: any) {
      firstRoundBroadcastRegistration?.fail();
      if (!isCurrentStart() || error instanceof TaskRoundCancelledError) {
        return false;
      }
      addLog(task.id, 'error', `任务启动校验失败: ${error.message || '未知错误'}`);
      if (task.status === 'running') pauseTask(task.id);
      return false;
    }

    if (!isCurrentStart()) {
      firstRoundBroadcastRegistration?.fail();
      return false;
    }

    // Fixed-rate scheduler: schedule the next tick from this round's start,
    // not from its slowest receipt.  Robinhood + no automatic stop condition
    // may prepare other free wallets while older known-hash transactions are
    // confirming.  Finite-stop and legacy-chain tasks remain non-overlapping
    // so count/amount targets and their existing semantics stay exact.
    function scheduleNextRound(previousRoundStartedAt: number): void {
      const currentTask = tasks.value.find(t => t.id === taskId);
      if (
        !currentTask
        || currentTask !== task
        || !isTaskExecutionCurrent(currentTask, executionGeneration)
      ) return;

      const delayMs = calculateNextRoundDelayMs(
        previousRoundStartedAt,
        currentTask.config.interval,
      );

      currentTask.intervalId = globalThis.setTimeout(() => {
        const latestTask = tasks.value.find(t => t.id === taskId);
        if (
          !latestTask
          || latestTask !== task
          || !isTaskExecutionCurrent(latestTask, executionGeneration)
        ) return;
        latestTask.intervalId = undefined;

        // 更新运行时间
        if (latestTask.stats.startTime) {
          latestTask.stats.elapsedTime = Math.floor((Date.now() - latestTask.stats.startTime) / 1000);
        }

        dispatchRound(latestTask);
      }, delayMs);
    }

    function dispatchRound(
      currentTask: Task,
      suppliedRegistration?: RobinhoodTaskBroadcastRegistration,
      suppressRegistration = false,
    ): void {
      if (!isTaskExecutionCurrent(currentTask, executionGeneration)) {
        suppliedRegistration?.fail();
        return;
      }
      const roundBroadcastRegistration = (
        currentTask.config.chainId === 4663
        && !isPureSellAllTask(currentTask)
        && !suppressRegistration
      )
        ? (
            suppliedRegistration
            ?? registerRobinhoodTaskBroadcastCohort(getRuntimeRobinhoodRpcUrl())
          )
        : undefined;
      const roundStartedAt = Date.now();
      scheduleNextRound(roundStartedAt);

      // Accepted Robinhood hashes now finish the wallet critical section
      // immediately and settle in the background. There is no longer a reason
      // to overlap two preparation rounds from the same task; keeping one
      // active round also prevents a temporarily queued shared wallet from
      // accumulating duplicate future rounds.
      const allowOverlap = false;
      if (!allowOverlap && activeRoundsForTask(taskId).length > 0) {
        roundBroadcastRegistration?.fail();
        return;
      }

      void runTrackedRound(
        taskId,
        () => executeRound(
          currentTask,
          roundBroadcastRegistration,
          executionGeneration,
        ),
      ).catch((error: any) => {
        if (
          error instanceof TaskRoundCancelledError
          || !isTaskExecutionCurrent(currentTask, executionGeneration)
        ) {
          return;
        }
        if (isRecoverableWalletLeaseBusy(error)) {
          addLog(
            taskId,
            'warning',
            `本轮有钱包正在被其他任务使用，未发送该钱包交易；任务保持运行并在下一轮自动重试: ${error.message || '钱包租约繁忙'}`,
          );
          return;
        }
        addLog(taskId, 'error', `任务轮次执行异常: ${error.message || '未知错误'}`);
        if (currentTask.status === 'running') pauseTask(taskId);
      }).finally(() => {
        // Idempotent: if the round submitted a complete signed batch this is a
        // no-op; every early return/error otherwise releases the sibling tasks.
        roundBroadcastRegistration?.fail();
      });
    }

    if (task.config.chainId === 4663) {
      dispatchRound(
        task,
        firstRoundBroadcastRegistration,
        overlapsActiveTaskWallet,
      );
    } else {
      // Preserve the established first-round completion contract for BSC/OKX.
      // Their services still return only after finality and are intentionally
      // outside this Robinhood-specific migration.
      const firstRoundStartedAt = Date.now();
      try {
        await runTrackedRound(
          taskId,
          () => executeRound(task, undefined, executionGeneration),
        );
      } catch (error: any) {
        if (
          error instanceof TaskRoundCancelledError
          || !isTaskExecutionCurrent(task, executionGeneration)
        ) {
          return false;
        }
        addLog(taskId, 'error', `任务轮次执行异常: ${error.message || '未知错误'}`);
        if (task.status === 'running') pauseTask(taskId);
        return false;
      }
      if (isCurrentStart()) scheduleNextRound(firstRoundStartedAt);
    }

    return true;
  }

  // 暂停任务
  function pauseTask(taskId: string): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return false;

    task.status = 'paused';
    void revokeTaskRuntime(taskId, '任务已暂停', { forceServer: true });

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
  function stopTask(
    taskId: string,
    reason?: string,
    runtimeOptions: RevokeTaskRuntimeOptions = {},
  ): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    task.status = 'stopped';
    void revokeTaskRuntime(taskId, reason || '任务已停止', runtimeOptions);

    if (task.intervalId) {
      clearTimeout(task.intervalId);  // 使用 clearTimeout
      task.intervalId = undefined;
    }

    // 清理缓存的 FourMemeService 实例
    fourMemeServiceCache.delete(taskId);
    clearTradingServiceCache(taskId);
    // 清理预授权追踪
    invalidatePreApprovalRun(taskId);
    invalidateRobinhoodSellPreparation(taskId);

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
    advanceTaskExecutionGeneration(taskId);

    // 本地立即撤销所有后续写入，再等待服务端确认撤销，最后删除配置。
    stopTask(taskId, '任务正在删除', {
      broadcast: true,
      callServer: false,
    });
    await revokeTaskRuntime(taskId, '任务正在删除', {
      broadcast: false,
      callServer: true,
      forceServer: true,
    });

    // 同步到服务器
    if (shouldUseServerMode() && task._id) {
      try {
        await taskApi.deleteTask(task._id);
      } catch (error: any) {
        console.error('从服务器删除任务失败:', error);
        addLog(taskId, 'error', `服务端删除失败，任务保留为已停止状态: ${error?.message || '未知错误'}`);
        return false;
      }
    }

    // 清理缓存的 FourMemeService 实例
    fourMemeServiceCache.delete(taskId);
    clearTradingServiceCache(taskId);
    // 清理预授权追踪
    invalidatePreApprovalRun(taskId);
    invalidateRobinhoodSellPreparation(taskId);
    mixedDirectionOffsets.delete(taskId);
    mixedDirectionStates.delete(taskId);
    remoteRuntimeIdentityRevisions.delete(taskId);
    pureSellCoverageStates.delete(taskId);

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
      invalidateRobinhoodSellPreparation(taskId);
      fourMemeServiceCache.delete(taskId);
      clearTradingServiceCache(taskId);
      mixedDirectionOffsets.delete(taskId);
      mixedDirectionStates.delete(taskId);
      remoteRuntimeIdentityRevisions.delete(taskId);
      advanceTaskExecutionGeneration(taskId);
      pureSellCoverageStates.delete(taskId);
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
    if (tradingRuntimeChanged && task.config.chainId === 4663 && (task.config.sellThreadCount || 0) > 0) {
      preApproveRobinhoodSellWallets(task);
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
      advanceTaskExecutionGeneration(taskId);
      invalidatePreApprovalRun(taskId);
      invalidateRobinhoodSellPreparation(taskId);
      fourMemeServiceCache.delete(taskId);
      clearTradingServiceCache(taskId);
      mixedDirectionOffsets.delete(taskId);
      mixedDirectionStates.delete(taskId);
      remoteRuntimeIdentityRevisions.delete(taskId);
      pureSellCoverageStates.delete(taskId);

      task.config.tokenContract = newTokenAddress;
      task.config.innerTokenAddress = newTokenAddress;
      if (isFourMemeTask(task) && task.config.poolBaseToken) {
        preApproveWallets(task);
      }
      if (task.config.chainId === 4663 && (task.config.sellThreadCount || 0) > 0) {
        preApproveRobinhoodSellWallets(task);
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
    const taskIds = tasks.value.map(task => task.id);
    for (const taskId of taskIds) {
      advanceTaskExecutionGeneration(taskId);
      stopTask(taskId, '正在清空任务', {
        broadcast: true,
        callServer: false,
      });
    }
    await Promise.all(taskIds.map(taskId => revokeTaskRuntime(taskId, '正在清空任务', {
      broadcast: false,
      callServer: true,
      forceServer: true,
    })));

    // 同步到服务器
    if (shouldUseServerMode()) {
      try {
        await taskApi.clearAllTasks();
      } catch (error: any) {
        console.error('清空服务器任务失败:', error);
        for (const task of tasks.value) {
          addLog(task.id, 'error', `服务端清空失败，任务保留为已停止状态: ${error?.message || '未知错误'}`);
        }
        return;
      }
    }

    // 停止所有运行中的任务
    tasks.value.forEach(task => {
      if (task.intervalId) {
        clearTimeout(task.intervalId);  // 使用 clearTimeout
      }
      invalidatePreApprovalRun(task.id);
      invalidateRobinhoodSellPreparation(task.id);
      fourMemeServiceCache.delete(task.id);
      clearTradingServiceCache(task.id);
      mixedDirectionOffsets.delete(task.id);
      mixedDirectionStates.delete(task.id);
      remoteRuntimeIdentityRevisions.delete(task.id);
      pureSellCoverageStates.delete(task.id);
    });
    tasks.value = [];
    activeLogTaskId.value = null;
  }

  // 批量删除任务（一次性删除，避免多次触发Vue响应式更新导致渲染问题）
  async function deleteMultipleTasks(taskIds: string[]): Promise<number> {
    if (taskIds.length === 0) return 0;

    for (const taskId of taskIds) {
      advanceTaskExecutionGeneration(taskId);
      stopTask(taskId, '任务正在批量删除', {
        broadcast: true,
        callServer: false,
      });
    }
    await Promise.all(taskIds.map(taskId => revokeTaskRuntime(taskId, '任务正在批量删除', {
      broadcast: false,
      callServer: true,
      forceServer: true,
    })));

    // 同步到服务器
    if (shouldUseServerMode()) {
      const serverIds = tasks.value
        .filter(t => taskIds.includes(t.id) && t._id)
        .map(t => t._id!);
      if (serverIds.length > 0) {
        try {
          await taskApi.deleteTasks(serverIds);
        } catch (error: any) {
          console.error('批量删除服务器任务失败:', error);
          for (const taskId of taskIds) {
            addLog(taskId, 'error', `服务端批量删除失败，任务保留为已停止状态: ${error?.message || '未知错误'}`);
          }
          return 0;
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
        invalidateRobinhoodSellPreparation(taskId);
        fourMemeServiceCache.delete(taskId);
        clearTradingServiceCache(taskId);
        mixedDirectionOffsets.delete(taskId);
        mixedDirectionStates.delete(taskId);
        remoteRuntimeIdentityRevisions.delete(taskId);
        pureSellCoverageStates.delete(taskId);
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
    let walletAddresses = [...uniqueWalletMap.values()];
    const duplicateCount = task.walletAddresses.length - walletAddresses.length;
    const tokenAddress = taskTokenAddress(task);
    if (!tokenAddress) {
      addLog(taskId, 'error', '未设置代币合约地址');
      return;
    }
    let batchWalletKeys = walletAddresses.map(walletAddress =>
      taskWalletLeaseKey(task.config.chainId, walletAddress),
    );

    if (activeBatchSellTaskIds.has(taskId)) {
      addLog(taskId, 'warning', '该任务已在执行手工批量卖出，本次重复操作未发送任何交易');
      return;
    }
    const busyBatchWalletKeys = new Set(
      batchWalletKeys.filter(key => activeBatchSellWalletKeys.has(key)),
    );
    if (busyBatchWalletKeys.size > 0) {
      walletAddresses = walletAddresses.filter(walletAddress =>
        !busyBatchWalletKeys.has(taskWalletLeaseKey(task.config.chainId, walletAddress)),
      );
      batchWalletKeys = walletAddresses.map(walletAddress =>
        taskWalletLeaseKey(task.config.chainId, walletAddress),
      );
      addLog(
        taskId,
        'warning',
        `${busyBatchWalletKeys.size} 个钱包正在被另一批手工交易使用；本批只跳过这些钱包，其余钱包继续`,
      );
    }
    if (walletAddresses.length === 0) {
      addLog(taskId, 'warning', '任务中没有当前可执行的钱包地址');
      return;
    }

    activeBatchSellTaskIds.add(taskId);
    batchWalletKeys.forEach(key => activeBatchSellWalletKeys.add(key));
    let manualRuntimeGuard: TaskRuntimeGuard | undefined;
    try {
      if (duplicateCount > 0) {
        addLog(taskId, 'warning', `已去除 ${duplicateCount} 个重复钱包地址，每个钱包本次最多卖出一次`);
      }

      // The task being manually sold is paused, but other tasks are not. Their
      // scheduler sees activeBatchSellWalletKeys and skips only the overlapping
      // wallets while continuing to use every other wallet.
      if (task.status === 'running') pauseTask(task.id);
      invalidatePreApprovalRun(task.id);
      invalidateRobinhoodSellPreparation(task.id);
      await revokeTaskRuntime(task.id, '手工批量卖出接管当前任务', {
        broadcast: true,
        forceServer: true,
      });

      const inFlightWalletCount = activeLocalWalletOperations(
        task.config.chainId,
        walletAddresses,
      ).length;
      if (inFlightWalletCount > 0) {
        addLog(
          taskId,
          'info',
          `检测到 ${inFlightWalletCount} 个相关源钱包仍有在途操作；预检会逐钱包排队或跳过，其他钱包和其他任务继续`,
        );
      }

      const walletStore = useWalletStore();
      const dexStore = useDexStore();
      const chainId = task.config.chainId;
      const rpcUrl = task.config.rpcUrl || defaultRpcForChain(chainId);
      const authoritativeSellRpc = isFourMemeTask(task)
        ? getSellRpcUrl(task.config)
        : chainId === 4663
          ? getRuntimeRobinhoodRpcUrl()
          : getSellRpcUrl(task.config);

      // 整批只持有该任务的服务端运行权；每个源钱包各自持有钱包租约。
      // 不再锁住整个代币市场，所以不同钱包的同代币任务可以并行。
      manualRuntimeGuard = await acquireTaskRuntime(task, {
        forceTakeover: true,
        shouldContinue: () => (
          activeBatchSellTaskIds.has(taskId)
          && tasks.value.find(candidate => candidate.id === taskId) === task
        ),
      });
      manualRuntimeGuard.assertActive();
      await (async (operationGuard: TransferLeaseGuard) => {
        operationGuard.assertActive();

        // Reconcile every wallet immediately against receipt/latest/pending.
        // A genuinely blocked wallet is skipped; it no longer turns a mixed
        // batch into a whole-batch cooldown or a zero-send result.
        let eligibleWalletAddresses = [...walletAddresses];
        let preflightSkippedCount = 0;
        while (eligibleWalletAddresses.length > 0) {
          const blockedWallet = await findBlockedUnresolvedWallet(
            task,
            eligibleWalletAddresses,
            true,
            authoritativeSellRpc,
          );
          if (!blockedWallet) break;

          eligibleWalletAddresses = eligibleWalletAddresses.filter(
            walletAddress => walletAddress.toLowerCase() !== blockedWallet.walletAddress.toLowerCase(),
          );
          preflightSkippedCount++;

          if (blockedWallet.code === WALLET_PENDING_PREDECESSOR_CODE) {
            await withTaskWalletLease(chainId, blockedWallet.walletAddress, async walletLeaseGuard => {
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
                walletLeaseGuard,
                'wallet',
              );
            });
          }

          addLog(
            taskId,
            'warning',
            `[批量卖出] ${blockedWallet.walletAddress.slice(0, 10)}... ${blockedWallet.message}；只跳过该钱包，其他钱包继续`,
            blockedWallet.walletAddress,
            blockedWallet.txHash,
          );
        }

        if (eligibleWalletAddresses.length === 0) {
          addLog(taskId, 'warning', `本批 ${preflightSkippedCount} 个钱包当前均有真实待确认交易或无法可靠读取 nonce，没有可安全发送的钱包`);
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
        let unsentCount = preflightSkippedCount;

        addLog(taskId, 'info', `开始 FourMeme 手工批量卖出，可执行钱包数: ${eligibleWalletAddresses.length}，按钱包逐笔确认`);
        for (let index = 0; index < eligibleWalletAddresses.length; index++) {
          const walletAddress = eligibleWalletAddresses[index];
          const privateKey = getWalletPrivateKey(walletStore, walletAddress);
          if (!privateKey) {
            failCount++;
            addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 没有私钥，未发送交易`, walletAddress);
            addLog(taskId, 'info', `已完成 ${index + 1}/${eligibleWalletAddresses.length} 个可执行钱包`);
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
              const leaseGuard = combineLeaseGuards(operationGuard, walletLeaseGuard);
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
                  walletLeaseGuard,
                  'wallet',
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
                  walletLeaseGuard,
                  'wallet',
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
              addLog(
                taskId,
                'warning',
                isPendingPredecessor
                  ? `[批量卖出] ${walletAddress.slice(0, 10)}... 检测到链上待确认前序交易，本次未广播新交易；只跳过该钱包，继续处理后续钱包`
                  : approvalOnly
                    ? `[批量卖出] ${walletAddress.slice(0, 10)}... 授权${outcome.status === 'pending' ? '仍在等待另一执行节点同步' : '确认状态未知'}，不会重发该钱包；授权不改变曲线，继续处理后续钱包`
                    : `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出${outcome.status === 'pending' ? '仍在等待确认/节点同步' : '当前确认状态未知'}，不会自动重发该钱包；继续处理后续钱包`,
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

          addLog(taskId, 'info', `已完成 ${index + 1}/${eligibleWalletAddresses.length} 个可执行钱包`);
          if (stopReason) {
            const unsentWallets = eligibleWalletAddresses.slice(index + 1);
            unsentCount += unsentWallets.length;
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
      let unsentCount = preflightSkippedCount;

      addLog(taskId, 'info', `开始手工批量卖出，可执行钱包数: ${eligibleWalletAddresses.length}，底池: ${spendToken}，按钱包动态报价并确认`);
      if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
        failCount = eligibleWalletAddresses.length;
        addLog(taskId, 'error', `当前 DEX 的 Router 地址未配置，${failCount} 个钱包均未发送交易`);
        addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔`);
        return;
      }

      if (chainId === 4663 && task.config.marketType === 'inner') {
        try {
          const validationClient = createPublicClient({ chain: robinhood, transport: http(effectiveRpcUrl) });
          await readAndValidatePonsLaunchedToken(validationClient, tokenAddress as `0x${string}`);
        } catch (error: any) {
          failCount = eligibleWalletAddresses.length;
          addLog(taskId, 'error', `Pons 代币校验失败: ${error.message || '未知错误'}，${failCount} 个钱包均未发送交易`);
          addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔`);
          return;
        }
      }

      let tradingService: ReturnType<typeof createTradingService>;
      try {
        tradingService = createTradingService(chainId, effectiveRpcUrl, routerAddress);
      } catch (error: any) {
        failCount = eligibleWalletAddresses.length;
        addLog(taskId, 'error', `交易服务初始化失败: ${error.message || '未知错误'}，${failCount} 个钱包均未发送交易`);
        addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔`);
        return;
      }

      for (let index = 0; index < eligibleWalletAddresses.length; index++) {
        const walletAddress = eligibleWalletAddresses[index];
        const privateKey = getWalletPrivateKey(walletStore, walletAddress);
        if (!privateKey) {
          failCount++;
          addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 没有私钥，未发送交易`, walletAddress);
          addLog(taskId, 'info', `已完成 ${index + 1}/${eligibleWalletAddresses.length} 个可执行钱包`);
          continue;
        }

        let stopReason: string | undefined;
        try {
           const broadcastHashes = new Set<string>();
           let latestBroadcastHash: string | undefined;
           const result = await withTaskWalletLease(chainId, walletAddress, async (walletLeaseGuard) => {
            const leaseGuard = combineLeaseGuards(operationGuard, walletLeaseGuard);
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
                 walletLeaseGuard,
                 'wallet',
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
            addLog(
              taskId,
              'warning',
              isPendingPredecessor
                ? `[批量卖出] ${walletAddress.slice(0, 10)}... 检测到链上待确认前序交易，本次未广播新交易；只跳过该钱包，继续处理后续钱包`
                : approvalOnly
                  ? `[批量卖出] ${walletAddress.slice(0, 10)}... 授权${result.status === 'pending' ? '仍在等待确认/节点同步' : '当前确认状态未知'}，不会重发该钱包；继续处理后续钱包`
                  : `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出${result.status === 'pending' ? '仍在等待确认/节点同步' : '当前确认状态未知'}，不会自动重发该钱包；继续处理后续钱包`,
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

        addLog(taskId, 'info', `已完成 ${index + 1}/${eligibleWalletAddresses.length} 个可执行钱包`);
        if (stopReason) {
          const unsentWallets = eligibleWalletAddresses.slice(index + 1);
          unsentCount += unsentWallets.length;
          for (const unsentWallet of unsentWallets) {
            addLog(taskId, 'warning', `[批量卖出] ${unsentWallet.slice(0, 10)}... 未发送：${stopReason}`, unsentWallet);
          }
          break;
        }
      }

      addLog(taskId, 'info', `批量卖出操作完成，确认 ${confirmedCount} 笔，待确认 ${pendingCount} 笔，失败 ${failCount} 笔，未发送 ${unsentCount} 笔`);
      })(manualRuntimeGuard);
    } catch (error: any) {
      if (isCoordinationLeaseError(error)) {
        addLog(taskId, 'warning', `无法取得或维持任务运行权/钱包锁: ${error.message || '未知错误'}；本次没有继续发送交易`);
      } else {
        addLog(taskId, 'error', `批量卖出异常: ${error.message || '未知错误'}；本次没有继续发送交易`);
      }
    } finally {
      activeBatchSellTaskIds.delete(taskId);
      batchWalletKeys.forEach(key => activeBatchSellWalletKeys.delete(key));
      await revokeTaskRuntime(taskId, '手工批量卖出已结束', {
        broadcast: false,
        expectedState: manualRuntimeGuard?.runtimeState ?? null,
      });
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
