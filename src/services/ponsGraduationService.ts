import { formatEther, type Address } from 'viem';
import {
  PONS_FACTORY,
  PONS_LAUNCHPAD_ABI,
  createPonsPublicClient,
  readAndValidatePonsLaunchedToken,
} from './ponsService';
import { getRuntimeRobinhoodRpcUrl } from './robinhoodRpcConfig';
import type { MigrationEvent, MigrationLog } from './migrationService';
import { uniswapV3FactoryAbi } from '../viem/abis/uniswapV3';

export interface PonsGraduationSnapshot {
  tokenAddress: Address;
  pairedPrincipal: bigint;
  threshold: bigint;
  graduated: boolean;
}

// v1 wrote this key before the sell callback had finished.  A rejected or
// partially failed sell could therefore suppress every future retry.  Keep a
// versioned completion key and only persist it after the callback confirms that
// every wallet requiring a sell has completed.
const completionKey = (token: string) => `pons:graduation-completed:v2:${token.toLowerCase()}`;
const observationKey = (token: string) => `pons:graduation-observed:v2:${token.toLowerCase()}`;
const legacyLatchKey = (token: string) => `pons:graduation-latched:${token.toLowerCase()}`;

export type PonsGraduationHandler = (event: MigrationEvent) => boolean | Promise<boolean>;

export class PonsGraduationService {
  private readonly publicClient;
  private readonly pollInterval: number;
  private monitoredTokens = new Set<string>();
  private completedTokens = new Set<string>();
  private inFlightTokens = new Set<string>();
  private observedTokens = new Set<string>();
  private isRunning = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onMigrationDetected: PonsGraduationHandler | null = null;
  private onLog: ((log: MigrationLog) => void) | null = null;

  constructor(httpRpcUrl: string = getRuntimeRobinhoodRpcUrl(), pollInterval = 3000) {
    this.publicClient = createPonsPublicClient(httpRpcUrl);
    this.pollInterval = Math.max(1000, pollInterval);
  }

  setOnMigrationDetected(callback: PonsGraduationHandler) {
    this.onMigrationDetected = callback;
  }

  setOnLog(callback: (log: MigrationLog) => void) {
    this.onLog = callback;
  }

  updateMonitoredTokens(tokens: Set<string>) {
    this.monitoredTokens = new Set(Array.from(tokens, (token) => token.toLowerCase()));
    this.log('info', `Pons 毕业监控列表已更新，共 ${this.monitoredTokens.size} 个代币`);
  }

  getMonitoredTokenCount() { return this.monitoredTokens.size; }

  async start() {
    if (this.isRunning) return;
    if (this.monitoredTokens.size === 0) throw new Error('没有需要监控的 Pons 代币');
    // Fail closed before monitoring/pre-approval begins. The same mutable DEX
    // entry is checked again at event handling and immediately before trades.
    await Promise.all(Array.from(this.monitoredTokens, token => (
      readAndValidatePonsLaunchedToken(this.publicClient, token as Address)
    )));
    this.isRunning = true;
    this.log('success', 'Pons 毕业监控已启动：首次 graduationStatus=true 时触发卖出，失败钱包会自动重试');
    void this.poll();
  }

  stop() {
    const wasRunning = this.isRunning;
    this.isRunning = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (wasRunning) this.log('info', 'Pons 毕业监控已停止');
  }

  destroy() {
    this.stop();
    this.onMigrationDetected = null;
    this.onLog = null;
  }

  async getStatus(token: Address): Promise<PonsGraduationSnapshot> {
    const [pairedPrincipal, threshold, graduated] = await this.publicClient.readContract({
      address: PONS_FACTORY,
      abi: PONS_LAUNCHPAD_ABI,
      functionName: 'graduationStatus',
      args: [token],
    });
    return { tokenAddress: token, pairedPrincipal, threshold, graduated };
  }

  clearLocalLatch(token: string) {
    const key = token.toLowerCase();
    this.completedTokens.delete(key);
    this.inFlightTokens.delete(key);
    this.observedTokens.delete(key);
    localStorage.removeItem(completionKey(key));
    localStorage.removeItem(observationKey(key));
    // Also remove the unsafe key written by older builds.
    localStorage.removeItem(legacyLatchKey(key));
  }

  private isCompleted(token: string): boolean {
    if (this.completedTokens.has(token)) return true;
    try {
      if (localStorage.getItem(completionKey(token)) === '1') {
        this.completedTokens.add(token);
        return true;
      }
    } catch {
      // Browser storage may be unavailable (for example in strict privacy
      // mode).  The in-memory completion set still prevents session repeats.
    }
    return false;
  }

