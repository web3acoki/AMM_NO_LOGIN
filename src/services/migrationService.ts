/**
 * 迁移检测服务
 *
 * 功能：
 * 1. 监控 PancakeSwap Factory 的 PairCreated 事件
 * 2. 监控 FourMeme 合约的迁移相关事件
 * 3. 当检测到目标代币迁移时触发回调
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  type Log
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { FOURMEME_CONTRACT } from './fourMemeService';

// ==================== 常量配置 ====================

// PancakeSwap V2 Factory 地址
export const PANCAKESWAP_V2_FACTORY = '0xcA143Ce0Fe65960E6Aa4D42C8D3cE161c2B6604f' as const;

// PairCreated 事件 topic hash
// event PairCreated(address indexed token0, address indexed token1, address pair, uint)
export const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9' as const;

// 支持 eth_getLogs 的 RPC 节点（Binance 官方节点限制 getLogs，不适合事件查询）
const LOGS_SUPPORTED_RPC_NODES = [
  'https://bsc.publicnode.com',
  'https://bsc-rpc.publicnode.com',
  'https://rpc.ankr.com/bsc',
] as const;

// ==================== 类型定义 ====================

export interface MigrationEvent {
  tokenAddress: string;      // 迁移的代币地址
  pairAddress: string;       // 新创建的交易对地址
  pairedWith: string;        // 配对的代币（WBNB 等）
  blockNumber: bigint;
  transactionHash: string;
  source: 'PairCreated' | 'FourMeme';
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
  private monitoredTokens: Set<string> = new Set(); // lowercase addresses
  private lastBlockNumber: bigint = 0n;
  private pollInterval: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedTxHashes: Set<string> = new Set(); // 去重
  private consecutiveFailures: number = 0;
  private rpcNodeIndex: number = 0;

  // 回调
  private onMigrationDetected: ((event: MigrationEvent) => void) | null = null;
  private onLog: ((log: MigrationLog) => void) | null = null;

  constructor(chainId: number, httpRpcUrl?: string, pollInterval?: number) {
    this.chainId = chainId;
    this.pollInterval = pollInterval || 3000;

    const chain = chainId === 97 ? bscTestnet : bsc;
    // 使用支持 getLogs 的节点（Binance 官方节点限制 eth_getLogs 会报 limit exceeded）
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

    try {
      // 获取当前区块号作为起点
      this.lastBlockNumber = await this.httpClient.getBlockNumber();
      this.log('info', `监控已启动，从区块 ${this.lastBlockNumber} 开始，轮询间隔 ${this.pollInterval}ms`);
      this.log('info', `正在监控 ${this.monitoredTokens.size} 个代币的迁移事件`);

      // 开始轮询
      this.schedulePoll();
    } catch (error: any) {
      this.isRunning = false;
      this.log('error', `启动失败: ${error.message}`);
      throw error;
    }
  }

  stop(): void {
    this.isRunning = false;
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

  // ==================== 轮询逻辑 ====================

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

        // 防止区块范围过大（RPC 限制）
        const maxRange = 5000n;
        const effectiveFrom = toBlock - fromBlock > maxRange
          ? toBlock - maxRange
          : fromBlock;

        // 并行查询两个通道
        await Promise.all([
          this.checkPairCreatedEvents(effectiveFrom, toBlock),
          this.checkFourMemeEvents(effectiveFrom, toBlock)
        ]);

        this.lastBlockNumber = toBlock;
        this.consecutiveFailures = 0;
      }
    } catch (error: any) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 10 === 0) {
        this.log('warning', `轮询失败 (${this.consecutiveFailures}次): ${error.message}`);
      }

      // 连续失败超过 10 次，尝试切换 RPC 节点
      if (this.consecutiveFailures > 10 && this.consecutiveFailures % 10 === 0) {
        this.switchRpcNode();
      }
    }

    // 继续轮询
    this.schedulePoll();
  }

  // ==================== PairCreated 检测 ====================

  private async checkPairCreatedEvents(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      // 使用原始 topics 查询，避免 viem event 语法在某些 RPC 上的兼容问题
      const logs = await this.httpClient.request({
        method: 'eth_getLogs',
        params: [{
          address: PANCAKESWAP_V2_FACTORY,
          topics: [PAIR_CREATED_TOPIC],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`
        }]
      }) as any[];

      for (const log of logs) {
        this.processPairCreatedLog(log as Log);
      }
    } catch (error: any) {
      // PairCreated 查询失败不阻塞整体流程
      if (this.consecutiveFailures <= 1) {
        this.log('warning', `PairCreated 查询失败: ${error.message}`);
      }
    }
  }

  private processPairCreatedLog(log: Log): void {
    const txHash = log.transactionHash as string;
    if (!txHash || this.processedTxHashes.has(txHash)) return;

    // 解析 PairCreated 事件
    const parsed = this.parsePairCreatedLog(log);
    if (!parsed) return;

    const { token0, token1, pair } = parsed;
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();

    // 检查是否匹配监控的代币
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

      // blockNumber 可能是 hex string（原始 RPC）或 bigint（viem 解析后）
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
      // 使用 viem 解析的 args（如果存在）
      const args = (log as any).args;
      if (args && args.token0 && args.token1 && args.pair) {
        return {
          token0: args.token0 as string,
          token1: args.token1 as string,
          pair: args.pair as string
        };
      }

      // 回退：手动解析 topics 和 data
      if (!log.topics || log.topics.length < 3 || !log.data) return null;

      const token0 = '0x' + log.topics[1]!.slice(26);
      const token1 = '0x' + log.topics[2]!.slice(26);
      const pair = '0x' + log.data.slice(26, 66);

      return { token0, token1, pair };
    } catch {
      return null;
    }
  }

  // ==================== FourMeme 事件检测 ====================

  private async checkFourMemeEvents(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      // 使用原始 RPC 请求，指定地址但不传 topics 参数（而非空数组）
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
    } catch (error: any) {
      // FourMeme 查询失败不阻塞整体流程，静默处理
      // publicnode 等节点可能不支持无 topics 的全量查询，这是预期内的
    }
  }

  private processFourMemeLog(log: Log): void {
    const txHash = log.transactionHash as string;
    if (!txHash) return;

    // 跳过已知的 TokenCreated 事件
    const tokenCreatedTopic = '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20';
    if (log.topics && log.topics[0] === tokenCreatedTopic) return;

    // 记录未知的 FourMeme 事件（用于发现迁移事件签名）
    if (log.topics && log.topics.length > 0) {
      const topic0 = log.topics[0];

      // 尝试从事件数据中提取代币地址并匹配
      const dataHex = (log.data as string) || '0x';

      // 检查 topics 中是否有匹配的代币地址
      for (let i = 1; i < log.topics.length; i++) {
        const addr = '0x' + log.topics[i]!.slice(26);
        if (this.monitoredTokens.has(addr.toLowerCase())) {
          if (this.processedTxHashes.has(txHash + '_fm')) return;
          this.processedTxHashes.add(txHash + '_fm');

          this.log('info', `FourMeme 事件检测到代币 ${addr.slice(0, 10)}...，topic0: ${topic0?.slice(0, 18)}...`);
          break;
        }
      }

      // 检查 data 字段中是否有匹配的代币地址（每 32 字节一个参数）
      if (dataHex.length >= 66) {
        for (let offset = 2; offset + 64 <= dataHex.length; offset += 64) {
          const paramHex = dataHex.slice(offset, offset + 64);
          const addr = '0x' + paramHex.slice(24);
          if (this.monitoredTokens.has(addr.toLowerCase())) {
            if (this.processedTxHashes.has(txHash + '_fm_data')) return;
            this.processedTxHashes.add(txHash + '_fm_data');

            const blockNum = typeof log.blockNumber === 'string'
              ? BigInt(log.blockNumber)
              : (log.blockNumber || 0n);

            const event: MigrationEvent = {
              tokenAddress: addr,
              pairAddress: '',
              pairedWith: '',
              blockNumber: blockNum,
              transactionHash: txHash,
              source: 'FourMeme'
            };

            this.log('success', `FourMeme 合约检测到代币 ${addr.slice(0, 10)}... 的迁移事件，topic0: ${topic0?.slice(0, 18)}...`);

            if (this.onMigrationDetected) {
              this.onMigrationDetected(event);
            }
            break;
          }
        }
      }
    }
  }

  // ==================== 辅助方法 ====================

  private getNextRpcNode(): string {
    const node = LOGS_SUPPORTED_RPC_NODES[this.rpcNodeIndex % LOGS_SUPPORTED_RPC_NODES.length];
    this.rpcNodeIndex++;
    return node;
  }

  private switchRpcNode(): void {
    const newUrl = this.getNextRpcNode();
    const chain = this.chainId === 97 ? bscTestnet : bsc;

    this.httpClient = createPublicClient({
      chain,
      transport: http(newUrl),
      batch: { multicall: true }
    });

    this.log('info', `已切换 RPC 节点: ${newUrl}`);
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

// 工厂函数
export function createMigrationService(
  chainId: number,
  httpRpcUrl?: string,
  pollInterval?: number
): MigrationService {
  return new MigrationService(chainId, httpRpcUrl, pollInterval);
}
