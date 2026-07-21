import { parseEther, type Address } from 'viem';
import {
  PONS_V3_POOL_FEE,
  ROBINHOOD_WETH_ADDRESS,
  UNISWAP_V3_ROBINHOOD_ADDRESSES,
} from '../constants';
import { erc20Abi } from '../viem/abis/erc20';
import {
  PONS_FACTORY,
  PONS_LAUNCHPAD_ABI,
  ROBINHOOD_HTTP_RPCS,
  ROBINHOOD_WSS_RPCS,
  createPonsPublicClient,
} from './ponsService';
import { createTradingService } from './tradingService';
import { UniswapV3Service } from './uniswapV3Service';
import type {
  BuyResult,
  SnipeLog,
  SnipeTaskConfig,
  TokenCreatedEvent,
} from './snipeService';

export const PONS_TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a' as const;

interface PendingLaunch {
  event: TokenCreatedEvent;
  launchL1Block: bigint;
  restrictionsEndBlock: bigint;
  poolFee: number;
  supply: bigint;
  maxWalletBps: number;
  maxTxBps: number;
}

interface RpcLog {
  address: string;
  blockNumber: `0x${string}`;
  transactionHash: string;
  topics: string[];
  data: string;
}

interface LaunchCandidateLock {
  key: string;
  token: Address;
}

class PonsBuyPrecheckError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'PonsBuyPrecheckError';
  }
}

function topicAddress(topic?: string): Address | null {
  if (!topic || topic.length !== 66) return null;
  return `0x${topic.slice(-40)}` as Address;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'RPC request failed');
  return payload.result as T;
}

export async function getRobinhoodL1BlockNumber(rpcUrl: string, blockTag = 'latest'): Promise<bigint> {
  const block = await rpcCall<{ l1BlockNumber?: string }>(rpcUrl, 'eth_getBlockByNumber', [blockTag, false]);
  if (!block?.l1BlockNumber) throw new Error('RPC 区块数据缺少 l1BlockNumber');
  return BigInt(block.l1BlockNumber);
}

/**
 * Pons sniping is log-driven. It intentionally never uses pending transactions:
 * the launch transaction's own block rejects external pool buys, so buying starts
 * only after a new Robinhood block reports an Ethereum L1 block greater than the
 * token's launch L1 block.
 */
export class PonsSnipeService {
  private readonly task: SnipeTaskConfig;
  private readonly httpRpcUrl: string;
  private readonly wssRpcUrl: string;
  private readonly publicClient;
  private isRunning = false;
  private rawWs: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPolledBlock = 0n;
  private pendingLaunch: PendingLaunch | null = null;
  private buyingLaunch: PendingLaunch | null = null;
  private validatingLaunch: LaunchCandidateLock | null = null;
  private deferredLaunches: RpcLog[] = [];
  private deferredLaunchKeys = new Set<string>();
  private processedTokens = new Set<string>();
  private logs: SnipeLog[] = [];
  private onLog: ((log: SnipeLog) => void) | null = null;
  private onTokenFound: ((event: TokenCreatedEvent) => void) | null = null;
  private onBuyComplete: ((results: BuyResult[]) => void) | null = null;
  private onStatusChange: ((status: SnipeTaskConfig['status']) => void) | null = null;

  constructor(task: SnipeTaskConfig, httpRpcUrl?: string, wssRpcUrl?: string) {
    this.task = task;
    this.httpRpcUrl = httpRpcUrl || task.customHttpRpc || ROBINHOOD_HTTP_RPCS[0];
    this.wssRpcUrl = wssRpcUrl || task.customWssRpc || ROBINHOOD_WSS_RPCS[0];
    this.publicClient = createPonsPublicClient(this.httpRpcUrl);
  }

  setOnLog(callback: (log: SnipeLog) => void) { this.onLog = callback; }
  setOnTokenFound(callback: (event: TokenCreatedEvent) => void) { this.onTokenFound = callback; }
  setOnBuyComplete(callback: (results: BuyResult[]) => void) { this.onBuyComplete = callback; }
  setOnStatusChange(callback: (status: SnipeTaskConfig['status']) => void) { this.onStatusChange = callback; }

