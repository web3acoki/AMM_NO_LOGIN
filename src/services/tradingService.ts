import { createPublicClient, createWalletClient, http, parseEther, parseUnits, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import { pancakeV2RouterAbi } from '../viem/abis/pancakeV2';
import { erc20Abi } from '../viem/abis/erc20';
import { WBNB_ADDRESSES, USDT_ADDRESSES, USDC_ADDRESSES, ASTER_TOKEN_ADDRESS, ASTER_DECIMALS } from '../constants';
import { parseBlockchainError } from '../utils/errorParser';
import { robinhood } from '../viem/chains/robinhood';
import { ROBINHOOD_WETH_ADDRESS, UNISWAP_V3_ROBINHOOD_ADDRESSES } from '../constants';
import { UniswapV3Service, applySlippageBps } from './uniswapV3Service';
import {
  WALLET_PENDING_PREDECESSOR_CODE,
  createWalletPendingPredecessorError,
  isWalletPendingPredecessorError,
} from './pendingNonceGuard';

// 获取链配置
function getChainConfig(chainId: number) {
  switch (chainId) {
    case 97:
      return bscTestnet;
    case 56:
      return bsc;
    case 4663:
      return robinhood;
    default:
      throw new Error(`不支持的交易链 ID: ${chainId}`);
  }
}

// 交易参数接口
export interface TradeParams {
  chainId: number;
  rpcUrl: string;
  routerAddress: string;
  privateKey: string;
  walletAddress: string;
  tokenAddress: string;       // 要买/卖的代币地址
  spendToken: string;         // 花费的代币类型 (BNB/USDT等)
  spendTokenAddress?: string; // 花费代币的合约地址（如果不是原生币）
  amount: number;             // 金额（BNB）
  amountType: 'amount' | 'quantity';  // 金额类型
  mode: 'pump' | 'dump';      // 模式：拉盘(买入)/砸盘(卖出)
  slippage: number;           // 滑点百分比 (例如: 30 表示 30%)
  gasPrice?: number;          // Gas Price (Gwei)
  gasLimit?: number;          // Gas Limit
  deadline?: number;          // 交易截止时间（秒），默认20分钟
  balancePercent?: number;    // 余额使用百分比 (1-100)，卖出全部时使用
  targetBnbAmount?: number;   // 目标BNB金额（砸盘时使用，系统会计算需要卖出多少Token）
  intermediateToken?: string;   // 中间代币地址（ASTER底池时设置，构建多跳路径）
  v3FeeTier?: number;           // Uniswap V3 fee tier，Pons 为 10000 (1%)
  leaseGuard?: {                // 后端全局钱包租约，在每次链上写入前再次校验
    assertActive: () => void;
  };
  onTransactionHash?: (txHash: string, kind: 'approval' | 'trade') => void;
}

// 交易结果接口
export interface TradeResult {
  success: boolean;
  status?: 'confirmed' | 'pending' | 'failed' | 'unknown';
  code?: string;
  /** The exact write whose outcome is unresolved; never infer this from an older hash callback. */
  transactionKind?: 'approval' | 'trade';
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  error?: string;
}

// 全局nonce管理器（追踪每个钱包的pending nonce）
const nonceManager: Map<string, number> = new Map();
const nonceLocks: Map<string, Promise<void>> = new Map();

function applyBalancePercent(balance: bigint, percent: number): bigint {
  if (!Number.isFinite(percent)) throw new Error('余额百分比无效');
  const bounded = Math.max(0, Math.min(100, percent));
  // Preserve two decimal places. BigInt(number) throws for random fractional
  // percentages, which previously made the range-mode batch sell fail before
  // it could even construct a transaction.
  const basisPoints = BigInt(Math.floor(bounded * 100));
  return (balance * basisPoints) / 10_000n;
}

// 获取并递增nonce（线程安全）
async function getAndIncrementNonce(
  publicClient: any,
  address: `0x${string}`,
  chainId: number
): Promise<number> {
  const key = `${chainId}:${address.toLowerCase()}`;

  const previous = nonceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  nonceLocks.set(key, queued);
  await previous;

  try {
    // This system now waits for finality after every write, so there is no
    // legitimate nonce pipeline to extend. If an older/external transaction is
    // still pending, using the next pending nonce would only queue this trade
    // behind it and recreate the hour-long "stuck" behaviour.
    const [latestNonce, pendingNonce] = await Promise.all([
      publicClient.getTransactionCount({ address, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    if (pendingNonce > latestNonce) {
      throw createWalletPendingPredecessorError(latestNonce, pendingNonce);
    }
    if (pendingNonce < latestNonce) {
      throw new Error('RPC 返回的 pending nonce 小于 latest nonce，状态不一致');
    }

    // 获取本地追踪的nonce
    const localNonce = nonceManager.get(key) || 0;
    if (localNonce > pendingNonce) {
      throw new Error('本地仍保留一笔提交状态未知的 nonce，已停止继续发送');
    }

    const nonce = pendingNonce;

    // 更新本地追踪的nonce
    nonceManager.set(key, nonce + 1);

    return nonce;
  } finally {
    release();
    if (nonceLocks.get(key) === queued) nonceLocks.delete(key);
  }
}

// 重置钱包的nonce追踪（交易失败时调用）
export function resetNonceForAddress(address: string, chainId?: number) {
  if (chainId !== undefined) {
    nonceManager.delete(`${chainId}:${address.toLowerCase()}`);
    return;
  }
  for (const key of nonceManager.keys()) {
    if (key.endsWith(`:${address.toLowerCase()}`)) nonceManager.delete(key);
  }
}

// 交易服务类
export class TradingService {
  private chainId: number;
  private rpcUrl: string;
  private routerAddress: `0x${string}`;
  private publicClient: any;
  private chainConfig: any;
  private tokenDecimalsCache = new Map<string, Promise<number>>();
  private v3PoolValidationCache = new Map<string, Promise<void>>();

  constructor(chainId: number, rpcUrl: string, routerAddress: string) {
    if (!rpcUrl) throw new Error('RPC URL 不能为空');
    if (chainId === 4663 && routerAddress.toLowerCase() !== UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02.toLowerCase()) {
      throw new Error('Robinhood Chain 只允许使用官方 Uniswap V3 SwapRouter02');
    }
    this.chainId = chainId;
    this.rpcUrl = rpcUrl;
    this.routerAddress = routerAddress as `0x${string}`;
    this.chainConfig = getChainConfig(chainId);
    this.publicClient = createPublicClient({
      chain: this.chainConfig,
      transport: http(rpcUrl)
    });
  }

  // 获取WBNB地址
  private getWBNBAddress(): `0x${string}` {
    if (this.chainId === 4663) return ROBINHOOD_WETH_ADDRESS;
    const address = WBNB_ADDRESSES[this.chainId];
    if (!address) throw new Error(`链 ${this.chainId} 未配置 Wrapped Native 地址`);
    return address;
  }

  // 获取USDT地址
  private getUSDTAddress(): `0x${string}` | null {
    return USDT_ADDRESSES[this.chainId] || null;
  }

  // 获取USDC地址
  private getUSDCAddress(): `0x${string}` | null {
    return USDC_ADDRESSES[this.chainId] || null;
  }

  // 根据代币名称获取地址
  private getSpendTokenAddress(spendToken: string): `0x${string}` | null {
    if (spendToken === 'USDT') {
      return this.getUSDTAddress();
    } else if (spendToken === 'USDC') {
      return this.getUSDCAddress();
    }
    return null;
  }

  // 获取最新的 nonce（使用全局nonce管理器）
  private async getLatestNonce(address: `0x${string}`): Promise<number> {
    try {
      return await getAndIncrementNonce(this.publicClient, address, this.chainId);
    } catch (error) {
      if (isWalletPendingPredecessorError(error)) throw error;
      throw new Error(`链 ${this.chainId} pending nonce 获取失败: ${parseBlockchainError(error)}`);
    }
  }

  private notifyTransactionHash(
    params: TradeParams,
    txHash: string,
    kind: 'approval' | 'trade'
  ): void {
    try {
      params.onTransactionHash?.(txHash, kind);
    } catch (error) {
      // UI 日志回调不能改变已经广播的链上交易结果。
      console.warn('交易哈希回调执行失败:', error);
    }
  }

  private async waitForFinality(
    txHash: `0x${string}`,
    actionText: string,
    timeout = 120000
  ): Promise<{ status: 'confirmed' | 'pending' | 'failed' | 'unknown'; error?: string }> {
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout });
      if (receipt.status === 'success') return { status: 'confirmed' };
      return { status: 'failed', error: `${actionText}交易已在链上回滚` };
    } catch (error: any) {
      const parsed = parseBlockchainError(error);
      if (error?.name === 'WaitForTransactionReceiptTimeoutError') {
        return {
          status: 'pending',
          error: `${actionText}交易已广播，但等待确认超时；禁止自动重发，请按交易哈希确认最终状态`,
        };
      }
      return {
        status: 'unknown',
        error: `${actionText}交易已广播，但暂时无法读取回执；禁止自动重发：${parsed}`,
      };
    }
  }

  private missingHashAfterSubmit(
    actionText: string,
    transactionKind: 'approval' | 'trade',
  ): TradeResult {
    // writeContract/sendTransaction 抛错可能只是节点已接收交易但响应中断。
    // 没有本地预签名 hash 时不能安全证明“未广播”，因此保留已预留 nonce，
    // 返回 unknown 让任务停线；绝不重置 nonce 后自动重发。
    return {
      success: false,
      status: 'unknown',
      transactionKind,
      error: `${actionText}提交响应丢失且无法确定交易哈希；nonce 可能已被占用，已停止自动重发`,
    };
  }

  private pendingPredecessorResult(error: unknown): TradeResult | undefined {
    if (!isWalletPendingPredecessorError(error)) return undefined;
    return {
      success: false,
      status: 'pending',
      code: WALLET_PENDING_PREDECESSOR_CODE,
      // The predecessor may be an old trade that changes the same pool. Treat
      // it as market-scoped until pending/latest reconcile, even when the
      // current write would otherwise have been only an approval.
      transactionKind: 'trade',
      error: error.message,
    };
  }

  // 检查并授权代币
  private async checkAndApprove(
    walletClient: any,
    tokenAddress: `0x${string}`,
    ownerAddress: `0x${string}`,
    spenderAddress: `0x${string}`,
    amount: bigint,
    params: TradeParams
  ): Promise<TradeResult | null> {
    let approvalHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    let submitAttempted = false;
    try {
      // 检查当前授权额度
      const allowance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [ownerAddress, spenderAddress]
      }) as bigint;

      console.log(`当前授权额度: ${formatEther(allowance)}, 需要: ${formatEther(amount)}`);

      // 如果授权额度不足，进行授权
      if (allowance < amount) {
        console.log('授权额度不足，正在授权...');

        params.leaseGuard?.assertActive();
        // 获取最新的 nonce
        const nonce = await this.getLatestNonce(ownerAddress);
        reservedNonce = nonce;

        // 授权最大值
        const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

        params.leaseGuard?.assertActive();
        submitAttempted = true;
        const sentApprovalHash = await walletClient.writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spenderAddress, maxApproval],
          nonce: nonce
        }) as `0x${string}`;
        approvalHash = sentApprovalHash;
        this.notifyTransactionHash(params, sentApprovalHash, 'approval');

        console.log(`授权交易已发送: ${sentApprovalHash}, nonce: ${nonce}`);

        // 等待授权交易确认
        const finality = await this.waitForFinality(sentApprovalHash, '授权');
        if (finality.status !== 'confirmed') {
          return {
            success: false,
            status: finality.status,
            transactionKind: 'approval',
            txHash: approvalHash,
            error: finality.error,
          };
        }
        console.log('授权成功');
      }

      return null;
    } catch (error: any) {
      console.error('授权失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      if (reservedNonce !== undefined && !approvalHash && submitAttempted) {
        return this.missingHashAfterSubmit('授权交易', 'approval');
      }
      if (reservedNonce !== undefined && !submitAttempted) {
        resetNonceForAddress(ownerAddress, this.chainId);
      }
      return {
        success: false,
        status: approvalHash ? 'unknown' : 'failed',
        transactionKind: approvalHash ? 'approval' : undefined,
        txHash: approvalHash,
        error: approvalHash
          ? `授权交易已广播，但状态未知：${parseBlockchainError(error)}`
          : `授权失败: ${parseBlockchainError(error)}`,
      };
    }
  }

  // 获取代币精度
  private async getTokenDecimals(tokenAddress: `0x${string}`): Promise<number> {
    const key = tokenAddress.toLowerCase();
    const cached = this.tokenDecimalsCache.get(key);
    if (cached) return cached;

    const request = (async () => {
      const decimals = Number(await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'decimals'
      }));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new Error(`代币 decimals 返回无效值: ${decimals}`);
      }
      return decimals;
    })();
    this.tokenDecimalsCache.set(key, request);

    try {
      return await request;
    } catch (error) {
      if (this.tokenDecimalsCache.get(key) === request) this.tokenDecimalsCache.delete(key);
      throw error;
    }
  }

  // 获取代币余额
  private async getTokenBalance(tokenAddress: `0x${string}`, walletAddress: `0x${string}`): Promise<bigint> {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletAddress]
    }) as bigint;
  }

  // 获取原生币余额
  private async getNativeBalance(walletAddress: `0x${string}`): Promise<bigint> {
    return await this.publicClient.getBalance({ address: walletAddress });
  }

  // 计算最小输出金额（考虑滑点）
  private calculateMinAmountOut(amountOut: bigint, slippage: number): bigint {
    const slippageFactor = BigInt(Math.floor((100 - slippage) * 100));
    return (amountOut * slippageFactor) / BigInt(10000);
  }

  // 买入代币（用原生币BNB买）
  async buyWithNative(params: TradeParams): Promise<TradeResult> {
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    let submitAttempted = false;
    let accountAddress: `0x${string}` | undefined;
    try {
      const {
        privateKey,
        walletAddress,
        tokenAddress,
        amount,
        slippage,
        gasPrice,
        gasLimit,
        deadline = 1200, // 20分钟
        balancePercent = 100
      } = params;

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      accountAddress = account.address;
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      const wbnbAddress = this.getWBNBAddress();
      const path: `0x${string}`[] = params.intermediateToken
        ? [wbnbAddress, params.intermediateToken as `0x${string}`, tokenAddress as `0x${string}`]
        : [wbnbAddress, tokenAddress as `0x${string}`];
      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 获取目标代币精度
      const targetDecimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);

      // 获取BNB余额
      const balance = await this.getNativeBalance(walletAddress as `0x${string}`);
      
      // 根据百分比计算实际交易金额
      let amountIn: bigint;
      if (balancePercent < 100) {
        // 使用余额的X%
        // 预留一些 gas 费（0.005 BNB）
        const reserveForGas = parseEther('0.005');
        const availableBalance = balance > reserveForGas ? balance - reserveForGas : BigInt(0);
        amountIn = applyBalancePercent(availableBalance, balancePercent);
        console.log(`使用 ${balancePercent}% 余额买入，可用: ${formatEther(availableBalance)} BNB, 实际: ${formatEther(amountIn)} BNB`);
      } else {
        // 使用固定金额 - 将数字转为不含科学计数法的字符串
        const amountStr = amount.toFixed(18).replace(/\.?0+$/, '');
        amountIn = parseEther(amountStr);
        console.log(`开始买入，花费 ${amountStr} BNB 购买代币 ${tokenAddress}`);
      }

      // 检查余额是否足够（移除 amountIn === 0 的检查，允许非常小的金额）
      if (balance < amountIn) {
        throw new Error(`BNB余额不足，当前: ${formatEther(balance)}, 需要: ${formatEther(amountIn)}`);
      }

      // 额外检查：如果金额为0，给出明确提示
      if (amountIn === BigInt(0)) {
        throw new Error(`交易金额为0，请检查输入的金额是否正确`);
      }

      // 获取预期输出
      const amountsOut = await this.publicClient.readContract({
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[];

      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);

      console.log(`预期获得: ${formatUnits(expectedOut, targetDecimals)}, 最小: ${formatUnits(minAmountOut, targetDecimals)}`);

      // 构建交易参数
      const txParams: any = {
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
        args: [minAmountOut, path, walletAddress as `0x${string}`, deadlineTimestamp],
        value: amountIn
      };

      // 获取最新的 nonce
      params.leaseGuard?.assertActive();
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);
      reservedNonce = nonce;

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9); // Gwei to Wei
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      params.leaseGuard?.assertActive();
      submitAttempted = true;
      txHash = await walletClient.writeContract(txParams);
      this.notifyTransactionHash(params, txHash, 'trade');

      console.log(`交易已发送: ${txHash}`);

      const finality = await this.waitForFinality(txHash, '原生币买入');
      if (finality.status === 'confirmed') {
        return {
          success: true,
          status: 'confirmed',
          txHash,
          amountIn: amount.toString(),
          amountOut: formatUnits(expectedOut, targetDecimals)
        };
      } else {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          txHash,
          error: finality.error,
        };
      }

    } catch (error: any) {
      console.error('买入失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      if (reservedNonce !== undefined && !txHash && submitAttempted) {
        return this.missingHashAfterSubmit('原生币买入', 'trade');
      }
      if (reservedNonce !== undefined && !submitAttempted && accountAddress) {
        resetNonceForAddress(accountAddress, this.chainId);
      }
      return {
        success: false,
        status: txHash ? 'unknown' : 'failed',
        transactionKind: txHash ? 'trade' : undefined,
        txHash,
        error: txHash
          ? `原生币买入已广播，但状态未知；禁止自动重发：${parseBlockchainError(error)}`
          : parseBlockchainError(error),
      };
    }
  }

  // 用USDT/USDC买入代币
  async buyWithToken(params: TradeParams): Promise<TradeResult> {
    try {
      const {
        privateKey,
        walletAddress,
        tokenAddress,
        spendToken,
        amount,
        slippage,
        gasPrice,
        gasLimit,
        deadline = 1200,
        balancePercent = 100
      } = params;

      // 获取花费代币的合约地址
      const spendTokenAddress = this.getSpendTokenAddress(spendToken);
      if (!spendTokenAddress) {
        return {
          success: false,
          error: `不支持的花费代币: ${spendToken}`
        };
      }

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      // 获取花费代币精度
      const spendDecimals = await this.getTokenDecimals(spendTokenAddress);
      // 获取目标代币精度
      const targetDecimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);
      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 获取花费代币余额
      const balance = await this.getTokenBalance(spendTokenAddress, walletAddress as `0x${string}`);
      
      // 根据百分比计算实际交易金额
      let amountIn: bigint;
      if (balancePercent < 100) {
        // 使用余额的X%
        amountIn = applyBalancePercent(balance, balancePercent);
        console.log(`使用 ${balancePercent}% 余额买入，可用: ${formatUnits(balance, spendDecimals)} ${spendToken}, 实际: ${formatUnits(amountIn, spendDecimals)} ${spendToken}`);
      } else {
        // 使用固定金额 - 将数字转为不含科学计数法的字符串
        const amountStr = amount.toFixed(18).replace(/\.?0+$/, '');
        amountIn = parseUnits(amountStr, spendDecimals);
        console.log(`开始买入，花费 ${amountStr} ${spendToken} 购买代币 ${tokenAddress}`);
      }

      // 检查余额是否足够
      if (balance < amountIn) {
        return {
          success: false,
          error: `${spendToken} 余额不足，当前: ${formatUnits(balance, spendDecimals)}, 需要: ${formatUnits(amountIn, spendDecimals)}`
        };
      }

      // 额外检查：如果金额为0，给出明确提示
      if (amountIn === BigInt(0)) {
        return {
          success: false,
          error: `交易金额为0，请检查输入的金额是否正确`
        };
      }

      // 构建交易路径: USDT -> 目标代币
      const path: `0x${string}`[] = [spendTokenAddress, tokenAddress as `0x${string}`];

      // 授权Router花费代币
      const approvalResult = await this.checkAndApprove(
        walletClient,
        spendTokenAddress,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn,
        params
      );
      if (approvalResult) return approvalResult;

      // 获取预期输出
      const amountsOut = await this.publicClient.readContract({
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[];

      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);

      console.log(`预期获得: ${formatUnits(expectedOut, targetDecimals)}, 最小: ${formatUnits(minAmountOut, targetDecimals)}`);

      // 构建交易参数
      const txParams: any = {
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
        args: [amountIn, minAmountOut, path, walletAddress as `0x${string}`, deadlineTimestamp]
      };

      // 获取最新的 nonce
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9);
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      const txHash = await walletClient.writeContract(txParams);

      console.log(`交易已发送: ${txHash}, nonce: ${nonce}`);

      // 等待交易确认
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'success') {
        return {
          success: true,
          txHash,
          amountIn: amount.toString(),
          amountOut: formatUnits(expectedOut, targetDecimals)
        };
      } else {
        return {
          success: false,
          txHash,
          error: '交易已发送但执行失败（可能是滑点或流动性问题）'
        };
      }

    } catch (error: any) {
      console.error('买入失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      return {
        success: false,
        error: parseBlockchainError(error)
      };
    }
  }

  // 用ASTER买入代币
  async buyWithAster(params: TradeParams): Promise<TradeResult> {
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    let submitAttempted = false;
    let accountAddress: `0x${string}` | undefined;
    try {
      const {
        privateKey,
        walletAddress,
        tokenAddress,
        amount,
        slippage,
        gasPrice,
        gasLimit,
        deadline = 1200,
        balancePercent = 100
      } = params;

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      accountAddress = account.address;
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      // 获取目标代币精度
      const targetDecimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);
      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 获取 ASTER 余额
      const balance = await this.getTokenBalance(ASTER_TOKEN_ADDRESS, walletAddress as `0x${string}`);

      // 根据百分比计算实际交易金额
      let amountIn: bigint;
      if (balancePercent < 100) {
        // 使用余额的X%
        amountIn = applyBalancePercent(balance, balancePercent);
        console.log(`使用 ${balancePercent}% ASTER 余额买入，可用: ${formatUnits(balance, ASTER_DECIMALS)}, 实际: ${formatUnits(amountIn, ASTER_DECIMALS)} ASTER`);
      } else {
        // 使用固定金额
        const amountStr = amount.toFixed(18).replace(/\.?0+$/, '');
        amountIn = parseUnits(amountStr, ASTER_DECIMALS);
        console.log(`开始买入，花费 ${amountStr} ASTER 购买代币 ${tokenAddress}`);
      }

      // 检查余额是否足够
      if (balance < amountIn) {
        return {
          success: false,
          error: `ASTER 余额不足，当前: ${formatUnits(balance, ASTER_DECIMALS)}, 需要: ${formatUnits(amountIn, ASTER_DECIMALS)}`
        };
      }

      // 额外检查：如果金额为0，给出明确提示
      if (amountIn === BigInt(0)) {
        return {
          success: false,
          error: `交易金额为0，请检查输入的金额是否正确`
        };
      }

      // 构建交易路径: ASTER -> 目标代币
      const path: `0x${string}`[] = [ASTER_TOKEN_ADDRESS, tokenAddress as `0x${string}`];

      // 授权Router花费ASTER
      const approvalResult = await this.checkAndApprove(
        walletClient,
        ASTER_TOKEN_ADDRESS,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn,
        params
      );
      if (approvalResult) return approvalResult;

      // 获取预期输出
      const amountsOut = await this.publicClient.readContract({
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[];

      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);

      console.log(`预期获得: ${formatUnits(expectedOut, targetDecimals)}, 最小: ${formatUnits(minAmountOut, targetDecimals)}`);

      // 构建交易参数
      const txParams: any = {
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
        args: [amountIn, minAmountOut, path, walletAddress as `0x${string}`, deadlineTimestamp]
      };

      // 获取最新的 nonce
      params.leaseGuard?.assertActive();
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);
      reservedNonce = nonce;

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9);
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      params.leaseGuard?.assertActive();
      submitAttempted = true;
      txHash = await walletClient.writeContract(txParams);
      this.notifyTransactionHash(params, txHash, 'trade');

      console.log(`交易已发送: ${txHash}, nonce: ${nonce}`);

      const finality = await this.waitForFinality(txHash, 'ASTER 买入');
      if (finality.status === 'confirmed') {
        return {
          success: true,
          status: 'confirmed',
          txHash,
          amountIn: formatUnits(amountIn, ASTER_DECIMALS) + ' ASTER',
          amountOut: formatUnits(expectedOut, targetDecimals)
        };
      } else {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          txHash,
          error: finality.error,
        };
      }

    } catch (error: any) {
      console.error('ASTER买入失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      if (reservedNonce !== undefined && !txHash && submitAttempted) {
        return this.missingHashAfterSubmit('ASTER 买入', 'trade');
      }
      if (reservedNonce !== undefined && !submitAttempted && accountAddress) {
        resetNonceForAddress(accountAddress, this.chainId);
      }
      return {
        success: false,
        status: txHash ? 'unknown' : 'failed',
        transactionKind: txHash ? 'trade' : undefined,
        txHash,
        error: txHash
          ? `ASTER 买入已广播，但状态未知；禁止自动重发：${parseBlockchainError(error)}`
          : parseBlockchainError(error),
      };
    }
  }

  // 卖出代币换USDT/USDC
  async sellForToken(params: TradeParams): Promise<TradeResult> {
    try {
      const {
        privateKey,
        walletAddress,
        tokenAddress,
        spendToken,  // 这里spendToken表示要换成的代币
        amount,
        amountType,
        slippage,
        gasPrice,
        gasLimit,
        deadline = 1200,
        balancePercent = 100
      } = params;

      // 获取目标代币的合约地址
      const targetTokenAddress = this.getSpendTokenAddress(spendToken);
      if (!targetTokenAddress) {
        return {
          success: false,
          error: `不支持的目标代币: ${spendToken}`
        };
      }

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      // 获取要卖出的代币精度和余额
      const tokenDecimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);
      const tokenBalance = await this.getTokenBalance(tokenAddress as `0x${string}`, walletAddress as `0x${string}`);

      // 根据百分比计算实际卖出数量
      let amountIn: bigint;
      if (balancePercent > 0 && balancePercent <= 100) {
        // 使用代币余额的X%
        amountIn = applyBalancePercent(tokenBalance, balancePercent);
        console.log(`使用 ${balancePercent}% 余额卖出，可用: ${formatUnits(tokenBalance, tokenDecimals)}, 实际: ${formatUnits(amountIn, tokenDecimals)}`);
      } else {
        // 使用固定数量 - 将数字转为不含科学计数法的字符串
        const amountStr = amount.toFixed(18).replace(/\.?0+$/, '');
        amountIn = parseUnits(amountStr, tokenDecimals);
        console.log(`开始卖出代币 ${tokenAddress} 换成 ${spendToken}，数量: ${amountStr}`);
      }

      // 检查余额是否足够
      if (tokenBalance < amountIn) {
        return {
          success: false,
          error: `代币余额不足，当前: ${formatUnits(tokenBalance, tokenDecimals)}, 需要: ${formatUnits(amountIn, tokenDecimals)}`
        };
      }

      // 额外检查：如果金额为0，给出明确提示
      if (amountIn === BigInt(0)) {
        return {
          success: false,
          error: `交易金额为0，请检查输入的金额是否正确`
        };
      }

      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 构建交易路径: 代币 -> USDT
      const path: `0x${string}`[] = [tokenAddress as `0x${string}`, targetTokenAddress];

      // 授权Router花费代币
      const approvalResult = await this.checkAndApprove(
        walletClient,
        tokenAddress as `0x${string}`,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn,
        params
      );
      if (approvalResult) return approvalResult;

      // 获取预期输出
      const targetDecimals = await this.getTokenDecimals(targetTokenAddress);
      const amountsOut = await this.publicClient.readContract({
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[];

      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);

      console.log(`预期获得: ${formatUnits(expectedOut, targetDecimals)} ${spendToken}, 最小: ${formatUnits(minAmountOut, targetDecimals)} ${spendToken}`);

      // 构建交易参数
      const txParams: any = {
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
        args: [amountIn, minAmountOut, path, walletAddress as `0x${string}`, deadlineTimestamp]
      };

      // 获取最新的 nonce
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9);
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      const txHash = await walletClient.writeContract(txParams);

      console.log(`交易已发送: ${txHash}, nonce: ${nonce}`);

      // 等待交易确认
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'success') {
        return {
          success: true,
          txHash,
          amountIn: formatUnits(amountIn, tokenDecimals),
          amountOut: formatUnits(expectedOut, targetDecimals)
        };
      } else {
        return {
          success: false,
          txHash,
          error: '交易已发送但执行失败（可能是滑点或流动性问题）'
        };
      }

    } catch (error: any) {
      console.error('卖出失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      return {
        success: false,
        error: parseBlockchainError(error)
      };
    }
  }

  // 卖出代币换ASTER
  async sellForAster(params: TradeParams): Promise<TradeResult> {
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    let submitAttempted = false;
    try {
      const {
        privateKey,
        walletAddress,
        tokenAddress,
        amount,
        slippage,
        gasPrice,
        gasLimit,
        deadline = 1200,
        balancePercent,
        targetBnbAmount  // 这里复用为目标ASTER金额
      } = params;

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      // 获取要卖出的代币精度和余额
      const tokenDecimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);
      const tokenBalance = await this.getTokenBalance(tokenAddress as `0x${string}`, walletAddress as `0x${string}`);

      // 根据不同模式计算实际卖出数量
      let amountIn: bigint;

      if (balancePercent && balancePercent > 0 && balancePercent <= 100) {
        // 模式1：使用代币余额的X%（卖出全部时使用）
        amountIn = applyBalancePercent(tokenBalance, balancePercent);
        console.log(`使用 ${balancePercent}% 余额卖出换 ASTER，可用: ${formatUnits(tokenBalance, tokenDecimals)}, 实际: ${formatUnits(amountIn, tokenDecimals)}`);
      } else if (targetBnbAmount && targetBnbAmount > 0) {
        // 模式2：根据目标ASTER金额计算需要卖出多少Token
        const path: `0x${string}`[] = [tokenAddress as `0x${string}`, ASTER_TOKEN_ADDRESS];
        const targetAsterStr = targetBnbAmount.toFixed(18).replace(/\.?0+$/, '');
        const targetAsterWei = parseUnits(targetAsterStr, ASTER_DECIMALS);
        try {
          const amountsIn = await this.publicClient.readContract({
            address: this.routerAddress,
            abi: pancakeV2RouterAbi,
            functionName: 'getAmountsIn',
            args: [targetAsterWei, path]
          }) as bigint[];
          amountIn = amountsIn[0];
          console.log(`目标获得 ${targetAsterStr} ASTER，需要卖出: ${formatUnits(amountIn, tokenDecimals)} Token`);
        } catch (e) {
          // 如果 getAmountsIn 失败，使用 getAmountsOut 反向估算
          console.log('getAmountsIn 失败，使用反向估算');
          const testAmountsOut = await this.publicClient.readContract({
            address: this.routerAddress,
            abi: pancakeV2RouterAbi,
            functionName: 'getAmountsOut',
            args: [tokenBalance, path]
          }) as bigint[];
          const maxAsterOut = testAmountsOut[testAmountsOut.length - 1];
          const ratio = Number(targetAsterWei) / Number(maxAsterOut);
          amountIn = BigInt(Math.floor(Number(tokenBalance) * Math.min(ratio * 1.05, 1)));
          console.log(`反向估算：需要卖出约 ${formatUnits(amountIn, tokenDecimals)} Token`);
        }

        // 确保不超过余额
        if (amountIn > tokenBalance) {
          console.log(`计算的卖出数量超过余额，使用全部余额`);
          amountIn = tokenBalance;
        }
      } else {
        // 模式3：使用固定数量
        const amountStr = amount.toFixed(18).replace(/\.?0+$/, '');
        amountIn = parseUnits(amountStr, tokenDecimals);
        console.log(`开始卖出代币 ${tokenAddress} 换成 ASTER，数量: ${amountStr}`);
      }

      // 检查余额是否足够
      if (tokenBalance < amountIn) {
        return {
          success: false,
          error: `代币余额不足，当前: ${formatUnits(tokenBalance, tokenDecimals)}, 需要: ${formatUnits(amountIn, tokenDecimals)}`
        };
      }

      // 额外检查：如果金额为0，给出明确提示
      if (amountIn === BigInt(0)) {
        return {
          success: false,
          error: `交易金额为0，请检查输入的金额是否正确`
        };
      }

      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 构建交易路径: 代币 -> ASTER
      const path: `0x${string}`[] = [tokenAddress as `0x${string}`, ASTER_TOKEN_ADDRESS];

      // 授权Router花费代币
      const approvalResult = await this.checkAndApprove(
        walletClient,
        tokenAddress as `0x${string}`,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn,
        params
      );
      if (approvalResult) return approvalResult;

      // 获取预期输出
      const amountsOut = await this.publicClient.readContract({
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[];

      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);

      console.log(`预期获得: ${formatUnits(expectedOut, ASTER_DECIMALS)} ASTER, 最小: ${formatUnits(minAmountOut, ASTER_DECIMALS)} ASTER`);

      // 构建交易参数
      const txParams: any = {
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
        args: [amountIn, minAmountOut, path, walletAddress as `0x${string}`, deadlineTimestamp]
      };

      // 获取最新的 nonce
      params.leaseGuard?.assertActive();
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);
      reservedNonce = nonce;

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9);
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      params.leaseGuard?.assertActive();
      submitAttempted = true;
      txHash = await walletClient.writeContract(txParams);
      this.notifyTransactionHash(params, txHash, 'trade');

      console.log(`交易已发送: ${txHash}, nonce: ${nonce}`);

      // 等待交易确认
      const finality = await this.waitForFinality(txHash, '卖出换 ASTER');

      if (finality.status === 'confirmed') {
        return {
          success: true,
          status: 'confirmed',
          txHash,
          amountIn: formatUnits(amountIn, tokenDecimals),
          amountOut: formatUnits(expectedOut, ASTER_DECIMALS) + ' ASTER'
        };
      } else {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          txHash,
          error: finality.error
        };
      }

    } catch (error: any) {
      console.error('卖出换ASTER失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      if (reservedNonce !== undefined && !txHash && submitAttempted) {
        return this.missingHashAfterSubmit('卖出换 ASTER 交易', 'trade');
      }
      if (reservedNonce !== undefined && !submitAttempted) {
        resetNonceForAddress(params.walletAddress, this.chainId);
      }
      return {
        success: false,
        status: txHash ? 'unknown' : 'failed',
        transactionKind: txHash ? 'trade' : undefined,
        txHash,
        error: txHash
          ? `卖出换 ASTER 交易已广播，但状态未知；禁止自动重发：${parseBlockchainError(error)}`
          : parseBlockchainError(error)
      };
    }
  }

  // 卖出代币（换成原生币BNB）
  async sellForNative(params: TradeParams): Promise<TradeResult> {
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    let submitAttempted = false;
    try {
      const {
        privateKey,
        walletAddress,
        tokenAddress,
        amount,
        slippage,
        gasPrice,
        gasLimit,
        deadline = 1200,
        balancePercent,
        targetBnbAmount
      } = params;

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      const wbnbAddress = this.getWBNBAddress();
      const path: `0x${string}`[] = params.intermediateToken
        ? [tokenAddress as `0x${string}`, params.intermediateToken as `0x${string}`, wbnbAddress]
        : [tokenAddress as `0x${string}`, wbnbAddress];
      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 获取代币精度
      const decimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);

      // 获取代币余额
      const tokenBalance = await this.getTokenBalance(tokenAddress as `0x${string}`, walletAddress as `0x${string}`);

      // 根据不同模式计算实际卖出数量
      let amountIn: bigint;

      if (balancePercent && balancePercent > 0 && balancePercent <= 100) {
        // 模式1：使用代币余额的X%（卖出全部时使用）
        amountIn = applyBalancePercent(tokenBalance, balancePercent);
        console.log(`使用 ${balancePercent}% 余额卖出，可用: ${formatUnits(tokenBalance, decimals)}, 实际: ${formatUnits(amountIn, decimals)}`);
      } else if (targetBnbAmount && targetBnbAmount > 0) {
        // 模式2：根据目标BNB金额计算需要卖出多少Token
        // 使用 getAmountsIn 计算需要多少 Token 才能获得目标 BNB
        const targetBnbStr = targetBnbAmount.toFixed(18).replace(/\.?0+$/, '');
        const targetBnbWei = parseEther(targetBnbStr);
        try {
          const amountsIn = await this.publicClient.readContract({
            address: this.routerAddress,
            abi: pancakeV2RouterAbi,
            functionName: 'getAmountsIn',
            args: [targetBnbWei, path]
          }) as bigint[];
          amountIn = amountsIn[0];
          console.log(`目标获得 ${targetBnbStr} BNB，需要卖出: ${formatUnits(amountIn, decimals)} Token`);
        } catch (e) {
          // 如果 getAmountsIn 失败，使用 getAmountsOut 反向估算
          console.log('getAmountsIn 失败，使用反向估算');
          // 先用全部余额查询能获得多少 BNB
          const testAmountsOut = await this.publicClient.readContract({
            address: this.routerAddress,
            abi: pancakeV2RouterAbi,
            functionName: 'getAmountsOut',
            args: [tokenBalance, path]
          }) as bigint[];
          const maxBnbOut = testAmountsOut[testAmountsOut.length - 1];
          // 按比例计算需要卖出的 Token 数量
          const ratio = Number(targetBnbWei) / Number(maxBnbOut);
          amountIn = BigInt(Math.floor(Number(tokenBalance) * Math.min(ratio * 1.05, 1))); // 多算5%以确保足够
          console.log(`反向估算：需要卖出约 ${formatUnits(amountIn, decimals)} Token`);
        }

        // 确保不超过余额
        if (amountIn > tokenBalance) {
          console.log(`计算的卖出数量超过余额，使用全部余额`);
          amountIn = tokenBalance;
        }
      } else {
        // 模式3：使用固定数量 - 将数字转为不含科学计数法的字符串
        const amountStr = amount.toFixed(18).replace(/\.?0+$/, '');
        amountIn = parseUnits(amountStr, decimals);
        console.log(`开始卖出代币 ${tokenAddress}，数量: ${amountStr}`);
      }

      // 检查余额是否足够
      if (tokenBalance < amountIn) {
        throw new Error(`代币余额不足，当前: ${formatUnits(tokenBalance, decimals)}, 需要: ${formatUnits(amountIn, decimals)}`);
      }

      // 额外检查：如果金额为0，给出明确提示
      if (amountIn === BigInt(0)) {
        throw new Error(`交易金额为0，请检查输入的金额是否正确`);
      }

      console.log(`卖出数量: ${formatUnits(amountIn, decimals)}`);

      // 授权Router花费代币
      const approvalResult = await this.checkAndApprove(
        walletClient,
        tokenAddress as `0x${string}`,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn,
        params
      );
      if (approvalResult) return approvalResult;

      // 获取预期输出
      const amountsOut = await this.publicClient.readContract({
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[];

      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);

      console.log(`预期获得: ${formatEther(expectedOut)} BNB, 最小: ${formatEther(minAmountOut)} BNB`);

      // 构建交易参数
      const txParams: any = {
        address: this.routerAddress,
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        args: [amountIn, minAmountOut, path, walletAddress as `0x${string}`, deadlineTimestamp]
      };

      // 获取最新的 nonce
      params.leaseGuard?.assertActive();
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);
      reservedNonce = nonce;

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9);
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      params.leaseGuard?.assertActive();
      submitAttempted = true;
      txHash = await walletClient.writeContract(txParams);
      this.notifyTransactionHash(params, txHash, 'trade');

      console.log(`交易已发送: ${txHash}, nonce: ${nonce}`);

      // 等待交易确认
      const finality = await this.waitForFinality(txHash, '卖出');

      if (finality.status === 'confirmed') {
        return {
          success: true,
          status: 'confirmed',
          txHash,
          amountIn: formatUnits(amountIn, decimals),
          amountOut: formatEther(expectedOut)
        };
      } else {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          txHash,
          error: finality.error
        };
      }

    } catch (error: any) {
      console.error('卖出失败:', error);
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      if (reservedNonce !== undefined && !txHash && submitAttempted) {
        return this.missingHashAfterSubmit('卖出交易', 'trade');
      }
      if (reservedNonce !== undefined && !submitAttempted) {
        resetNonceForAddress(params.walletAddress, this.chainId);
      }
      return {
        success: false,
        status: txHash ? 'unknown' : 'failed',
        transactionKind: txHash ? 'trade' : undefined,
        txHash,
        error: txHash
          ? `卖出交易已广播，但状态未知；禁止自动重发：${parseBlockchainError(error)}`
          : parseBlockchainError(error)
      };
    }
  }

  private getTransactionOverrides(params: TradeParams): { gas?: bigint; gasPrice?: bigint } {
    const overrides: { gas?: bigint; gasPrice?: bigint } = {};
    if (params.gasLimit && params.gasLimit > 0) {
      overrides.gas = BigInt(Math.floor(params.gasLimit));
    }
    // Robinhood 是 EIP-1559 链，交给节点/viem 计算 maxFeePerGas 与
    // maxPriorityFeePerGas；不要把 BSC 的 legacy gasPrice 强塞进去。
    if (this.chainId !== 4663 && params.gasPrice && params.gasPrice > 0) {
      overrides.gasPrice = parseUnits(params.gasPrice.toString(), 9);
    }
    return overrides;
  }

  private async assertV3PoolAvailable(
    v3: UniswapV3Service,
    tokenAddress: `0x${string}`,
    fee: number,
  ): Promise<void> {
    const key = `${tokenAddress.toLowerCase()}:${fee}`;
    const cached = this.v3PoolValidationCache.get(key);
    if (cached) return cached;

    const request = (async () => {
      const pool = await v3.getPool(tokenAddress, ROBINHOOD_WETH_ADDRESS, fee);
      if (!pool || pool.liquidity <= 0n) {
        throw new Error(`未找到可交易的 Uniswap V3 ${fee / 10000}% 池`);
      }
    })();
    this.v3PoolValidationCache.set(key, request);

    try {
      await request;
    } catch (error) {
      if (this.v3PoolValidationCache.get(key) === request) {
        this.v3PoolValidationCache.delete(key);
      }
      throw error;
    }
  }

  // Robinhood Chain only: standard ERC20 <-> WETH swaps through the official
  // Uniswap V3 SwapRouter02. Pons tokens are plain ERC20s, so the V2
  // fee-on-transfer entry points used on BSC must not be reused here.
  private async executeV3Trade(params: TradeParams): Promise<TradeResult> {
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    let submitAttempted = false;
    const normalizedKey = params.privateKey.startsWith('0x')
      ? params.privateKey
      : `0x${params.privateKey}`;
    const account = privateKeyToAccount(normalizedKey as `0x${string}`);
    if (account.address.toLowerCase() !== params.walletAddress.toLowerCase()) {
      return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
    }

    const tokenAddress = params.tokenAddress as `0x${string}`;
    const fee = params.v3FeeTier ?? 10000;
    const slippageBps = Math.round(params.slippage * 100);
    if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10000) {
      return { success: false, error: `无效滑点: ${params.slippage}%` };
    }

    const walletClient = createWalletClient({
      account,
      chain: robinhood,
      transport: http(this.rpcUrl)
    });
    const v3 = new UniswapV3Service(this.publicClient, {
      routerAddress: this.routerAddress,
      defaultFee: fee,
    });
    const transactionOverrides = this.getTransactionOverrides(params);

    try {
      // Pool 地址、token metadata、fee tier 都是整批不变量。手工批卖复用同一个
      // TradingService，只校验一次；每个钱包的 Quoter 调用仍读取最新池状态。
      await this.assertV3PoolAvailable(v3, tokenAddress, fee);

      if (params.mode === 'pump') {
        if (params.spendToken !== 'ETH') {
          return { success: false, error: 'Robinhood Chain 目前只支持使用 ETH 买入' };
        }

        const amountText = params.amount.toFixed(18).replace(/\.?0+$/, '');
        const amountIn = parseEther(amountText);
        if (amountIn <= 0n) return { success: false, error: '买入金额必须大于 0' };

        const nativeBalance = await this.getNativeBalance(account.address);
        if (nativeBalance <= amountIn) {
          return {
            success: false,
            error: `ETH 余额不足（还需预留 Robinhood L2 执行费和 L1 数据费）`
          };
        }

        const quote = await v3.quoteExactInputSingle({
          tokenIn: ROBINHOOD_WETH_ADDRESS,
          tokenOut: tokenAddress,
          amountIn,
          fee,
        });
        const amountOutMinimum = applySlippageBps(quote.amountOut, slippageBps);
        const request = v3.buildNativeBuyTransaction({
          tokenOut: tokenAddress,
          recipient: account.address,
          amountIn,
          amountOutMinimum,
          fee,
        });
        params.leaseGuard?.assertActive();
        const nonce = await this.getLatestNonce(account.address);
        reservedNonce = nonce;
        params.leaseGuard?.assertActive();
        submitAttempted = true;
        txHash = await walletClient.sendTransaction({
          account,
          chain: robinhood,
          to: request.to,
          data: request.data,
          value: request.value,
          nonce,
          ...transactionOverrides,
        });
        this.notifyTransactionHash(params, txHash, 'trade');
        const finality = await this.waitForFinality(txHash, 'Uniswap V3 买入');
        if (finality.status !== 'confirmed') {
          return { success: false, status: finality.status, transactionKind: 'trade', txHash, error: finality.error };
        }

        const decimals = await this.getTokenDecimals(tokenAddress);
        return {
          success: true,
          status: 'confirmed',
          txHash,
          amountIn: formatEther(amountIn),
          amountOut: formatUnits(quote.amountOut, decimals),
        };
      }

      if (params.spendToken !== 'ETH') {
        return { success: false, error: 'Robinhood Chain 目前只支持卖出换回 ETH' };
      }

      const tokenDecimals = await this.getTokenDecimals(tokenAddress);
      const balance = await this.getTokenBalance(tokenAddress, account.address);
      if (balance <= 0n) return { success: false, error: '代币余额为 0' };

      let amountIn: bigint;
      if (params.balancePercent !== undefined) {
        const percent = Math.max(0, Math.min(100, params.balancePercent));
        amountIn = applyBalancePercent(balance, percent);
      } else if (params.targetBnbAmount && params.targetBnbAmount > 0) {
        const targetOutputText = params.targetBnbAmount.toFixed(18).replace(/\.?0+$/, '');
        const targetOutput = parseEther(targetOutputText);
        const exactOutputQuote = await v3.quoteExactOutputSingle({
          tokenIn: tokenAddress,
          tokenOut: ROBINHOOD_WETH_ADDRESS,
          amountOut: targetOutput,
          fee,
        });
        // exactInputSingle is used for execution; add the configured tolerance
        // to the quoted input, then cap it at the wallet's real balance.
        const buffered = (exactOutputQuote.amountIn * BigInt(10000 + slippageBps) + 9999n) / 10000n;
        amountIn = buffered > balance ? balance : buffered;
      } else if (params.amountType === 'quantity' && params.amount > 0) {
        const amountText = params.amount.toFixed(tokenDecimals).replace(/\.?0+$/, '');
        amountIn = parseUnits(amountText, tokenDecimals);
      } else {
        amountIn = balance;
      }

      if (amountIn <= 0n) return { success: false, error: '卖出数量必须大于 0' };
      if (amountIn > balance) return { success: false, error: '卖出数量超过代币余额' };

      const approvalResult = await this.checkAndApprove(
        walletClient,
        tokenAddress,
        account.address,
        this.routerAddress,
        amountIn,
        params,
      );
      if (approvalResult) return approvalResult;

      const quote = await v3.quoteExactInputSingle({
        tokenIn: tokenAddress,
        tokenOut: ROBINHOOD_WETH_ADDRESS,
        amountIn,
        fee,
      });
      const amountOutMinimum = applySlippageBps(quote.amountOut, slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + (params.deadline ?? 1200));
      const request = v3.buildTokenToNativeSellTransaction({
        tokenIn: tokenAddress,
        recipient: account.address,
        amountIn,
        amountOutMinimum,
        deadline,
        fee,
      });
      params.leaseGuard?.assertActive();
      const nonce = await this.getLatestNonce(account.address);
      reservedNonce = nonce;
      params.leaseGuard?.assertActive();
      submitAttempted = true;
      txHash = await walletClient.sendTransaction({
        account,
        chain: robinhood,
        to: request.to,
        data: request.data,
        value: 0n,
        nonce,
        ...transactionOverrides,
      });
      this.notifyTransactionHash(params, txHash, 'trade');
      const finality = await this.waitForFinality(txHash, 'Uniswap V3 卖出');
      if (finality.status !== 'confirmed') {
        return { success: false, status: finality.status, transactionKind: 'trade', txHash, error: finality.error };
      }

      return {
        success: true,
        status: 'confirmed',
        txHash,
        amountIn: formatUnits(amountIn, tokenDecimals),
        amountOut: formatEther(quote.amountOut),
      };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error);
      if (predecessor) return predecessor;
      if (reservedNonce !== undefined && !txHash && submitAttempted) {
        return this.missingHashAfterSubmit('Uniswap V3 交易', 'trade');
      }
      if (reservedNonce !== undefined && !submitAttempted) {
        resetNonceForAddress(account.address, this.chainId);
      }
      return {
        success: false,
        status: txHash ? 'unknown' : 'failed',
        transactionKind: txHash ? 'trade' : undefined,
        txHash,
        error: txHash
          ? `交易已广播，但状态未知；禁止自动重发：${parseBlockchainError(error)}`
          : parseBlockchainError(error),
      };
    }
  }

  // 执行交易（根据模式自动选择买入或卖出）
  async executeTrade(params: TradeParams): Promise<TradeResult> {
    if (this.chainId === 4663) {
      return this.executeV3Trade(params);
    }

    const { mode, spendToken } = params;

    if (mode === 'pump') {
      // 拉盘 = 买入
      if (spendToken === 'BNB' || spendToken === 'tBNB') {
        return this.buyWithNative(params);
      } else if (spendToken === 'USDT' || spendToken === 'USDC') {
        return this.buyWithToken(params);
      } else if (spendToken === 'ASTER') {
        return this.buyWithAster(params);
      } else {
        return {
          success: false,
          error: `不支持的花费代币: ${spendToken}`
        };
      }
    } else {
      // 砸盘 = 卖出（卖出代币换成指定的币）
      if (spendToken === 'BNB' || spendToken === 'tBNB') {
        return this.sellForNative(params);
      } else if (spendToken === 'USDT' || spendToken === 'USDC') {
        return this.sellForToken(params);
      } else if (spendToken === 'ASTER') {
        return this.sellForAster(params);
      } else {
        return {
          success: false,
          error: `不支持的目标代币: ${spendToken}`
        };
      }
    }
  }
}

// 创建交易服务实例
export function createTradingService(chainId: number, rpcUrl: string, routerAddress: string): TradingService {
  return new TradingService(chainId, rpcUrl, routerAddress);
}

