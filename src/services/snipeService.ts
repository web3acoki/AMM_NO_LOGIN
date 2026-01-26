/**
 * FourMeme 代币狙击服务
 *
 * 功能：
 * 1. 监听 TokenCreated 事件
 * 2. 检测目标钱包创建的代币
 * 3. 自动执行买入交易
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  parseEther,
  formatEther,
  keccak256,
  toHex,
  concat,
  type PublicClient,
  type WalletClient,
  type Log
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ==================== 常量配置 ====================

export const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as const;
export const BUY_METHOD_SELECTOR = '0x87f27655' as const;
export const TOKEN_CREATED_EVENT_SIGNATURE = '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20' as const;

// 创建代币的方法选择器
export const CREATE_TOKEN_SELECTORS = [
  '0x519ebb10', // createAndBuy
  '0x47ee97ff', // 其他创建方法
  '0x810c705b', // 其他创建方法
] as const;

// CREATE2 地址预测参数
const DEPLOYER = '0x757eba15a64468e6535532fcf093cef90e226f85';
const INIT_CODE_HASH = '0x3eb722ec5d79ddc2f52880ea62f1b7e7d95c66d4ae0dfe32f988ca9eca52b359';
const CREATE_AND_BUY_SELECTOR = '0x519ebb10';

// WebSocket RPC 节点
export const WSS_RPC_NODES = [
  'wss://bsc.publicnode.com',
  'wss://bsc-rpc.publicnode.com',
];

// HTTP RPC 节点（用于发送交易）
export const HTTP_RPC_NODES = [
  'https://bsc.publicnode.com',
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
];

// ==================== 类型定义 ====================

export interface SnipeTaskConfig {
  id: string;
  targetWallet: string;      // 被监听的目标钱包
  buyAmount: number;         // 买入金额 (BNB)
  gasPrice: number;          // Gas Price (Gwei)
  gasLimit: number;          // Gas Limit
  wallets: SnipeWallet[];    // 执行买入的钱包列表
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  createdAt: number;
  customHttpRpc?: string;    // 自定义 HTTP RPC
  customWssRpc?: string;     // 自定义 WebSocket
}

export interface SnipeWallet {
  address: string;
  privateKey: string;
  remark?: string;
}

export interface SnipeLog {
  timestamp: number;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: any;
}

export interface TokenCreatedEvent {
  creator: string;
  token: string;
  blockNumber: bigint;
  transactionHash: string;
}

export interface BuyResult {
  success: boolean;
  walletAddress: string;
  txHash?: string;
  error?: string;
  tokensBought?: string;
}

// ==================== 工具函数 ====================

/**
 * 计算 CREATE2 地址
 */
function computeCreate2Address(deployer: string, salt: string, initCodeHash: string): string {
  const deployerHex = deployer.toLowerCase().replace('0x', '');
  const saltHex = salt.replace('0x', '').padStart(64, '0');
  const hashHex = initCodeHash.replace('0x', '');
  const data = ('0xff' + deployerHex + saltHex + hashHex) as `0x${string}`;
  const hash = keccak256(data);
  return '0x' + hash.slice(-40);
}

/**
 * 从 createAndBuy 交易 input 中预测代币地址
 * 关键发现: Field5 (第 6 个字段) 就是 salt
 */
export function predictTokenAddress(txInput: string): string | null {
  // 检查是否是 createAndBuy 方法
  if (!txInput.toLowerCase().startsWith(CREATE_AND_BUY_SELECTOR)) {
    return null;
  }

  // 去掉方法选择器 (4 bytes = 8 hex chars)
  const inputData = txInput.slice(10);

  // Field5 在第 6 个字段 (index 5)，每个字段 64 个 hex 字符
  const field5Start = 5 * 64;
  const field5End = field5Start + 64;

  if (inputData.length < field5End) {
    return null;
  }

  const salt = '0x' + inputData.slice(field5Start, field5End);

  // 计算地址
  return computeCreate2Address(DEPLOYER, salt, INIT_CODE_HASH);
}

