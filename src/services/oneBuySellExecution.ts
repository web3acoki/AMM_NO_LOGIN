import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  PONS_V3_POOL_FEE,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_WETH_ADDRESS,
  UNISWAP_V3_ROBINHOOD_ADDRESSES,
} from '../constants';
import { robinhood } from '../viem/chains/robinhood';
import {
  controlOneBuySellRun,
  heartbeatOneBuySellRuntime,
  isOneBuySellRuntimeRevoked,
  patchOneBuySellRunState,
  startOneBuySellRuntime,
  type OneBuySellGroup,
  type OneBuySellRun,
  type OneBuySellStatePatch,
  type OneBuySellRuntimeLease,
  type OneBuySellWalletProgress,
} from './oneBuySellApi';
import { getRuntimeRobinhoodRpcUrl } from './robinhoodRpcConfig';
import { createTradingService, type TradeParams, type TradeResult } from './tradingService';
import { getV3Pool, readTokenMetadata } from './uniswapV3Service';
import { withTransferLease, type TransferLeaseGuard } from './transferLeaseApi';
import {
  executeOneToManyTransfer,
  type OneToManyTransferResult,
} from './oneToManyTransferService';

const RECEIPT_TIMEOUT_MS = 120_000;
const GAS_RESERVE_BUFFER_BPS = 13_000n;
const GAS_RESERVE_FIXED_WEI = parseEther('0.0001');
const NON_LAST_GAS_UNITS = 900_000n;
const LAST_GAS_UNITS = 850_000n;

export interface OneBuySellPrivateKey {
  address: string;
  privateKey: string;
}

export interface OneBuySellRunnerCallbacks {
  onRunUpdated?: (run: OneBuySellRun) => void;
  onRuntimeLost?: (message: string) => void;
  onFinished?: (run: OneBuySellRun) => void;
}

export interface SafeBuyEstimate {
  balanceWei: bigint;
  reserveWei: bigint;
  safeMaxWei: bigint;
  balanceEth: string;
  reserveEth: string;
  safeMaxEth: string;
}

export interface ValidatedOneBuySellToken {
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
  poolAddress: `0x${string}`;
}

type ReceiptOutcome = {
  status: 'confirmed' | 'failed' | 'pending';
  confirmedAt?: string;
  error?: string;
};

