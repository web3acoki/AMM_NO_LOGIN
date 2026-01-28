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

// 方法选择器
export const BUY_METHOD_SELECTOR = '0x87f27655' as const;   // 买入
export const SELL_METHOD_SELECTOR = '0xf464e7db' as const;  // 卖出

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
}

export interface FourMemeTradeResult {
  success: boolean;
  txHash?: string;
  error?: string;
  amountIn?: string;
  amountOut?: string;
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

      // 构建买入交易数据
      // FourMeme 买入方法: buy(address token)
      // 选择器: 0x87f27655
      const callData = (BUY_METHOD_SELECTOR +
        tokenAddress.slice(2).padStart(64, '0')) as `0x${string}`;

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

      // 等待交易确认
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60000
      });

      if (receipt.status === 'success') {
        return {
          success: true,
          txHash: txHash,
          amountIn: `${params.amount} BNB`
        };
      } else {
        return {
          success: false,
          txHash: txHash,
          error: '交易失败 (reverted)'
        };
      }
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

      // 构建卖出交易数据
      // FourMeme 卖出方法: sell(address token, uint256 amount)
      // 选择器: 0xf464e7db
      const callData = (SELL_METHOD_SELECTOR +
        tokenAddress.slice(2).padStart(64, '0') +
        sellAmount.toString(16).padStart(64, '0')) as `0x${string}`;

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

      // 等待交易确认
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60000
      });

      if (receipt.status === 'success') {
        return {
          success: true,
          txHash: txHash,
          amountIn: formatEther(sellAmount) + ' Token'
        };
      } else {
        return {
          success: false,
          txHash: txHash,
          error: '交易失败 (reverted)'
        };
      }
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
}

/**
 * 创建 FourMeme 服务实例
 */
export function createFourMemeService(chainId: number, rpcUrl: string): FourMemeService {
  return new FourMemeService(chainId, rpcUrl);
}
