import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWalletStore } from './walletStore';
import { useChainStore } from './chainStore';
import { useDexStore } from './dexStore';
import { createTradingService, type TradeParams } from '../services/tradingService';
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
  poolType: string;           // 池子类型 (BNB/USDT/USDC)
  spendToken: string;         // 花费代币
  targetPrice: number;        // 目标价格
  targetMarketCap?: number;   // 目标市值（BNB）
  amountType: 'amount' | 'quantity';  // 金额类型
  amount: number;             // 买入/卖出金额或数量
  stopType: 'count' | 'amount' | 'time' | 'price' | 'marketcap';  // 停止类型
  stopValue: number;          // 停止条件值
  interval: number;           // 交易间隔(秒)
  gasPrice?: number;          // 自定义Gas价格 (Gwei)
  gasLimit?: number;          // 自定义Gas上限
  sellThreshold: number;      // 卖出阈值
  walletMode: 'sequential' | 'parallel';  // 钱包使用方式：顺序/同时
  balancePercent?: number;    // 余额使用百分比 (1-100)
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
      }
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
        // 达到目标市值时停止
        return currentMarketCap >= stopValue;
      default:
        return false;
    }
  }

  // 执行单个钱包的交易
  async function executeWalletTrade(task: Task, walletAddress: string): Promise<boolean> {
    const walletStore = useWalletStore();
    const chainStore = useChainStore();
    const dexStore = useDexStore();
    
    const wallet = walletStore.localWallets.find(w => w.address === walletAddress);
    if (!wallet || !wallet.encrypted) {
      addLog(task.id, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
      return false;
    }

    try {
      // 获取链和DEX配置
      const chainId = chainStore.selectedChainId;
      const rpcUrl = chainStore.rpcUrl;
      const routerAddress = dexStore.currentRouterAddress;
      
      if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
        addLog(task.id, 'error', '当前DEX的Router地址未配置', walletAddress);
        return false;
      }

      addLog(task.id, 'info', `开始${task.mode === 'pump' ? '买入' : '卖出'}交易...`, walletAddress);
      
      // 创建交易服务
      const tradingService = createTradingService(chainId, rpcUrl, routerAddress);

      // 构建交易参数（滑点固定30%）
      const tradeParams: TradeParams = {
        chainId,
        rpcUrl,
        routerAddress,
        privateKey: wallet.encrypted,
        walletAddress: wallet.address,
        tokenAddress: task.config.tokenContract,
        spendToken: task.config.spendToken,
        amount: task.config.amount,
        amountType: task.config.amountType,
        mode: task.mode,
        slippage: 30,
        gasPrice: task.config.gasPrice,
        gasLimit: task.config.gasLimit,
        balancePercent: task.config.balancePercent,
      };
      
      // 执行交易
      const result = await tradingService.executeTrade(tradeParams);
      
      if (result.success) {
        // 更新统计
        task.stats.executedCount++;
        task.stats.spentAmount += task.config.amount;
        
        const actionText = task.mode === 'pump' ? '买入' : '卖出';
        const resultText = result.amountOut 
          ? `${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
          : `${actionText}成功，金额: ${task.config.amount} ${task.config.spendToken}`;
        
        addLog(task.id, 'success', resultText, walletAddress, result.txHash);
        return true;
      } else {
        addLog(task.id, 'error', `交易失败: ${result.error}`, walletAddress, result.txHash);
        return false;
      }
      
    } catch (error: any) {
      addLog(task.id, 'error', `交易异常: ${error.message}`, walletAddress);
      return false;
    }
  }

  // 获取当前池子市值（BNB）
  async function getCurrentMarketCap(task: Task): Promise<number | undefined> {
    try {
      const chainStore = useChainStore();
      const dexStore = useDexStore();
      
      const chainId = chainStore.selectedChainId;
      const rpcUrl = chainStore.rpcUrl;
      const factoryAddress = dexStore.currentFactoryAddress;
      const baseTokens = dexStore.currentBaseTokens;
      
      if (!factoryAddress || !baseTokens || baseTokens.length === 0) {
        return undefined;
      }

      // 确定底池代币（BNB池使用BNB作为底池）
      let baseToken: string | undefined;
      if (task.config.poolType === 'BNB' || task.config.poolType === 'tBNB') {
        // 查找WBNB地址
        baseToken = baseTokens.find(addr => {
          // WBNB通常在baseTokens中，或者需要根据链ID查找
          return true; // 简化处理，使用第一个baseToken
        });
        if (!baseToken && baseTokens.length > 0) {
          baseToken = baseTokens[0];
        }
      } else {
        // USDT/USDC池，需要找到对应的代币地址
        // 这里简化处理，使用第一个baseToken
        baseToken = baseTokens[0];
      }

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
      
      // 市值 = BNB储备 * 2（因为池子中两边价值相等）
      return bnbAmount * 2;
      
    } catch (error) {
      console.error('获取市值失败:', error);
      return undefined;
    }
  }

  // 执行一轮交易（根据钱包模式）
  async function executeRound(task: Task): Promise<void> {
    if (task.status !== 'running') return;

    const { walletMode } = task.config;
    const wallets = task.walletAddresses;

    if (wallets.length === 0) {
      addLog(task.id, 'warning', '没有钱包参与交易');
      return;
    }

    if (walletMode === 'parallel') {
      // 并行执行：所有钱包同时发起交易（添加随机延迟避免 nonce 冲突）
      addLog(task.id, 'info', `并行执行模式：${wallets.length} 个钱包同时发起交易`);
      
      // 为每个钱包添加随机延迟（0-500ms），避免 nonce 冲突
      const promises = wallets.map((addr, index) => {
        const delay = Math.random() * 500; // 0-500ms 随机延迟
        return new Promise<void>((resolve) => {
          setTimeout(async () => {
            await executeWalletTrade(task, addr);
            resolve();
          }, delay);
        });
      });
      await Promise.allSettled(promises);
      
    } else {
      // 顺序执行：逐个钱包执行
      for (const walletAddr of wallets) {
        if (task.status !== 'running') break;
        
        await executeWalletTrade(task, walletAddr);
        
        // 检查停止条件（包括市值）
        const currentMarketCap = await getCurrentMarketCap(task);
        if (checkStopCondition(task, undefined, currentMarketCap)) {
          stopTask(task.id, '已达到停止条件');
          return;
        }
      }
    }

    // 检查停止条件（包括市值）
    const currentMarketCap = await getCurrentMarketCap(task);
    if (checkStopCondition(task, undefined, currentMarketCap)) {
      stopTask(task.id, '已达到停止条件');
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
    
    addLog(task.id, 'info', `任务开始执行，间隔: ${task.config.interval}秒`);

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
        return `花费 ${stopValue} ${task.config.spendToken}`;
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
    setActiveLogTask,
    clearTaskLogs,
    clearAllTasks,
    addLog,
    getStopConditionText,
    getTaskProgress,
    checkStopCondition
  };
});