class RunnerCancelledError extends Error {
  constructor(message = '一买一卖运行已暂停或停止') {
    super(message);
    this.name = 'RunnerCancelledError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function actionableErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return errorMessage(error);
  const value = error as {
    code?: string;
    message?: string;
    data?: {
      conflicts?: Array<{ address?: string }>;
      missingAddresses?: string[];
    };
  };
  if (value.code === 'ONE_BUY_SELL_WALLET_CONFLICT') {
    const addresses = value.data?.conflicts?.map(item => item.address).filter(Boolean);
    return addresses?.length
      ? `以下钱包正在被其他一买一卖组使用：${addresses.join('、')}`
      : '组内钱包正在被其他一买一卖组使用';
  }
  if (value.code === 'ONE_BUY_SELL_PRIVATE_KEY_MISSING') {
    const addresses = value.data?.missingAddresses || [];
    return addresses.length
      ? `以下钱包缺少匹配私钥：${addresses.join('、')}`
      : '组内钱包缺少匹配私钥';
  }
  if (value.code === 'ONE_BUY_SELL_RUNTIME_BUSY') {
    return '该运行正在另一个页面执行，请先在原页面暂停或停止';
  }
  return value.message || errorMessage(error);
}

function createPaidPublicClient(rpcUrl = getRuntimeRobinhoodRpcUrl()) {
  return createPublicClient({
    chain: robinhood,
    transport: http(rpcUrl, {
      batch: {
        batchSize: 20,
        wait: 10,
      },
    }),
  });
}

type PaidPublicClient = ReturnType<typeof createPaidPublicClient>;

async function readFeeCap(publicClient: PaidPublicClient): Promise<bigint> {
  try {
    const fees = await publicClient.estimateFeesPerGas({ type: 'eip1559', chain: undefined });
    const cap = fees.maxFeePerGas ?? fees.maxPriorityFeePerGas;
    if (cap && cap > 0n) return cap;
  } catch {
    // Fall through to a legacy gas-price read.
  }
  const gasPrice = await publicClient.getGasPrice();
  if (gasPrice <= 0n) throw new Error('付费节点返回的 Gas 价格无效');
  return gasPrice;
}

export async function estimateOneBuySellSafeMax(
  publicClient: PaidPublicClient,
  address: string,
  isLastWallet: boolean,
): Promise<SafeBuyEstimate> {
  const normalized = address as `0x${string}`;
  const [balanceWei, feeCap] = await Promise.all([
    publicClient.getBalance({ address: normalized, blockTag: 'pending' }),
    readFeeCap(publicClient),
  ]);
  const gasUnits = isLastWallet ? LAST_GAS_UNITS : NON_LAST_GAS_UNITS;
  const variableReserve = (gasUnits * feeCap * GAS_RESERVE_BUFFER_BPS) / 10_000n;
  const reserveWei = variableReserve + GAS_RESERVE_FIXED_WEI;
  const safeMaxWei = balanceWei > reserveWei ? balanceWei - reserveWei : 0n;
  return {
    balanceWei,
    reserveWei,
    safeMaxWei,
    balanceEth: formatEther(balanceWei),
    reserveEth: formatEther(reserveWei),
    safeMaxEth: formatEther(safeMaxWei),
  };
}

export function randomAmountAtMostSixDecimals(
  minimum: number,
  maximum: number,
): string {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) {
    throw new Error('随机买入区间无效');
  }
  const minMicros = Math.ceil(minimum * 1_000_000 - 1e-9);
  const maxMicros = Math.floor(maximum * 1_000_000 + 1e-9);
  if (!Number.isSafeInteger(minMicros) || !Number.isSafeInteger(maxMicros) || maxMicros < minMicros) {
    throw new Error('随机买入区间无法按最多 6 位小数生成');
  }
  const units = minMicros === maxMicros
    ? minMicros
    : minMicros + Math.floor(Math.random() * (maxMicros - minMicros + 1));
  return (units / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
}

export async function validateOneBuySellToken(
  tokenAddress: string,
  rpcUrl = getRuntimeRobinhoodRpcUrl(),
): Promise<ValidatedOneBuySellToken> {
  if (!isAddress(tokenAddress)) throw new Error('目标代币合约地址格式无效');
  if (tokenAddress.toLowerCase() === ROBINHOOD_WETH_ADDRESS.toLowerCase()) {
    throw new Error('目标代币不能是 Robinhood WETH');
  }
  const publicClient = createPaidPublicClient(rpcUrl);
  const address = tokenAddress as `0x${string}`;
  const [metadata, pool] = await Promise.all([
    readTokenMetadata(publicClient, address),
    getV3Pool(
      publicClient,
      address,
      ROBINHOOD_WETH_ADDRESS,
      PONS_V3_POOL_FEE,
    ),
  ]);
  if (!pool || pool.liquidity <= 0n) {
    throw new Error('目标代币没有可用的 Robinhood Uniswap V3 1% 流动池');
  }
  return {
    address,
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    poolAddress: pool.address,
  };
}

export async function preflightFirstOneBuySellWallet(
  group: OneBuySellGroup,
  rpcUrl = getRuntimeRobinhoodRpcUrl(),
): Promise<SafeBuyEstimate> {
  const publicClient = createPaidPublicClient(rpcUrl);
  const service = createTradingService(
    ROBINHOOD_CHAIN_ID,
    rpcUrl,
    UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
  );
  const [safe] = await Promise.all([
    estimateOneBuySellSafeMax(
      publicClient,
      group.walletOrder[0],
      group.walletOrder.length === 1,
    ),
    service.warmupV3SellPreparation(
      group.tokenAddress as `0x${string}`,
      group.v3FeeTier,
    ),
  ]);
  if (safe.safeMaxWei < parseEther(String(group.amountMin))) {
    throw new Error(
      `第一个钱包可安全买入上限仅 ${safe.safeMaxEth} ETH，低于组内最小值 ${group.amountMin} ETH`
    );
  }
  return safe;
}

function validatePrivateKeys(
  walletOrder: string[],
  privateKeys: OneBuySellPrivateKey[],
): Map<string, `0x${string}`> {
  const byAddress = new Map<string, `0x${string}`>();
  for (const item of privateKeys) {
    try {
      const normalized = item.privateKey.startsWith('0x')
        ? item.privateKey
        : `0x${item.privateKey}`;
      const account = privateKeyToAccount(normalized as `0x${string}`);
      if (account.address.toLowerCase() === item.address.toLowerCase()) {
        byAddress.set(item.address.toLowerCase(), normalized as `0x${string}`);
      }
    } catch {
      // Missing/mismatched keys are reported together below.
    }
  }
  const missing = walletOrder.filter(address => !byAddress.has(address.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`以下钱包缺少匹配的私钥：${missing.join('、')}`);
  }
  return byAddress;
}

export function assertOneBuySellPrivateKeys(
  walletOrder: string[],
  privateKeys: OneBuySellPrivateKey[],
): void {
  validatePrivateKeys(walletOrder, privateKeys);
}

class RuntimeSession {
  private active = true;
  private heartbeatTimer: number | undefined;
  private heartbeatInFlight = false;

