import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi } from '../viem/abis/erc20';
import { parseBlockchainError } from '../utils/errorParser';

const ROBINHOOD_CHAIN_ID = 4663;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000;
const GAS_LIMIT_BUFFER_PERCENT = 20n;
const FEE_CAP_BUFFER_PERCENT = 20n;
const GAS_ESTIMATE_CONCURRENCY = 8;

export type OneToManyTransferStatus =
  | 'confirmed'
  | 'pending'
  | 'failed'
  | 'not_sent'
  | 'unknown';

export type OneToManyTransferResult = {
  source: string;
  target: string;
  hash?: Hash;
  nonce?: number;
  error?: string;
  success: boolean;
  status: OneToManyTransferStatus;
  retryable: false;
  amount: string;
};

export type OneToManyTransferAsset =
  | {
      kind: 'native';
      symbol: string;
    }
  | {
      kind: 'erc20';
      address: Address;
      symbol: string;
      decimals: number;
    };

type PublicClient = ReturnType<typeof createPublicClient>;

export type OneToManyTransferDependencies = {
  publicClient?: PublicClient;
  sleep?: (milliseconds: number) => Promise<void>;
  confirmationTimeoutMs?: number;
  reconciliationAttempts?: number;
};

export type ExecuteOneToManyTransferOptions = {
  chain: Chain;
  rpcUrl: string;
  sourceAddress: string;
  targetAddresses: string[];
  privateKey: string;
  amount: string | number;
  asset: OneToManyTransferAsset;
  transferAllBalance?: boolean;
  intervalMs?: number;
  leaseGuard?: {
    assertActive: () => void;
  };
  onProgress?: (results: OneToManyTransferResult[]) => void;
  dependencies?: OneToManyTransferDependencies;
};

type FeeQuote =
  | {
      type: 'eip1559';
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      budgetFeePerGas: bigint;
    }
  | {
      type: 'legacy';
      gasPrice: bigint;
      budgetFeePerGas: bigint;
    };

type PlannedTransaction = {
  index: number;
  source: Address;
  target: Address;
  to: Address;
  value: bigint;
  data?: Hex;
  gas: bigint;
  nonce: number;
  serializedTransaction: Hex;
  expectedHash: Hash;
  amount: string;
};

const activeFallbackLocks = new Set<string>();

function addPercent(value: bigint, percent: bigint): bigint {
  return (value * (100n + percent) + 99n) / 100n;
}

function normalizeAddress(value: string, label: string): Address {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`${label}格式无效: ${trimmed || '空地址'}`);
  }
  return getAddress(trimmed.toLowerCase());
}

function normalizePrivateKey(value: string): Hex {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('源钱包私钥格式无效');
  }
  return normalized as Hex;
}

function normalizeDecimalAmount(value: string | number): string {
  const text = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new Error(`转账金额格式无效: ${text || '空'}`);
  }
  return text;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return output;
}

function fullErrorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: any = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);
    for (const key of ['shortMessage', 'details', 'message']) {
      if (typeof current[key] === 'string' && current[key].trim()) {
        parts.push(current[key]);
      }
    }
    current = current.cause;
  }

  return parts.join(' | ').toLowerCase();
}

function isAlreadyKnownError(error: unknown): boolean {
  const message = fullErrorMessage(error);
  return [
    'already known',
    'known transaction',
    'already imported',
    'transaction already exists',
  ].some((keyword) => message.includes(keyword));
}

function isDeterministicBroadcastRejection(error: unknown): boolean {
  const message = fullErrorMessage(error);
  return [
    'insufficient funds',
    'nonce too low',
    'nonce too high',
    'replacement transaction underpriced',
    'transaction underpriced',
    'intrinsic gas too low',
    'exceeds block gas limit',
    'max fee per gas less than block base fee',
    'fee cap less than block base fee',
    'invalid sender',
    'invalid chain id',
    'invalid transaction',
    'rlp',
  ].some((keyword) => message.includes(keyword));
}

