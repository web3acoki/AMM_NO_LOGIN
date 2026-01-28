import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWalletStore } from './walletStore';
import { useChainStore } from './chainStore';
import { useDexStore } from './dexStore';
import { createTradingService, type TradeParams } from '../services/tradingService';
import { createFourMemeService, type FourMemeTradeParams } from '../services/fourMemeService';
import { PriceCalculator } from '../utils/priceCalculator';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

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
  tokenContract: string;      // 代币合约地址
  targetPrice: number;        // 目标价格
  targetMarketCap?: number;   // 目标市值（BNB）
  amountMin: number;          // 金额区间最小值（BNB）
  amountMax: number;          // 金额区间最大值（BNB）
  stopType: 'count' | 'amount' | 'time' | 'price' | 'marketcap';  // 停止类型
  stopValue: number;          // 停止条件值
  interval: number;           // 交易间隔(秒)
  threadCount: number;        // 线程数：每个间隔内同时执行的钱包数量
  gasPrice?: number;          // 自定义Gas价格 (Gwei)
  gasLimit?: number;          // 自定义Gas上限
  sellAll?: boolean;          // 砸盘时是否卖出全部
  marketType: 'inner' | 'outer';  // 盘口类型：inner=内盘(FourMeme), outer=外盘(DEX)
  innerTokenAddress?: string; // 内盘目标代币地址（仅内盘模式使用）
}

// 任务统计接口
export interface TaskStats {
  executedCount: number;      // 已执行次数
  spentAmount: number;        // 已花费金额
  startTime?: number;         // 开始时间
  elapsedTime: number;        // 已运行时间(秒)
}

// 任务接口
export interface Task {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'stopped';
  mode: 'pump' | 'dump';      // 拉盘/砸盘
  config: TaskConfig;
  walletAddresses: string[];  // 选中的钱包地址列表
  logs: LogEntry[];
  stats: TaskStats;
  intervalId?: number;        // 定时器ID
  currentWalletIndex: number; // 当前轮询到的钱包索引（用于round-robin）
}