  private markCompleted(token: string) {
    this.completedTokens.add(token);
    try {
      localStorage.setItem(completionKey(token), '1');
      localStorage.removeItem(observationKey(token));
      localStorage.removeItem(legacyLatchKey(token));
    } catch (error: any) {
      this.log('warning', `卖出已完成，但无法写入浏览器完成记录: ${error.message}`);
    }
  }

  private isObserved(token: string): boolean {
    if (this.observedTokens.has(token)) return true;
    try {
      // Treat the old unsafe latch as an observation, never as completion. This
      // repairs browsers that already persisted v1 before a failed sell.
      if (
        localStorage.getItem(observationKey(token)) === '1'
        || localStorage.getItem(legacyLatchKey(token)) === '1'
      ) {
        this.observedTokens.add(token);
        localStorage.setItem(observationKey(token), '1');
        localStorage.removeItem(legacyLatchKey(token));
        return true;
      }
    } catch {
      // Session state remains usable when browser storage is unavailable.
    }
    return false;
  }

  private markObserved(token: string) {
    this.observedTokens.add(token);
    try {
      localStorage.setItem(observationKey(token), '1');
      localStorage.removeItem(legacyLatchKey(token));
    } catch {
      // Observation remains latched for this browser session.
    }
  }

  private async poll() {
    if (!this.isRunning) return;
    for (const token of this.monitoredTokens) {
      if (!this.isRunning) break;
      try {
        const snapshot = await this.getStatus(token as Address);
        const previouslyObserved = this.isObserved(token);
        // graduationStatus is dynamic. Once true has been observed, keep
        // retrying unfinished wallets even if pairedPrincipal later dips below
        // the threshold.
        if (!snapshot.graduated && !previouslyObserved) continue;
        if (this.isCompleted(token) || this.inFlightTokens.has(token)) continue;

        // This lock is deliberately session-only.  It prevents concurrent
        // callbacks while leaving the token eligible for a later retry when
        // any wallet fails.
        this.inFlightTokens.add(token);
        this.markObserved(token);

        // Pons computes this dynamically and can later fall below the threshold.
        // Remember the first true observation in memory, but do not persist a
        // completion latch until the sell callback reports full success.
        try {
          const [blockNumber, validated] = await Promise.all([
            this.publicClient.getBlockNumber(),
            readAndValidatePonsLaunchedToken(this.publicClient, token as Address),
          ]);
          const poolAddress = await this.publicClient.readContract({
            address: validated.dex.factory,
            abi: uniswapV3FactoryAbi,
            functionName: 'getPool',
            args: [
              token as Address,
              validated.launched.pairedToken,
              validated.launched.poolFee,
            ],
          });
          if (poolAddress === '0x0000000000000000000000000000000000000000') {
            throw new Error('官方 Uniswap V3 Factory 未返回该 Pons 1% 池');
          }
          const event: MigrationEvent = {
            tokenAddress: token,
            pairAddress: poolAddress,
            pairedWith: validated.launched.pairedToken,
            blockNumber,
            transactionHash: '',
            source: 'PonsGraduation',
          };
          const firstObservation = !previouslyObserved;
          this.log(
            firstObservation ? 'success' : 'warning',
            firstObservation
              ? `Pons 首次达到毕业阈值：${formatEther(snapshot.pairedPrincipal)} / ${formatEther(snapshot.threshold)} ETH`
              : `Pons 毕业卖出尚未全部完成，正在重试失败钱包：${token.slice(0, 10)}...`,
            snapshot,
          );

          const completed = this.onMigrationDetected
            ? await this.onMigrationDetected(event)
            : false;
          if (completed) {
            this.markCompleted(token);
            this.log('success', `Pons 毕业卖出已全部完成：${token.slice(0, 10)}...`);
          } else {
            this.log('warning', `Pons 毕业卖出未全部完成，将在下次轮询重试失败钱包`);
          }
        } finally {
          this.inFlightTokens.delete(token);
        }
      } catch (error: any) {
        this.inFlightTokens.delete(token);
        this.log('warning', `处理 ${token.slice(0, 10)}... Pons 毕业状态失败: ${error.message}`);
      }
    }
    if (this.isRunning) this.timer = setTimeout(() => void this.poll(), this.pollInterval);
  }

  private log(type: MigrationLog['type'], message: string, data?: unknown) {
    this.onLog?.({ timestamp: Date.now(), type, message, data });
  }
}

export function createPonsGraduationService(httpRpcUrl?: string, pollInterval?: number) {
  return new PonsGraduationService(httpRpcUrl, pollInterval);
}