/**
 * 构建买入交易的 calldata
 */
export function buildBuyCalldata(tokenAddress: string, minAmountOut: bigint = 0n, flags: bigint = 0n): `0x${string}` {
  const encodedToken = tokenAddress.slice(2).toLowerCase().padStart(64, '0');
  const encodedMinOut = minAmountOut.toString(16).padStart(64, '0');
  const encodedFlags = flags.toString(16).padStart(64, '0');

  return (BUY_METHOD_SELECTOR + encodedToken + encodedMinOut + encodedFlags) as `0x${string}`;
}

/**
 * 解析 TokenCreated 事件
 */
export function parseTokenCreatedEvent(log: Log): TokenCreatedEvent {
  const data = log.data.slice(2);

  // Field 0: creator address (offset 24-64 of first word)
  // Field 1: token address (offset 24-64 of second word)
  const creator = '0x' + data.slice(24, 64);
  const token = '0x' + data.slice(64 + 24, 128);

  return {
    creator,
    token,
    blockNumber: log.blockNumber || 0n,
    transactionHash: log.transactionHash || ''
  };
}

/**
 * 获取链配置
 */
function getChainConfig(chainId: number) {
  return chainId === 97 ? bscTestnet : bsc;
}

// ==================== 狙击服务类 ====================

export class SnipeService {
  private task: SnipeTaskConfig;
  private chainId: number;
  private httpRpcUrl: string;
  private wssRpcUrl: string;
  private wsClient: PublicClient | null = null;
  private httpClient: PublicClient | null = null;
  private rawWs: WebSocket | null = null;  // 原生 WebSocket 用于 pending 监听
  private walletClients: Map<string, WalletClient> = new Map();
  private unwatch: (() => void) | null = null;
  private isRunning: boolean = false;
  private pendingTxProcessed: Set<string> = new Set();  // 已处理的 pending 交易
  private pendingTxQueue: string[] = [];  // 待处理的交易队列
  private isProcessingQueue: boolean = false;  // 是否正在处理队列
  private maxConcurrentRequests: number = 5;  // 最大并发请求数
  private activeRequests: number = 0;  // 当前活跃请求数
  private logs: SnipeLog[] = [];
  private onLog: ((log: SnipeLog) => void) | null = null;
  private onTokenFound: ((event: TokenCreatedEvent) => void) | null = null;
  private onBuyComplete: ((results: BuyResult[]) => void) | null = null;
  private onStatusChange: ((status: SnipeTaskConfig['status']) => void) | null = null;

  constructor(
    task: SnipeTaskConfig,
    chainId: number = 56,
    httpRpcUrl?: string,
    wssRpcUrl?: string
  ) {
    this.task = task;
    this.chainId = chainId;
    // 优先使用传入的自定义节点，其次使用任务配置的，最后使用默认
    this.httpRpcUrl = httpRpcUrl || task.customHttpRpc || HTTP_RPC_NODES[0];
    this.wssRpcUrl = wssRpcUrl || task.customWssRpc || WSS_RPC_NODES[0];
  }

  // ==================== 事件回调设置 ====================

  setOnLog(callback: (log: SnipeLog) => void) {
    this.onLog = callback;
  }

  setOnTokenFound(callback: (event: TokenCreatedEvent) => void) {
    this.onTokenFound = callback;
  }

  setOnBuyComplete(callback: (results: BuyResult[]) => void) {
    this.onBuyComplete = callback;
  }

  setOnStatusChange(callback: (status: SnipeTaskConfig['status']) => void) {
    this.onStatusChange = callback;
  }

  // ==================== 日志方法 ====================

