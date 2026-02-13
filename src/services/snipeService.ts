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

// HTTP RPC 节点池（多个公共节点分散压力）
export const HTTP_RPC_NODES = [
  'https://bsc.publicnode.com',
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-dataseed2.ninicoin.io',
  'https://rpc.ankr.com/bsc',
  'https://bsc-rpc.publicnode.com',
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
  private logs: SnipeLog[] = [];
  private onLog: ((log: SnipeLog) => void) | null = null;
  private onTokenFound: ((event: TokenCreatedEvent) => void) | null = null;
  private onBuyComplete: ((results: BuyResult[]) => void) | null = null;
  private onStatusChange: ((status: SnipeTaskConfig['status']) => void) | null = null;

  // 多节点请求池
  private httpClients: PublicClient[] = [];
  private nodeIndex: number = 0;
  private activeRequests: number = 0;
  private maxConcurrentRequests: number = 50;  // 提高并发限制到 50
  private fourMemeDetected: number = 0;  // FourMeme 交易检测计数

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

      // 创建主 HTTP 客户端（用于发送交易）
      this.httpClient = createPublicClient({
        chain: getChainConfig(this.chainId),
        transport: http(this.httpRpcUrl)
      });

      this.log('info', `主节点: ${this.httpRpcUrl}`);

      // 创建多节点 HTTP 客户端池（用于 pending 查询，分散压力）
      const nodesToUse = this.task.customHttpRpc
        ? [this.task.customHttpRpc]  // 如果有自定义节点，只用自定义的
        : HTTP_RPC_NODES;            // 否则使用所有公共节点

      for (const rpcUrl of nodesToUse) {
        try {
          const client = createPublicClient({
            chain: getChainConfig(this.chainId),
            transport: http(rpcUrl, { timeout: 5000 })  // 5秒超时
          });
          this.httpClients.push(client);
        } catch (e) {
          // 忽略创建失败的节点
        }
      }

      this.log('info', `节点池: ${this.httpClients.length} 个节点`);

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

  /**
   * 获取下一个 HTTP 客户端（轮询）
   */
  private getNextClient(): PublicClient | null {
    if (this.httpClients.length === 0) return this.httpClient;
    const client = this.httpClients[this.nodeIndex % this.httpClients.length];
    this.nodeIndex++;
    return client;
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

    // 判断监听模式
    const isWatchAll = !this.task.targetWallet || this.task.targetWallet.trim() === '';
    if (isWatchAll) {
      this.log('warning', `⚠️ 监听模式: 所有创建代币交易 (测试模式)`);
    } else {
      this.log('info', `监听目标钱包: ${this.task.targetWallet}`);
    }
    this.log('info', `买入金额: ${this.task.buyAmount.toFixed(18).replace(/\.?0+$/, '')} BNB`);
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

            // 限制缓存大小（只是为了内存，不影响处理）
            if (lastCheckedHashes.size > 50000) {
              const first = lastCheckedHashes.values().next().value;
              if (first) lastCheckedHashes.delete(first);
            }

            // 检查是否是 FourMeme createAndBuy
            if (tx.to?.toLowerCase() !== FOURMEME_CONTRACT.toLowerCase()) continue;
            const methodSelector = tx.input.slice(0, 10).toLowerCase();
            if (methodSelector !== CREATE_AND_BUY_SELECTOR) continue;

            const detectTime = Date.now();
            const isWatchAll = !this.task.targetWallet || this.task.targetWallet.trim() === '';

            this.log('info', `[HTTP Pending] 检测到 FourMeme createAndBuy`);
            this.log('info', `[HTTP Pending] 发送者: ${tx.from}`);

            // 检查是否是目标钱包（如果设置了的话）
            if (!isWatchAll && tx.from.toLowerCase() !== this.task.targetWallet.toLowerCase()) {
              continue;
            }

            if (isWatchAll) {
              this.log('success', `🚀 [HTTP Pending] 检测到创建交易! (监听所有)`);
            } else {
              this.log('success', `🚀 [HTTP Pending] 目标钱包创建交易!`);
            }

            // 预测地址
            const predictStartTime = Date.now();
            const predictedToken = predictTokenAddress(tx.input);
            const predictTime = Date.now() - predictStartTime;

            if (!predictedToken) {
              this.log('error', '无法预测代币地址');
              continue;
            }

            this.log('success', `🎯 [预测地址] ${predictedToken}`);
            this.log('info', `⏱️ 预测耗时: ${predictTime}ms`);

            const event: TokenCreatedEvent = {
              creator: tx.from,
              token: predictedToken,
              blockNumber: 0n,
              transactionHash: tx.hash
            };
            this.onTokenFound?.(event);

            // 执行买入
            const buyStartTime = Date.now();
            this.log('info', `⚡ 开始买入...`);
            const results = await this.executeBuy(predictedToken);
            const buyTime = Date.now() - buyStartTime;

            this.log('info', `⏱️ 买入耗时: ${buyTime}ms`);
            this.log('info', `⏱️ 总耗时 (检测到买入完成): ${Date.now() - detectTime}ms`);

            this.onBuyComplete?.(results);

            // 验证预测
            this.verifyPrediction(tx.hash, predictedToken, detectTime);

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
   * 使用原生 WebSocket 监听 Pending 交易 - 带自动重连
   */
  private startPendingTxMonitor() {
    let pendingCount = 0;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    const connect = () => {
      if (!this.isRunning) return;

      try {
        this.rawWs = new WebSocket(this.wssRpcUrl);

        this.rawWs.onopen = () => {
          reconnectAttempts = 0;
          this.log('success', `WebSocket Pending 监听已连接: ${this.wssRpcUrl}`);

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
            this.log('info', `[Pending统计] 10秒内收到: ${pendingCount}, FourMeme: ${this.fourMemeDetected}, 当前并发: ${this.activeRequests}`);
            pendingCount = 0;
            this.fourMemeDetected = 0;
          }, 10000);
        };

        this.rawWs.onmessage = async (event) => {
          if (!this.isRunning) return;

          try {
            const data = JSON.parse(event.data);

            // 订阅确认
            if (data.id === 1 && data.result) {
              this.log('success', `Pending 订阅成功，ID: ${data.result}`);
              return;
            }

            // Pending 交易通知 - 直接处理，无限制
            if (data.method === 'eth_subscription' && data.params?.result) {
              const txHash = data.params.result;
              pendingCount++;

              // 避免重复处理
              if (this.pendingTxProcessed.has(txHash)) return;
              this.pendingTxProcessed.add(txHash);

              // 限制缓存大小（只是为了内存，不影响处理）
              if (this.pendingTxProcessed.size > 50000) {
                const first = this.pendingTxProcessed.values().next().value;
                if (first) this.pendingTxProcessed.delete(first);
              }

              // 直接处理，不排队，不限并发
              this.processPendingTxDirect(txHash);
            }
          } catch (e) {
            // 忽略解析错误
          }
        };

        this.rawWs.onerror = (error) => {
          this.log('warning', 'WebSocket 错误');
        };

        this.rawWs.onclose = () => {
          if (!this.isRunning) return;

          reconnectAttempts++;
          if (reconnectAttempts <= maxReconnectAttempts) {
            this.log('warning', `WebSocket 断开，${reconnectAttempts}秒后重连 (${reconnectAttempts}/${maxReconnectAttempts})`);
            setTimeout(connect, reconnectAttempts * 1000);
          } else {
            this.log('error', 'WebSocket 重连失败，仅依赖 HTTP 轮询');
          }
        };

      } catch (e: any) {
        this.log('warning', `WebSocket 连接失败: ${e.message}`);
        reconnectAttempts++;
        if (reconnectAttempts <= maxReconnectAttempts) {
          setTimeout(connect, reconnectAttempts * 1000);
        }
      }
    };

    connect();
  }

  /**
   * 直接处理 Pending 交易 - 多节点轮询 + 并发限制
   */
  private async processPendingTxDirect(txHash: string) {
    if (!this.isRunning) return;

    // 并发限制 - 但不要完全跳过，记录一下
    if (this.activeRequests >= this.maxConcurrentRequests) {
      return; // 超过并发限制，跳过（但节点池足够大，应该很少发生）
    }

    this.activeRequests++;
    const detectTime = Date.now();

    try {
      // 使用轮询获取下一个节点
      const client = this.getNextClient();
      if (!client) return;

      const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
      if (!tx) return;

      // 检查是否是 FourMeme 合约
      if (tx.to?.toLowerCase() !== FOURMEME_CONTRACT.toLowerCase()) return;

      // 检查是否是 createAndBuy 方法
      const methodSelector = tx.input.slice(0, 10).toLowerCase();
      if (methodSelector !== CREATE_AND_BUY_SELECTOR) return;

      // 🎯 检测到 FourMeme createAndBuy 交易！
      this.fourMemeDetected++;  // 统计计数
      const isWatchAll = !this.task.targetWallet || this.task.targetWallet.trim() === '';

      this.log('info', `[Pending] 检测到 FourMeme createAndBuy`);
      this.log('info', `[Pending] 发送者: ${tx.from}`);
      this.log('info', `[Pending] 检测耗时: ${Date.now() - detectTime}ms`);

      // 检查是否是目标钱包（如果设置了的话）
      if (!isWatchAll && tx.from.toLowerCase() !== this.task.targetWallet.toLowerCase()) {
        return; // 非目标钱包，静默忽略
      }

      const matchTime = Date.now();
      if (isWatchAll) {
        this.log('success', `🚀 [Pending] 检测到创建交易! (监听所有)`);
      } else {
        this.log('success', `🚀 [Pending] 目标钱包创建交易!`);
      }
      this.log('info', `交易哈希: ${txHash}`);

      // 立即预测代币地址
      const predictStartTime = Date.now();
      const predictedToken = predictTokenAddress(tx.input);
      const predictTime = Date.now() - predictStartTime;

      if (!predictedToken) {
        this.log('error', '预测失败，等待确认...');
        await this.waitAndBuyConfirmed(txHash);
        return;
      }

      this.log('success', `🎯 [预测地址] ${predictedToken}`);
      this.log('info', `⏱️ 预测耗时: ${predictTime}ms`);

      const event: TokenCreatedEvent = {
        creator: tx.from,
        token: predictedToken,
        blockNumber: 0n,
        transactionHash: txHash
      };
      this.onTokenFound?.(event);

      // 执行买入
      const buyStartTime = Date.now();
      this.log('info', `⚡ 开始买入...`);
      const results = await this.executeBuy(predictedToken);
      const buyTime = Date.now() - buyStartTime;

      this.log('info', `⏱️ 买入耗时: ${buyTime}ms`);
      this.log('info', `⏱️ 总耗时 (检测到买入完成): ${Date.now() - detectTime}ms`);

      this.onBuyComplete?.(results);

      // 验证预测地址 - 等待交易确认后对比
      this.verifyPrediction(txHash, predictedToken, detectTime);

      this.stop();
      this.updateStatus('completed');

    } catch (e) {
      // 忽略错误
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * 验证预测地址是否正确
   */
  private async verifyPrediction(createTxHash: string, predictedToken: string, detectTime: number) {
    if (!this.httpClient) return;

    try {
      this.log('info', `⏳ 等待创建交易确认，验证预测...`);

      const receipt = await this.httpClient.waitForTransactionReceipt({
        hash: createTxHash as `0x${string}`,
        timeout: 60000
      });

      const confirmTime = Date.now();

      if (receipt.status === 'success') {
        const tokenCreatedLog = receipt.logs.find(log =>
          log.topics[0]?.toLowerCase() === TOKEN_CREATED_EVENT_SIGNATURE.toLowerCase()
        );

        if (tokenCreatedLog) {
          const event = parseTokenCreatedEvent(tokenCreatedLog);
          const realToken = event.token.toLowerCase();
          const predicted = predictedToken.toLowerCase();
          const isMatch = realToken === predicted;

          this.log('info', `━━━━━━━━━━ 预测验证结果 ━━━━━━━━━━`);
          this.log('info', `🔮 预测地址: ${predictedToken}`);
          this.log('info', `✅ 真实地址: ${event.token}`);

          if (isMatch) {
            this.log('success', `🎉 预测正确! ✓`);
          } else {
            this.log('error', `❌ 预测错误!`);
          }

          this.log('info', `⏱️ 创建交易确认区块: ${receipt.blockNumber}`);
          this.log('info', `⏱️ 从检测到确认耗时: ${confirmTime - detectTime}ms`);
          this.log('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        }
      } else {
        this.log('error', `创建交易失败`);
      }
    } catch (e) {
      this.log('warning', `验证超时或失败`);
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
    const detectTime = Date.now();
    try {
      const event = parseTokenCreatedEvent(log);
      const isWatchAll = !this.task.targetWallet || this.task.targetWallet.trim() === '';

      this.log('info', `[区块轮询] 检测到新代币创建: ${event.token}`);
      this.log('info', `[区块轮询] 创建者: ${event.creator}`);

      // 检查是否为目标钱包（如果设置了的话）
      const isTargetWallet = isWatchAll || event.creator.toLowerCase() === this.task.targetWallet.toLowerCase();

      if (isTargetWallet) {
        if (isWatchAll) {
          this.log('success', `🎯 [区块轮询] 检测到代币创建! (监听所有) Token: ${event.token}`);
        } else {
          this.log('success', `🎯 [区块轮询] 目标钱包创建代币！Token: ${event.token}`);
        }

        // 触发回调
        this.onTokenFound?.(event);

        // 执行买入
        const buyStartTime = Date.now();
        this.log('info', `⚡ 开始买入...`);
        const results = await this.executeBuy(event.token);
        const buyTime = Date.now() - buyStartTime;

        this.log('info', `⏱️ 买入耗时: ${buyTime}ms`);

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

      // 构建交易参数 - 修复 JavaScript 浮点数精度丢失问题
      // 使用 parseEther 替代直接乘法，避免金额 >= 0.01 BNB 时的精度问题
      const buyAmountStr = this.task.buyAmount.toFixed(18).replace(/\.?0+$/, '');
      const buyAmountWei = parseEther(buyAmountStr);

      // 获取最新 nonce（使用 pending 状态，包含未确认交易）
      let nonce: number | undefined;
      if (this.httpClient) {
        try {
          nonce = await this.httpClient.getTransactionCount({
            address: wallet.address as `0x${string}`,
            blockTag: 'pending'
          });
        } catch (e) {
          // 获取失败，让 viem 自动处理
        }
      }

      const txParams: any = {
        to: FOURMEME_CONTRACT as `0x${string}`,
        data: calldata,
        value: buyAmountWei
      };

      // 设置 nonce
      if (nonce !== undefined) {
        txParams.nonce = nonce;
      }

      // 设置 gasLimit
      if (this.task.gasLimit > 0) {
        txParams.gas = BigInt(this.task.gasLimit);
      }

      // 设置 gasPrice
      if (this.task.gasPrice > 0) {
        txParams.gasPrice = BigInt(this.task.gasPrice) * BigInt(1e9);
      }

      this.log('info', `发送买入交易: ${wallet.address.slice(0, 10)}... (nonce: ${nonce ?? 'auto'})`);

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