async function transactionExists(publicClient: PublicClient, hash: Hash): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch {
    return false;
  }
}

async function reconcileExpectedHash(
  publicClient: PublicClient,
  hash: Hash,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await transactionExists(publicClient, hash)) return true;
    if (attempt < attempts - 1) await sleep(800);
  }
  return false;
}

async function quoteFees(publicClient: PublicClient, chainId: number): Promise<FeeQuote> {
  if (chainId === ROBINHOOD_CHAIN_ID) {
    const [estimatedFees, latestBlock] = await Promise.all([
      publicClient.estimateFeesPerGas({ type: 'eip1559', chain: undefined }),
      publicClient.getBlock({ blockTag: 'latest' }),
    ]);
    const maxPriorityFeePerGas = estimatedFees.maxPriorityFeePerGas ?? 0n;
    const baseFeePerGas = latestBlock.baseFeePerGas ?? 0n;
    const minimumMaxFee = baseFeePerGas * 2n + maxPriorityFeePerGas;
    const quotedMaxFee = estimatedFees.maxFeePerGas > minimumMaxFee
      ? estimatedFees.maxFeePerGas
      : minimumMaxFee;
    const maxFeePerGas = addPercent(quotedMaxFee, FEE_CAP_BUFFER_PERCENT);

    if (maxFeePerGas <= 0n) {
      throw new Error('Robinhood Chain EIP-1559 费率获取失败');
    }

    return {
      type: 'eip1559',
      maxFeePerGas,
      maxPriorityFeePerGas,
      budgetFeePerGas: maxFeePerGas,
    };
  }

  const gasPrice = await publicClient.getGasPrice();
  if (gasPrice <= 0n) throw new Error('Gas Price 获取失败');
  return {
    type: 'legacy',
    gasPrice,
    budgetFeePerGas: gasPrice,
  };
}

function pendingResult(plan: PlannedTransaction): OneToManyTransferResult {
  return {
    source: plan.source,
    target: plan.target,
    hash: plan.expectedHash,
    nonce: plan.nonce,
    success: false,
    status: 'pending',
    retryable: false,
    amount: plan.amount,
    error: '交易已广播，正在等待链上确认，请勿重复转账',
  };
}

function notSentResult(
  plan: PlannedTransaction,
  error: string,
): OneToManyTransferResult {
  return {
    source: plan.source,
    target: plan.target,
    nonce: plan.nonce,
    success: false,
    status: 'not_sent',
    retryable: false,
    amount: plan.amount,
    error,
  };
}

async function resolveReceipt(
  publicClient: PublicClient,
  plan: PlannedTransaction,
  initialStatus: 'pending' | 'unknown',
  timeout: number,
): Promise<OneToManyTransferResult> {
  try {
    let replacementReason: 'repriced' | 'cancelled' | 'replaced' | undefined;
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: plan.expectedHash,
      timeout,
      onReplaced: (replacement: any) => {
        replacementReason = replacement.reason;
      },
    });
    const resolvedHash = receipt.transactionHash;

    if (
      receipt.status === 'success' &&
      (
        resolvedHash.toLowerCase() === plan.expectedHash.toLowerCase() ||
        replacementReason === 'repriced'
      )
    ) {
      return {
        source: plan.source,
        target: plan.target,
        hash: resolvedHash,
        nonce: plan.nonce,
        success: true,
        status: 'confirmed',
        retryable: false,
        amount: plan.amount,
        error: replacementReason === 'repriced'
          ? '交易通过同 nonce 加价后确认，当前链接为最终交易哈希'
          : undefined,
      };
    }

    return {
      source: plan.source,
      target: plan.target,
      hash: resolvedHash,
      nonce: plan.nonce,
      success: false,
      status: 'failed',
      retryable: false,
      amount: plan.amount,
      error: receipt.status === 'reverted'
        ? '交易已上链但执行回滚，不能自动重发'
        : replacementReason === 'cancelled'
          ? '本笔交易被同 nonce 取消交易替换，当前链接为替换交易'
          : '同一 nonce 被其他内容的交易替换，当前链接为替换交易',
    };
  } catch {
    const exists = await transactionExists(publicClient, plan.expectedHash);
    if (exists) return pendingResult(plan);

    return {
      source: plan.source,
      target: plan.target,
      hash: plan.expectedHash,
      nonce: plan.nonce,
      success: false,
      status: initialStatus,
      retryable: false,
      amount: plan.amount,
      error: initialStatus === 'unknown'
        ? '节点广播响应不确定，已保留本地交易哈希并停止后续转账，请勿重复发送'
        : '交易已广播但节点暂未返回回执，已保留哈希，请勿重复转账',
    };
  }
}

