/**
 * FourMeme 内盘交易服务
 *
 * 功能：
 * 1. 通过 FourMeme 主合约买入代币
 * 2. 通过 FourMeme 主合约卖出代币
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  encodeFunctionData,
  type PublicClient,
  type WalletClient,
  type Address
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  WALLET_PENDING_PREDECESSOR_CODE,
  createWalletPendingPredecessorError,
  isWalletPendingPredecessorError,
} from './pendingNonceGuard';

// ==================== 常量配置 ====================

// FourMeme 主合约地址
export const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as const;

// 防夹 RPC 节点（用于内盘买入交易）
// blxrbdn 是专业防夹节点，速度快，但 CORS 支持不稳定
// 批量卖出在 taskStore 中强制使用 Binance 官方节点
export const ANTI_SANDWICH_RPC = 'https://bsc.rpc.blxrbdn.com' as const;

// 高速卖出 RPC 节点（从后端获取，避免在开源前端暴露付费节点地址）
// 登录后通过 /api/config 接口获取，未获取时 fallback 到防夹节点
let _premiumSellRpc: string = '';

export function getPremiumSellRpc(): string {
  return _premiumSellRpc || ANTI_SANDWICH_RPC;
}

export function setPremiumSellRpc(url: string) {
  _premiumSellRpc = url;
}

// FourMeme 合约 ABI (只包含我们需要的函数)
const FOURMEME_ABI = [
  {
    name: 'buyTokenAMAP',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'origin', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'funds', type: 'uint256' },
      { name: 'minAmount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    name: 'sellToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'minEthAmount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    name: 'getAmountOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'isBuy', type: 'bool' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

// ==================== 类型定义 ====================

export interface FourMemeTradeParams {
  chainId: number;
  rpcUrl: string;
  privateKey: string;
  walletAddress: string;
  tokenAddress: string;       // 目标代币地址
  amount: number;             // BNB 金额（买入时）或代币数量百分比（卖出时）
  mode: 'buy' | 'sell';       // 交易模式
  gasPrice?: number;          // Gas Price (Gwei)
  gasLimit?: number;          // Gas Limit
  sellPercent?: number;       // 卖出百分比 (1-100)
  slippage?: number;          // 滑点百分比 (例如: 10 表示 10%)
  poolBaseToken?: string;     // 底池基础代币地址（设置时表示非BNB底池，如ASTER）
  leaseGuard?: {
    assertActive: () => void;
  };
  onTransactionHash?: (txHash: string, kind: 'approval' | 'trade') => void;
}

export interface FourMemeTradeResult {
  success: boolean;
  status?: 'confirmed' | 'pending' | 'failed' | 'unknown';
  code?: string;
  /** The exact write whose outcome is unresolved; never infer it from an older callback. */
  transactionKind?: 'approval' | 'trade';
  /** RPC endpoint that still needs receipt/nonce reconciliation before leases can be released. */
  reconciliationRpcUrl?: string;
  /** Reconciliation must observe this exact successful receipt; nonce equality is insufficient. */
  receiptRequired?: boolean;
  txHash?: string;
  error?: string;
  amountIn?: string;
  amountOut?: string;
}

export interface FourMemeRoundPrefetchData {
  tokenBalance: bigint;
  buyAllowanceSufficient: boolean;
  sellAllowanceSufficient: boolean;
}

// 卖出准备结果接口
export interface SellPrepareResult {
  success: boolean;
  status?: 'confirmed' | 'pending' | 'failed' | 'unknown';
  code?: string;
  transactionKind?: 'approval' | 'trade';
  reconciliationRpcUrl?: string;
  receiptRequired?: boolean;
  txHash?: string;
  error?: string;
  walletAddress: string;
  sellAmount: bigint;
  needsApproval: boolean;
  approved: boolean;
}

// ==================== Nonce 管理器 ====================

// 全局 nonce 管理器（追踪每个钱包的 pending nonce，避免快速发送时冲突）
const nonceManager: Map<string, number> = new Map();

// 获取并预留 nonce（乐观锁：立即递增，失败时回滚）
async function acquireNonce(
  publicClient: PublicClient,
  address: string
): Promise<number> {
  const key = address.toLowerCase();

  // Every FourMeme write waits for finality. Extending an existing pending
  // nonce chain would make the new trade wait behind an unknown predecessor,
  // so fail closed before reserving or broadcasting anything.
  const normalizedAddress = address as `0x${string}`;
  const [latestNonce, pendingNonce] = await Promise.all([
    publicClient.getTransactionCount({ address: normalizedAddress, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: normalizedAddress, blockTag: 'pending' }),
  ]);
  if (pendingNonce > latestNonce) {
    throw createWalletPendingPredecessorError(latestNonce, pendingNonce);
  }
  if (pendingNonce < latestNonce) {
    throw new Error('RPC 返回的 pending nonce 小于 latest nonce，状态不一致');
  }

  // 获取本地追踪的 nonce
  const localNonce = nonceManager.get(key) || 0;

  if (localNonce > pendingNonce) {
    throw new Error('本地仍保留一笔提交状态未知的 nonce，已停止继续发送');
  }

  const nonce = pendingNonce;

  // 立即递增本地追踪的 nonce（乐观锁：假设交易会成功）
  nonceManager.set(key, nonce + 1);

  return nonce;
}

// 重置钱包的 nonce 追踪（需要刷新时调用）
export function resetNonceForAddress(address: string) {
  nonceManager.delete(address.toLowerCase());
}

interface FourMemeExecutionContext {
  executionClient: PublicClient;
  executionRpcUrl: string;
  peerClient: PublicClient;
  peerRpcUrl: string;
}