  private log(type: SnipeLog['type'], message: string, data?: any) {
    const logEntry: SnipeLog = {
      timestamp: Date.now(),
      type,
      message,
      data
    };
    this.logs.push(logEntry);
    this.onLog?.(logEntry);

    // 控制台输出
    const prefix = {
      info: '[INFO]',
      success: '[SUCCESS]',
      error: '[ERROR]',
      warning: '[WARNING]'
    }[type];
    console.log(`${prefix} ${message}`, data || '');
  }

  // ==================== 初始化方法 ====================

  /**
   * 初始化服务
   */
  async initialize(): Promise<boolean> {
    try {
      this.log('info', '正在初始化狙击服务...');

      // 创建 HTTP 客户端（用于发送交易和查询）
      this.httpClient = createPublicClient({
        chain: getChainConfig(this.chainId),
        transport: http(this.httpRpcUrl)
      });

      this.log('info', `HTTP RPC: ${this.httpRpcUrl}`);

      // 尝试创建 WebSocket 客户端
      try {
        this.wsClient = createPublicClient({
          chain: getChainConfig(this.chainId),
          transport: webSocket(this.wssRpcUrl)
        });
        // 测试 WebSocket 连接
        await this.wsClient.getBlockNumber();
        this.log('success', `WebSocket 连接成功: ${this.wssRpcUrl}`);
      } catch (wsError: any) {
        this.log('warning', `WebSocket 不可用，使用 HTTP 轮询模式`);
        this.wsClient = null;
      }

      // 预创建钱包客户端
      for (const wallet of this.task.wallets) {
        try {
          const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
          const walletClient = createWalletClient({
            account,
            chain: getChainConfig(this.chainId),
            transport: http(this.httpRpcUrl)
          });
          this.walletClients.set(wallet.address.toLowerCase(), walletClient);
          this.log('info', `钱包已加载: ${wallet.address.slice(0, 10)}...`);
        } catch (e: any) {
          this.log('error', `钱包加载失败: ${wallet.address}`, e.message);
        }
      }

      this.log('success', '狙击服务初始化完成');
      return true;

    } catch (error: any) {
      this.log('error', '初始化失败', error.message);
      return false;
    }
  }

  // ==================== 监听方法 ====================

  /**
   * 开始监听
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.log('warning', '监听已经在运行中');
      return;
    }

    const initialized = await this.initialize();
    if (!initialized) {
      this.updateStatus('failed');
      return;
    }

    this.isRunning = true;
    this.updateStatus('running');

    this.log('info', `开始监听目标钱包: ${this.task.targetWallet}`);
    this.log('info', `买入金额: ${this.task.buyAmount} BNB`);
    this.log('info', `Gas: ${this.task.gasPrice > 0 ? this.task.gasPrice + ' Gwei' : '自动'}, Limit: ${this.task.gasLimit > 0 ? this.task.gasLimit : '自动'}`);
    this.log('info', `执行钱包数量: ${this.task.wallets.length}`);

    // 同时启动三种监听模式
    this.startPendingTxMonitor();      // WebSocket Pending 监听（最快）
    this.startHttpPendingPolling();    // HTTP Pending 轮询（备份，也支持预测）
    this.startPolling();               // 区块轮询（最后备份）
  }

  /**
   * HTTP 轮询 Pending 交易池 - 支持地址预测
   */
  private startHttpPendingPolling() {
    if (!this.httpClient) return;

    this.log('info', '启动 HTTP Pending 轮询...');
    let lastCheckedHashes = new Set<string>();

    const pollPending = async () => {
      if (!this.isRunning || !this.httpClient) return;

      try {
        // 获取 pending 区块的交易
        const pendingBlock = await this.httpClient.getBlock({
          blockTag: 'pending',
          includeTransactions: true
        });

        if (pendingBlock && pendingBlock.transactions) {
          for (const tx of pendingBlock.transactions) {
            // 跳过已处理的交易
            if (typeof tx === 'string') continue;
            if (lastCheckedHashes.has(tx.hash)) continue;
            lastCheckedHashes.add(tx.hash);

            // 限制缓存大小
            if (lastCheckedHashes.size > 1000) {
              const first = lastCheckedHashes.values().next().value;
              if (first) lastCheckedHashes.delete(first);
            }

            // 检查是否是 FourMeme createAndBuy
            if (tx.to?.toLowerCase() !== FOURMEME_CONTRACT.toLowerCase()) continue;
            const methodSelector = tx.input.slice(0, 10).toLowerCase();
            if (methodSelector !== CREATE_AND_BUY_SELECTOR) continue;

            this.log('info', `[HTTP Pending] 检测到 FourMeme createAndBuy`);
            this.log('info', `[HTTP Pending] 发送者: ${tx.from}`);

            // 检查是否是目标钱包
            if (tx.from.toLowerCase() !== this.task.targetWallet.toLowerCase()) {
              this.log('info', `[HTTP Pending] 非目标钱包，忽略`);
              continue;
            }

            this.log('success', `🚀 [HTTP Pending预测] 检测到目标钱包创建交易!`);

            // 预测地址
            const predictedToken = predictTokenAddress(tx.input);
            if (!predictedToken) {
              this.log('error', '无法预测代币地址');
              continue;
            }

            this.log('success', `🎯 [预测地址] ${predictedToken}`);
            this.log('info', `⚡ 立即发送买入交易!`);

            const event: TokenCreatedEvent = {
              creator: tx.from,
              token: predictedToken,
              blockNumber: 0n,
              transactionHash: tx.hash
            };
            this.onTokenFound?.(event);

            const results = await this.executeBuy(predictedToken);
            this.onBuyComplete?.(results);

            this.stop();
            this.updateStatus('completed');
            return;
          }
        }
      } catch (e) {
        // 忽略错误，继续轮询
      }

      // 继续轮询（每 200ms）
      if (this.isRunning) {
        setTimeout(pollPending, 200);
      }
    };

    pollPending();
  }