  constructor(
    readonly runId: string,
    readonly lease: OneBuySellRuntimeLease,
    private readonly onLost: (message: string) => void,
  ) {
    this.heartbeatTimer = window.setInterval(
      () => void this.heartbeat(),
      lease.heartbeatIntervalMs,
    );
  }

  assertActive(): void {
    if (!this.active) throw new RunnerCancelledError();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this.heartbeatTimer !== undefined) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  private async heartbeat(): Promise<void> {
    if (!this.active || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await heartbeatOneBuySellRuntime(this.runId, this.lease);
    } catch (error) {
      this.deactivate();
      this.onLost(
        isOneBuySellRuntimeRevoked(error)
          ? '运行权已失效，后续交易已停止'
          : `运行心跳失败，后续交易已停止：${errorMessage(error)}`,
      );
    } finally {
      this.heartbeatInFlight = false;
    }
  }
}

function combinedGuard(
  runtime: RuntimeSession,
  guard: TransferLeaseGuard,
): TransferLeaseGuard {
  return {
    ...guard,
    assertActive() {
      runtime.assertActive();
      guard.assertActive();
    },
  };
}

async function receiptOutcome(
  publicClient: PaidPublicClient,
  hash: Hash,
  wait = true,
): Promise<ReceiptOutcome> {
  try {
    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      if (!wait) return { status: 'pending', error: errorMessage(error) };
      receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
    }
    if (receipt.status !== 'success') {
      return { status: 'failed', error: '交易已在链上回滚' };
    }
    let confirmedAt = new Date().toISOString();
    try {
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      confirmedAt = new Date(Number(block.timestamp) * 1000).toISOString();
    } catch {
      // Confirmation observation time is a safe fallback.
    }
    return { status: 'confirmed', confirmedAt };
  } catch (error) {
    return { status: 'pending', error: errorMessage(error) };
  }
}

function normalizeUnlimitedSlippage(value: number): number {
  return value === 0 ? 100 : value;
}

export class OneBuySellRunner {
  private run: OneBuySellRun;
  private readonly rpcUrl: string;
  private readonly publicClient: PaidPublicClient;
  private readonly tradingService: ReturnType<typeof createTradingService>;
  private readonly privateKeys: Map<string, `0x${string}`>;
  private session: RuntimeSession | null = null;
  private patchQueue: Promise<OneBuySellRun> | null = null;
  private cancelled = false;

  constructor(
    run: OneBuySellRun,
    privateKeys: OneBuySellPrivateKey[],
    private readonly callbacks: OneBuySellRunnerCallbacks = {},
  ) {
    this.run = run;
    this.privateKeys = validatePrivateKeys(run.walletOrder, privateKeys);
    this.rpcUrl = getRuntimeRobinhoodRpcUrl();
    this.publicClient = createPaidPublicClient(this.rpcUrl);
    this.tradingService = createTradingService(
      ROBINHOOD_CHAIN_ID,
      this.rpcUrl,
      UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
    );
  }

  getRun(): OneBuySellRun {
    return this.run;
  }

  cancelLocal(): void {
    this.cancelled = true;
    this.session?.deactivate();
  }

