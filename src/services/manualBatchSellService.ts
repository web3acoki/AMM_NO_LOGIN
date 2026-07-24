import { createPublicClient, http, isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { ENABLE_LOGIN } from '../config';
import { robinhood } from '../viem/chains/robinhood';
import * as walletApi from './walletApi';
import {
  createTradingService,
  resetNonceForAddress,
  type TradeParams,
  type TradeResult,
} from './tradingService';
import {
  withTransferLease,
  type TransferLeaseGuard,
} from './transferLeaseApi';
import {
  checkUnresolvedTransaction,
  markUnresolvedTransaction,
} from './unresolvedTransactionGuard';

export type ManualBatchSellStatus =
  | 'preflight'
  | 'processing'
  | 'broadcast'
  | 'confirmed'
  | 'pending'
  | 'unknown'
  | 'failed'
  | 'not_sent';

export type ManualBatchSellWallet = {
  address: string;
  privateKey: string;
  percent: number;
};

export type ManualBatchSellResult = {
  wallet: string;
  percent: number;
  success: boolean;
  status: ManualBatchSellStatus;
  hash?: string;
  transactionKind?: 'approval' | 'trade';
  amountIn?: string;
  amountOut?: string;
  error?: string;
};

type TradingServiceLike = {
  executeTrade: (params: TradeParams) => Promise<TradeResult>;
};

type PublicClientLike = ReturnType<typeof createPublicClient>;

export type ManualBatchSellDependencies = {
  publicClient?: PublicClientLike;
  tradingService?: TradingServiceLike;
  loginEnabled?: boolean;
  isLoggedIn?: () => boolean;
  walletLease?: typeof withTransferLease;
  checkUnresolved?: typeof checkUnresolvedTransaction;
  markUnresolved?: typeof markUnresolvedTransaction;
  monitorUnresolved?: (chainId: number, walletAddress: string, rpcUrl: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type ExecuteManualBatchSellOptions = {
  chainId: number;
  rpcUrl: string;
  routerAddress: string;
  tokenAddress: string;
  spendToken: string;
  intermediateToken?: string;
  v3FeeTier?: number;
  slippage: number;
  wallets: ManualBatchSellWallet[];
  intervalMs?: number;
  onProgress?: (results: ManualBatchSellResult[]) => void;
  dependencies?: ManualBatchSellDependencies;
};

const localLeaseKeys = new Set<string>();
const NONCE_PREFLIGHT_CONCURRENCY = 10;
const RECONCILIATION_INTERVAL_MS = 10_000;

function chainFor(chainId: number) {
  if (chainId === 56) return bsc;
  if (chainId === 97) return bscTestnet;
  if (chainId === 4663) return robinhood;
  throw new Error(`批量卖出不支持链 ID ${chainId}`);
}

function combineGuards(...guards: Array<TransferLeaseGuard | undefined>): TransferLeaseGuard {
  const active = guards.filter((guard): guard is TransferLeaseGuard => Boolean(guard));
  return {
    assertActive() {
      active.forEach(guard => guard.assertActive());
    },
  };
}

async function withLocalLease<T>(
  key: string,
  callback: (guard: TransferLeaseGuard) => Promise<T>,
): Promise<T> {
  if (localLeaseKeys.has(key)) throw new Error('另一个交易任务正在占用相同的钱包');
  localLeaseKeys.add(key);
  let retainedUntil: Promise<unknown> | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    localLeaseKeys.delete(key);
  };
  const guard: TransferLeaseGuard = {
    assertActive() {
      if (released) throw new Error('本地交易锁已释放');
    },
    retainUntil(settlement) {
      const safeSettlement = Promise.resolve(settlement).catch(() => undefined);
      retainedUntil = retainedUntil
        ? Promise.allSettled([retainedUntil, safeSettlement])
        : safeSettlement;
      return safeSettlement.then(() => undefined);
    },
  };

  try {
    return await callback(guard);
  } finally {
    const retention = retainedUntil as Promise<unknown> | null;
    if (retention) void retention.finally(release);
    else release();
  }
}

async function monitorUntilSettled(
  chainId: number,
  walletAddress: string,
  rpcUrl: string,
  check: typeof checkUnresolvedTransaction,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (;;) {
    try {
      const result = await check({ chainId, walletAddress, rpcUrl });
      if (!result.blocked) {
        if (result.reason !== 'none') resetNonceForAddress(walletAddress, chainId);
        return;
      }
    } catch {
      // Fail closed. This loop is read-only and never resubmits a transaction.
    }
    await sleep(RECONCILIATION_INTERVAL_MS);
  }
}

async function findBlockedWallets(
  options: ExecuteManualBatchSellOptions,
  wallets: ManualBatchSellWallet[],
  publicClient: PublicClientLike,
): Promise<Map<string, { wallet: string; message: string }>> {
  const check = options.dependencies?.checkUnresolved ?? checkUnresolvedTransaction;
  const blocked = new Map<string, { wallet: string; message: string }>();
  for (const wallet of wallets) {
    try {
      const unresolved = await check({
        chainId: options.chainId,
        walletAddress: wallet.address,
        rpcUrl: options.rpcUrl,
      });
      if (unresolved.blocked) {
        blocked.set(wallet.address.toLowerCase(), {
          wallet: wallet.address,
          message: unresolved.message,
        });
        continue;
      }
      if (unresolved.reason !== 'none') resetNonceForAddress(wallet.address, options.chainId);
    } catch (error: any) {
      blocked.set(wallet.address.toLowerCase(), {
        wallet: wallet.address,
        message: `无法核对上一笔交易状态: ${error?.message || '未知错误'}`,
      });
    }
  }

  const nonceCandidates = wallets.filter(wallet => !blocked.has(wallet.address.toLowerCase()));
  for (let offset = 0; offset < nonceCandidates.length; offset += NONCE_PREFLIGHT_CONCURRENCY) {
    const chunk = nonceCandidates.slice(offset, offset + NONCE_PREFLIGHT_CONCURRENCY);
    const checks = await Promise.allSettled(chunk.map(async wallet => {
      const address = wallet.address as `0x${string}`;
      const [latestNonce, pendingNonce] = await Promise.all([
        publicClient.getTransactionCount({ address, blockTag: 'latest' }),
        publicClient.getTransactionCount({ address, blockTag: 'pending' }),
      ]);
      return { wallet: wallet.address, latestNonce, pendingNonce };
    }));

    for (let index = 0; index < checks.length; index++) {
      const result = checks[index];
      const wallet = chunk[index].address;
      if (result.status === 'rejected') {
        blocked.set(wallet.toLowerCase(), {
          wallet,
          message: `无法读取 latest/pending nonce: ${result.reason?.message || 'RPC 请求失败'}`,
        });
        continue;
      }
      if (result.value.pendingNonce > result.value.latestNonce) {
        blocked.set(wallet.toLowerCase(), {
          wallet,
          message: `已有 ${result.value.pendingNonce - result.value.latestNonce} 笔链上待确认前序交易`,
        });
        continue;
      }
      if (result.value.pendingNonce < result.value.latestNonce) {
        blocked.set(wallet.toLowerCase(), {
          wallet,
          message: 'RPC 返回的 pending nonce 小于 latest nonce，状态不一致',
        });
      }
    }
  }

  return blocked;
}

export async function executeManualBatchSell(
  options: ExecuteManualBatchSellOptions,
): Promise<ManualBatchSellResult[]> {
  if (!isAddress(options.tokenAddress, { strict: false })) throw new Error('代币合约地址无效');
  if (!isAddress(options.routerAddress, { strict: false })) throw new Error('Router 地址无效');
  if (!options.rpcUrl.trim()) throw new Error('RPC URL 不能为空');
  if (!Number.isFinite(options.slippage) || options.slippage < 0 || options.slippage >= 100) {
    throw new Error('滑点必须在 0 到 100 之间');
  }

  const uniqueWallets = new Map<string, ManualBatchSellWallet>();
  for (const wallet of options.wallets) {
    if (!isAddress(wallet.address, { strict: false })) continue;
    if (!uniqueWallets.has(wallet.address.toLowerCase())) {
      uniqueWallets.set(wallet.address.toLowerCase(), wallet);
    }
  }
  const wallets = [...uniqueWallets.values()];
  if (wallets.length === 0) throw new Error('没有有效的卖出钱包');

  const results: ManualBatchSellResult[] = wallets.map(wallet => ({
    wallet: wallet.address,
    percent: wallet.percent,
    success: false,
    status: 'preflight',
    error: '正在进行整批安全预检',
  }));
  const publish = () => {
    try {
      options.onProgress?.(results.map(result => ({ ...result })));
    } catch (error) {
      console.warn('Failed to publish manual batch-sell progress:', error);
    }
  };
  publish();

  const dependencies = options.dependencies;
  const loginEnabled = dependencies?.loginEnabled ?? ENABLE_LOGIN;
  const isLoggedIn = dependencies?.isLoggedIn ?? walletApi.isLoggedIn;
  const walletLease = dependencies?.walletLease ?? withTransferLease;
  const sleep = dependencies?.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    (timer as unknown as { unref?: () => void }).unref?.();
  }));
  const publicClient = dependencies?.publicClient ?? createPublicClient({
    chain: chainFor(options.chainId),
    transport: http(options.rpcUrl, { timeout: 10_000 }),
  });
  const tradingService = dependencies?.tradingService ?? createTradingService(
    options.chainId,
    options.rpcUrl,
    options.routerAddress,
  );

  const runWallet = <T>(walletAddress: string, callback: (guard: TransferLeaseGuard) => Promise<T>) => {
    if (loginEnabled) return walletLease(options.chainId, walletAddress, callback);
    return withLocalLease(`wallet:${options.chainId}:${walletAddress.toLowerCase()}`, callback);
  };

  try {
    if (loginEnabled && !isLoggedIn()) {
      throw new Error('登录状态已失效，已停止批量卖出；请重新登录');
    }
    await (async () => {
      const blockedWallets = await findBlockedWallets(options, wallets, publicClient);
      for (let index = 0; index < wallets.length; index++) {
        const wallet = wallets[index];
        const blocked = blockedWallets.get(wallet.address.toLowerCase());
        if (!blocked) continue;
        results[index].status = 'not_sent';
        results[index].error = `${blocked.wallet.slice(0, 10)}... ${blocked.message}；只跳过该钱包，其他钱包继续`;
      }
      publish();

      const executableWallets = wallets
        .map((wallet, resultIndex) => ({ wallet, resultIndex }))
        .filter(({ wallet }) => !blockedWallets.has(wallet.address.toLowerCase()));
      if (executableWallets.length === 0) return;

      for (let executionIndex = 0; executionIndex < executableWallets.length; executionIndex++) {
        const { wallet, resultIndex } = executableWallets[executionIndex];
        const row = results[resultIndex];
        row.status = 'processing';
        row.error = '正在读取最新余额、授权和池报价';
        publish();

        try {
          const tradeResult = await runWallet(wallet.address, async walletGuard => {
            const leaseGuard = combineGuards(walletGuard);
            const result = await tradingService.executeTrade({
              chainId: options.chainId,
              rpcUrl: options.rpcUrl,
              routerAddress: options.routerAddress,
              privateKey: wallet.privateKey,
              walletAddress: wallet.address,
              tokenAddress: options.tokenAddress,
              spendToken: options.spendToken,
              amount: 0,
              amountType: 'amount',
              mode: 'dump',
              slippage: options.slippage,
              balancePercent: wallet.percent,
              intermediateToken: options.intermediateToken,
              v3FeeTier: options.v3FeeTier,
              leaseGuard,
              onTransactionHash(txHash, kind) {
                row.status = 'broadcast';
                row.hash = txHash;
                row.transactionKind = kind;
                row.error = kind === 'approval'
                  ? '授权已广播，确认后立即发送卖出'
                  : '卖出已广播，正在等待链上确认';
                publish();
              },
            });

            if (result.status === 'pending' || result.status === 'unknown') {
              const mark = dependencies?.markUnresolved ?? markUnresolvedTransaction;
              mark({
                chainId: options.chainId,
                walletAddress: wallet.address,
                status: result.status,
                txHash: result.txHash,
                rpcUrl: options.rpcUrl,
              });
              const settlement = dependencies?.monitorUnresolved
                ? dependencies.monitorUnresolved(options.chainId, wallet.address, options.rpcUrl)
                : monitorUntilSettled(
                    options.chainId,
                    wallet.address,
                    options.rpcUrl,
                    dependencies?.checkUnresolved ?? checkUnresolvedTransaction,
                    sleep,
                  );
              walletGuard.retainUntil?.(settlement);
            }
            return result;
          });

          row.hash = tradeResult.txHash ?? row.hash;
          row.transactionKind = tradeResult.transactionKind ?? row.transactionKind;
          row.amountIn = tradeResult.amountIn;
          row.amountOut = tradeResult.amountOut;
          if (tradeResult.success && tradeResult.status === 'confirmed') {
            row.success = true;
            row.status = 'confirmed';
            row.error = undefined;
          } else if (tradeResult.status === 'pending' || tradeResult.status === 'unknown') {
            row.success = false;
            row.status = tradeResult.status;
            row.error = tradeResult.error || '交易已广播但尚未完成链上确认';
          } else {
            row.success = false;
            row.status = 'failed';
            row.error = tradeResult.error || '卖出失败';
          }
        } catch (error: any) {
          row.success = false;
          row.status = 'failed';
          row.error = error?.message || '卖出执行异常';
        }
        publish();

        const intervalMs = Math.max(0, options.intervalMs ?? 0);
        if (intervalMs > 0 && executionIndex < executableWallets.length - 1) await sleep(intervalMs);
      }
    })();
  } catch (error: any) {
    const message = error?.message || '无法取得批量卖出交易锁';
    for (const result of results) {
      if (result.status === 'preflight' || result.status === 'processing') {
        result.status = 'not_sent';
        result.error = message;
      }
    }
    publish();
  }

  return results;
}