  /**
   * 使用原生 WebSocket 监听 Pending 交易
   */
  private startPendingTxMonitor() {
    try {
      this.rawWs = new WebSocket(this.wssRpcUrl);
      let pendingCount = 0;
      let fourMemeCount = 0;

      this.rawWs.onopen = () => {
        this.log('success', 'Pending 监听 WebSocket 已连接');

        // 订阅 pending 交易
        const subscribeMsg = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_subscribe',
          params: ['newPendingTransactions']
        });
        this.rawWs?.send(subscribeMsg);

        // 定期输出 pending 统计
        const statsInterval = setInterval(() => {
          if (!this.isRunning) {
            clearInterval(statsInterval);
            return;
          }
          if (pendingCount > 0) {
            this.log('info', `[Pending统计] 收到: ${pendingCount}, FourMeme相关: ${fourMemeCount}`);
            pendingCount = 0;
            fourMemeCount = 0;
          }
        }, 10000);
      };

      this.rawWs.onmessage = async (event) => {
        if (!this.isRunning) return;

        try {
          const data = JSON.parse(event.data);

          // 订阅确认
          if (data.id === 1 && data.result) {
            this.log('success', `Pending 交易订阅成功，订阅ID: ${data.result}`);
            return;
          }

          // Pending 交易通知
          if (data.method === 'eth_subscription' && data.params?.result) {
            const txHash = data.params.result;
            pendingCount++;
            this.queuePendingTx(txHash);
          }
        } catch (e) {
          // 忽略解析错误
        }
      };

      this.rawWs.onerror = (error) => {
        this.log('warning', 'Pending 监听 WebSocket 错误，将依赖区块轮询模式');
      };