  async execute(): Promise<OneBuySellRun> {
    try {
      const lease = await startOneBuySellRuntime(this.run._id);
      if (this.cancelled) throw new RunnerCancelledError();
      this.session = new RuntimeSession(this.run._id, lease, (message) => {
        this.cancelled = true;
        this.callbacks.onRuntimeLost?.(message);
      });
      this.run = { ...this.run, status: 'running' };
      this.callbacks.onRunUpdated?.(this.run);

      await this.tradingService.warmupV3SellPreparation(
        this.run.config.tokenAddress as `0x${string}`,
        this.run.config.v3FeeTier,
      );

      while (this.run.currentWalletIndex < this.run.walletProgress.length) {
        this.assertActive();
        const index = this.run.currentWalletIndex;
        let wallet = this.run.walletProgress[index];
        if (wallet.step === 'completed') {
          if (wallet.status !== 'completed') {
            await this.patch({
              currentStep: 'completed',
              walletIndex: index,
              wallet: {
                status: 'completed',
                step: 'completed',
                completedAt: wallet.completedAt || new Date().toISOString(),
                error: '',
              },
            });
            wallet = this.run.walletProgress[index];
          }
          if (index === this.run.walletProgress.length - 1) {
            await this.completeRun();
            break;
          }
          await this.patch({
            currentWalletIndex: index + 1,
            currentStep: 'ready',
          });
          continue;
        }
        await this.executeWallet(index);
      }
      return this.run;
    } catch (error) {
      if (
        error instanceof RunnerCancelledError
        || this.cancelled
        || isOneBuySellRuntimeRevoked(error)
      ) {
        return this.run;
      }
      await this.pauseForFailure(actionableErrorMessage(error));
      return this.run;
    } finally {
      this.session?.deactivate();
    }
  }

  private assertActive(): void {
    if (this.cancelled) throw new RunnerCancelledError();
    this.session?.assertActive();
  }

  private async patch(patch: OneBuySellStatePatch): Promise<OneBuySellRun> {
    this.assertActive();
    if (!this.session) throw new RunnerCancelledError();
    const request = async () => {
      this.assertActive();
      const updated = await patchOneBuySellRunState(
        this.run._id,
        this.session!.lease,
        patch,
      );
      this.run = updated;
      this.callbacks.onRunUpdated?.(updated);
      return updated;
    };
    const next = this.patchQueue
      ? this.patchQueue.catch(() => this.run).then(request)
      : request();
    this.patchQueue = next;
    try {
      return await next;
    } finally {
      if (this.patchQueue === next) this.patchQueue = null;
    }
  }

  private tradeParams(
    wallet: OneBuySellWalletProgress,
    mode: 'pump' | 'dump',
    amount: number,
    guard: TransferLeaseGuard,
    beforeBroadcast: TradeParams['onBeforeTransactionBroadcast'],
  ): TradeParams {
    return {
      chainId: ROBINHOOD_CHAIN_ID,
      rpcUrl: this.rpcUrl,
      routerAddress: UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
      privateKey: this.privateKeys.get(wallet.address.toLowerCase())!,
      walletAddress: wallet.address,
      tokenAddress: this.run.config.tokenAddress,
      spendToken: 'ETH',
      amount,
      amountType: mode === 'pump' ? 'amount' : 'quantity',
      mode,
      balancePercent: mode === 'dump' ? 100 : undefined,
      slippage: normalizeUnlimitedSlippage(
        mode === 'pump' ? this.run.config.buySlippage : this.run.config.sellSlippage,
      ),
      v3FeeTier: this.run.config.v3FeeTier,
      awaitConfirmation: false,
      leaseGuard: guard,
      onBeforeTransactionBroadcast: beforeBroadcast,
    };
  }

  private async executeWallet(index: number): Promise<void> {
    let wallet = this.run.walletProgress[index];
    if (!wallet.randomBuyAmount) {
      const safe = await estimateOneBuySellSafeMax(
        this.publicClient,
        wallet.address,
        index === this.run.walletProgress.length - 1,
      );
      const configuredMinWei = parseEther(String(this.run.config.amountMin));
      if (safe.safeMaxWei < configuredMinWei) {
        throw new Error(
          `钱包 ${wallet.address} 可安全买入上限 ${safe.safeMaxEth} ETH，低于最小值 ${this.run.config.amountMin} ETH；请补充 ETH 后点击继续`
        );
      }
      const effectiveMax = Math.min(
        this.run.config.amountMax,
        Number(formatEther(safe.safeMaxWei)),
      );
      const amount = randomAmountAtMostSixDecimals(
        this.run.config.amountMin,
        effectiveMax,
      );
      await this.patch({
        currentStep: 'preflight',
        walletIndex: index,
        wallet: {
          status: 'running',
          step: 'preflight',
          startedAt: wallet.startedAt || new Date().toISOString(),
          safeBuyMax: safe.safeMaxEth,
          randomBuyAmount: amount,
          error: '',
        },
        log: {
          level: 'info',
          message: `钱包 ${index + 1}/${this.run.walletProgress.length} 安全上限 ${safe.safeMaxEth} ETH，本次随机买入 ${amount} ETH`,
          walletAddress: wallet.address,
        },
      });
      wallet = this.run.walletProgress[index];
    }

    await this.ensureBuy(index);
    await this.waitUntilSell(index);
    await this.ensureApproval(index);
    await this.ensureSell(index);
    await this.finishOrTransfer(index);
  }