async function withSourceLock<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lockManager) {
    return lockManager.request(
      `amm-one-to-many:${lockKey}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error('该源钱包已有一对多转账任务正在执行，请等待当前任务结束');
        return task();
      },
    );
  }

  if (activeFallbackLocks.has(lockKey)) {
    throw new Error('该源钱包已有一对多转账任务正在执行，请等待当前任务结束');
  }
  activeFallbackLocks.add(lockKey);
  try {
    return await task();
  } finally {
    activeFallbackLocks.delete(lockKey);
  }
}

async function executeLocked(
  options: ExecuteOneToManyTransferOptions,
  source: Address,
  targets: Address[],
  privateKey: Hex,
): Promise<OneToManyTransferResult[]> {
  const dependencies = options.dependencies;
  const publicClient = dependencies?.publicClient ?? createPublicClient({
    chain: options.chain,
    // Receipt watchers share one JSON-RPC batch transport, so a 100-target job
    // does not fan out into 100 independent HTTP requests on every block.
    transport: http(options.rpcUrl, { batch: { batchSize: 20, wait: 10 } }),
  });
  const sleep = dependencies?.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const confirmationTimeout = dependencies?.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const reconciliationAttempts = dependencies?.reconciliationAttempts ?? 5;
  if ((options.intervalMs ?? 0) > 0) {
    throw new Error('一对多采用连续 nonce 快速广播，不支持逐笔转账间隔，请关闭间隔后执行');
  }

  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== source.toLowerCase()) {
    throw new Error(`私钥与源钱包地址不匹配，私钥对应地址为 ${account.address}`);
  }
  options.leaseGuard?.assertActive();

  const transferAllBalance = options.transferAllBalance === true;
  if (transferAllBalance && targets.length !== 1) {
    throw new Error('转全部余额只允许一个源钱包对应一个目标钱包');
  }
  const amountText = transferAllBalance ? '0' : normalizeDecimalAmount(options.amount);

  let transferUnits: bigint;
  let tokenAddress: Address | undefined;
  let dataForTarget: ((target: Address) => Hex) | undefined;
  let preloadedNativeBalance: bigint | undefined;
  let preloadedTokenBalance: bigint | undefined;

  if (options.asset.kind === 'native') {
    // A one-to-one "transfer all" estimates the intrinsic/L1 gas first and
    // fills the exact value after the pending balance and fee quote are known.
    transferUnits = transferAllBalance ? 0n : parseEther(amountText);
    if (transferAllBalance) {
      preloadedNativeBalance = await publicClient.getBalance({ address: source, blockTag: 'pending' });
    }
  } else {
    if (!Number.isInteger(options.asset.decimals) || options.asset.decimals < 0 || options.asset.decimals > 255) {
      throw new Error('ERC20 代币精度无效');
    }
    tokenAddress = normalizeAddress(options.asset.address, 'ERC20 合约地址');
    if (transferAllBalance) {
      preloadedTokenBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [source],
      }) as bigint;
      transferUnits = preloadedTokenBalance;
    } else {
      transferUnits = parseUnits(amountText, options.asset.decimals);
    }
    dataForTarget = (target) => encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [target, transferUnits],
    });
  }

  if (options.asset.kind === 'erc20' && transferUnits <= 0n) {
    throw new Error(transferAllBalance ? `${options.asset.symbol} 余额为 0` : '转账金额换算后必须大于 0');
  }
  if (options.asset.kind === 'native' && !transferAllBalance && transferUnits <= 0n) {
    throw new Error('转账金额换算后必须大于 0');
  }

  const gasLimits = await mapWithConcurrency(
    targets,
    GAS_ESTIMATE_CONCURRENCY,
    async (target, index) => {
      try {
        const estimated = options.asset.kind === 'native'
          ? await publicClient.estimateGas({
              account: source,
              to: target,
              // Use a realistic non-zero value while computing the sweep. On
              // rollups, the RLP byte length can affect the L1 calldata fee;
              // half the pending balance closely matches the final value while
              // still leaving enough headroom for estimateGas to succeed.
              value: transferAllBalance
                ? (preloadedNativeBalance ?? 0n) > 1n
                  ? (preloadedNativeBalance ?? 0n) / 2n
                  : 1n
                : transferUnits,
            })
          : await publicClient.estimateGas({
              account: source,
              to: tokenAddress!,
              data: dataForTarget!(target),
              value: 0n,
            });
        return addPercent(estimated, GAS_LIMIT_BUFFER_PERCENT);
      } catch (error) {
        throw new Error(`第 ${index + 1} 个目标地址 Gas 估算失败: ${parseBlockchainError(error)}`);
      }
    },
  );

  const feeQuote = await quoteFees(publicClient, options.chain.id);
  const [nativeBalance, latestNonce, pendingNonce, tokenBalance] = await Promise.all([
    preloadedNativeBalance !== undefined
      ? Promise.resolve(preloadedNativeBalance)
      : publicClient.getBalance({ address: source, blockTag: 'pending' }),
    publicClient.getTransactionCount({ address: source, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: source, blockTag: 'pending' }),
    options.asset.kind === 'erc20'
      ? preloadedTokenBalance !== undefined
        ? Promise.resolve(preloadedTokenBalance)
        : publicClient.readContract({
            address: tokenAddress!,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [source],
          }) as Promise<bigint>
      : Promise.resolve(undefined),
  ]);

  if (pendingNonce !== latestNonce) {
    throw new Error(
      `源钱包已有 ${pendingNonce - latestNonce} 笔待确认交易。为避免 nonce 冲突，本次未发送任何交易，请先等待或处理现有 pending 交易`,
    );
  }

  const totalGasLimit = gasLimits.reduce((sum, gas) => sum + gas, 0n);
  const totalGasBudget = totalGasLimit * feeQuote.budgetFeePerGas;
  if (options.asset.kind === 'native' && transferAllBalance) {
    transferUnits = nativeBalance - totalGasBudget;
    if (transferUnits <= 0n) {
      throw new Error(
        `余额不足以支付最高 Gas 预算：当前 ${formatEther(nativeBalance)} ${options.asset.symbol}，` +
        `最高 Gas 预算需要 ${formatEther(totalGasBudget)} ${options.asset.symbol}，本次未发送任何交易`,
      );
    }
  }
  const totalTransferValue = transferUnits * BigInt(targets.length);

  if (options.asset.kind === 'native') {
    const totalRequired = totalTransferValue + totalGasBudget;
    if (nativeBalance < totalRequired) {
      throw new Error(
        `整批余额不足：当前 ${formatEther(nativeBalance)} ${options.asset.symbol}，` +
        `整批转账和最高 Gas 预算需要 ${formatEther(totalRequired)} ${options.asset.symbol}，本次未发送任何交易`,
      );
    }
  } else {
    if ((tokenBalance ?? 0n) < totalTransferValue) {
      throw new Error(
        `整批 ${options.asset.symbol} 余额不足：当前 ${formatUnits(tokenBalance ?? 0n, options.asset.decimals)}，` +
        `需要 ${formatUnits(totalTransferValue, options.asset.decimals)}，本次未发送任何交易`,
      );
    }
    if (nativeBalance < totalGasBudget) {
      throw new Error(
        `整批 Gas 余额不足：当前 ${formatEther(nativeBalance)} ${options.chain.nativeCurrency.symbol}，` +
        `最高 Gas 预算需要 ${formatEther(totalGasBudget)} ${options.chain.nativeCurrency.symbol}，本次未发送任何交易`,
      );
    }
  }

  const plannedTransactions: PlannedTransaction[] = [];
  const plannedAmountText = transferAllBalance
    ? options.asset.kind === 'native'
      ? formatEther(transferUnits)
      : formatUnits(transferUnits, options.asset.decimals)
    : amountText;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const to = options.asset.kind === 'native' ? target : tokenAddress!;
    const value = options.asset.kind === 'native' ? transferUnits : 0n;
    const data = options.asset.kind === 'erc20' ? dataForTarget!(target) : undefined;
    const nonce = pendingNonce + index;
    const commonRequest = {
      chainId: options.chain.id,
      to,
      value,
      data,
      gas: gasLimits[index],
      nonce,
    };
    const serializedTransaction = feeQuote.type === 'eip1559'
      ? await account.signTransaction({
          ...commonRequest,
          type: 'eip1559',
          maxFeePerGas: feeQuote.maxFeePerGas,
          maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas,
        })
      : await account.signTransaction({
          ...commonRequest,
          type: 'legacy',
          gasPrice: feeQuote.gasPrice,
        });

    plannedTransactions.push({
      index,
      source,
      target,
      to,
      value,
      data,
      gas: gasLimits[index],
      nonce,
      serializedTransaction,
      expectedHash: keccak256(serializedTransaction),
      amount: plannedAmountText,
    });
  }

  options.leaseGuard?.assertActive();
  const nonceImmediatelyBeforeBroadcast = await publicClient.getTransactionCount({
    address: source,
    blockTag: 'pending',
  });
  if (nonceImmediatelyBeforeBroadcast !== pendingNonce) {
    throw new Error('预检期间源钱包 nonce 已被其他交易占用，本次未发送任何交易，请重新执行');
  }

  const resultByIndex = new Map<number, OneToManyTransferResult>();
  const confirmationCandidates: Array<{
    plan: PlannedTransaction;
    initialStatus: 'pending' | 'unknown';
  }> = [];
  let stoppedAt = -1;

  // Publish a defensive snapshot as soon as each signed transaction has been
  // attempted. This lets the UI retain the deterministic hash before receipt
  // polling finishes, so a refresh cannot make an already-broadcast payment
  // look like an unsent row.
  const publishProgress = () => {
    if (!options.onProgress) return;
    const snapshot = plannedTransactions
      .map((plan) => resultByIndex.get(plan.index))
      .filter((result): result is OneToManyTransferResult => Boolean(result))
      .map((result) => ({ ...result }));
    try {
      options.onProgress(snapshot);
    } catch (error) {
      // UI persistence/rendering failures must never alter transaction flow.
      console.warn('Failed to publish one-to-many transfer progress:', error);
    }
  };

  for (const plan of plannedTransactions) {
    try {
      options.leaseGuard?.assertActive();
    } catch (error) {
      resultByIndex.set(
        plan.index,
        notSentResult(plan, `${error instanceof Error ? error.message : '源钱包全局锁已丢失'}，本笔及后续交易未发送`),
      );
      publishProgress();
      stoppedAt = plan.index;
      break;
    }

    // Persist the deterministic signed hash before crossing the RPC write
    // boundary. If the HTTP request hangs after the node accepted the bytes,
    // the UI still knows exactly which transaction may exist and will not
    // offer a blind resend.
    resultByIndex.set(plan.index, {
      ...pendingResult(plan),
      status: 'unknown',
      error: '交易已开始提交到节点，已预先保留本地签名哈希，请勿重复转账',
    });
    publishProgress();

    try {
      const returnedHash = await publicClient.sendRawTransaction({
        serializedTransaction: plan.serializedTransaction,
      });
      if (returnedHash.toLowerCase() !== plan.expectedHash.toLowerCase()) {
        resultByIndex.set(plan.index, {
          ...pendingResult(plan),
          status: 'unknown',
          error: '节点返回的交易哈希与本地签名哈希不一致，已停止后续转账，请勿重复发送',
        });
        confirmationCandidates.push({ plan, initialStatus: 'unknown' });
        publishProgress();
        stoppedAt = plan.index;
        break;
      }

      resultByIndex.set(plan.index, pendingResult(plan));
      confirmationCandidates.push({ plan, initialStatus: 'pending' });
      publishProgress();
    } catch (error) {
      const foundByHash = await reconcileExpectedHash(
        publicClient,
        plan.expectedHash,
        reconciliationAttempts,
        sleep,
      );

      if (foundByHash || isAlreadyKnownError(error)) {
        resultByIndex.set(plan.index, pendingResult(plan));
        confirmationCandidates.push({ plan, initialStatus: 'pending' });
        publishProgress();
      } else {
        const rejectionHint = isDeterministicBroadcastRejection(error)
          ? '节点返回拒绝，但由于发送调用已经发生，仍按状态未知处理'
          : '节点广播响应不确定';
        resultByIndex.set(plan.index, {
          ...pendingResult(plan),
          status: 'unknown',
          error: `${rejectionHint}，已保留本地哈希并停止后续转账: ${parseBlockchainError(error)}`,
        });
        confirmationCandidates.push({ plan, initialStatus: 'unknown' });
        publishProgress();
        stoppedAt = plan.index;
        break;
      }
    }

  }

  if (stoppedAt >= 0) {
    for (let index = stoppedAt + 1; index < plannedTransactions.length; index++) {
      resultByIndex.set(
        index,
        notSentResult(
          plannedTransactions[index],
          `前序 nonce ${plannedTransactions[stoppedAt].nonce} 未被确认接收，为避免 nonce 空洞，本笔未发送`,
        ),
      );
    }
    publishProgress();
  }

  await Promise.all(confirmationCandidates.map(async ({ plan, initialStatus }) => {
    const result = await resolveReceipt(publicClient, plan, initialStatus, confirmationTimeout);
    resultByIndex.set(plan.index, result);
    publishProgress();
  }));

  return plannedTransactions.map((plan) => resultByIndex.get(plan.index) ?? notSentResult(
    plan,
    '执行链路提前终止，本笔未发送',
  ));
}

export async function executeOneToManyTransfer(
  options: ExecuteOneToManyTransferOptions,
): Promise<OneToManyTransferResult[]> {
  if (options.targetAddresses.length === 0) throw new Error('至少需要一个目标钱包地址');
  if (options.transferAllBalance && options.targetAddresses.length !== 1) {
    throw new Error('一对多不能对多个目标重复转出全部余额，请输入每个目标的固定金额');
  }

  const source = normalizeAddress(options.sourceAddress, '源钱包地址');
  const targets = options.targetAddresses.map((address, index) => normalizeAddress(
    address,
    `第 ${index + 1} 个目标钱包地址`,
  ));
  const seenTargets = new Set<string>();
  for (const target of targets) {
    const normalized = target.toLowerCase();
    if (seenTargets.has(normalized)) {
      throw new Error(`目标地址列表中存在重复地址 ${target}，为避免重复付款，本次未发送任何交易`);
    }
    seenTargets.add(normalized);
  }
  const privateKey = normalizePrivateKey(options.privateKey);
  const lockKey = `${options.chain.id}:${source.toLowerCase()}`;

  return withSourceLock(lockKey, () => executeLocked(options, source, targets, privateKey));
}
