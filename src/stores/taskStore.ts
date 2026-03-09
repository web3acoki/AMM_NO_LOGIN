import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useWalletStore } from './walletStore';
import { useChainStore } from './chainStore';
import { useDexStore } from './dexStore';
import { createTradingService, type TradeParams } from '../services/tradingService';
import { createFourMemeService, FourMemeService, ANTI_SANDWICH_RPC, type FourMemeTradeParams, type SellPrepareResult, acquireNonceLocal } from '../services/fourMemeService';
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
  const preApprovalTracker = new Map<string, { promise: Promise<void>; completed: boolean }>();

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
    config: TaskConfig,
    walletAddresses: string[]
  ): Task {
    const task: Task = {
      id: generateId(),
      name,
      status: 'stopped',
      config,
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
    tasks.value.push(task);

    // 自动设置为当前查看的任务
    if (!activeLogTaskId.value) {
      activeLogTaskId.value = task.id;
    }

    const buyCount = config.buyThreadCount || 0;
    const sellCount = config.sellThreadCount || 0;
    addLog(task.id, 'info', `任务 "${name}" 已创建，买${buyCount}/卖${sellCount}，钱包数量: ${walletAddresses.length}`);

    // 内盘任务：创建时就预热 RPC 连接（异步，不阻塞）
    // 这样当用户点击"开始"时，RPC 连接已经建立好了
    if (config.marketType === 'inner') {
      const chainStore = useChainStore();
      const antiSandwichRpc = config.antiSandwichRpc || ANTI_SANDWICH_RPC;
      const chain = chainStore.selectedChainId === 97 ? bscTestnet : bsc;

      // 预创建并缓存 FourMemeService 实例
      const service = createFourMemeService(chainStore.selectedChainId, antiSandwichRpc);
      fourMemeServiceCache.set(task.id, service);

      // 异步预热 RPC 连接（获取区块号 + 第一个钱包的 nonce）
      const publicClient = createPublicClient({ chain, transport: http(antiSandwichRpc) });
      const firstWallet = walletAddresses[0];
      Promise.all([
        publicClient.getBlockNumber(),
        firstWallet ? publicClient.getTransactionCount({ address: firstWallet as `0x${string}`, blockTag: 'pending' }) : Promise.resolve(0)
      ]).then(() => {
        addLog(task.id, 'info', 'RPC 预热完成，可以开始任务');
      }).catch(() => {});

      // ASTER 池任务：创建时预授权所有钱包（后台异步，不阻塞 UI）
      if (config.poolBaseToken) {
        preApproveWallets(task);
      }
    }

    return task;
  }

  // 预授权所有钱包的底池代币（ASTER 池任务创建时调用）
  function preApproveWallets(task: Task) {
    const walletStore = useWalletStore();
    const chainStore = useChainStore();
    const baseTokenAddress = task.config.poolBaseToken;
    if (!baseTokenAddress) return;

    const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as const;
    // 使用 Binance 官方 RPC 执行 approve，不占用防夹节点
    const approveRpcUrl = 'https://bsc-dataseed.binance.org';
    const chain = chainStore.selectedChainId === 97 ? bscTestnet : bsc;

    const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const maxUint128 = BigInt('0xffffffffffffffffffffffffffffffff');

    const promise = (async () => {
      try {
        addLog(task.id, 'info', `开始预授权 ${task.walletAddresses.length} 个钱包的底池代币...`);

        // 1. 用 multicall 批量查询所有钱包的 allowance（1 次 RPC 代替 N 次）
        const approvePublicClient = createPublicClient({
          chain,
          transport: http(approveRpcUrl, { batch: true }),
          batch: { multicall: true }
        });

        const allowancePromises = task.walletAddresses.map(addr =>
          approvePublicClient.readContract({
            address: baseTokenAddress as `0x${string}`,
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
          }).then(val => ({ addr, allowance: val as bigint }))
            .catch(() => ({ addr, allowance: 0n }))
        );

        const allowanceResults = await Promise.all(allowancePromises);

        // 2. 筛出 allowance 不足的钱包
        const needApproval = allowanceResults
          .filter(r => r.allowance < maxUint128)
          .map(r => r.addr);

        if (needApproval.length === 0) {
          addLog(task.id, 'success', '所有钱包已有足够授权，预授权跳过');
          task.preApprovalDone = true;
          return;
        }

        addLog(task.id, 'info', `${needApproval.length} 个钱包需要授权，开始并行发送 approve 交易...`);

        // 3. 并行发送所有 approve TX（每批 10 个）
        const BATCH_SIZE = 10;
        const allTxHashes: { addr: string; txHash: string }[] = [];

        for (let i = 0; i < needApproval.length; i += BATCH_SIZE) {
          const batch = needApproval.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.allSettled(
            batch.map(async (addr) => {
              const privateKey = getWalletPrivateKey(walletStore, addr);
              if (!privateKey) throw new Error('无私钥');

              const account = (await import('viem/accounts')).privateKeyToAccount(privateKey as `0x${string}`);
              const walletClient = (await import('viem')).createWalletClient({
                account,
                chain,
                transport: http(approveRpcUrl)
              });

              // ERC20 approve 方法选择器: 0x095ea7b3
              const callData = ('0x095ea7b3' +
                FOURMEME_CONTRACT.slice(2).padStart(64, '0') +
                maxUint256.toString(16).padStart(64, '0')) as `0x${string}`;

              const txHash = await walletClient.sendTransaction({
                to: baseTokenAddress as `0x${string}`,
                data: callData,
                value: 0n,
                gas: BigInt(100000)
              });

              return { addr, txHash };
            })
          );

          for (const result of batchResults) {
            if (result.status === 'fulfilled') {
              allTxHashes.push(result.value);
            } else {
              addLog(task.id, 'warning', `预授权发送失败: ${result.reason?.message || '未知错误'}`);
            }
          }
        }

        // 4. 并行等待所有 receipt（Promise.allSettled 一次等，非逐个等）
        if (allTxHashes.length > 0) {
          addLog(task.id, 'info', `等待 ${allTxHashes.length} 笔授权交易确认...`);
          const receiptResults = await Promise.allSettled(
            allTxHashes.map(({ txHash }) =>
              approvePublicClient.waitForTransactionReceipt({
                hash: txHash as `0x${string}`,
                timeout: 60000
              })
            )
          );

          let successCount = 0;
          let failCount = 0;
          for (const result of receiptResults) {
            if (result.status === 'fulfilled' && result.value.status === 'success') {
              successCount++;
            } else {
              failCount++;
            }
          }
          addLog(task.id, 'info', `预授权确认完成: ${successCount} 成功, ${failCount} 失败`);
        }

        task.preApprovalDone = true;
        addLog(task.id, 'success', '预授权完成，所有钱包已就绪');
      } catch (error: any) {
        addLog(task.id, 'warning', `预授权异常: ${error.message}，交易时将使用 inline approve 兜底`);
        // 不设置 preApprovalDone = true，让 startTask 中的兜底逻辑处理
      }
    })();

    preApprovalTracker.set(task.id, { promise, completed: false });
    promise.then(() => {
      const tracker = preApprovalTracker.get(task.id);
      if (tracker) tracker.completed = true;
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
  async function executeWalletTrade(task: Task, walletAddress: string, tradeDirection: 'buy' | 'sell', sharedFourMemeService?: InstanceType<typeof FourMemeService>): Promise<boolean> {
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
      // 保留8位小数精度（避免 JavaScript 浮点数精度问题）
      // 0.1.toFixed(18) = "0.100000000000000006"（错误）
      // 0.1.toFixed(8) = "0.10000000"（正确）
      const roundedAmount = Number(randomAmount.toFixed(8));

      // 格式化显示金额，避免科学计数法
      const formatAmount = (num: number): string => {
        if (num === 0) return '0';
        return num.toFixed(8).replace(/\.?0+$/, '');
      };

      const marketTypeText = task.config.marketType === 'inner' ? '内盘' : '外盘';
      const amountUnit = task.config.poolBaseToken ? 'ASTER' : 'BNB';
      addLog(task.id, 'info', `开始${tradeDirection === 'buy' ? '买入' : '卖出'}交易 [${marketTypeText}]...`, walletAddress);
      addLog(task.id, 'info', `交易金额: ${formatAmount(roundedAmount)} ${amountUnit} (区间: ${formatAmount(amountMin)}~${formatAmount(amountMax)})`, walletAddress);

      // 根据盘口类型选择不同的交易服务
      if (task.config.marketType === 'inner') {
        // 内盘交易：使用 FourMeme 服务（优先使用共享实例）
        return await executeInnerMarketTrade(task, walletAddress, privateKey, chainId, rpcUrl, roundedAmount, tradeDirection, sharedFourMemeService);
      } else {
        // 外盘交易：使用 DEX 服务
        return await executeOuterMarketTrade(task, walletAddress, privateKey, chainId, rpcUrl, roundedAmount, tradeDirection, dexStore);
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
    amount: number,
    tradeDirection: 'buy' | 'sell',
    sharedService?: InstanceType<typeof FourMemeService>
  ): Promise<boolean> {
    // 内盘交易使用配置的防夹节点，未配置则使用默认
    const antiSandwichRpc = task.config.antiSandwichRpc || ANTI_SANDWICH_RPC;
    const fourMemeService = sharedService || createFourMemeService(chainId, antiSandwichRpc);

    // 卖出模式：如果 sellAll 为 true 则卖出100%
    const sellAll = tradeDirection === 'sell' && task.config.sellAll;

    const tradeParams: FourMemeTradeParams = {
      chainId,
      rpcUrl: antiSandwichRpc,
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
    };

    const result = await fourMemeService.executeTrade(tradeParams);

    if (result.success) {
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
    prefetchData?: { tokenBalance: bigint; allowanceSufficient: boolean }
  ): Promise<boolean> {
    const walletStore = useWalletStore();
    const chainStore = useChainStore();

    const privateKey = getWalletPrivateKey(walletStore, walletAddress);
    if (!privateKey) {
      addLog(task.id, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
      return false;
    }

    // 如果预取数据显示 allowance 不足，fallback 到原有慢路径
    if (prefetchData && !prefetchData.allowanceSufficient && tradeDirection === 'buy') {
      addLog(task.id, 'warning', `${walletAddress.slice(0, 10)}... 授权不足，使用慢路径`, walletAddress);
      return await executeWalletTrade(task, walletAddress, tradeDirection, sharedFourMemeService);
    }

    // 卖出时如果余额为 0，直接跳过
    if (tradeDirection === 'sell' && prefetchData && prefetchData.tokenBalance <= 0n) {
      addLog(task.id, 'info', `${walletAddress.slice(0, 10)}... 代币余额为零，跳过卖出`, walletAddress);
      return false;
    }

    try {
      const chainId = chainStore.selectedChainId;
      const antiSandwichRpc = task.config.antiSandwichRpc || ANTI_SANDWICH_RPC;

      // 计算随机金额
      const amountMin = task.config.amountMin || 0;
      const amountMax = task.config.amountMax || amountMin;
      const randomAmount = amountMin + Math.random() * (amountMax - amountMin);
      const roundedAmount = Number(randomAmount.toFixed(8));

      const sellAll = tradeDirection === 'sell' && task.config.sellAll;

      const tradeParams: FourMemeTradeParams = {
        chainId,
        rpcUrl: antiSandwichRpc,
        privateKey,
        walletAddress,
        tokenAddress: task.config.innerTokenAddress || task.config.tokenContract,
        amount: roundedAmount,
        mode: tradeDirection === 'buy' ? 'buy' : 'sell',
        gasPrice: task.config.gasPrice,
        gasLimit: task.config.gasLimit,
        sellPercent: sellAll ? 100 : undefined,
        slippage: task.config.innerSlippage,
        poolBaseToken: task.config.poolBaseToken,
      };

      const result = await sharedFourMemeService.executeTradeFast(
        tradeParams,
        tradeDirection === 'sell' ? prefetchData?.tokenBalance : undefined
      );

      if (result.success) {
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
      addLog(task.id, 'error', `[内盘-快速] 交易异常: ${error.message}，尝试慢路径`, walletAddress);
      // fallback 到原有慢路径
      return await executeWalletTrade(task, walletAddress, tradeDirection, sharedFourMemeService);
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
    dexStore: ReturnType<typeof useDexStore>
  ): Promise<boolean> {
    const routerAddress = dexStore.currentRouterAddress;

    if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
      addLog(task.id, 'error', '当前DEX的Router地址未配置', walletAddress);
      return false;
    }

    // 外盘交易：优先使用配置的节点，未配置则跟随网络设置
    const effectiveRpcUrl = task.config.antiSandwichRpc || rpcUrl;
    const tradingService = createTradingService(chainId, effectiveRpcUrl, routerAddress);

    // 卖出模式：如果 sellAll 为 true 则卖出100%
    const sellAll = tradeDirection === 'sell' && task.config.sellAll;

    const tradeMode = tradeDirection === 'buy' ? 'pump' : 'dump';

    // 判断是使用 ASTER 还是 BNB
    // 如果设置了 poolBaseToken，说明是 ASTER 底池，直接用 ASTER 交易
    const useAster = !!task.config.poolBaseToken;
    const spendToken = useAster ? 'ASTER' : 'BNB';
    const amountUnit = useAster ? 'ASTER' : 'BNB';

    const tradeParams: TradeParams = {
      chainId,
      rpcUrl: effectiveRpcUrl,
      routerAddress,
      privateKey,
      walletAddress,
      tokenAddress: task.config.tokenContract,
      spendToken,
      amount,
      amountType: 'amount',
      mode: tradeMode,
      slippage: 30,
      gasPrice: task.config.gasPrice,
      gasLimit: task.config.gasLimit,
      balancePercent: sellAll ? 100 : undefined,
      targetBnbAmount: tradeDirection === 'sell' && !sellAll ? amount : undefined,
      // ASTER 底池时不需要 intermediateToken，直接 ASTER <-> Token
    };

    const result = await tradingService.executeTrade(tradeParams);

    if (result.success) {
      if (tradeDirection === 'buy') {
        task.stats.buyCount++;
      } else {
        task.stats.sellCount++;
      }
      task.stats.spentAmount += amount;

      const actionText = tradeDirection === 'buy' ? '买入' : '卖出';
      const resultText = result.amountOut
        ? `[外盘] ${actionText}成功，花费: ${result.amountIn}, 获得: ${result.amountOut}`
        : `[外盘] ${actionText}成功，金额: ${amount} ${amountUnit}`;

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

  // 执行一轮交易（round-robin + 买卖线程数）
  async function executeRound(task: Task): Promise<void> {
    if (task.status !== 'running') return;

    // 在执行前先检查市值停止条件（仅外盘模式，内盘没有 DEX 交易对）
    if (task.config.stopType === 'marketcap' && task.config.marketType !== 'inner') {
      const currentMarketCap = await getCurrentMarketCap(task);
      if (currentMarketCap !== undefined) {
        addLog(task.id, 'info', `当前市值: ${currentMarketCap.toFixed(4)} BNB, 目标: ${task.config.stopValue} BNB [>=目标停止]`);
        if (checkStopCondition(task, undefined, currentMarketCap)) {
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
    if (task.config.marketType === 'inner') {
      sharedFourMemeService = fourMemeServiceCache.get(task.id);
      if (!sharedFourMemeService) {
        const chainStore = useChainStore();
        const antiSandwichRpc = task.config.antiSandwichRpc || ANTI_SANDWICH_RPC;
        sharedFourMemeService = createFourMemeService(chainStore.selectedChainId, antiSandwichRpc);
        fourMemeServiceCache.set(task.id, sharedFourMemeService);
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

    // ===== ASTER 池内盘快速路径（两阶段执行） =====
    const isAsterInner = task.config.marketType === 'inner' && !!task.config.poolBaseToken && task.preApprovalDone;

    if (isAsterInner && sharedFourMemeService) {
      const allWallets = [...new Set([...buyWallets, ...sellWallets])];

      addLog(task.id, 'info', `[快速路径] 批量预取数据，钱包数: ${allWallets.length}`);

      // 阶段1：批量预取（并行执行 nonce + balance/allowance）
      const tokenAddress = task.config.innerTokenAddress || task.config.tokenContract;
      const baseTokenAddress = task.config.poolBaseToken!;

      const [, prefetchData] = await Promise.all([
        // 批量获取 nonce（因 batch: true，Viem 自动合并为 1 个 HTTP 请求）
        sharedFourMemeService.batchFetchNonces(allWallets),
        // 批量获取余额 + allowance（通过 multicall 合约）
        sharedFourMemeService.batchPrepareRound({
          tokenAddress,
          baseTokenAddress,
          sellWalletAddresses: sellWallets,
          allWalletAddresses: allWallets
        })
      ]);

      // 阶段2：同时发送所有交易（火发即忘）
      const allPromises: Promise<boolean>[] = [];

      if (buyWallets.length > 0) {
        addLog(task.id, 'info', `买入: ${buyWallets.length} 个钱包 [快速]`);
        for (const addr of buyWallets) {
          const data = prefetchData.get(addr.toLowerCase());
          allPromises.push(executeWalletTradeFast(task, addr, 'buy', sharedFourMemeService, data));
        }
      }

      if (sellWallets.length > 0) {
        addLog(task.id, 'info', `卖出: ${sellWallets.length} 个钱包 [快速]`);
        for (const addr of sellWallets) {
          const data = prefetchData.get(addr.toLowerCase());
          allPromises.push(executeWalletTradeFast(task, addr, 'sell', sharedFourMemeService, data));
        }
      }

      await Promise.allSettled(allPromises);

    } else {
      // ===== 非 ASTER 池 / 外盘 / 预授权未完成：走原有路径 =====
      const allPromises: Promise<boolean>[] = [];

      if (buyWallets.length > 0) {
        addLog(task.id, 'info', `买入: ${buyWallets.length} 个钱包`);
        for (const addr of buyWallets) {
          allPromises.push(executeWalletTrade(task, addr, 'buy', sharedFourMemeService));
        }
      }

      if (sellWallets.length > 0) {
        addLog(task.id, 'info', `卖出: ${sellWallets.length} 个钱包`);
        for (const addr of sellWallets) {
          allPromises.push(executeWalletTrade(task, addr, 'sell', sharedFourMemeService));
        }
      }

      await Promise.allSettled(allPromises);
    }

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
  async function startTask(taskId: string): Promise<boolean> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return false;

    if (task.walletAddresses.length === 0) {
      addLog(task.id, 'error', '没有选中任何钱包，无法开始任务');
      return false;
    }

    // 内盘任务：确保 FourMemeService 实例存在（创建任务时已预热）
    if (task.config.marketType === 'inner' && !fourMemeServiceCache.has(taskId)) {
      const chainStore = useChainStore();
      const antiSandwichRpc = task.config.antiSandwichRpc || ANTI_SANDWICH_RPC;
      const service = createFourMemeService(chainStore.selectedChainId, antiSandwichRpc);
      fourMemeServiceCache.set(taskId, service);
    }

    // ASTER 池预授权守卫：等待预授权完成（最多 30 秒）
    if (task.config.marketType === 'inner' && task.config.poolBaseToken && !task.preApprovalDone) {
      const tracker = preApprovalTracker.get(taskId);
      if (tracker && !tracker.completed) {
        addLog(task.id, 'info', '等待预授权完成...');
        try {
          await Promise.race([
            tracker.promise,
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('预授权超时')), 30000))
          ]);
        } catch {
          addLog(task.id, 'warning', '预授权超时，将使用 inline approve 兜底继续执行');
        }
      }
    }

    // 立即设置状态为运行中
    task.status = 'running';
    task.stats.startTime = Date.now();
    task.currentBuyWalletIndex = 0;
    task.currentSellWalletIndex = 0;

    const buyThreadCount = task.config.buyThreadCount || 0;
    const sellThreadCount = task.config.sellThreadCount || 0;
    addLog(task.id, 'info', `任务开始执行，间隔: ${task.config.interval}秒，买${buyThreadCount}/卖${sellThreadCount}，钱包数: ${task.walletAddresses.length}`);

    // 立即执行一轮
    executeRound(task);

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

        await executeRound(latestTask);

        // 递归调度下一轮
        scheduleNextRound();
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
    preApprovalTracker.delete(taskId);

    addLog(task.id, 'info', `任务已停止${reason ? `，原因: ${reason}` : ''}`);
    return true;
  }

  // 删除任务
  function deleteTask(taskId: string): boolean {
    const taskIndex = tasks.value.findIndex(t => t.id === taskId);
    if (taskIndex === -1) return false;

    // 清理缓存的 FourMemeService 实例
    fourMemeServiceCache.delete(taskId);
    // 清理预授权追踪
    preApprovalTracker.delete(taskId);

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

  // 批量更改代币地址（仅内盘任务，仅停止/暂停状态）
  function batchUpdateTokenAddress(taskIds: string[], newTokenAddress: string): number {
    let updatedCount = 0;
    for (const taskId of taskIds) {
      const task = tasks.value.find(t => t.id === taskId);
      if (!task) continue;
      // 只更新内盘任务
      if (task.config.marketType !== 'inner') continue;
      // 只有停止或暂停状态的任务才能更新
      if (task.status === 'running') continue;

      task.config.tokenContract = newTokenAddress;
      task.config.innerTokenAddress = newTokenAddress;
      updatedCount++;
      addLog(taskId, 'info', `代币地址已更新为: ${newTokenAddress}`);
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
  function clearAllTasks() {
    // 停止所有运行中的任务
    tasks.value.forEach(task => {
      if (task.intervalId) {
        clearTimeout(task.intervalId);  // 使用 clearTimeout
      }
    });
    tasks.value = [];
    activeLogTaskId.value = null;
  }

  // 批量删除任务（一次性删除，避免多次触发Vue响应式更新导致渲染问题）
  function deleteMultipleTasks(taskIds: string[]): number {
    if (taskIds.length === 0) return 0;

    // 先停止所有运行中的任务
    for (const taskId of taskIds) {
      const task = tasks.value.find(t => t.id === taskId);
      if (task) {
        if (task.intervalId) {
          clearTimeout(task.intervalId);
          task.intervalId = undefined;
        }
        task.status = 'stopped';
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

    const chainStore = useChainStore();
    const chainId = chainStore.selectedChainId;
    const rpcUrl = chainStore.effectiveRpcUrl;
    const chain = chainId === 97 ? bscTestnet : bsc;

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

  // 批量卖出任务所有钱包的代币（两阶段执行，确保同时上链）
  async function batchSellForTask(taskId: string): Promise<void> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) return;

    const walletStore = useWalletStore();
    const chainStore = useChainStore();
    const dexStore = useDexStore();

    const chainId = chainStore.selectedChainId;
    const rpcUrl = chainStore.effectiveRpcUrl;

    const tokenAddress = task.config.marketType === 'inner'
      ? (task.config.innerTokenAddress || task.config.tokenContract)
      : task.config.tokenContract;

    if (!tokenAddress) {
      addLog(taskId, 'error', '未设置代币合约地址');
      return;
    }

    // 内盘模式：使用两阶段卖出，确保所有交易同时发送
    // 批量卖出使用 Binance 官方节点（支持 CORS，不限流）
    if (task.config.marketType === 'inner') {
      const antiSandwichRpc = 'https://bsc-dataseed.binance.org';
      const sharedFourMemeService = createFourMemeService(chainId, antiSandwichRpc);

      addLog(taskId, 'info', `[阶段1] 准备卖出，检查余额和授权，钱包数: ${task.walletAddresses.length}...`);

      // ========== 第一阶段：准备（检查余额、处理授权）==========
      const preparePromises = task.walletAddresses.map(async (walletAddress) => {
        const privateKey = getWalletPrivateKey(walletStore, walletAddress);
        if (!privateKey) {
          addLog(taskId, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
          return null;
        }

        const prepareResult = await sharedFourMemeService.prepareSell({
          chainId,
          rpcUrl: antiSandwichRpc,
          privateKey,
          walletAddress,
          tokenAddress,
          amount: 0,
          mode: 'sell',
          gasPrice: task.config.gasPrice,
          gasLimit: task.config.gasLimit,
          sellPercent: 100,
          slippage: task.config.innerSlippage,
        });

        if (prepareResult.success) {
          if (prepareResult.needsApproval) {
            addLog(taskId, 'info', `${walletAddress.slice(0, 10)}... 授权完成`, walletAddress);
          } else {
            addLog(taskId, 'info', `${walletAddress.slice(0, 10)}... 已授权，准备就绪`, walletAddress);
          }
          return { walletAddress, privateKey, sellAmount: prepareResult.sellAmount };
        } else {
          addLog(taskId, 'error', `${walletAddress.slice(0, 10)}... 准备失败: ${prepareResult.error}`, walletAddress);
          return null;
        }
      });

      const prepareResults = await Promise.all(preparePromises);
      const readyWallets = prepareResults.filter((r): r is { walletAddress: string; privateKey: string; sellAmount: bigint } => r !== null);

      if (readyWallets.length === 0) {
        addLog(taskId, 'warning', '没有钱包准备成功，取消批量卖出');
        return;
      }

      addLog(taskId, 'info', `[阶段2] 准备完成，${readyWallets.length} 个钱包同时发送卖出交易...`);

      // ========== 第二阶段：同时发送所有卖出交易 ==========
      const sellPromises = readyWallets.map(async ({ walletAddress, privateKey, sellAmount }) => {
        const result = await sharedFourMemeService.executeSellDirect({
          chainId,
          rpcUrl: antiSandwichRpc,
          privateKey,
          walletAddress,
          tokenAddress,
          amount: 0,
          mode: 'sell',
          gasPrice: task.config.gasPrice,
          gasLimit: task.config.gasLimit,
          slippage: task.config.innerSlippage,
        }, sellAmount);

        if (result.success) {
          addLog(taskId, 'success', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出成功`, walletAddress, result.txHash);
        } else {
          addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出失败: ${result.error}`, walletAddress);
        }
      });

      await Promise.allSettled(sellPromises);
      addLog(taskId, 'info', `批量卖出操作完成，共发送 ${readyWallets.length} 笔交易`);

    } else {
      // 外盘模式：优先使用配置的节点，未配置则跟随网络设置
      const effectiveRpcUrl = task.config.antiSandwichRpc || rpcUrl;
      // 判断是使用 ASTER 还是 BNB
      const useAster = !!task.config.poolBaseToken;
      const spendToken = useAster ? 'ASTER' : 'BNB';
      addLog(taskId, 'info', `开始批量卖出，钱包数: ${task.walletAddresses.length}，底池: ${spendToken}，使用最大线程并行执行...`);

      const promises = task.walletAddresses.map(async (walletAddress) => {
        const privateKey = getWalletPrivateKey(walletStore, walletAddress);
        if (!privateKey) {
          addLog(taskId, 'error', `钱包 ${walletAddress.slice(0, 10)}... 没有私钥，跳过`, walletAddress);
          return;
        }

        try {
          const routerAddress = dexStore.currentRouterAddress;
          if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
            addLog(taskId, 'error', '当前DEX的Router地址未配置', walletAddress);
            return;
          }

          const tradingService = createTradingService(chainId, effectiveRpcUrl, routerAddress);
          const result = await tradingService.executeTrade({
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
            slippage: 30,
            gasPrice: task.config.gasPrice,
            gasLimit: task.config.gasLimit,
            balancePercent: 100,
            // ASTER 底池时不需要 intermediateToken
          });

          if (result.success) {
            addLog(taskId, 'success', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出成功`, walletAddress, result.txHash);
          } else {
            addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 卖出失败: ${result.error}`, walletAddress);
          }
        } catch (error: any) {
          addLog(taskId, 'error', `[批量卖出] ${walletAddress.slice(0, 10)}... 异常: ${error.message}`, walletAddress);
        }
      });

      await Promise.allSettled(promises);
      addLog(taskId, 'info', `批量卖出操作完成`);
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