  private async ensureBuy(index: number): Promise<void> {
    let wallet = this.run.walletProgress[index];
    if (wallet.buyConfirmedAt) return;

    if (wallet.buyTxHash) {
      const outcome = await receiptOutcome(this.publicClient, wallet.buyTxHash);
      if (outcome.status !== 'confirmed') {
        throw new Error(
          outcome.status === 'failed'
            ? `买入交易 ${wallet.buyTxHash} 已回滚`
            : `买入交易 ${wallet.buyTxHash} 尚未确认，请稍后继续`
        );
      }
      await this.markBuyConfirmed(index, outcome.confirmedAt!);
      return;
    }

    await this.patch({
      currentStep: 'buying',
      walletIndex: index,
      wallet: { status: 'running', step: 'buying', error: '' },
      log: {
        level: 'info',
        message: `开始买入 ${wallet.randomBuyAmount} ETH`,
        walletAddress: wallet.address,
      },
    });
    wallet = this.run.walletProgress[index];
    const result = await withTransferLease(
      ROBINHOOD_CHAIN_ID,
      wallet.address,
      async (rawGuard) => {
        const guard = combinedGuard(this.session!, rawGuard);
        const trade = await this.tradingService.executeTrade(this.tradeParams(
          wallet,
          'pump',
          Number(wallet.randomBuyAmount),
          guard,
          async (hash, kind) => {
            if (kind !== 'trade') return;
            await this.patch({
              currentStep: 'buying',
              walletIndex: index,
              wallet: { step: 'buying', buyTxHash: hash as `0x${string}` },
              log: {
                level: 'info',
                message: '买入交易已签名并持久化，开始广播',
                walletAddress: wallet.address,
                txHash: hash as `0x${string}`,
              },
            });
          },
        ));
        if (trade.settlement) void rawGuard.retainUntil?.(trade.settlement);
        return trade;
      },
    );
    const outcome = await this.resolveTradeResult(result, '买入');
    if (outcome.status !== 'confirmed') {
      throw new Error(outcome.error || '买入交易状态未知');
    }
    const confirmed = result.txHash
      ? await receiptOutcome(this.publicClient, result.txHash as Hash, false)
      : outcome;
    await this.markBuyConfirmed(
      index,
      confirmed.status === 'confirmed' && confirmed.confirmedAt
        ? confirmed.confirmedAt
        : new Date().toISOString(),
    );
  }

  private async markBuyConfirmed(index: number, confirmedAt: string): Promise<void> {
    const wallet = this.run.walletProgress[index];
    const sellAt = new Date(
      new Date(confirmedAt).getTime() + this.run.config.sellDelaySeconds * 1000,
    ).toISOString();
    await this.patch({
      currentStep: 'waiting_sell',
      sellAt,
      walletIndex: index,
      wallet: {
        status: 'running',
        step: 'waiting_sell',
        buyConfirmedAt: confirmedAt,
        sellAt,
        error: '',
      },
      log: {
        level: 'success',
        message: `买入已确认，将于 ${new Date(sellAt).toLocaleString()} 全部卖出`,
        walletAddress: wallet.address,
        txHash: wallet.buyTxHash,
      },
    });
  }

  private async waitUntilSell(index: number): Promise<void> {
    const wallet = this.run.walletProgress[index];
    const sellAt = wallet.sellAt || this.run.sellAt;
    if (!sellAt) throw new Error('买入已确认但缺少卖出计划时间');
    while (Date.now() < new Date(sellAt).getTime()) {
      this.assertActive();
      await new Promise<void>(resolve => {
        window.setTimeout(resolve, Math.min(1000, new Date(sellAt).getTime() - Date.now()));
      });
    }
    this.assertActive();
  }

