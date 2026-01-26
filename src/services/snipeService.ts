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

// WebSocket RPC 节点
export const WSS_RPC_NODES = [
  'wss://bsc.publicnode.com',
  'wss://bsc-rpc.publicnode.com',
];

// HTTP RPC 节点（用于发送交易）
export const HTTP_RPC_NODES = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.publicnode.com',
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
  private walletClients: Map<string, WalletClient> = new Map();
  private unwatch: (() => void) | null = null;
  private isRunning: boolean = false;
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
    this.httpRpcUrl = httpRpcUrl || HTTP_RPC_NODES[0];
    this.wssRpcUrl = wssRpcUrl || WSS_RPC_NODES[0];
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

      // 创建 HTTP 客户端（用于发送交易）
      this.httpClient = createPublicClient({
        chain: getChainConfig(this.chainId),
        transport: http(this.httpRpcUrl)
      });

      // 创建 WebSocket 客户端（用于实时订阅事件）
      try {
        this.wsClient = createPublicClient({
          chain: getChainConfig(this.chainId),
          transport: webSocket(this.wssRpcUrl)
        });
        this.log('success', `WebSocket 连接成功: ${this.wssRpcUrl}`);
      } catch (wsError) {
        this.log('warning', `WebSocket 连接失败，将使用 HTTP 轮询: ${wsError}`);
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

    // 优先使用 WebSocket 订阅（实时），否则降级为轮询
    if (this.wsClient) {
      this.startWebSocketSubscription();
    } else {
      this.log('warning', 'WebSocket 不可用，降级为 HTTP 轮询');
      this.startPolling();
    }
  }

  /**
   * 使用 WebSocket 实时订阅事件
   */
  private startWebSocketSubscription() {
    if (!this.wsClient) return;

    this.log('info', '使用 WebSocket 实时订阅 TokenCreated 事件...');

    // 使用 watchEvent 订阅特定合约的特定事件
    this.unwatch = this.wsClient.watchBlockNumber({
      onBlockNumber: async (blockNumber) => {
        if (!this.isRunning || !this.httpClient) return;

        try {
          // 获取当前区块的 TokenCreated 事件
          const logs = await this.httpClient.getLogs({
            address: FOURMEME_CONTRACT,
            topics: [TOKEN_CREATED_EVENT_SIGNATURE],
            fromBlock: blockNumber,
            toBlock: blockNumber
          });

          for (const log of logs) {
            await this.handleTokenCreatedEvent(log);
          }
        } catch (error: any) {
          // 忽略单次查询错误
        }
      },
      onError: (error) => {
        this.log('error', `WebSocket 订阅错误: ${error.message}`);
        // 降级为轮询
        if (this.isRunning) {
          this.log('warning', '切换为 HTTP 轮询...');
          this.startPolling();
        }
      }
    });

    this.log('success', '实时订阅已启动（监听新区块）');
  }

  /**
   * 使用轮询方式监听事件
   */
  private startPolling() {
    if (!this.httpClient) return;

    let lastBlockNumber = 0n;

    const poll = async () => {
      if (!this.isRunning || !this.httpClient) return;

      try {
        const currentBlock = await this.httpClient.getBlockNumber();

        if (lastBlockNumber === 0n) {
          lastBlockNumber = currentBlock;
          this.log('info', `开始从区块 ${currentBlock} 监听...`);
        }

        if (currentBlock > lastBlockNumber) {
          // 查询新区块的 TokenCreated 事件
          const logs = await this.httpClient.getLogs({
            address: FOURMEME_CONTRACT,
            topics: [TOKEN_CREATED_EVENT_SIGNATURE],
            fromBlock: lastBlockNumber + 1n,
            toBlock: currentBlock
          });

          for (const log of logs) {
            await this.handleTokenCreatedEvent(log);
          }

          lastBlockNumber = currentBlock;
        }
      } catch (error: any) {
        this.log('warning', `轮询出错: ${error.message}`);
      }

      // 继续轮询（每 1 秒）
      if (this.isRunning) {
        setTimeout(poll, 1000);
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

      // 构建交易参数（不指定 nonce，让 viem 自动获取）
      const txParams: any = {
        to: FOURMEME_CONTRACT as `0x${string}`,
        data: calldata,
        value: parseEther(this.task.buyAmount.toString())
      };

      // 只有当 gasLimit > 0 时才设置
      if (this.task.gasLimit > 0) {
        txParams.gas = BigInt(this.task.gasLimit);
      }

      // 只有当 gasPrice > 0 时才设置
      if (this.task.gasPrice > 0) {
        txParams.gasPrice = BigInt(this.task.gasPrice) * BigInt(1e9); // Gwei to Wei
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
