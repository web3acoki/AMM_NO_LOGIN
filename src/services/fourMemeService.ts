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

// ==================== 常量配置 ====================

// FourMeme 主合约地址
export const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as const;

// 防夹 RPC 节点（用于内盘买入交易）
// blxrbdn 是专业防夹节点，速度快，但 CORS 支持不稳定
// 批量卖出在 taskStore 中强制使用 Binance 官方节点
export const ANTI_SANDWICH_RPC = 'https://bsc.rpc.blxrbdn.com' as const;

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
}

export interface FourMemeTradeResult {
  success: boolean;
  txHash?: string;
  error?: string;
  amountIn?: string;
  amountOut?: string;
}

// 卖出准备结果接口
export interface SellPrepareResult {
  success: boolean;
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

  // 获取链上的 pending nonce
  const chainNonce = await publicClient.getTransactionCount({
    address: address as `0x${string}`,
    blockTag: 'pending'
  });

  // 获取本地追踪的 nonce
  const localNonce = nonceManager.get(key) || 0;

  // 使用两者中较大的值（确保不会重复使用已发送的 nonce）
  const nonce = Math.max(chainNonce, localNonce);

  // 立即递增本地追踪的 nonce（乐观锁：假设交易会成功）
  nonceManager.set(key, nonce + 1);

  return nonce;
}

// 回滚 nonce（交易发送失败时调用，将 nonce 减回去）
function rollbackNonce(address: string, failedNonce: number) {
  const key = address.toLowerCase();
  const currentNonce = nonceManager.get(key) || 0;
  // 只有当本地 nonce 比失败的 nonce 大时才回滚
  if (currentNonce > failedNonce) {
    nonceManager.set(key, failedNonce);
  }
}

// 重置钱包的 nonce 追踪（需要刷新时调用）
export function resetNonceForAddress(address: string) {
  nonceManager.delete(address.toLowerCase());
}

// 纯本地 nonce 获取（不发 RPC，用于快速交易路径）
// 从 nonceManager 读取并递增，若无本地记录返回 null（调用方 fallback 到 acquireNonce）
export function acquireNonceLocal(address: string): number | null {
  const key = address.toLowerCase();
  const localNonce = nonceManager.get(key);
  if (localNonce === undefined) return null;
  nonceManager.set(key, localNonce + 1);
  return localNonce;
}

// ==================== 服务类 ====================

export class FourMemeService {
  private publicClient: PublicClient;
  private readClient: PublicClient;  // 只读操作使用 Binance 官方 RPC（低延迟，不占用防夹节点）
  private chainId: number;
  private rpcUrl: string;

