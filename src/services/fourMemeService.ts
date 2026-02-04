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

// 防夹 RPC 节点（用于内盘交易）
// 推荐节点（按优先级）：
// 1. BlockSec (专门针对 Four.meme 优化): https://bsc.rpc.blocksec.com
// 2. 48 Club (BSC最大builder): https://rpc-bsc.48.club
// 3. BlockRazor: https://meme.bsc.blockrazor.xyz
export const ANTI_SANDWICH_RPC = 'https://bsc.rpc.blocksec.com' as const;

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

// ==================== 服务类 ====================

export class FourMemeService {
  private publicClient: PublicClient;
  private chainId: number;
  private rpcUrl: string;

  constructor(chainId: number, rpcUrl: string) {
    this.chainId = chainId;
    this.rpcUrl = rpcUrl;

    const chain = chainId === 97 ? bscTestnet : bsc;
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl)
    });
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
      const buyAmountWei = BigInt(Math.floor(params.amount * 1e18));
      const slippage = params.slippage || 0;

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
          buyAmountWei,  // funds: BNB 金额
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

      // 获取当前 nonce
      const nonce = await this.publicClient.getTransactionCount({
        address: walletClient.account!.address,
        blockTag: 'pending'
      });

      // 发送交易
      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: buyAmountWei,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      // 交易已发送，不等待链上确认，直接返回成功
      return {
        success: true,
        txHash: txHash,
        amountIn: `${params.amount} BNB`
      };
    } catch (error: any) {
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

      // 获取当前 nonce
      const nonce = await this.publicClient.getTransactionCount({
        address: walletAddress,
        blockTag: 'pending'
      });

      // 发送交易
      const txHash = await walletClient.sendTransaction({
        to: FOURMEME_CONTRACT,
        data: callData,
        value: 0n,
        gas: gasLimit,
        gasPrice: gasPrice,
        nonce: nonce
      });

      // 交易已发送，不等待链上确认，直接返回成功
      return {
        success: true,
        txHash: txHash,
        amountIn: formatEther(sellAmount) + ' Token'
      };
    } catch (error: any) {
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

      // 获取当前 nonce
      const nonce = await this.publicClient.getTransactionCount({
        address: walletAddress,
        blockTag: 'pending'
      });

      // 发送交易
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
      return {
        success: false,
        error: error.message || '卖出执行失败'
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