  private async ensureApproval(index: number): Promise<void> {
    let wallet = this.run.walletProgress[index];
    if (wallet.approvalConfirmedAt) return;

    if (wallet.approvalTxHash) {
      const outcome = await receiptOutcome(this.publicClient, wallet.approvalTxHash);
      if (outcome.status !== 'confirmed') {
        throw new Error(
          outcome.status === 'failed'
            ? `授权交易 ${wallet.approvalTxHash} 已回滚`
            : `授权交易 ${wallet.approvalTxHash} 尚未确认，请稍后继续`
        );
      }
      await this.markApprovalReady(index, outcome.confirmedAt!);
      return;
    }

    const approval = await this.tradingService.checkV3SellApproval(
      this.run.config.tokenAddress as `0x${string}`,
      wallet.address as `0x${string}`,
    );
    if (approval.error) throw new Error(`读取卖出授权失败：${approval.error}`);
    if (approval.ready) {
      await this.markApprovalReady(index, new Date().toISOString());
      return;
    }

    await this.patch({
      currentStep: 'approving',
      walletIndex: index,
      wallet: { status: 'running', step: 'approving', error: '' },
      log: {
        level: 'info',
        message: '代币需要授权，开始提交无限额度授权',
        walletAddress: wallet.address,
      },
    });
    wallet = this.run.walletProgress[index];
    const result = await withTransferLease(
      ROBINHOOD_CHAIN_ID,
      wallet.address,
      async (rawGuard) => {
        const guard = combinedGuard(this.session!, rawGuard);
        return this.tradingService.ensureV3SellApproval(
          this.tradeParams(
            wallet,
            'dump',
            0,
            guard,
            async (hash, kind) => {
              if (kind !== 'approval') return;
              await this.patch({
                currentStep: 'approving',
                walletIndex: index,
                wallet: { step: 'approving', approvalTxHash: hash as `0x${string}` },
                log: {
                  level: 'info',
                  message: '授权交易已签名并持久化，开始广播',
                  walletAddress: wallet.address,
                  txHash: hash as `0x${string}`,
                },
              });
            },
          ),
          approval.allowance,
        );
      },
    );
    if (!result.success || !['confirmed', undefined].includes(result.status)) {
      throw new Error(result.error || '代币授权失败或状态未知');
    }
    const confirmedAt = result.txHash
      ? (await receiptOutcome(this.publicClient, result.txHash as Hash, false)).confirmedAt
      : undefined;
    await this.markApprovalReady(index, confirmedAt || new Date().toISOString());
  }

  private async markApprovalReady(index: number, confirmedAt: string): Promise<void> {
    const wallet = this.run.walletProgress[index];
    await this.patch({
      currentStep: 'selling',
      walletIndex: index,
      wallet: {
        status: 'running',
        step: 'selling',
        approvalConfirmedAt: confirmedAt,
        error: '',
      },
      log: {
        level: 'success',
        message: wallet.approvalTxHash ? '卖出授权已确认' : '卖出授权额度已满足',
        walletAddress: wallet.address,
        txHash: wallet.approvalTxHash,
      },
    });
  }

  private async ensureSell(index: number): Promise<void> {
    let wallet = this.run.walletProgress[index];
    if (wallet.sellConfirmedAt) return;

    if (wallet.sellTxHash) {
      const outcome = await receiptOutcome(this.publicClient, wallet.sellTxHash);
      if (outcome.status !== 'confirmed') {
        throw new Error(
          outcome.status === 'failed'
            ? `卖出交易 ${wallet.sellTxHash} 已回滚`
            : `卖出交易 ${wallet.sellTxHash} 尚未确认，请稍后继续`
        );
      }
      await this.markSellConfirmed(index, outcome.confirmedAt!);
      return;
    }

    const tokenBalance = await this.tradingService.readTokenBalance(
      this.run.config.tokenAddress as `0x${string}`,
      wallet.address as `0x${string}`,
    );
    if (tokenBalance <= 0n) throw new Error('当前钱包目标代币余额为 0，无法执行全部卖出');

    await this.patch({
      currentStep: 'selling',
      walletIndex: index,
      wallet: { status: 'running', step: 'selling', error: '' },
      log: {
        level: 'info',
        message: `开始卖出全部 ${formatUnits(tokenBalance, this.run.config.tokenDecimals)} ${this.run.config.tokenSymbol || 'Token'}`,
        walletAddress: wallet.address,
      },
    });
    wallet = this.run.walletProgress[index];
    const result = await withTransferLease(
      ROBINHOOD_CHAIN_ID,
      wallet.address,
      async (rawGuard) => {
        const guard = combinedGuard(this.session!, rawGuard);
        const trade = await this.tradingService.executeTrade(this.tradeParams(
          wallet,
          'dump',
          0,
          guard,
          async (hash, kind) => {
            if (kind !== 'trade') return;
            await this.patch({
              currentStep: 'selling',
              walletIndex: index,
              wallet: { step: 'selling', sellTxHash: hash as `0x${string}` },
              log: {
                level: 'info',
                message: '全部卖出交易已签名并持久化，开始广播',
                walletAddress: wallet.address,
                txHash: hash as `0x${string}`,
              },
            });
          },
        ));
        if (trade.settlement) void rawGuard.retainUntil?.(trade.settlement);
        return trade;
      },
    );
    const outcome = await this.resolveTradeResult(result, '卖出');
    if (outcome.status !== 'confirmed') {
      throw new Error(outcome.error || '卖出交易状态未知');
    }
    const confirmed = result.txHash
      ? await receiptOutcome(this.publicClient, result.txHash as Hash, false)
      : outcome;
    await this.markSellConfirmed(
      index,
      confirmed.status === 'confirmed' && confirmed.confirmedAt
        ? confirmed.confirmedAt
        : new Date().toISOString(),
    );
  }