interface FourMemeFinalityResult {
  status: 'confirmed' | 'pending' | 'failed' | 'unknown';
  error?: string;
  reconciliationRpcUrl?: string;
  receiptRequired?: boolean;
}

function normalizeRpcEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

// ==================== 服务类 ====================

export class FourMemeService {
  private publicClient: PublicClient;      // 买入广播节点：nonce / 回执必须与广播节点一致
  private sellPublicClient: PublicClient; // 卖出广播节点：nonce / 回执必须与广播节点一致
  private readClient: PublicClient;        // 余额、授权、报价等无状态只读查询
  private chainId: number;
  private rpcUrl: string;       // 买入发交易用的 RPC
  private sellRpcUrl: string;   // 卖出发交易用的 RPC

  constructor(chainId: number, rpcUrl: string, sellRpcUrl?: string) {
    if (chainId !== 56 && chainId !== 97) {
      throw new Error(`FourMeme 交易仅支持 BSC（收到 chainId=${chainId}）`);
    }
    this.chainId = chainId;
    this.rpcUrl = rpcUrl;
    this.sellRpcUrl = sellRpcUrl || rpcUrl;

    const chain = chainId === 97 ? bscTestnet : bsc;
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl)
    });
    this.sellPublicClient = createPublicClient({
      chain,
      transport: http(this.sellRpcUrl)
    });
    // readClient 只用于 balance、allowance、报价等不会影响写入顺序的读取。
    // nonce 和回执不能走这里，否则不同节点的 mempool 传播延迟会造成误判。
    this.readClient = createPublicClient({
      chain,
      transport: http('https://bsc-dataseed.binance.org', { batch: true }),
      batch: { multicall: true }
    });
  }

  private notifyTransactionHash(
    params: FourMemeTradeParams,
    txHash: string,
    kind: 'approval' | 'trade',
  ): void {
    try {
      params.onTransactionHash?.(txHash, kind);
    } catch (error) {
      console.warn('FourMeme 交易哈希回调执行失败:', error);
    }
  }

  private getExecutionContext(mode: 'buy' | 'sell'): FourMemeExecutionContext {
    return mode === 'buy'
      ? {
          executionClient: this.publicClient,
          executionRpcUrl: this.rpcUrl,
          peerClient: this.sellPublicClient,
          peerRpcUrl: this.sellRpcUrl,
        }
      : {
          executionClient: this.sellPublicClient,
          executionRpcUrl: this.sellRpcUrl,
          peerClient: this.publicClient,
          peerRpcUrl: this.rpcUrl,
        };
  }

  private async waitForFinality(
    context: FourMemeExecutionContext,
    txHash: `0x${string}`,
    actionText: string,
  ): Promise<FourMemeFinalityResult> {
    try {
      const receipt = await context.executionClient.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
      if (receipt.status !== 'success') {
        return { status: 'failed', error: `${actionText}交易已在链上回滚` };
      }

      // Buy and sell intentionally use different RPCs. Do not release the
      // wallet/market lease until the other execution endpoint has observed
      // the same receipt, otherwise its stale nonce/balance/curve state can
      // corrupt the next operation in a mixed round. This only reads; it never
      // resubmits or replaces a transaction.
      if (normalizeRpcEndpoint(context.executionRpcUrl) === normalizeRpcEndpoint(context.peerRpcUrl)) {
        return { status: 'confirmed' };
      }

      try {
        const peerReceipt = await context.peerClient.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
        if (peerReceipt.status === 'success') return { status: 'confirmed' };
        return {
          status: 'unknown',
          reconciliationRpcUrl: context.peerRpcUrl,
          receiptRequired: true,
          error: `${actionText}在执行节点已确认，但另一交易节点返回不一致回执；已暂停后续交易`,
        };
      } catch (error: any) {
        if (error?.name === 'WaitForTransactionReceiptTimeoutError') {
          return {
            status: 'pending',
            reconciliationRpcUrl: context.peerRpcUrl,
            receiptRequired: true,
            error: `${actionText}在执行节点已确认，但另一交易节点同步超时；已暂停后续交易且不会重发`,
          };
        }
        return {
          status: 'unknown',
          reconciliationRpcUrl: context.peerRpcUrl,
          receiptRequired: true,
          error: `${actionText}在执行节点已确认，但另一交易节点暂时无法读取回执；已暂停后续交易且不会重发：${error?.message || '未知错误'}`,
        };
      }
    } catch (error: any) {
      if (error?.name === 'WaitForTransactionReceiptTimeoutError') {
        return {
          status: 'pending',
          reconciliationRpcUrl: context.executionRpcUrl,
          error: `${actionText}交易已广播，但等待确认超时；禁止自动重发`,
        };
      }
      return {
        status: 'unknown',
        reconciliationRpcUrl: context.executionRpcUrl,
        error: `${actionText}交易已广播，但暂时无法读取回执；禁止自动重发：${error?.message || '未知错误'}`,
      };
    }
  }

  private async reconcileMissingHash(
    _walletAddress: Address,
    _reservedNonce: number,
    actionText: string,
    _error: unknown,
    transactionKind: 'approval' | 'trade',
    reconciliationRpcUrl: string,
  ): Promise<FourMemeTradeResult> {
    // sendTransaction 抛错不代表节点没有接收交易。没有确定 hash 时一律
    // 保留 nonce 并暂停，不自动重发；用户刷新后再以执行节点的 pending nonce 对账。
    return {
      success: false,
      status: 'unknown',
      transactionKind,
      reconciliationRpcUrl,
      error: `${actionText}提交响应丢失且无法确定交易哈希；pending nonce 可能已被占用，已停止自动重发`,
    };
  }

  private pendingPredecessorResult(
    error: unknown,
    reconciliationRpcUrl?: string,
  ): FourMemeTradeResult | undefined {
    if (!isWalletPendingPredecessorError(error)) return undefined;
    return {
      success: false,
      status: 'pending',
      code: WALLET_PENDING_PREDECESSOR_CODE,
      // The predecessor may be an old curve trade. Conservatively keep both
      // the wallet and token market locked until pending/latest reconcile.
      transactionKind: 'trade',
      reconciliationRpcUrl,
      error: error.message,
    };
  }

  /**
   * 预热两个 RPC 端点的 TCP/TLS 连接
   * 创建任务时调用，让浏览器提前建立连接（DNS + TCP + TLS），
   * 后续交易直接复用 keep-alive 连接，消除冷启动延迟
   */
  async warmupConnections(): Promise<void> {
    await Promise.allSettled([
      this.publicClient.getChainId(),
      this.sellPublicClient.getChainId(),
      this.readClient.getChainId()
    ]);
  }

  /**
   * 预热防夹节点连接（仅 publicClient）
   * 在 Phase 1 并行调用，确保 Phase 2 发送交易时连接已建立
   */
  async warmupTradeRpc(): Promise<void> {
    await Promise.allSettled([
      this.publicClient.getChainId(),
      this.sellPublicClient.getChainId(),
    ]);
  }

  /**
   * 计算滑点保护的最小输出金额
   */
  private calculateMinAmountOut(expectedOut: bigint, slippage: number): bigint {
    if (slippage <= 0 || slippage >= 100) return 0n;
    const slippageFactor = BigInt(Math.floor((100 - slippage) * 100));
    return (expectedOut * slippageFactor) / BigInt(10000);
  }

  /**
   * 尝试获取预期输出金额（查询合约）
   * @param tokenAddress 代币地址
   * @param amountIn 输入金额
   * @param isBuy true=买入(BNB->Token), false=卖出(Token->BNB)
   * @returns 预期输出金额；查询失败时必须终止，不能静默取消滑点保护
   */
  private async tryGetAmountOut(
    executionClient: PublicClient,
    tokenAddress: Address,
    amountIn: bigint,
    isBuy: boolean,
  ): Promise<bigint> {
    try {
      const result = await executionClient.readContract({
        address: FOURMEME_CONTRACT,
        abi: FOURMEME_ABI,
        functionName: 'getAmountOut',
        args: [tokenAddress, amountIn, isBuy]
      });
      return result as bigint;
    } catch (error: any) {
      throw new Error(`FourMeme 报价失败: ${error?.message || 'RPC 请求失败'}`);
    }
  }

  /**
   * 执行 FourMeme 内盘交易
   */
  async executeTrade(params: FourMemeTradeParams): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext(params.mode);
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;

      // 买入和卖出使用不同的 RPC 节点发送交易
      const tradeRpcUrl = params.mode === 'sell' ? this.sellRpcUrl : this.rpcUrl;

      // 创建钱包客户端
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(tradeRpcUrl)
      });

      if (params.mode === 'buy') {
        return await this.executeBuy(walletClient, params);
      } else {
        return await this.executeSell(walletClient, params);
      }
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      return {
        success: false,
        error: error.message || '交易执行失败'
      };
    }
  }

  /**
   * 执行买入
   */
  private async executeBuy(
    walletClient: WalletClient,
    params: FourMemeTradeParams
  ): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext('buy');
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;
      if (walletAddress.toLowerCase() !== params.walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const isNonBnbPool = !!params.poolBaseToken;

      // 修复: 使用 parseEther 避免 JavaScript 浮点数精度丢失问题
      const amountStr = params.amount.toFixed(18).replace(/\.?0+$/, '');
      const buyAmountWei = parseEther(amountStr);

      // 非 BNB 底池（如 ASTER）：需要先 approve 底池代币给 FourMeme 合约
      if (isNonBnbPool) {
        const baseTokenAddress = params.poolBaseToken as Address;
        const allowance = await this.getTokenAllowance(
          executionContext.executionClient,
          baseTokenAddress,
          walletAddress,
          FOURMEME_CONTRACT,
        );
        if (allowance < buyAmountWei) {
          const approveResult = await this.approveToken(
            walletClient,
            executionContext,
            baseTokenAddress,
            FOURMEME_CONTRACT,
            params,
          );
          if (!approveResult.success) {
            return {
              success: false,
              status: approveResult.status,
              code: approveResult.code,
              transactionKind: approveResult.transactionKind || 'approval',
              reconciliationRpcUrl: approveResult.reconciliationRpcUrl,
              receiptRequired: approveResult.receiptRequired,
              txHash: approveResult.txHash,
              error: `底池代币授权失败: ${approveResult.error}`
            };
          }
        }
      }

      const minAmount = await this.getProtectedMinAmountOut(
        executionContext.executionClient,
        tokenAddress,
        buyAmountWei,
        true,
        params.slippage,
      );

      // 使用 ABI 编码买入交易数据
      // buyTokenAMAP(uint256 origin, address token, uint256 funds, uint256 minAmount)
      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'buyTokenAMAP',
        args: [
          0n,            // origin: 0 (直接购买，无推荐)
          tokenAddress,  // token: 代币地址
          buyAmountWei,  // funds: 底池代币金额
          minAmount      // minAmount: 滑点保护
        ]
      });

      // 获取 gas 设置
      const gasPrice = params.gasPrice
        ? BigInt(params.gasPrice * 1e9)
        : undefined;

      const gasLimit = params.gasLimit
        ? BigInt(params.gasLimit)
        : BigInt(300000);

      // 获取并预留 nonce（乐观锁：立即递增，失败时回滚）
      params.leaseGuard?.assertActive();
      const nonce = await acquireNonce(executionContext.executionClient, walletAddress);
      reservedNonce = nonce;

      // 发送交易
      // 非 BNB 底池：value = 0（通过 transferFrom 转底池代币）
      // BNB 底池：value = buyAmountWei（发送 BNB）
      params.leaseGuard?.assertActive();
      txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain,
        to: FOURMEME_CONTRACT,
        data: callData,
        value: isNonBnbPool ? 0n : buyAmountWei,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });
      this.notifyTransactionHash(params, txHash, 'trade');

      const finality = await this.waitForFinality(
        executionContext,
        txHash,
        'FourMeme 买入',
      );
      if (finality.status !== 'confirmed') {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          reconciliationRpcUrl: finality.reconciliationRpcUrl,
          receiptRequired: finality.receiptRequired,
          txHash,
          error: finality.error,
        };
      }
      const unit = isNonBnbPool ? '底池代币' : 'BNB';
      return {
        success: true,
        status: 'confirmed',
        txHash: txHash,
        amountIn: `${params.amount} ${unit}`
      };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      if (txHash) {
        return {
          success: false,
          status: 'unknown',
          transactionKind: 'trade',
          reconciliationRpcUrl: executionContext.executionRpcUrl,
          txHash,
          error: `FourMeme 买入交易已广播，但状态未知；禁止自动重发：${error?.message || '未知错误'}`,
        };
      }
      if (reservedNonce !== undefined && walletClient.account?.address) {
        return this.reconcileMissingHash(
          walletClient.account.address,
          reservedNonce,
          'FourMeme 买入',
          error,
          'trade',
          executionContext.executionRpcUrl,
        );
      }
      return {
        success: false,
        status: 'failed',
        error: error.message || '买入执行失败'
      };
    }
  }

  /**
   * 执行卖出
   */
  private async executeSell(
    walletClient: WalletClient,
    params: FourMemeTradeParams
  ): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext('sell');
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;
      if (walletAddress.toLowerCase() !== params.walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }

      // 最终余额和授权必须从卖出执行节点读取，避免跨节点旧状态。
      const [tokenBalance, allowance] = await Promise.all([
        this.getTokenBalance(executionContext.executionClient, tokenAddress, walletAddress),
        this.getTokenAllowance(executionContext.executionClient, tokenAddress, walletAddress, FOURMEME_CONTRACT)
      ]);

      if (tokenBalance <= 0n) {
        return {
          success: false,
          error: '代币余额为零'
        };
      }

      // 计算卖出数量
      let sellAmount: bigint;
      if (params.sellPercent && params.sellPercent > 0) {
        sellAmount = (tokenBalance * BigInt(params.sellPercent)) / 100n;
      } else {
        // 默认卖出全部
        sellAmount = tokenBalance;
      }

      if (sellAmount <= 0n) {
        return {
          success: false,
          error: '卖出数量为零'
        };
      }

      // 首先需要授权 FourMeme 合约
      if (allowance < sellAmount) {
        const approveResult = await this.approveToken(
          walletClient,
          executionContext,
          tokenAddress,
          FOURMEME_CONTRACT,
          params,
        );
        if (!approveResult.success) {
          return {
              success: false,
              status: approveResult.status,
              code: approveResult.code,
              transactionKind: approveResult.transactionKind || 'approval',
              reconciliationRpcUrl: approveResult.reconciliationRpcUrl,
              receiptRequired: approveResult.receiptRequired,
              txHash: approveResult.txHash,
            error: `授权失败: ${approveResult.error}`
          };
        }
      }

      // 报价必须在 nonce 预留之前完成；报价失败不能留下本地 nonce 空洞。
      const minEthAmount = await this.getProtectedMinAmountOut(
        executionContext.executionClient,
        tokenAddress,
        sellAmount,
        false,
        params.slippage,
      );
      params.leaseGuard?.assertActive();
      const nonce = await acquireNonce(executionContext.executionClient, walletAddress);
      reservedNonce = nonce;

      // 使用 ABI 编码卖出交易数据
      // sellToken(address token, uint256 amount, uint256 minEthAmount)
      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'sellToken',
        args: [
          tokenAddress,  // token: 代币地址
          sellAmount,    // amount: 卖出数量
          minEthAmount   // minEthAmount: 滑点保护
        ]
      });

      // 获取 gas 设置
      const gasPrice = params.gasPrice
        ? BigInt(params.gasPrice * 1e9)
        : undefined;

      const gasLimit = params.gasLimit
        ? BigInt(params.gasLimit)
        : BigInt(300000);

      // 发送交易
      params.leaseGuard?.assertActive();
      txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain,
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });
      this.notifyTransactionHash(params, txHash, 'trade');

      const finality = await this.waitForFinality(
        executionContext,
        txHash,
        'FourMeme 卖出',
      );
      if (finality.status !== 'confirmed') {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          reconciliationRpcUrl: finality.reconciliationRpcUrl,
          receiptRequired: finality.receiptRequired,
          txHash,
          error: finality.error,
        };
      }
      return {
        success: true,
        status: 'confirmed',
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      if (txHash) {
        return {
          success: false,
          status: 'unknown',
          transactionKind: 'trade',
          reconciliationRpcUrl: executionContext.executionRpcUrl,
          txHash,
          error: `FourMeme 卖出交易已广播，但状态未知；禁止自动重发：${error?.message || '未知错误'}`,
        };
      }
      if (reservedNonce !== undefined && walletClient.account?.address) {
        return this.reconcileMissingHash(
          walletClient.account.address,
          reservedNonce,
          'FourMeme 卖出',
          error,
          'trade',
          executionContext.executionRpcUrl,
        );
      }
      return {
        success: false,
        status: 'failed',
        error: error.message || '卖出执行失败'
      };
    }
  }

  /**
   * 获取代币余额
   */
  private async getTokenBalance(
    executionClient: PublicClient,
    tokenAddress: Address,
    walletAddress: Address,
  ): Promise<bigint> {
    try {
      const data = await executionClient.readContract({
        address: tokenAddress,
        abi: [{
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }]
        }],
        functionName: 'balanceOf',
        args: [walletAddress]
      });
      return data as bigint;
    } catch (error: any) {
      throw new Error(`读取代币余额失败: ${error?.message || 'RPC 请求失败'}`);
    }
  }

  /**
   * 获取代币授权额度
   */
  private async getTokenAllowance(
    executionClient: PublicClient,
    tokenAddress: Address,
    ownerAddress: Address,
    spenderAddress: Address
  ): Promise<bigint> {
    try {
      const data = await executionClient.readContract({
        address: tokenAddress,
        abi: [{
          name: 'allowance',
          type: 'function',
          stateMutability: 'view',
          inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' }
          ],
          outputs: [{ name: '', type: 'uint256' }]
        }],
        functionName: 'allowance',
        args: [ownerAddress, spenderAddress]
      });
      return data as bigint;
    } catch (error: any) {
      throw new Error(`读取授权额度失败: ${error?.message || 'RPC 请求失败'}`);
    }
  }

  /**
   * 根据任务滑点配置获取受保护的最小输出。
   *
   * 任务界面沿用既有语义：未配置或配置为 0 时表示不限制，因此返回 0。
   * 一旦配置了正滑点，就必须拿到有效链上报价并计算出非零 minOut；
   * 报价失败、返回 0 或配置非法时全部 fail closed，禁止以 0 下限广播。
   */
  private async getProtectedMinAmountOut(
    executionClient: PublicClient,
    tokenAddress: Address,
    amountIn: bigint,
    isBuy: boolean,
    configuredSlippage?: number,
  ): Promise<bigint> {
    const slippage = configuredSlippage ?? 0;

    if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 100) {
      throw new Error(`FourMeme 滑点配置无效: ${slippage}`);
    }

    if (slippage === 0) return 0n;

    const expectedOut = await this.tryGetAmountOut(executionClient, tokenAddress, amountIn, isBuy);
    if (expectedOut <= 0n) {
      throw new Error('FourMeme 报价无效: 预期输出为 0');
    }

    const minAmountOut = this.calculateMinAmountOut(expectedOut, slippage);
    if (minAmountOut <= 0n) {
      throw new Error('FourMeme 滑点保护计算失败: 最小输出为 0');
    }

    return minAmountOut;
  }

  /**
   * 授权代币
   */
  private async approveToken(
    walletClient: WalletClient,
    executionContext: FourMemeExecutionContext,
    tokenAddress: Address,
    spenderAddress: Address,
    params?: FourMemeTradeParams
  ): Promise<FourMemeTradeResult> {
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    try {
      const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      const walletAddress = walletClient.account?.address;
      if (!walletAddress) return { success: false, status: 'failed', error: '钱包账户不存在' };

      // ERC20 approve 方法选择器: 0x095ea7b3
      const callData = ('0x095ea7b3' +
        spenderAddress.slice(2).padStart(64, '0') +
        maxUint256.toString(16).padStart(64, '0')) as `0x${string}`;

      params?.leaseGuard?.assertActive();
      const nonce = await acquireNonce(executionContext.executionClient, walletAddress);
      reservedNonce = nonce;
      params?.leaseGuard?.assertActive();
      txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain,
        to: tokenAddress,
        data: callData,
        value: 0n,
        gas: BigInt(100000),
        nonce,
      });
      if (params) this.notifyTransactionHash(params, txHash, 'approval');

      const finality = await this.waitForFinality(
        executionContext,
        txHash,
        'FourMeme 授权',
      );
      return finality.status === 'confirmed'
        ? { success: true, status: 'confirmed', txHash }
        : {
            success: false,
            status: finality.status,
            transactionKind: 'approval',
            reconciliationRpcUrl: finality.reconciliationRpcUrl,
            receiptRequired: finality.receiptRequired,
            txHash,
            error: finality.error,
          };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      if (txHash) {
        return {
          success: false,
          status: 'unknown',
          transactionKind: 'approval',
          reconciliationRpcUrl: executionContext.executionRpcUrl,
          txHash,
          error: `授权交易已广播，但状态未知；禁止自动重发：${error?.message || '未知错误'}`,
        };
      }
      if (reservedNonce !== undefined && walletClient.account?.address) {
        return this.reconcileMissingHash(
          walletClient.account.address,
          reservedNonce,
          'FourMeme 授权',
          error,
          'approval',
          executionContext.executionRpcUrl,
        );
      }
      return { success: false, status: 'failed', error: error?.message || '授权失败' };
    }
  }

  /**
   * 准备卖出（第一阶段）：检查余额、处理授权
   * 返回准备结果，包括卖出数量和授权状态
   */
  async prepareSell(params: FourMemeTradeParams): Promise<SellPrepareResult> {
    const executionContext = this.getExecutionContext('sell');
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = params.walletAddress as Address;

      // 创建钱包客户端（卖出使用 sellRpcUrl）
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return {
          success: false,
          status: 'failed',
          error: '私钥与任务钱包地址不匹配',
          walletAddress: params.walletAddress,
          sellAmount: 0n,
          needsApproval: false,
          approved: false,
        };
      }
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(this.sellRpcUrl)
      });

      // 最终余额和授权必须从卖出执行节点读取，避免跨节点旧状态。
      const [tokenBalance, allowance] = await Promise.all([
        this.getTokenBalance(executionContext.executionClient, tokenAddress, walletAddress),
        this.getTokenAllowance(executionContext.executionClient, tokenAddress, walletAddress, FOURMEME_CONTRACT)
      ]);

      if (tokenBalance <= 0n) {
        return {
          success: false,
          error: '代币余额为零',
          walletAddress: params.walletAddress,
          sellAmount: 0n,
          needsApproval: false,
          approved: false
        };
      }

      // 计算卖出数量
      let sellAmount: bigint;
      if (params.sellPercent && params.sellPercent > 0) {
        sellAmount = (tokenBalance * BigInt(params.sellPercent)) / 100n;
      } else {
        sellAmount = tokenBalance;
      }

      if (sellAmount <= 0n) {
        return {
          success: false,
          error: '卖出数量为零',
          walletAddress: params.walletAddress,
          sellAmount: 0n,
          needsApproval: false,
          approved: false
        };
      }

      // 检查授权
      const needsApproval = allowance < sellAmount;

      // 如果需要授权，执行授权并等待确认
      if (needsApproval) {
        const approveResult = await this.approveToken(
          walletClient,
          executionContext,
          tokenAddress,
          FOURMEME_CONTRACT,
          params,
        );
        if (!approveResult.success) {
          return {
            success: false,
            status: approveResult.status,
            code: approveResult.code,
            transactionKind: approveResult.transactionKind || 'approval',
            reconciliationRpcUrl: approveResult.reconciliationRpcUrl,
            receiptRequired: approveResult.receiptRequired,
            txHash: approveResult.txHash,
            error: `授权失败: ${approveResult.error}`,
            walletAddress: params.walletAddress,
            sellAmount,
            needsApproval: true,
            approved: false
          };
        }
      }

      return {
        success: true,
        walletAddress: params.walletAddress,
        sellAmount,
        needsApproval,
        approved: true
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || '准备卖出失败',
        walletAddress: params.walletAddress,
        sellAmount: 0n,
        needsApproval: false,
        approved: false
      };
    }
  }

  /**
   * 执行已准备好的卖出：假设已经授权，并等待链上最终回执。
   * 手工批量卖出逐钱包调用它，确保下一钱包基于更新后的曲线重新报价。
   */
  async executeSellDirect(params: FourMemeTradeParams, sellAmount: bigint): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext('sell');
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = params.walletAddress as Address;

      // 创建钱包客户端（卖出使用 sellRpcUrl）
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(this.sellRpcUrl)
      });

      // 手工批量卖出也必须与普通/快速路径使用同一套 fail-closed
      // 滑点保护：配置了正滑点时，报价失败或报价为零都不得广播。
      // 这一步必须在 nonce 预留之前完成，避免报价失败留下 nonce 空洞。
      const minEthAmount = await this.getProtectedMinAmountOut(
        executionContext.executionClient,
        tokenAddress,
        sellAmount,
        false,
        params.slippage,
      );

      // 使用 ABI 编码卖出交易数据
      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'sellToken',
        args: [
          tokenAddress,
          sellAmount,
          minEthAmount
        ]
      });

      // 获取 gas 设置
      const gasPrice = params.gasPrice
        ? BigInt(params.gasPrice * 1e9)
        : undefined;

      const gasLimit = params.gasLimit
        ? BigInt(params.gasLimit)
        : BigInt(300000);

      // 获取并预留 nonce（乐观锁：立即递增，失败时回滚）
      params.leaseGuard?.assertActive();
      const nonce = await acquireNonce(executionContext.executionClient, walletAddress);
      reservedNonce = nonce;

      // 发送交易
      params.leaseGuard?.assertActive();
      txHash = await walletClient.sendTransaction({
        account,
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });
      this.notifyTransactionHash(params, txHash, 'trade');

      const finality = await this.waitForFinality(
        executionContext,
        txHash,
        'FourMeme 卖出',
      );
      if (finality.status !== 'confirmed') {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          reconciliationRpcUrl: finality.reconciliationRpcUrl,
          receiptRequired: finality.receiptRequired,
          txHash,
          error: finality.error,
        };
      }

      return {
        success: true,
        status: 'confirmed',
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      if (txHash) {
        return {
          success: false,
          status: 'unknown',
          transactionKind: 'trade',
          reconciliationRpcUrl: executionContext.executionRpcUrl,
          txHash,
          error: `FourMeme 卖出交易已广播，但状态未知；禁止自动重发：${error?.message || '未知错误'}`,
        };
      }
      if (reservedNonce !== undefined) {
        return this.reconcileMissingHash(
          params.walletAddress as Address,
          reservedNonce,
          'FourMeme 卖出',
          error,
          'trade',
          executionContext.executionRpcUrl,
        );
      }
      return {
        success: false,
        status: 'failed',
        error: error.message || '卖出执行失败'
      };
    }
  }

  /**
   * 批量预取轮次数据（Change 3c）
   * 用 multicall 一次性获取：
   * - 卖出钱包的目标代币余额 (balanceOf)
   * - 买入钱包的底池代币 allowance (ASTER → FourMeme)
   * - 卖出钱包的目标代币 allowance (meme token → FourMeme)
   */
  async batchPrepareRound(params: {
    tokenAddress: string;
    baseTokenAddress: string;
    buyWalletAddresses: string[];
    sellWalletAddresses: string[];
  }): Promise<Map<string, FourMemeRoundPrefetchData>> {
    const results = new Map<string, FourMemeRoundPrefetchData>();
    const tokenAddr = params.tokenAddress as `0x${string}`;
    const baseTokenAddr = params.baseTokenAddress as `0x${string}`;
    const maxUint128 = BigInt('0xffffffffffffffffffffffffffffffff');

    const allowanceAbi = [{
      type: 'function' as const,
      name: 'allowance' as const,
      stateMutability: 'view' as const,
      inputs: [
        { name: 'owner' as const, type: 'address' as const },
        { name: 'spender' as const, type: 'address' as const }
      ],
      outputs: [{ name: '' as const, type: 'uint256' as const }]
    }] as const;

    const balanceOfAbi = [{
      type: 'function' as const,
      name: 'balanceOf' as const,
      stateMutability: 'view' as const,
      inputs: [{ name: 'account' as const, type: 'address' as const }],
      outputs: [{ name: '' as const, type: 'uint256' as const }]
    }] as const;

    // 构建 multicall 合约调用
    const calls: any[] = [];
    const callMeta: { type: 'balance' | 'baseAllowance' | 'targetAllowance'; wallet: string }[] = [];

    // 卖出钱包：查目标代币余额
    for (const addr of params.sellWalletAddresses) {
      calls.push({
        address: tokenAddr,
        abi: balanceOfAbi,
        functionName: 'balanceOf',
        args: [addr as `0x${string}`]
      });
      callMeta.push({ type: 'balance', wallet: addr });
    }

    // 买入钱包：查底池代币 (ASTER) 对 FourMeme 的 allowance
    for (const addr of params.buyWalletAddresses) {
      calls.push({
        address: baseTokenAddr,
        abi: allowanceAbi,
        functionName: 'allowance',
        args: [addr as `0x${string}`, FOURMEME_CONTRACT]
      });
      callMeta.push({ type: 'baseAllowance', wallet: addr });
    }

    // 卖出钱包：查目标代币 (meme token) 对 FourMeme 的 allowance
    for (const addr of params.sellWalletAddresses) {
      calls.push({
        address: tokenAddr,
        abi: allowanceAbi,
        functionName: 'allowance',
        args: [addr as `0x${string}`, FOURMEME_CONTRACT]
      });
      callMeta.push({ type: 'targetAllowance', wallet: addr });
    }

    if (calls.length === 0) return results;

    try {
      const multicallResults = await this.readClient.multicall({
        contracts: calls,
        allowFailure: true
      });

      for (let i = 0; i < multicallResults.length; i++) {
        const meta = callMeta[i];
        const res = multicallResults[i];
        const key = meta.wallet.toLowerCase();

        if (!results.has(key)) {
          results.set(key, {
            tokenBalance: 0n,
            buyAllowanceSufficient: false,
            sellAllowanceSufficient: false,
          });
        }
        const entry = results.get(key)!;

        if (res.status === 'success') {
          if (meta.type === 'balance') {
            entry.tokenBalance = res.result as bigint;
          } else if (meta.type === 'baseAllowance') {
            // 买入钱包：底池代币授权
            entry.buyAllowanceSufficient = (res.result as bigint) >= maxUint128;
          } else if (meta.type === 'targetAllowance') {
            // 卖出钱包：目标代币授权
            entry.sellAllowanceSufficient = (res.result as bigint) >= maxUint128;
          }
        }
      }
    } catch (error) {
      console.error('batchPrepareRound multicall failed:', error);
    }

    return results;
  }

  /**
   * 快速交易路径（Change 4a）
   * 跳过 allowance 检查和冗余 RPC nonce 查询；配置滑点时仍实时获取报价
   */
  async executeTradeFast(params: FourMemeTradeParams, prefetchedBalance?: bigint): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext(params.mode);
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);

      // 买入和卖出使用不同的 RPC 节点发送交易
      const tradeRpcUrl = params.mode === 'sell' ? this.sellRpcUrl : this.rpcUrl;

      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(tradeRpcUrl)
      });

      if (params.mode === 'buy') {
        return await this.executeBuyFast(walletClient, params);
      } else {
        return await this.executeSellFast(walletClient, params, prefetchedBalance);
      }
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      return {
        success: false,
        error: error.message || '快速交易执行失败'
      };
    }
  }

  /**
   * 快速买入（跳过 allowance 检查，使用本地 nonce）
   */
  private async executeBuyFast(
    walletClient: WalletClient,
    params: FourMemeTradeParams,
  ): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext('buy');
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;
      if (walletAddress.toLowerCase() !== params.walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }
      const isNonBnbPool = !!params.poolBaseToken;

      const amountStr = params.amount.toFixed(18).replace(/\.?0+$/, '');
      const buyAmountWei = parseEther(amountStr);

      // 跳过 allowance 检查（已预授权），但不能跳过任务配置的滑点保护。
      // 报价失败会直接抛错并在预留 nonce / 广播之前终止。
      const minAmount = await this.getProtectedMinAmountOut(
        executionContext.executionClient,
        tokenAddress,
        buyAmountWei,
        true,
        params.slippage,
      );

      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'buyTokenAMAP',
        args: [0n, tokenAddress, buyAmountWei, minAmount]
      });

      // 用户未显式配置时交给 Viem 在锁内、临近广播时读取当前 gasPrice；
      // 不能复用整轮开始时的旧费率。
      const gasPrice = params.gasPrice ? BigInt(params.gasPrice * 1e9) : undefined;
      const gasLimit = params.gasLimit ? BigInt(params.gasLimit) : BigInt(300000);

      // 市场/钱包锁可能等待了其他任务，锁外预取的 nonce 此时已可能过期。
      // 在锁内重新读取 pending nonce，绝不使用批量预取的旧值。
      params.leaseGuard?.assertActive();
      const nonce = await acquireNonce(executionContext.executionClient, walletAddress);
      reservedNonce = nonce;

      params.leaseGuard?.assertActive();
      txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain,
        to: FOURMEME_CONTRACT,
        data: callData,
        value: isNonBnbPool ? 0n : buyAmountWei,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });
      this.notifyTransactionHash(params, txHash, 'trade');

      const finality = await this.waitForFinality(
        executionContext,
        txHash,
        'FourMeme 快速买入',
      );
      if (finality.status !== 'confirmed') {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          reconciliationRpcUrl: finality.reconciliationRpcUrl,
          receiptRequired: finality.receiptRequired,
          txHash,
          error: finality.error,
        };
      }

      const unit = isNonBnbPool ? '底池代币' : 'BNB';
      return {
        success: true,
        status: 'confirmed',
        txHash: txHash,
        amountIn: `${params.amount} ${unit}`
      };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      if (txHash) {
        return {
          success: false,
          status: 'unknown',
          transactionKind: 'trade',
          reconciliationRpcUrl: executionContext.executionRpcUrl,
          txHash,
          error: `FourMeme 快速买入已广播，但状态未知；禁止自动重发：${error?.message || '未知错误'}`,
        };
      }
      if (reservedNonce !== undefined && walletClient.account?.address) {
        return this.reconcileMissingHash(
          walletClient.account.address,
          reservedNonce,
          'FourMeme 快速买入',
          error,
          'trade',
          executionContext.executionRpcUrl,
        );
      }
      return {
        success: false,
        status: 'failed',
        error: error.message || '快速买入执行失败'
      };
    }
  }

  /**
   * 快速卖出（使用预取的余额，跳过 allowance 检查，使用本地 nonce）
   */
  private async executeSellFast(
    walletClient: WalletClient,
    params: FourMemeTradeParams,
    prefetchedBalance?: bigint,
  ): Promise<FourMemeTradeResult> {
    const executionContext = this.getExecutionContext('sell');
    let txHash: `0x${string}` | undefined;
    let reservedNonce: number | undefined;
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;
      if (walletAddress.toLowerCase() !== params.walletAddress.toLowerCase()) {
        return { success: false, status: 'failed', error: '私钥与任务钱包地址不匹配' };
      }

      // 预取发生在市场/钱包锁外；排队期间余额可能已被前一个任务改变。
      // 因此锁内必须重新读取真实余额，prefetchedBalance 只用于上层提前跳过
      // 明确为零的场景，绝不能成为实际卖出数量。
      void prefetchedBalance;
      params.leaseGuard?.assertActive();
      const tokenBalance = await this.getTokenBalance(executionContext.executionClient, tokenAddress, walletAddress);

      if (tokenBalance <= 0n) {
        return { success: false, error: '代币余额为零' };
      }

      // 计算卖出数量
      let sellAmount: bigint;
      if (params.sellPercent && params.sellPercent > 0) {
        sellAmount = (tokenBalance * BigInt(params.sellPercent)) / 100n;
      } else {
        sellAmount = tokenBalance;
      }

      if (sellAmount <= 0n) {
        return { success: false, error: '卖出数量为零' };
      }

      // 跳过 allowance 检查（已预授权），但按任务配置实时计算滑点下限。
      // 报价失败会直接抛错并在预留 nonce / 广播之前终止。
      const minEthAmount = await this.getProtectedMinAmountOut(
        executionContext.executionClient,
        tokenAddress,
        sellAmount,
        false,
        params.slippage,
      );

      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'sellToken',
        args: [tokenAddress, sellAmount, minEthAmount]
      });

      // 用户未显式配置时交给 Viem 在锁内、临近广播时读取当前 gasPrice。
      const gasPrice = params.gasPrice ? BigInt(params.gasPrice * 1e9) : undefined;
      const gasLimit = params.gasLimit ? BigInt(params.gasLimit) : BigInt(300000);

      // 与余额相同，锁外预取的 nonce 不能用于最终广播。
      params.leaseGuard?.assertActive();
      const nonce = await acquireNonce(executionContext.executionClient, walletAddress);
      reservedNonce = nonce;

      params.leaseGuard?.assertActive();
      txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain,
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });
      this.notifyTransactionHash(params, txHash, 'trade');

      const finality = await this.waitForFinality(
        executionContext,
        txHash,
        'FourMeme 快速卖出',
      );
      if (finality.status !== 'confirmed') {
        return {
          success: false,
          status: finality.status,
          transactionKind: 'trade',
          reconciliationRpcUrl: finality.reconciliationRpcUrl,
          receiptRequired: finality.receiptRequired,
          txHash,
          error: finality.error,
        };
      }

      return {
        success: true,
        status: 'confirmed',
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
      const predecessor = this.pendingPredecessorResult(error, executionContext.executionRpcUrl);
      if (predecessor) return predecessor;
      if (txHash) {
        return {
          success: false,
          status: 'unknown',
          transactionKind: 'trade',
          reconciliationRpcUrl: executionContext.executionRpcUrl,
          txHash,
          error: `FourMeme 快速卖出已广播，但状态未知；禁止自动重发：${error?.message || '未知错误'}`,
        };
      }
      if (reservedNonce !== undefined) {
        return this.reconcileMissingHash(
          params.walletAddress as Address,
          reservedNonce,
          'FourMeme 快速卖出',
          error,
          'trade',
          executionContext.executionRpcUrl,
        );
      }
      return {
        success: false,
        status: 'failed',
        error: error.message || '快速卖出执行失败'
      };
    }
  }
}

/**
 * 创建 FourMeme 服务实例
 */
export function createFourMemeService(chainId: number, rpcUrl: string, sellRpcUrl?: string): FourMemeService {
  return new FourMemeService(chainId, rpcUrl, sellRpcUrl);
}