  private log(type: SnipeLog['type'], message: string, data?: unknown) {
    const entry: SnipeLog = { timestamp: Date.now(), type, message, data };
    this.logs.push(entry);
    this.onLog?.(entry);
  }

  private updateStatus(status: SnipeTaskConfig['status']) {
    this.task.status = status;
    this.onStatusChange?.(status);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (this.task.wallets.length === 0) throw new Error('没有执行钱包');
    try {
      // Do not publish a running state until the initial RPC checkpoint exists.
      // Otherwise a startup RPC failure leaves an unrestartable zombie service.
      this.lastPolledBlock = await this.publicClient.getBlockNumber();
    } catch (error) {
      this.isRunning = false;
      this.updateStatus('failed');
      throw error;
    }
    this.isRunning = true;
    this.updateStatus('running');
    this.log('success', `Pons 狙击已启动，从 L2 区块 ${this.lastPolledBlock} 监听 TokenLaunched`);
    this.log('info', '使用 TokenLaunched 日志 + newHeads；不会监听 pending，也不会尝试同区块抢跑');
    this.connectWebSocket();
    this.scheduleHttpPoll();
  }

  private connectWebSocket() {
    if (!this.isRunning) return;
    try {
      this.rawWs = new WebSocket(this.wssRpcUrl);
      this.rawWs.onopen = () => {
        this.log('success', `Pons WebSocket 已连接: ${this.wssRpcUrl}`);
        this.rawWs?.send(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
          params: ['logs', { address: PONS_FACTORY.toLowerCase(), topics: [PONS_TOKEN_LAUNCHED_TOPIC] }],
        }));
        this.rawWs?.send(JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'],
        }));
      };
      this.rawWs.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data));
          if (payload.id === 1 && payload.result) this.log('success', 'TokenLaunched 日志订阅成功');
          if (payload.id === 2 && payload.result) this.log('success', 'newHeads 订阅成功');
          if (payload.method !== 'eth_subscription') return;
          const result = payload.params?.result;
          if (result?.topics?.[0]?.toLowerCase() === PONS_TOKEN_LAUNCHED_TOPIC) {
            void this.handleLaunchLog(result as RpcLog);
          } else if (result?.number) {
            void this.handleNewHead(result.number);
          }
        } catch {
          // Ignore malformed provider messages.
        }
      };
      this.rawWs.onerror = () => this.log('warning', 'Pons WebSocket 错误，HTTP 轮询仍在补漏');
      this.rawWs.onclose = () => {
        this.rawWs = null;
        if (!this.isRunning) return;
        this.log('warning', 'Pons WebSocket 已断开，3 秒后重连');
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 3000);
      };
    } catch (error: any) {
      this.log('warning', `Pons WebSocket 连接失败: ${error.message}`);
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 3000);
    }
  }

  private scheduleHttpPoll() {
    const poll = async () => {
      if (!this.isRunning) return;
      try {
        const current = await this.publicClient.getBlockNumber();
        if (current > this.lastPolledBlock) {
          const logs = await this.publicClient.getLogs({
            address: PONS_FACTORY,
            fromBlock: this.lastPolledBlock + 1n,
            toBlock: current,
          });
          for (const log of logs) {
            if (log.topics[0]?.toLowerCase() !== PONS_TOKEN_LAUNCHED_TOPIC) continue;
            await this.handleLaunchLog({
              address: log.address,
              blockNumber: `0x${(log.blockNumber ?? current).toString(16)}`,
              transactionHash: log.transactionHash ?? '',
              topics: [...log.topics] as string[],
              data: log.data,
            });
          }
          this.lastPolledBlock = current;
          await this.handleNewHead(`0x${current.toString(16)}`);
        }
      } catch (error: any) {
        this.log('warning', `Pons HTTP 补漏轮询失败: ${error.message}`);
      } finally {
        if (this.isRunning) this.pollTimer = setTimeout(poll, 1000);
      }
    };
    void poll();
  }

  private async handleLaunchLog(log: RpcLog) {
    if (!this.isRunning) return;
    const token = topicAddress(log.topics[1]);
    const creator = topicAddress(log.topics[2]);
    if (!token || !creator) return;
    const key = token.toLowerCase();
    if (this.processedTokens.has(key)) return;
    const target = this.task.targetWallet.trim().toLowerCase();
    if (target && creator.toLowerCase() !== target) return;
    if (this.pendingLaunch) {
      this.log('warning', `任务已锁定首个匹配代币 ${this.pendingLaunch.event.token}，忽略后续发射 ${token}`);
      return;
    }
    if (this.buyingLaunch) {
      this.log('warning', `任务正在买入首个匹配代币 ${this.buyingLaunch.event.token}，忽略后续发射 ${token}`);
      return;
    }
    if (this.validatingLaunch) {
      if (!this.deferredLaunchKeys.has(key)) {
        this.deferredLaunches.push(log);
        this.deferredLaunchKeys.add(key);
        this.log(
          'warning',
          `正在校验首个匹配代币 ${this.validatingLaunch.token}，将后续发射 ${token} 暂存为后备候选`,
        );
      }
      return;
    }

    // Reserve the first matching event synchronously, before any chain reads.
    // This prevents concurrent log handlers from letting RPC completion order
    // decide which token wins the task.
    const candidate: LaunchCandidateLock = { key, token };
    this.validatingLaunch = candidate;
    this.processedTokens.add(key);

    try {
      const launched = await this.publicClient.readContract({
        address: PONS_FACTORY,
        abi: PONS_LAUNCHPAD_ABI,
        functionName: 'getLaunchedToken',
        args: [token],
      });
      if (!launched.exists) throw new Error('getLaunchedToken 未确认该代币属于 Pons');

      const [launchConfig, dexConfig] = await Promise.all([
        this.publicClient.readContract({
          address: PONS_FACTORY,
          abi: PONS_LAUNCHPAD_ABI,
          functionName: 'getLaunchConfig',
          args: [launched.launchConfigId],
        }),
        this.publicClient.readContract({
          address: PONS_FACTORY,
          abi: PONS_LAUNCHPAD_ABI,
          functionName: 'getDexConfig',
          args: [launched.dexId],
        }),
      ]);
      if (!this.isRunning || this.validatingLaunch !== candidate) {
        this.processedTokens.delete(key);
        return;
      }

      const eventDexFactory = topicAddress(log.topics[3]);
      const isOfficialPonsV3 = (
        sameAddress(launched.token, token)
        && sameAddress(launched.deployer, creator)
        && sameAddress(launched.pairedToken, ROBINHOOD_WETH_ADDRESS)
        && sameAddress(launched.positionManager, UNISWAP_V3_ROBINHOOD_ADDRESSES.positionManager)
        && launched.poolFee === PONS_V3_POOL_FEE
        && launchConfig.enabled
        && sameAddress(launchConfig.pairToken, ROBINHOOD_WETH_ADDRESS)
        && dexConfig.enabled
        && dexConfig.poolFee === PONS_V3_POOL_FEE
        && sameAddress(dexConfig.factory, UNISWAP_V3_ROBINHOOD_ADDRESSES.factory)
        && sameAddress(dexConfig.swapRouter, UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02)
        && sameAddress(dexConfig.positionManager, UNISWAP_V3_ROBINHOOD_ADDRESSES.positionManager)
        && eventDexFactory !== null
        && sameAddress(eventDexFactory, UNISWAP_V3_ROBINHOOD_ADDRESSES.factory)
      );
      if (!isOfficialPonsV3) {
        throw new Error('候选代币不是官方 Robinhood WETH / Uniswap V3 1% Pons 配置');
      }

      const launchL1Block = launched.restrictionsEndBlock - BigInt(launchConfig.restrictionBlocks);
      const event: TokenCreatedEvent = {
        creator,
        token,
        blockNumber: BigInt(log.blockNumber),
        transactionHash: log.transactionHash,
      };
      this.pendingLaunch = {
        event,
        launchL1Block,
        restrictionsEndBlock: launched.restrictionsEndBlock,
        poolFee: launched.poolFee,
        supply: launched.supply,
        maxWalletBps: launchConfig.maxWalletBps,
        maxTxBps: launchConfig.maxTxBps,
      };
      this.validatingLaunch = null;
      this.deferredLaunches.length = 0;
      this.deferredLaunchKeys.clear();
      this.onTokenFound?.(event);
      this.log('success', `发现 Pons 代币 ${token}，创建者 ${creator}`, event);
      this.log('info', `发射 L1 区块 ${launchL1Block}；等待 current L1 > ${launchL1Block} 后买入`);
      await this.handleNewHead('latest');
    } catch (error: any) {
      this.processedTokens.delete(key);
      let next: RpcLog | undefined;
      if (this.validatingLaunch === candidate) {
        this.validatingLaunch = null;
        next = this.deferredLaunches.shift();
        const nextToken = topicAddress(next?.topics[1]);
        if (nextToken) this.deferredLaunchKeys.delete(nextToken.toLowerCase());
      }
      this.log('error', `读取 Pons 发射数据失败: ${error.message}`);
      if (next) await this.handleLaunchLog(next);
    }
  }

  private async handleNewHead(blockTag: string) {
    if (!this.isRunning || !this.pendingLaunch) return;
    const pendingCandidate = this.pendingLaunch;
    try {
      const currentL1 = await getRobinhoodL1BlockNumber(this.httpRpcUrl, blockTag);
      // WS newHeads and HTTP补漏可能同时进入；只有仍持有同一候选的调用可消费它。
      if (!this.isRunning || this.pendingLaunch !== pendingCandidate) return;
      if (currentL1 <= pendingCandidate.launchL1Block) return;
      const pending = pendingCandidate;
      this.pendingLaunch = null;
      this.buyingLaunch = pending;
      this.log('success', `L1 已进入 ${currentL1}，开始通过 Uniswap V3 买入 ${pending.event.token}`);
      let results: BuyResult[];
      try {
        // executeBuy performs all shared quote/restriction reads before entering
        // its per-wallet transaction block. Every wallet transaction is caught
        // and returned as a BuyResult, so a rejection here proves that no wallet
        // transaction has started and the same first candidate is safe to retry.
        results = await this.executeBuy(pending, currentL1);
      } catch (error) {
        const safeToRetry = error instanceof PonsBuyPrecheckError;
        if (safeToRetry && this.isRunning && this.buyingLaunch === pending && !this.pendingLaunch) {
          this.pendingLaunch = pending;
        }
        if (this.buyingLaunch === pending) this.buyingLaunch = null;
        if (!safeToRetry && this.isRunning) {
          // An unexpected rejection after wallet execution begins must never
          // restore the launch, because one or more transactions may already
          // have been broadcast.
          this.updateStatus('failed');
          this.stop(false);
        }
        throw error;
      }
      if (this.buyingLaunch === pending) this.buyingLaunch = null;
      this.onBuyComplete?.(results);
      const successCount = results.filter((result) => result.success).length;
      this.log(successCount > 0 ? 'success' : 'error', `Pons 买入完成: ${successCount}/${results.length} 成功`);
      this.updateStatus(successCount > 0 ? 'completed' : 'failed');
      this.stop(false);
    } catch (error: any) {
      this.log('warning', `读取 L1 区块或执行买入失败: ${error.message}`);
    }
  }

  private async executeBuy(pending: PendingLaunch, currentL1: bigint): Promise<BuyResult[]> {
    const token = pending.event.token as Address;
    const poolFee = pending.poolFee;
    let tradingService: ReturnType<typeof createTradingService>;
    const precheckErrors = new Map<string, string>();
    try {
      tradingService = createTradingService(
        4663,
        this.httpRpcUrl,
        UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
      );
      this.log('info', `每个钱包买入 ${this.task.buyAmount} ETH，V3 fee=${poolFee}，滑点=${this.task.slippage ?? 30}%`);
      if (currentL1 <= pending.restrictionsEndBlock) {
        const amountText = this.task.buyAmount.toFixed(18).replace(/\.?0+$/, '');
        const amountIn = parseEther(amountText);
        const v3 = new UniswapV3Service(this.publicClient, { defaultFee: poolFee });
        const quote = await v3.quoteExactInputSingle({
          tokenIn: ROBINHOOD_WETH_ADDRESS,
          tokenOut: token,
          amountIn,
          fee: poolFee,
        });
        const maxTxAmount = pending.maxTxBps > 0
          ? (pending.supply * BigInt(pending.maxTxBps)) / 10_000n
          : null;
        const maxWalletAmount = pending.maxWalletBps > 0
          ? (pending.supply * BigInt(pending.maxWalletBps)) / 10_000n
          : null;

        if (maxTxAmount !== null && quote.amountOut > maxTxAmount) {
          const message = `预计买入数量超过 Pons 限制期单笔上限 ${pending.maxTxBps / 100}%`;
          for (const wallet of this.task.wallets) precheckErrors.set(wallet.address.toLowerCase(), message);
        } else if (maxWalletAmount !== null) {
          await Promise.all(this.task.wallets.map(async wallet => {
            const balance = await this.publicClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [wallet.address as Address],
            });
            if (balance + quote.amountOut > maxWalletAmount) {
              precheckErrors.set(
                wallet.address.toLowerCase(),
                `预计持仓超过 Pons 限制期钱包上限 ${pending.maxWalletBps / 100}%`,
              );
            }
          }));
        }
        this.log('info', `当前仍在限制期（至 L1 ${pending.restrictionsEndBlock}），已执行 maxTx/maxWallet 预检`);
      }
    } catch (error) {
      throw new PonsBuyPrecheckError(error);
    }

    return Promise.all(this.task.wallets.map(async (wallet): Promise<BuyResult> => {
      try {
        const precheckError = precheckErrors.get(wallet.address.toLowerCase());
        if (precheckError) throw new Error(precheckError);
        const result = await tradingService.executeTrade({
          chainId: 4663,
          rpcUrl: this.httpRpcUrl,
          routerAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
          privateKey: wallet.privateKey,
          walletAddress: wallet.address,
          tokenAddress: token,
          spendToken: 'ETH',
          amount: this.task.buyAmount,
          amountType: 'amount',
          mode: 'pump',
          slippage: this.task.slippage ?? 30,
          gasPrice: this.task.gasPrice,
          gasLimit: this.task.gasLimit,
          v3FeeTier: poolFee,
        });
        if (!result.success) throw new Error(result.error || 'Uniswap V3 买入失败');
        this.log('success', `${wallet.address.slice(0, 10)}... 买入确认: ${result.txHash}`);
        return {
          success: true,
          walletAddress: wallet.address,
          txHash: result.txHash,
          tokensBought: result.amountOut,
        };
      } catch (error: any) {
        this.log('error', `${wallet.address.slice(0, 10)}... 买入失败: ${error.message}`);
        return { success: false, walletAddress: wallet.address, error: error.message };
      }
    }));
  }

  stop(updateStatus = true) {
    const wasRunning = this.isRunning;
    this.isRunning = false;
    this.rawWs?.close();
    this.rawWs = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.buyingLaunch = null;
    this.validatingLaunch = null;
    this.deferredLaunches.length = 0;
    this.deferredLaunchKeys.clear();
    if (updateStatus && wasRunning && this.task.status === 'running') this.updateStatus('stopped');
    if (wasRunning) this.log('info', 'Pons 狙击监听已停止');
  }

  destroy() {
    this.stop();
    this.pendingLaunch = null;
    this.processedTokens.clear();
  }

  getLogs() { return [...this.logs]; }
  getStatus() { return this.task.status; }
}

export function createPonsSnipeService(
  task: SnipeTaskConfig,
  httpRpcUrl?: string,
  wssRpcUrl?: string,
) {
  return new PonsSnipeService(task, httpRpcUrl, wssRpcUrl);
}