  private async markSellConfirmed(index: number, confirmedAt: string): Promise<void> {
    const wallet = this.run.walletProgress[index];
    const isLast = index === this.run.walletProgress.length - 1;
    await this.patch({
      currentStep: isLast ? 'completed' : 'transferring',
      sellAt: null,
      walletIndex: index,
      wallet: {
        status: 'running',
        step: isLast ? 'completed' : 'transferring',
        sellConfirmedAt: confirmedAt,
        error: '',
      },
      log: {
        level: 'success',
        message: isLast ? '全部卖出已确认，正在核对最终余额' : '全部卖出已确认，准备转出全部可转 ETH',
        walletAddress: wallet.address,
        txHash: wallet.sellTxHash,
      },
    });
  }

  private async finishOrTransfer(index: number): Promise<void> {
    let wallet = this.run.walletProgress[index];
    const isLast = index === this.run.walletProgress.length - 1;
    if (isLast) {
      const [ethBalance, tokenBalance] = await Promise.all([
        this.publicClient.getBalance({
          address: wallet.address as `0x${string}`,
          blockTag: 'pending',
        }),
        this.tradingService.readTokenBalance(
          this.run.config.tokenAddress as `0x${string}`,
          wallet.address as `0x${string}`,
        ),
      ]);
      await this.patch({
        currentStep: 'completed',
        walletIndex: index,
        wallet: {
          status: 'completed',
          step: 'completed',
          finalEthBalance: formatEther(ethBalance),
          finalTokenBalance: formatUnits(tokenBalance, this.run.config.tokenDecimals),
          completedAt: new Date().toISOString(),
          error: '',
        },
        log: {
          level: 'success',
          message: `最后钱包完成，最终保留 ${formatEther(ethBalance)} ETH`,
          walletAddress: wallet.address,
        },
      });
      await this.completeRun();
      return;
    }

    if (wallet.transferConfirmedAt) {
      await this.advanceToNextWallet(index);
      return;
    }
    if (wallet.transferTxHash) {
      const outcome = await receiptOutcome(this.publicClient, wallet.transferTxHash);
      if (outcome.status !== 'confirmed') {
        throw new Error(
          outcome.status === 'failed'
            ? `ETH 转账 ${wallet.transferTxHash} 已回滚`
            : `ETH 转账 ${wallet.transferTxHash} 尚未确认，请稍后继续`
        );
      }
      await this.markTransferConfirmed(index, outcome.confirmedAt!, wallet.transferredEth);
      await this.advanceToNextWallet(index);
      return;
    }

    const nextAddress = this.run.walletOrder[index + 1];
    const result = await withTransferLease(
      ROBINHOOD_CHAIN_ID,
      wallet.address,
      async (rawGuard) => executeOneToManyTransfer({
        chain: robinhood,
        rpcUrl: this.rpcUrl,
        sourceAddress: wallet.address,
        targetAddresses: [nextAddress],
        privateKey: this.privateKeys.get(wallet.address.toLowerCase())!,
        amount: 0,
        asset: { kind: 'native', symbol: 'ETH' },
        transferAllBalance: true,
        intervalMs: 0,
        leaseGuard: combinedGuard(this.session!, rawGuard),
        dependencies: { publicClient: this.publicClient },
        onBeforeBroadcast: async (pending) => {
          if (!pending.hash) throw new Error('转账签名后未生成确定性哈希');
          await this.patch({
            currentStep: 'transferring',
            walletIndex: index,
            wallet: {
              status: 'running',
              step: 'transferring',
              transferTxHash: pending.hash,
              transferTo: nextAddress,
              transferredEth: pending.amount,
            },
            log: {
              level: 'info',
              message: `全部可转 ETH（${pending.amount} ETH）已签名并持久化，开始转给下一个钱包`,
              walletAddress: wallet.address,
              txHash: pending.hash,
            },
          });
        },
      }),
    );
    const transfer = result[0];
    if (!transfer || transfer.status !== 'confirmed') {
      throw new Error(transfer?.error || 'ETH 全余额转账失败或状态未知');
    }
    await this.markTransferConfirmed(
      index,
      new Date().toISOString(),
      transfer.amount,
      transfer,
    );
    await this.advanceToNextWallet(index);
  }

