/**
 * 迁移检测服务
 *
 * 功能：
 * 1. WebSocket 实时订阅 PancakeSwap Factory 的 PairCreated 事件（主通道，毫秒级）
 * 2. HTTP getLogs 轮询作为备用通道
 * 3. 当检测到目标代币迁移时触发回调
 */

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  type Log
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { FOURMEME_CONTRACT } from './fourMemeService';

// ==================== 常量配置 ====================

export const PANCAKESWAP_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as const;

// PairCreated(address indexed token0, address indexed token1, address pair, uint)
export const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9' as const;

// WebSocket 节点（用于实时订阅）
const WSS_RPC_NODES = [
  'wss://bsc.publicnode.com',
  'wss://bsc-rpc.publicnode.com',
];

// 支持 eth_getLogs 的 HTTP 节点（备用轮询）
const LOGS_SUPPORTED_RPC_NODES = [
  'https://bsc.publicnode.com',
  'https://bsc-rpc.publicnode.com',
  'https://rpc.ankr.com/bsc',
];

// ==================== 类型定义 ====================

export interface MigrationEvent {
  tokenAddress: string;
  pairAddress: string;
  pairedWith: string;
  blockNumber: bigint;
  transactionHash: string;
  source: 'PairCreated' | 'FourMeme' | 'PonsGraduation';
}

export interface MigrationLog {
  timestamp: number;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: any;
}

// ==================== 服务类 ====================

export class MigrationService {
  private httpClient: PublicClient;
  private chainId: number;
  private isRunning: boolean = false;
  private monitoredTokens: Set<string> = new Set();
  private lastBlockNumber: bigint = 0n;
  private pollInterval: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedTxHashes: Set<string> = new Set();
  private consecutiveFailures: number = 0;
  private rpcNodeIndex: number = 0;

  // WebSocket 相关
  private ws: WebSocket | null = null;
  private wsSubscriptionId: string | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectAttempts: number = 0;
  private wsNodeIndex: number = 0;
  private wsConnected: boolean = false;

  // 回调
  private onMigrationDetected: ((event: MigrationEvent) => void) | null = null;
  private onLog: ((log: MigrationLog) => void) | null = null;