      this.rawWs.onclose = () => {
        this.log('warning', 'Pending 监听 WebSocket 已断开');
      };

    } catch (e: any) {
      this.log('warning', `Pending 监听启动失败: ${e.message}`);
    }
  }

  /**
   * 将交易加入队列
   */
  private queuePendingTx(txHash: string) {
    // 避免重复处理
    if (this.pendingTxProcessed.has(txHash)) return;
    this.pendingTxProcessed.add(txHash);

    // 限制缓存大小
    if (this.pendingTxProcessed.size > 5000) {
      const first = this.pendingTxProcessed.values().next().value;
      this.pendingTxProcessed.delete(first);
    }

    // 限制队列大小，避免积压
    if (this.pendingTxQueue.length < 100) {
      this.pendingTxQueue.push(txHash);
    }

    // 启动队列处理
    this.processQueue();
  }

  /**
   * 处理交易队列（限流）
   */
  private async processQueue() {
    if (this.isProcessingQueue || !this.isRunning) return;
    this.isProcessingQueue = true;

    while (this.pendingTxQueue.length > 0 && this.isRunning) {
      // 等待有空闲的请求槽位
      if (this.activeRequests >= this.maxConcurrentRequests) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const txHash = this.pendingTxQueue.shift();
      if (txHash) {
        this.processPendingTx(txHash);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * 处理 Pending 交易 - 使用地址预测实现同区块买入
   */
  private async processPendingTx(txHash: string) {
    if (!this.httpClient || !this.isRunning) return;

    this.activeRequests++;

    try {
      const tx = await this.httpClient.getTransaction({ hash: txHash as `0x${string}` });
      if (!tx) return;

      // 检查是否是 FourMeme 合约
      if (tx.to?.toLowerCase() !== FOURMEME_CONTRACT.toLowerCase()) return;

      // 检查是否是 createAndBuy 方法 (只有这个方法支持地址预测)
      const methodSelector = tx.input.slice(0, 10).toLowerCase();
      if (methodSelector !== CREATE_AND_BUY_SELECTOR) return;

      // 这是一个 FourMeme createAndBuy 交易！
      this.log('info', `[Pending] 检测到 FourMeme createAndBuy 交易`);
      this.log('info', `[Pending] 发送者: ${tx.from}`);
      this.log('info', `[Pending] 目标钱包: ${this.task.targetWallet}`);

      // 检查是否是目标钱包
      if (tx.from.toLowerCase() !== this.task.targetWallet.toLowerCase()) {
        this.log('info', `[Pending] 非目标钱包，忽略`);
        return;
      }

      this.log('success', `🚀 [Pending预测] 检测到目标钱包创建交易!`);
      this.log('info', `交易哈希: ${txHash}`);

      // 🎯 关键: 立即预测代币地址，不等待确认
      const predictedToken = predictTokenAddress(tx.input);

      if (!predictedToken) {
        this.log('error', '无法预测代币地址，等待交易确认...');
        // 回退到原来的等待确认逻辑
        await this.waitAndBuyConfirmed(txHash);
        return;
      }

      this.log('success', `🎯 [预测地址] ${predictedToken}`);
      this.log('info', `⚡ 立即发送买入交易，不等待创建确认!`);

      // 触发事件
      const event: TokenCreatedEvent = {
        creator: tx.from,
        token: predictedToken,
        blockNumber: 0n,  // pending 交易还没有区块号
        transactionHash: txHash
      };
      this.onTokenFound?.(event);

      // 🚀 立即执行买入 (与创建交易同时 pending)
      const results = await this.executeBuy(predictedToken);
      this.onBuyComplete?.(results);

      // 任务完成
      this.stop();
      this.updateStatus('completed');

    } catch (e) {
      // 忽略单个交易错误
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * 等待交易确认后买入 (备用方法)
   */
  private async waitAndBuyConfirmed(txHash: string) {
    if (!this.httpClient) return;

    try {
      const receipt = await this.httpClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: 60000
      });

      if (receipt.status === 'success') {
        const tokenCreatedLog = receipt.logs.find(log =>
          log.topics[0]?.toLowerCase() === TOKEN_CREATED_EVENT_SIGNATURE.toLowerCase()
        );

        if (tokenCreatedLog) {
          const event = parseTokenCreatedEvent(tokenCreatedLog);
          this.log('success', `🎯 代币地址 (确认): ${event.token}`);

          this.onTokenFound?.(event);

          const results = await this.executeBuy(event.token);
          this.onBuyComplete?.(results);

          this.stop();
          this.updateStatus('completed');
        }
      }
    } catch (e) {
      this.log('error', '等待交易确认失败');
    }
  }

  /**
   * 使用轮询方式监听事件
   */
  private startPolling() {
    if (!this.httpClient) return;

    let lastBlockNumber = 0n;
    let pollCount = 0;

    this.log('info', '启动 HTTP 轮询监听...');

    const poll = async () => {
      if (!this.isRunning || !this.httpClient) return;

      try {
        const currentBlock = await this.httpClient.getBlockNumber();

        if (lastBlockNumber === 0n) {
          lastBlockNumber = currentBlock;
          this.log('info', `开始从区块 ${currentBlock} 监听...`);
        }

        if (currentBlock > lastBlockNumber) {
          try {
            // 查询新区块的所有 FourMeme 合约事件
            const logs = await this.httpClient.getLogs({
              address: FOURMEME_CONTRACT,
              fromBlock: lastBlockNumber + 1n,
              toBlock: currentBlock
            });

            // 过滤出 TokenCreated 事件
            const tokenCreatedLogs = logs.filter(log =>
              log.topics[0]?.toLowerCase() === TOKEN_CREATED_EVENT_SIGNATURE.toLowerCase()
            );

            if (tokenCreatedLogs.length > 0) {
              this.log('info', `区块 ${lastBlockNumber + 1n}-${currentBlock} 发现 ${tokenCreatedLogs.length} 个代币创建事件`);
            }

            for (const log of tokenCreatedLogs) {
              await this.handleTokenCreatedEvent(log);
            }

            lastBlockNumber = currentBlock;
          } catch (e) {
            // 偶发的 RPC 错误，忽略继续
          }
        }

        // 每 100 次轮询输出一次心跳日志（约10秒）
        pollCount++;
        if (pollCount % 100 === 0) {
          this.log('info', `监听中... 当前区块: ${currentBlock}`);
        }

      } catch (error: any) {
        // 获取区块号失败，静默忽略
      }

      // 继续轮询（每 100ms）
      if (this.isRunning) {
        setTimeout(poll, 100);
      }
    };

    poll();
  }

  /**
   * 处理 TokenCreated 事件
   */
  private async handleTokenCreatedEvent(log: Log) {
    try {
      const event = parseTokenCreatedEvent(log);

      this.log('info', `检测到新代币创建: ${event.token.slice(0, 10)}...`);
      this.log('info', `创建者: ${event.creator}`);

      // 检查是否为目标钱包
      if (event.creator.toLowerCase() === this.task.targetWallet.toLowerCase()) {
        this.log('success', `🎯 目标钱包创建代币！Token: ${event.token}`);

        // 触发回调
        this.onTokenFound?.(event);

        // 执行买入
        const results = await this.executeBuy(event.token);

        // 触发买入完成回调
        this.onBuyComplete?.(results);

        // 任务完成（一次性）
        this.stop();
        this.updateStatus('completed');
      }
    } catch (error: any) {
      this.log('error', `处理事件失败: ${error.message}`);
    }
  }

  // ==================== 买入方法 ====================

  /**
   * 执行买入（所有钱包并行）
   */
  private async executeBuy(tokenAddress: string): Promise<BuyResult[]> {
    this.log('info', `开始执行买入，代币: ${tokenAddress}`);

    const buyPromises = this.task.wallets.map(wallet =>
      this.buyWithWallet(wallet, tokenAddress)
    );

    const results = await Promise.all(buyPromises);

    // 统计结果
    const successCount = results.filter(r => r.success).length;
    this.log('info', `买入完成: ${successCount}/${results.length} 成功`);

    return results;
  }

  /**
   * 单个钱包买入
   */
  private async buyWithWallet(wallet: SnipeWallet, tokenAddress: string): Promise<BuyResult> {
    const walletClient = this.walletClients.get(wallet.address.toLowerCase());

    if (!walletClient) {
      return {
        success: false,
        walletAddress: wallet.address,
        error: '钱包客户端未初始化'
      };
    }

    try {
      const startTime = Date.now();

      // 构建 calldata
      const calldata = buildBuyCalldata(tokenAddress);

      // 构建交易参数 - 彻底解决科学计数法问题
      // 将数字转换为最小单位 (wei)，避免任何浮点数问题
      const buyAmountWei = BigInt(Math.floor(this.task.buyAmount * 1e18));
      const txParams: any = {
        to: FOURMEME_CONTRACT as `0x${string}`,
        data: calldata,
        value: buyAmountWei
      };

      // 设置 gasLimit
      if (this.task.gasLimit > 0) {
        txParams.gas = BigInt(this.task.gasLimit);
      }

      // 设置 gasPrice
      if (this.task.gasPrice > 0) {
        txParams.gasPrice = BigInt(this.task.gasPrice) * BigInt(1e9);
      }

      this.log('info', `发送买入交易: ${wallet.address.slice(0, 10)}...`);

      // 发送交易
      const txHash = await walletClient.sendTransaction(txParams);

      const elapsed = Date.now() - startTime;
      this.log('success', `交易已发送: ${txHash.slice(0, 20)}... (${elapsed}ms)`);

      // 等待确认（可选，不阻塞其他钱包）
      if (this.httpClient) {
        this.httpClient.waitForTransactionReceipt({ hash: txHash }).then(receipt => {
          if (receipt.status === 'success') {
            this.log('success', `交易确认成功: ${txHash.slice(0, 20)}...`);
          } else {
            this.log('error', `交易执行失败: ${txHash.slice(0, 20)}...`);
          }
        }).catch(e => {
          this.log('warning', `等待确认超时: ${txHash.slice(0, 20)}...`);
        });
      }

      return {
        success: true,
        walletAddress: wallet.address,
        txHash
      };

    } catch (error: any) {
      this.log('error', `钱包 ${wallet.address.slice(0, 10)}... 买入失败: ${error.message}`);
      return {
        success: false,
        walletAddress: wallet.address,
        error: error.message
      };
    }
  }

  // ==================== 控制方法 ====================

  /**
   * 停止监听
   */
  stop() {
    this.isRunning = false;
    this.unwatch?.();
    this.unwatch = null;

    // 关闭原生 WebSocket
    if (this.rawWs) {
      this.rawWs.close();
      this.rawWs = null;
    }

    // 清空队列
    this.pendingTxQueue = [];
    this.isProcessingQueue = false;

    this.log('info', '监听已停止');
  }

  /**
   * 更新状态
   */
  private updateStatus(status: SnipeTaskConfig['status']) {
    this.task.status = status;
    this.onStatusChange?.(status);
  }

  /**
   * 获取日志
   */
  getLogs(): SnipeLog[] {
    return [...this.logs];
  }

  /**
   * 获取任务状态
   */
  getStatus(): SnipeTaskConfig['status'] {
    return this.task.status;
  }

  /**
   * 清理资源
   */
  destroy() {
    this.stop();
    this.walletClients.clear();
    this.pendingTxProcessed.clear();
    this.pendingTxQueue = [];
    this.isProcessingQueue = false;
    this.activeRequests = 0;
    this.wsClient = null;
    this.httpClient = null;
    this.logs = [];
  }
}

// ==================== 导出工厂函数 ====================

export function createSnipeService(
  task: SnipeTaskConfig,
  chainId?: number,
  httpRpcUrl?: string,
  wssRpcUrl?: string
): SnipeService {
  return new SnipeService(task, chainId, httpRpcUrl, wssRpcUrl);
}