  private async markTransferConfirmed(
    index: number,
    confirmedAt: string,
    transferredEth?: string,
    transfer?: OneToManyTransferResult,
  ): Promise<void> {
    const wallet = this.run.walletProgress[index];
    await this.patch({
      currentStep: 'transferring',
      walletIndex: index,
      wallet: {
        status: 'completed',
        step: 'completed',
        transferConfirmedAt: confirmedAt,
        transferredEth: transferredEth || transfer?.amount || wallet.transferredEth,
        completedAt: confirmedAt,
        error: '',
      },
      log: {
        level: 'success',
        message: `已将全部可转 ETH 转给钱包 ${index + 2}/${this.run.walletProgress.length}`,
        walletAddress: wallet.address,
        txHash: wallet.transferTxHash || transfer?.hash,
      },
    });
  }

  private async advanceToNextWallet(index: number): Promise<void> {
    await this.patch({
      currentWalletIndex: index + 1,
      currentStep: 'ready',
      log: {
        level: 'info',
        message: `进入钱包 ${index + 2}/${this.run.walletProgress.length}`,
        walletAddress: this.run.walletOrder[index + 1],
      },
    });
  }

  private async resolveTradeResult(
    result: TradeResult,
    label: string,
  ): Promise<ReceiptOutcome> {
    if (!result.success) {
      return {
        status: result.status === 'failed' ? 'failed' : 'pending',
        error: result.error || `${label}失败`,
      };
    }
    if (result.status === 'confirmed') {
      return { status: 'confirmed', confirmedAt: new Date().toISOString() };
    }
    if (result.status === 'broadcast' && result.settlement) {
      const settlement = await result.settlement;
      return {
        status: settlement.status === 'confirmed'
          ? 'confirmed'
          : settlement.status === 'failed'
            ? 'failed'
            : 'pending',
        confirmedAt: settlement.status === 'confirmed' ? new Date().toISOString() : undefined,
        error: settlement.error,
      };
    }
    return {
      status: 'pending',
      error: result.error || `${label}广播结果未知，已禁止自动重发`,
    };
  }

  private async completeRun(): Promise<void> {
    if (this.run.status === 'completed') return;
    await this.patch({
      status: 'completed',
      currentStep: 'completed',
      log: {
        level: 'success',
        message: `第 ${this.run.runNumber} 轮全部 ${this.run.walletProgress.length} 个钱包执行完成`,
      },
    });
    this.session?.deactivate();
    this.callbacks.onFinished?.(this.run);
  }

  private async pauseForFailure(reason: string): Promise<void> {
    this.callbacks.onRuntimeLost?.(reason);
    const walletIndex = Math.min(
      Math.max(this.run.currentWalletIndex, 0),
      this.run.walletProgress.length - 1,
    );
    const wallet = this.run.walletProgress[walletIndex];
    try {
      if (this.session?.isActive()) {
        await this.patch({
          walletIndex,
          wallet: {
            status: 'paused',
            error: reason,
          },
          pauseReason: reason,
          log: {
            level: 'error',
            message: `运行暂停：${reason}`,
            walletAddress: wallet?.address,
          },
        });
      }
    } catch {
      // The control endpoint below is authoritative when state persistence lost its runtime.
    }
    this.cancelled = true;
    this.session?.deactivate();
    try {
      this.run = await controlOneBuySellRun(this.run._id, 'pause', reason);
      this.callbacks.onRunUpdated?.(this.run);
    } catch (error) {
      this.callbacks.onRuntimeLost?.(`暂停状态保存失败：${errorMessage(error)}`);
    }
  }
}