  constructor(chainId: number, rpcUrl: string) {
    this.chainId = chainId;
    this.rpcUrl = rpcUrl;

    const chain = chainId === 97 ? bscTestnet : bsc;
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, { batch: true }),
      batch: { multicall: true }
    });
    // readClient 用于只读批量查询（nonce、balance、allowance、gasPrice），
    // 走 Binance 官方 RPC，延迟更低且不占用防夹节点连接数
    this.readClient = createPublicClient({
      chain,
      transport: http('https://bsc-dataseed.binance.org', { batch: true }),
      batch: { multicall: true }
    });
  }

  /**
   * 预热两个 RPC 端点的 TCP/TLS 连接
   * 创建任务时调用，让浏览器提前建立连接（DNS + TCP + TLS），
   * 后续交易直接复用 keep-alive 连接，消除冷启动延迟
   */
  async warmupConnections(): Promise<void> {
    await Promise.allSettled([
      this.publicClient.getChainId(),
      this.readClient.getChainId()
    ]);
  }

  /**
   * 预热防夹节点连接（仅 publicClient）
   * 在 Phase 1 并行调用，确保 Phase 2 发送交易时连接已建立
   */
  async warmupTradeRpc(): Promise<void> {
    await this.publicClient.getChainId().catch(() => {});
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
   * @returns 预期输出金额，如果查询失败返回 0n
   */
  private async tryGetAmountOut(tokenAddress: Address, amountIn: bigint, isBuy: boolean): Promise<bigint> {
    try {
      const result = await this.publicClient.readContract({
        address: FOURMEME_CONTRACT,
        abi: FOURMEME_ABI,
        functionName: 'getAmountOut',
        args: [tokenAddress, amountIn, isBuy]
      });
      return result as bigint;
    } catch {
      // 合约可能不支持 getAmountOut 函数，返回 0
      return 0n;
    }
  }

  /**
   * 执行 FourMeme 内盘交易
   */
  async executeTrade(params: FourMemeTradeParams): Promise<FourMemeTradeResult> {
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;

      // 创建钱包客户端
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(this.rpcUrl)
      });

      if (params.mode === 'buy') {
        return await this.executeBuy(walletClient, params);
      } else {
        return await this.executeSell(walletClient, params);
      }
    } catch (error: any) {
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
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;
      const isNonBnbPool = !!params.poolBaseToken;

      // 修复: 使用 parseEther 避免 JavaScript 浮点数精度丢失问题
      const amountStr = params.amount.toFixed(18).replace(/\.?0+$/, '');
      const buyAmountWei = parseEther(amountStr);
      const slippage = params.slippage || 0;

      // 非 BNB 底池（如 ASTER）：需要先 approve 底池代币给 FourMeme 合约
      if (isNonBnbPool) {
        const baseTokenAddress = params.poolBaseToken as Address;
        const allowance = await this.getTokenAllowance(baseTokenAddress, walletAddress, FOURMEME_CONTRACT);
        if (allowance < buyAmountWei) {
          const approveResult = await this.approveToken(walletClient, baseTokenAddress, FOURMEME_CONTRACT);
          if (!approveResult.success) {
            return {
              success: false,
              error: `底池代币授权失败: ${approveResult.error}`
            };
          }
        }
      }

      // 计算滑点保护的最小获得代币数量
      let minAmount = 0n;
      if (slippage > 0) {
        const expectedOut = await this.tryGetAmountOut(tokenAddress, buyAmountWei, true);
        if (expectedOut > 0n) {
          minAmount = this.calculateMinAmountOut(expectedOut, slippage);
        }
      }

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
      const nonce = await acquireNonce(this.publicClient, walletAddress);

      // 发送交易
      // 非 BNB 底池：value = 0（通过 transferFrom 转底池代币）
      // BNB 底池：value = buyAmountWei（发送 BNB）
      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: isNonBnbPool ? 0n : buyAmountWei,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      // 交易发送成功，nonce 已在 acquireNonce 中递增，无需额外操作

      // 交易已发送，不等待链上确认，直接返回成功
      const unit = isNonBnbPool ? '底池代币' : 'BNB';
      return {
        success: true,
        txHash: txHash,
        amountIn: `${params.amount} ${unit}`
      };
    } catch (error: any) {
      // 交易发送失败，回滚 nonce（如果已获取）
      if (walletClient.account?.address) {
        rollbackNonce(walletClient.account.address, 0); // 回滚到重新从链上获取
        resetNonceForAddress(walletClient.account.address);
      }
      return {
        success: false,
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
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;

      // 获取代币余额
      const tokenBalance = await this.getTokenBalance(tokenAddress, walletAddress);
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
      const allowance = await this.getTokenAllowance(tokenAddress, walletAddress, FOURMEME_CONTRACT);
      if (allowance < sellAmount) {
        const approveResult = await this.approveToken(walletClient, tokenAddress, FOURMEME_CONTRACT);
        if (!approveResult.success) {
          return {
            success: false,
            error: `授权失败: ${approveResult.error}`
          };
        }
      }

      // 计算滑点保护的最小获得 BNB 数量
      const slippage = params.slippage || 0;
      let minEthAmount = 0n;
      if (slippage > 0) {
        const expectedOut = await this.tryGetAmountOut(tokenAddress, sellAmount, false);
        if (expectedOut > 0n) {
          minEthAmount = this.calculateMinAmountOut(expectedOut, slippage);
        }
      }

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

      // 获取并预留 nonce（乐观锁：立即递增，失败时回滚）
      const nonce = await acquireNonce(this.publicClient, walletAddress);

      // 发送交易
      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      // 交易发送成功，nonce 已在 acquireNonce 中递增，无需额外操作

      // 交易已发送，不等待链上确认，直接返回成功
      return {
        success: true,
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
      // 交易发送失败，重置 nonce 追踪
      resetNonceForAddress(params.walletAddress);
      return {
        success: false,
        error: error.message || '卖出执行失败'
      };
    }
  }

  /**
   * 获取代币余额
   */
  private async getTokenBalance(tokenAddress: Address, walletAddress: Address): Promise<bigint> {
    try {
      const data = await this.publicClient.readContract({
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
    } catch {
      return 0n;
    }
  }

  /**
   * 获取代币授权额度
   */
  private async getTokenAllowance(
    tokenAddress: Address,
    ownerAddress: Address,
    spenderAddress: Address
  ): Promise<bigint> {
    try {
      const data = await this.publicClient.readContract({
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
    } catch {
      return 0n;
    }
  }

  /**
   * 授权代币
   */
  private async approveToken(
    walletClient: WalletClient,
    tokenAddress: Address,
    spenderAddress: Address
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

      // ERC20 approve 方法选择器: 0x095ea7b3
      const callData = ('0x095ea7b3' +
        spenderAddress.slice(2).padStart(64, '0') +
        maxUint256.toString(16).padStart(64, '0')) as `0x${string}`;

      const txHash = await walletClient.sendTransaction({
        to: tokenAddress,
        data: callData,
        value: 0n,
        gas: BigInt(100000)
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60000
      });

      if (receipt.status === 'success') {
        return { success: true };
      } else {
        return { success: false, error: '授权交易失败' };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 准备卖出（第一阶段）：检查余额、处理授权
   * 返回准备结果，包括卖出数量和授权状态
   */
  async prepareSell(params: FourMemeTradeParams): Promise<SellPrepareResult> {
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = params.walletAddress as Address;

      // 创建钱包客户端
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(this.rpcUrl)
      });

      // 获取代币余额
      const tokenBalance = await this.getTokenBalance(tokenAddress, walletAddress);
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
      const allowance = await this.getTokenAllowance(tokenAddress, walletAddress, FOURMEME_CONTRACT);
      const needsApproval = allowance < sellAmount;

      // 如果需要授权，执行授权并等待确认
      if (needsApproval) {
        const approveResult = await this.approveToken(walletClient, tokenAddress, FOURMEME_CONTRACT);
        if (!approveResult.success) {
          return {
            success: false,
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
   * 直接执行卖出（第二阶段）：只发送卖出交易，假设已经授权
   * 用于批量卖出时所有钱包同时发送
   */
  async executeSellDirect(params: FourMemeTradeParams, sellAmount: bigint): Promise<FourMemeTradeResult> {
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = params.walletAddress as Address;

      // 创建钱包客户端
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(this.rpcUrl)
      });

      // 计算滑点保护的最小获得 BNB 数量
      const slippage = params.slippage || 0;
      let minEthAmount = 0n;
      if (slippage > 0) {
        const expectedOut = await this.tryGetAmountOut(tokenAddress, sellAmount, false);
        if (expectedOut > 0n) {
          minEthAmount = this.calculateMinAmountOut(expectedOut, slippage);
        }
      }

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
      const nonce = await acquireNonce(this.publicClient, walletAddress);

      // 发送交易
      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      // 交易发送成功，nonce 已在 acquireNonce 中递增，无需额外操作

      return {
        success: true,
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
      // 交易发送失败，重置 nonce 追踪
      resetNonceForAddress(params.walletAddress);
      return {
        success: false,
        error: error.message || '卖出执行失败'
      };
    }
  }

  /**
   * 获取当前 gasPrice（一次 RPC，供整轮交易共享）
   * 使用 readClient（Binance RPC），避免占用防夹节点
   */
  async fetchGasPrice(): Promise<bigint> {
    return await this.readClient.getGasPrice();
  }

  /**
   * 批量预取所有钱包的 nonce（Change 3a）
   * 利用 batch: true，Viem 会自动将同一 tick 内的多个 getTransactionCount 合并为 1 个 HTTP 请求
   */
  async batchFetchNonces(walletAddresses: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    const noncePromises = walletAddresses.map(async (addr) => {
      const nonce = await this.readClient.getTransactionCount({
        address: addr as `0x${string}`,
        blockTag: 'pending'
      });
      return { addr, nonce };
    });

    const settled = await Promise.allSettled(noncePromises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const { addr, nonce } = result.value;
        const key = addr.toLowerCase();
        results.set(key, nonce);
        // 同步写入全局 nonceManager，以便 acquireNonceLocal 使用
        const localNonce = nonceManager.get(key) || 0;
        nonceManager.set(key, Math.max(nonce, localNonce));
      }
    }

    return results;
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
  }): Promise<Map<string, { tokenBalance: bigint; allowanceSufficient: boolean }>> {
    const results = new Map<string, { tokenBalance: bigint; allowanceSufficient: boolean }>();
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
          results.set(key, { tokenBalance: 0n, allowanceSufficient: false });
        }
        const entry = results.get(key)!;

        if (res.status === 'success') {
          if (meta.type === 'balance') {
            entry.tokenBalance = res.result as bigint;
          } else if (meta.type === 'baseAllowance') {
            // 买入钱包：底池代币授权
            entry.allowanceSufficient = (res.result as bigint) >= maxUint128;
          } else if (meta.type === 'targetAllowance') {
            // 卖出钱包：目标代币授权
            entry.allowanceSufficient = (res.result as bigint) >= maxUint128;
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
   * 跳过 allowance 检查、getAmountOut、RPC nonce 查询
   */
  async executeTradeFast(params: FourMemeTradeParams, prefetchedBalance?: bigint, prefetchedGasPrice?: bigint): Promise<FourMemeTradeResult> {
    try {
      const chain = this.chainId === 97 ? bscTestnet : bsc;
      const account = privateKeyToAccount(params.privateKey as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(this.rpcUrl)
      });

      if (params.mode === 'buy') {
        return await this.executeBuyFast(walletClient, params, prefetchedGasPrice);
      } else {
        return await this.executeSellFast(walletClient, params, prefetchedBalance, prefetchedGasPrice);
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || '快速交易执行失败'
      };
    }
  }

  /**
   * 快速买入（跳过 allowance 检查和 getAmountOut，使用本地 nonce）
   */
  private async executeBuyFast(
    walletClient: WalletClient,
    params: FourMemeTradeParams,
    prefetchedGasPrice?: bigint
  ): Promise<FourMemeTradeResult> {
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;
      const isNonBnbPool = !!params.poolBaseToken;

      const amountStr = params.amount.toFixed(18).replace(/\.?0+$/, '');
      const buyAmountWei = parseEther(amountStr);

      // 跳过 allowance 检查（已预授权）
      // 跳过 getAmountOut（使用 minAmount = 0n 接受任意滑点，内盘交易量小影响不大）
      const minAmount = 0n;

      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'buyTokenAMAP',
        args: [0n, tokenAddress, buyAmountWei, minAmount]
      });

      // 优先使用用户配置 > 预取的 gasPrice > undefined（让 Viem 自动获取作为兜底）
      const gasPrice = params.gasPrice ? BigInt(params.gasPrice * 1e9) : prefetchedGasPrice;
      const gasLimit = params.gasLimit ? BigInt(params.gasLimit) : BigInt(300000);

      // 优先使用本地 nonce（零 RPC），fallback 到链上查询
      let nonce = acquireNonceLocal(walletAddress);
      if (nonce === null) {
        nonce = await acquireNonce(this.publicClient, walletAddress);
      }

      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: isNonBnbPool ? 0n : buyAmountWei,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      const unit = isNonBnbPool ? '底池代币' : 'BNB';
      return {
        success: true,
        txHash: txHash,
        amountIn: `${params.amount} ${unit}`
      };
    } catch (error: any) {
      if (walletClient.account?.address) {
        resetNonceForAddress(walletClient.account.address);
      }
      return {
        success: false,
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
    prefetchedGasPrice?: bigint
  ): Promise<FourMemeTradeResult> {
    try {
      const tokenAddress = params.tokenAddress as Address;
      const walletAddress = walletClient.account!.address;

      // 使用预取的余额，如果没有则查询链上
      let tokenBalance: bigint;
      if (prefetchedBalance !== undefined) {
        tokenBalance = prefetchedBalance;
      } else {
        tokenBalance = await this.getTokenBalance(tokenAddress, walletAddress);
      }

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

      // 跳过 allowance 检查（已预授权）
      // 跳过 getAmountOut（使用 minEthAmount = 0n）
      const minEthAmount = 0n;

      const callData = encodeFunctionData({
        abi: FOURMEME_ABI,
        functionName: 'sellToken',
        args: [tokenAddress, sellAmount, minEthAmount]
      });

      // 优先使用用户配置 > 预取的 gasPrice > undefined（让 Viem 自动获取作为兜底）
      const gasPrice = params.gasPrice ? BigInt(params.gasPrice * 1e9) : prefetchedGasPrice;
      const gasLimit = params.gasLimit ? BigInt(params.gasLimit) : BigInt(300000);

      // 优先使用本地 nonce（零 RPC），fallback 到链上查询
      let nonce = acquireNonceLocal(walletAddress);
      if (nonce === null) {
        nonce = await acquireNonce(this.publicClient, walletAddress);
      }

      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      return {
        success: true,
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
      resetNonceForAddress(params.walletAddress);
      return {
        success: false,
        error: error.message || '快速卖出执行失败'
      };
    }
  }
}

/**
 * 创建 FourMeme 服务实例
 */
export function createFourMemeService(chainId: number, rpcUrl: string): FourMemeService {
  return new FourMemeService(chainId, rpcUrl);
}