  constructor(chainId: number, _httpRpcUrl?: string, pollInterval?: number) {
    if (chainId !== 56 && chainId !== 97) {
      throw new Error(`FourMeme 迁移监控仅支持 BSC（收到 chainId=${chainId}）`);
    }
    this.chainId = chainId;
    this.pollInterval = pollInterval || 3000;

    const chain = chainId === 97 ? bscTestnet : bsc;
    const rpcUrl = LOGS_SUPPORTED_RPC_NODES[0];

    this.httpClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
      batch: { multicall: true }
    });
  }

  // ==================== 回调设置 ====================

  setOnMigrationDetected(cb: (event: MigrationEvent) => void): void {
    this.onMigrationDetected = cb;
  }

  setOnLog(cb: (log: MigrationLog) => void): void {
    this.onLog = cb;
  }

  // ==================== 代币管理 ====================

  updateMonitoredTokens(tokens: Set<string>): void {
    this.monitoredTokens = new Set(
      Array.from(tokens).map(t => t.toLowerCase())
    );
    this.log('info', `监控代币列表已更新，共 ${this.monitoredTokens.size} 个代币`);
  }

  getMonitoredTokenCount(): number {
    return this.monitoredTokens.size;
  }

  // ==================== 生命周期 ====================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.log('warning', '监控服务已在运行中');
      return;
    }

    if (this.monitoredTokens.size === 0) {
      this.log('warning', '没有需要监控的代币');
      return;
    }

    this.isRunning = true;
    this.consecutiveFailures = 0;
    this.wsReconnectAttempts = 0;

    try {
      this.lastBlockNumber = await this.httpClient.getBlockNumber();
      this.log('info', `监控已启动，从区块 ${this.lastBlockNumber} 开始`);
      this.log('info', `正在监控 ${this.monitoredTokens.size} 个代币的 PairCreated 事件`);

      // 主通道：WebSocket 实时订阅
      this.connectWebSocket();

      // HTTP 轮询仅在 WebSocket 断连时自动启用，此处不启动
    } catch (error: any) {
      this.isRunning = false;
      this.log('error', `启动失败: ${error.message}`);
      throw error;
    }
  }

  stop(): void {
    this.isRunning = false;
    this.disconnectWebSocket();
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log('info', '监控已停止');
  }

  destroy(): void {
    this.stop();
    this.onMigrationDetected = null;
    this.onLog = null;
    this.monitoredTokens.clear();
    this.processedTxHashes.clear();
  }

  // ==================== WebSocket 主通道 ====================

  private connectWebSocket(): void {
    if (!this.isRunning) return;

    const wssUrl = WSS_RPC_NODES[this.wsNodeIndex % WSS_RPC_NODES.length];
    this.log('info', `[WS] 连接 ${wssUrl} ...`);

    try {
      this.ws = new WebSocket(wssUrl);

      this.ws.onopen = () => {
        this.wsConnected = true;
        this.wsReconnectAttempts = 0;
        this.log('success', `[WS] 已连接，订阅 PairCreated 事件...`);

        // WS 连上了，停止 HTTP 轮询
        if (this.pollTimer !== null) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }

        // 订阅 PancakeSwap Factory 的 PairCreated 日志
        const subscribeMsg = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_subscribe',
          params: [
            'logs',
            {
              address: PANCAKESWAP_V2_FACTORY.toLowerCase(),
              topics: [PAIR_CREATED_TOPIC]
            }
          ]
        });
        this.ws!.send(subscribeMsg);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);

          // 订阅确认
          if (data.id === 1 && data.result) {
            this.wsSubscriptionId = data.result;
            this.log('success', `[WS] 订阅成功 (ID: ${data.result.slice(0, 10)}...)，实时监听中`);
            return;
          }

          // 实时日志推送
          if (data.method === 'eth_subscription' && data.params?.result) {
            const logEntry = data.params.result;
            this.processPairCreatedLog(logEntry as Log);
          }
        } catch (e: any) {
          // 解析失败，忽略
        }
      };

      this.ws.onerror = (error) => {
        this.log('warning', `[WS] 连接错误`);
      };

      this.ws.onclose = () => {
        this.wsConnected = false;
        this.wsSubscriptionId = null;

        if (this.isRunning) {
          this.wsReconnectAttempts++;
          const delay = Math.min(1000 * this.wsReconnectAttempts, 10000);

          if (this.wsReconnectAttempts % 3 === 0) {
            this.wsNodeIndex++;
          }

          this.log('info', `[WS] 连接断开，启用 HTTP 轮询备用，${delay}ms 后重连 (第${this.wsReconnectAttempts}次)...`);

          // WS 断了，启动 HTTP 轮询补漏
          if (this.pollTimer === null) {
            this.schedulePoll();
          }

          this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
        }
      };
    } catch (error: any) {
      this.log('warning', `[WS] 创建连接失败: ${error.message}`);
      // 回退到轮询
    }
  }

  private disconnectWebSocket(): void {
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try {
        // 取消订阅
        if (this.wsSubscriptionId) {
          this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'eth_unsubscribe',
            params: [this.wsSubscriptionId]
          }));
        }
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.wsConnected = false;
    this.wsSubscriptionId = null;
  }

  // ==================== HTTP 轮询备用通道 ====================

  private schedulePoll(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.pollNewBlocks(), this.pollInterval);
  }

  private async pollNewBlocks(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const currentBlock = await this.httpClient.getBlockNumber();

      if (currentBlock > this.lastBlockNumber) {
        const fromBlock = this.lastBlockNumber + 1n;
        const toBlock = currentBlock;

        const maxRange = 5000n;
        const effectiveFrom = toBlock - fromBlock > maxRange
          ? toBlock - maxRange
          : fromBlock;

        // PairCreated 检测（HTTP 补漏，和 WebSocket 共用去重逻辑）
        await this.checkPairCreatedEvents(effectiveFrom, toBlock);

        // FourMeme 事件（仅日志记录）
        await this.checkFourMemeEvents(effectiveFrom, toBlock);

        this.lastBlockNumber = toBlock;
        this.consecutiveFailures = 0;
      }
    } catch (error: any) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 10 === 0) {
        this.log('warning', `[HTTP] 轮询失败 (${this.consecutiveFailures}次): ${error.message}`);
      }
      if (this.consecutiveFailures > 10 && this.consecutiveFailures % 10 === 0) {
        this.switchHttpRpcNode();
      }
    }

    this.schedulePoll();
  }

  // ==================== PairCreated 检测 ====================

  private async checkPairCreatedEvents(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      const logs = await this.httpClient.request({
        method: 'eth_getLogs',
        params: [{
          address: PANCAKESWAP_V2_FACTORY.toLowerCase() as Address,
          topics: [PAIR_CREATED_TOPIC],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`
        }]
      }) as any[];

      for (const log of logs) {
        this.processPairCreatedLog(log as Log);
      }
    } catch (error: any) {
      if (this.consecutiveFailures <= 1) {
        this.log('warning', `[HTTP] PairCreated 查询失败: ${error.message}`);
      }
    }
  }

  private processPairCreatedLog(log: Log): void {
    const txHash = (log.transactionHash as string) || '';
    if (!txHash || this.processedTxHashes.has(txHash)) return;

    const parsed = this.parsePairCreatedLog(log);
    if (!parsed) return;

    const { token0, token1, pair } = parsed;
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    let matchedToken: string | null = null;
    let pairedWith: string | null = null;

    if (this.monitoredTokens.has(token0Lower)) {
      matchedToken = token0;
      pairedWith = token1;
    } else if (this.monitoredTokens.has(token1Lower)) {
      matchedToken = token1;
      pairedWith = token0;
    }

    if (matchedToken) {
      this.processedTxHashes.add(txHash);

      const blockNum = typeof log.blockNumber === 'string'
        ? BigInt(log.blockNumber)
        : (log.blockNumber || 0n);

      const event: MigrationEvent = {
        tokenAddress: matchedToken,
        pairAddress: pair,
        pairedWith: pairedWith!,
        blockNumber: blockNum,
        transactionHash: txHash,
        source: 'PairCreated'
      };

      this.log('success', `检测到代币迁移！代币: ${matchedToken.slice(0, 10)}...，交易对: ${pair.slice(0, 10)}...`);

      if (this.onMigrationDetected) {
        this.onMigrationDetected(event);
      }
    }
  }

  private parsePairCreatedLog(log: Log): { token0: string; token1: string; pair: string } | null {
    try {
      const args = (log as any).args;
      if (args && args.token0 && args.token1 && args.pair) {
        return {
          token0: args.token0 as string,
          token1: args.token1 as string,
          pair: args.pair as string
        };
      }

      if (!log.topics || log.topics.length < 3 || !log.data) return null;

      const token0 = '0x' + log.topics[1]!.slice(26);
      const token1 = '0x' + log.topics[2]!.slice(26);
      // data: pair address (32 bytes) + uint256 (32 bytes)
      const dataHex = (log.data as string).replace('0x', '');
      const pair = '0x' + dataHex.slice(24, 64);

      return { token0, token1, pair };
    } catch {
      return null;
    }
  }

  // ==================== FourMeme 事件检测（仅日志） ====================

  private async checkFourMemeEvents(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      const logs = await this.httpClient.request({
        method: 'eth_getLogs',
        params: [{
          address: FOURMEME_CONTRACT,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`
        }]
      }) as any[];

      for (const log of logs) {
        this.processFourMemeLog(log as Log);
      }
    } catch {
      // 静默处理 — FourMeme 全量查询部分节点不支持
    }
  }

  private processFourMemeLog(log: Log): void {
    const txHash = log.transactionHash as string;
    if (!txHash) return;

    const tokenCreatedTopic = '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20';
    if (log.topics && log.topics[0] === tokenCreatedTopic) return;

    // FourMeme 通道仅记录日志，不触发卖出
    if (log.topics && log.topics.length > 0) {
      const topic0 = log.topics[0];
      const dataHex = (log.data as string) || '0x';

      for (let i = 1; i < log.topics.length; i++) {
        const addr = '0x' + log.topics[i]!.slice(26);
        if (this.monitoredTokens.has(addr.toLowerCase())) {
          if (this.processedTxHashes.has(txHash + '_fm')) return;
          this.processedTxHashes.add(txHash + '_fm');
          this.log('info', `[FourMeme] 代币 ${addr.slice(0, 10)}... 相关事件，topic0: ${topic0?.slice(0, 18)}...（仅记录）`);
          return;
        }
      }

      if (dataHex.length >= 66) {
        for (let offset = 2; offset + 64 <= dataHex.length; offset += 64) {
          const paramHex = dataHex.slice(offset, offset + 64);
          const addr = '0x' + paramHex.slice(24);
          if (this.monitoredTokens.has(addr.toLowerCase())) {
            if (this.processedTxHashes.has(txHash + '_fm_data')) return;
            this.processedTxHashes.add(txHash + '_fm_data');
            this.log('info', `[FourMeme] 代币 ${addr.slice(0, 10)}... 相关事件，topic0: ${topic0?.slice(0, 18)}...（仅记录）`);
            return;
          }
        }
      }
    }
  }

  // ==================== 辅助方法 ====================

  private getNextHttpRpcNode(): string {
    const node = LOGS_SUPPORTED_RPC_NODES[this.rpcNodeIndex % LOGS_SUPPORTED_RPC_NODES.length];
    this.rpcNodeIndex++;
    return node;
  }

  private switchHttpRpcNode(): void {
    const newUrl = this.getNextHttpRpcNode();
    const chain = this.chainId === 97 ? bscTestnet : bsc;

    this.httpClient = createPublicClient({
      chain,
      transport: http(newUrl),
      batch: { multicall: true }
    });

    this.log('info', `[HTTP] 已切换节点: ${newUrl}`);
  }

  private log(type: MigrationLog['type'], message: string, data?: any): void {
    if (this.onLog) {
      this.onLog({
        timestamp: Date.now(),
        type,
        message,
        data
      });
    }
  }
}

export function createMigrationService(
  chainId: number,
  httpRpcUrl?: string,
  pollInterval?: number
): MigrationService {
  return new MigrationService(chainId, httpRpcUrl, pollInterval);
}