export const useTaskStore = defineStore('task', () => {
  // 状态
  const tasks = ref<Task[]>([]);
  const activeLogTaskId = ref<string | null>(null);  // 当前查看日志的任务ID

  // 计算属性
  const runningTasks = computed(() => tasks.value.filter(t => t.status === 'running'));
  const pausedTasks = computed(() => tasks.value.filter(t => t.status === 'paused'));
  const taskCount = computed(() => tasks.value.length);
  
  // 当前查看日志的任务
  const activeLogTask = computed(() => {
    if (!activeLogTaskId.value) return null;
    return tasks.value.find(t => t.id === activeLogTaskId.value) || null;
  });

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
  function createTask(
    name: string,
    mode: 'pump' | 'dump',
    config: TaskConfig,
    walletAddresses: string[]
  ): Task {
    const task: Task = {
      id: generateId(),
      name,
      status: 'stopped',
      mode,
      config,
      walletAddresses,
      logs: [],
      stats: {
        executedCount: 0,
        spentAmount: 0,
        elapsedTime: 0
      },
      currentWalletIndex: 0  // 初始化钱包索引
    };
    tasks.value.push(task);
    
    // 自动设置为当前查看的任务
    if (!activeLogTaskId.value) {
      activeLogTaskId.value = task.id;
    }
    
    addLog(task.id, 'info', `任务 "${name}" 已创建，模式: ${mode === 'pump' ? '拉盘' : '砸盘'}，钱包数量: ${walletAddresses.length}`);
    
    return task;
  }

  // 检查停止条件
  function checkStopCondition(task: Task, currentPrice?: number, currentMarketCap?: number): boolean {
    const { stopType, stopValue } = task.config;
    const { executedCount, spentAmount, startTime, elapsedTime } = task.stats;

    switch (stopType) {
      case 'count':
        return executedCount >= stopValue;
      case 'amount':
        return spentAmount >= stopValue;
      case 'time':
        return elapsedTime >= stopValue;
      case 'price':
        if (currentPrice === undefined) return false;
        if (task.mode === 'pump') {
          return currentPrice >= stopValue;  // 拉盘：价格达到目标
        } else {
          return currentPrice <= stopValue;  // 砸盘：价格跌到目标
        }
      case 'marketcap':
        if (currentMarketCap === undefined) return false;
        if (task.mode === 'pump') {
          return currentMarketCap >= stopValue;  // 拉盘：市值涨到目标
        } else {
          return currentMarketCap <= stopValue;  // 砸盘：市值跌到目标
        }
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

  // 执行单个钱包的交易
  async function executeWalletTrade(task: Task, walletAddress: string): Promise<boolean> {
    const walletStore = useWalletStore();
    const chainStore = useChainStore();
    const dexStore = useDexStore();

    // 获取私钥（支持本地钱包和批次钱包）
    const privateKey = getWalletPrivateKey(walletStore, walletAddress);
    if (!privateKey) {
      addLog(task.id, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
      return false;
    }

    try {
      // 获取链配置
      const chainId = chainStore.selectedChainId;
      const rpcUrl = chainStore.effectiveRpcUrl;

      // 计算随机金额（在区间内）
      const amountMin = task.config.amountMin || 0;
      const amountMax = task.config.amountMax || amountMin;
      const randomAmount = amountMin + Math.random() * (amountMax - amountMin);
      // 保留18位小数精度（与以太坊精度一致），避免小数被截断为0
      const roundedAmount = Number(randomAmount.toFixed(18));

      // 格式化显示金额，避免科学计数法
      const formatAmount = (num: number): string => {
        if (num === 0) return '0';
        return num.toFixed(18).replace(/\.?0+$/, '');
      };

      const marketTypeText = task.config.marketType === 'inner' ? '内盘' : '外盘';
      addLog(task.id, 'info', `开始${task.mode === 'pump' ? '买入' : '卖出'}交易 [${marketTypeText}]...`, walletAddress);
      addLog(task.id, 'info', `交易金额: ${formatAmount(roundedAmount)} BNB (区间: ${formatAmount(amountMin)}~${formatAmount(amountMax)})`, walletAddress);

      // 根据盘口类型选择不同的交易服务
      if (task.config.marketType === 'inner') {
        // 内盘交易：使用 FourMeme 服务
        return await executeInnerMarketTrade(task, walletAddress, privateKey, chainId, rpcUrl, roundedAmount);
      } else {
        // 外盘交易：使用 DEX 服务
        return await executeOuterMarketTrade(task, walletAddress, privateKey, chainId, rpcUrl, roundedAmount, dexStore);
      }

    } catch (error: any) {
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
    amount: number
  ): Promise<boolean> {
    const fourMemeService = createFourMemeService(chainId, rpcUrl);

    // 砸盘模式：如果 sellAll 为 true 则卖出100%
    const sellAll = task.mode === 'dump' && task.config.sellAll;

    const tradeParams: FourMemeTradeParams = {
      chainId,
      rpcUrl,
      privateKey,
      walletAddress,
      tokenAddress: task.config.innerTokenAddress || task.config.tokenContract,
      amount,
      mode: task.mode === 'pump' ? 'buy' : 'sell',
      gasPrice: task.config.gasPrice,
      gasLimit: task.config.gasLimit,
      sellPercent: sellAll ? 100 : undefined,
    };

    const result = await fourMemeService.executeTrade(tradeParams);

    if (result.success) {
      task.stats.executedCount++;
      task.stats.spentAmount += amount;

      const actionText = task.mode === 'pump' ? '买入' : '卖出';
      const resultText = result.amountOut
        ? `[内盘] ${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
        : `[内盘] ${actionText}成功，金额: ${amount} BNB`;

      addLog(task.id, 'success', resultText, walletAddress, result.txHash);
      return true;
    } else {
      addLog(task.id, 'error', `[内盘] 交易失败: ${result.error}`, walletAddress, result.txHash);
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
    dexStore: ReturnType<typeof useDexStore>
  ): Promise<boolean> {
    const routerAddress = dexStore.currentRouterAddress;

    if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
      addLog(task.id, 'error', '当前DEX的Router地址未配置', walletAddress);
      return false;
    }

    const tradingService = createTradingService(chainId, rpcUrl, routerAddress);

    // 砸盘模式：如果 sellAll 为 true 则卖出100%
    const sellAll = task.mode === 'dump' && task.config.sellAll;

    const tradeParams: TradeParams = {
      chainId,
      rpcUrl,
      routerAddress,
      privateKey,
      walletAddress,
      tokenAddress: task.config.tokenContract,
      spendToken: 'BNB',
      amount,
      amountType: 'amount',
      mode: task.mode,
      slippage: 30,
      gasPrice: task.config.gasPrice,
      gasLimit: task.config.gasLimit,
      balancePercent: sellAll ? 100 : undefined,
      targetBnbAmount: task.mode === 'dump' && !sellAll ? amount : undefined,
    };

    const result = await tradingService.executeTrade(tradeParams);

    if (result.success) {
      task.stats.executedCount++;
      task.stats.spentAmount += amount;

      const actionText = task.mode === 'pump' ? '买入' : '卖出';
      const resultText = result.amountOut
        ? `[外盘] ${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
        : `[外盘] ${actionText}成功，金额: ${amount} BNB`;

      addLog(task.id, 'success', resultText, walletAddress, result.txHash);
      return true;
    } else {
      addLog(task.id, 'error', `[外盘] 交易失败: ${result.error}`, walletAddress, result.txHash);
      return false;
    }
  }

  // 获取当前池子市值（BNB）
  async function getCurrentMarketCap(task: Task): Promise<number | undefined> {
    try {
      const chainStore = useChainStore();
      const dexStore = useDexStore();

      const chainId = chainStore.selectedChainId;
      const rpcUrl = chainStore.effectiveRpcUrl;
      const factoryAddress = dexStore.currentFactoryAddress;
      const baseTokens = dexStore.currentBaseTokens;

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
      const chain = chainId === 97 ? bscTestnet : bsc;
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl)
      });

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

  // 执行一轮交易（round-robin + 线程数）
  async function executeRound(task: Task): Promise<void> {
    if (task.status !== 'running') return;

    // 在执行前先检查市值停止条件（仅外盘模式，内盘没有 DEX 交易对）
    if (task.config.stopType === 'marketcap' && task.config.marketType !== 'inner') {
      const currentMarketCap = await getCurrentMarketCap(task);
      if (currentMarketCap !== undefined) {
        const modeText = task.mode === 'pump' ? '拉盘(>=目标停止)' : '砸盘(<=目标停止)';
        addLog(task.id, 'info', `当前市值: ${currentMarketCap.toFixed(4)} BNB, 目标: ${task.config.stopValue} BNB [${modeText}]`);
        if (checkStopCondition(task, undefined, currentMarketCap)) {
          stopTask(task.id, '已达到停止条件');
          return;
        }
      }
    }

    const wallets = task.walletAddresses;
    const threadCount = task.config.threadCount || 1;

    if (wallets.length === 0) {
      addLog(task.id, 'warning', '没有钱包参与交易');
      return;
    }

    // Round-robin + 线程数执行逻辑：
    // 每次执行 threadCount 个钱包，从 currentWalletIndex 开始
    // 执行完后更新 currentWalletIndex，循环使用钱包列表

    const walletsToExecute: string[] = [];
    for (let i = 0; i < threadCount; i++) {
      const walletIndex = (task.currentWalletIndex + i) % wallets.length;
      walletsToExecute.push(wallets[walletIndex]);
    }

    // 更新下一轮的起始索引
    task.currentWalletIndex = (task.currentWalletIndex + threadCount) % wallets.length;

    // 检查是否完成一轮（所有钱包都执行过一次）
    const isNewRound = task.currentWalletIndex < threadCount || task.currentWalletIndex === 0;
    if (isNewRound && task.stats.executedCount > 0) {
      addLog(task.id, 'info', `--- 新一轮开始 ---`);
    }

    addLog(task.id, 'info', `执行 ${walletsToExecute.length} 个钱包 (线程数: ${threadCount})`);

    // 并行执行选中的钱包（添加递增延迟避免 nonce 冲突）
    const promises = walletsToExecute.map((addr, index) => {
      const delay = index * 100; // 递增延迟：0ms, 100ms, 200ms...
      return new Promise<void>((resolve) => {
        setTimeout(async () => {
          await executeWalletTrade(task, addr);
          resolve();
        }, delay);
      });
    });
    await Promise.allSettled(promises);

    // 执行后检查停止条件（内盘模式不检查市值，因为没有 DEX 交易对）
    if (task.config.marketType !== 'inner') {
      const currentMarketCap = await getCurrentMarketCap(task);
      if (checkStopCondition(task, undefined, currentMarketCap)) {
        stopTask(task.id, '已达到停止条件');
      }
    } else {
      // 内盘模式：只检查非市值相关的停止条件
      if (checkStopCondition(task, undefined, undefined)) {
        stopTask(task.id, '已达到停止条件');
      }
    }
  }

  // 开始任务
  function startTask(taskId: string): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    if (task.walletAddresses.length === 0) {
      addLog(task.id, 'error', '没有选中任何钱包，无法开始任务');
      return false;
    }

    task.status = 'running';
    task.stats.startTime = Date.now();
    task.currentWalletIndex = 0;  // 重置钱包索引

    const threadCount = task.config.threadCount || 1;
    addLog(task.id, 'info', `任务开始执行，间隔: ${task.config.interval}秒，线程数: ${threadCount}，钱包数: ${task.walletAddresses.length}`);

    // 立即执行一轮
    executeRound(task);

    // 设置定时器
    const intervalMs = task.config.interval * 1000;
    task.intervalId = window.setInterval(() => {
      if (task.status === 'running') {
        // 更新运行时间
        if (task.stats.startTime) {
          task.stats.elapsedTime = Math.floor((Date.now() - task.stats.startTime) / 1000);
        }
        executeRound(task);
      }
    }, intervalMs);

    return true;
  }

  // 暂停任务
  function pauseTask(taskId: string): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return false;

    task.status = 'paused';
    
    if (task.intervalId) {
      clearInterval(task.intervalId);
      task.intervalId = undefined;
    }

    addLog(task.id, 'warning', '任务已暂停');
    return true;
  }

  // 继续任务
  function resumeTask(taskId: string): boolean {
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
      clearInterval(task.intervalId);
      task.intervalId = undefined;
    }

    addLog(task.id, 'info', `任务已停止${reason ? `，原因: ${reason}` : ''}`);
    return true;
  }

  // 删除任务
  function deleteTask(taskId: string): boolean {
    const taskIndex = tasks.value.findIndex(t => t.id === taskId);
    if (taskIndex === -1) return false;

    const task = tasks.value[taskIndex];

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
  function updateTask(
    taskId: string,
    updates: {
      name?: string;
      config?: Partial<TaskConfig>;
      walletAddresses?: string[];
    }
  ): boolean {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    // 只有暂停或停止状态的任务才能编辑
    if (task.status === 'running') {
      console.error('运行中的任务不能编辑');
      return false;
    }

    // 更新任务名称
    if (updates.name !== undefined) {
      task.name = updates.name;
    }

    // 更新任务配置
    if (updates.config) {
      task.config = { ...task.config, ...updates.config };
    }

    // 更新钱包地址列表
    if (updates.walletAddresses !== undefined) {
      task.walletAddresses = updates.walletAddresses;
    }

    addLog(taskId, 'info', `任务配置已更新`);
    return true;
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
  function clearAllTasks() {
    // 停止所有运行中的任务
    tasks.value.forEach(task => {
      if (task.intervalId) {
        clearInterval(task.intervalId);
      }
    });
    tasks.value = [];
    activeLogTaskId.value = null;
  }

  // 获取任务的停止条件描述
  function getStopConditionText(task: Task): string {
    const { stopType, stopValue } = task.config;
    switch (stopType) {
      case 'count':
        return `执行 ${stopValue} 次`;
      case 'amount':
        return `花费 ${stopValue} BNB`;
      case 'time':
        return `运行 ${stopValue} 秒`;
      case 'price':
        return `价格达到 ${stopValue}`;
      case 'marketcap':
        return `市值达到 ${stopValue} BNB`;
      default:
        return '未知';
    }
  }

  // 获取任务进度
  function getTaskProgress(task: Task): number {
    const { stopType, stopValue } = task.config;
    const { executedCount, spentAmount, elapsedTime } = task.stats;
    
    switch (stopType) {
      case 'count':
        return Math.min((executedCount / stopValue) * 100, 100);
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
    createTask,
    startTask,
    pauseTask,
    resumeTask,
    stopTask,
    deleteTask,
    updateTask,
    setActiveLogTask,
    clearTaskLogs,
    clearAllTasks,
    addLog,
    getStopConditionText,
    getTaskProgress,
    checkStopCondition
  };
});

