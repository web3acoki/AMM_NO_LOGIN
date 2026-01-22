import { createPublicClient, createWalletClient, http, parseEther, parseUnits, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import { pancakeV2RouterAbi } from '../viem/abis/pancakeV2';
import { erc20Abi } from '../viem/abis/erc20';
import { WBNB_ADDRESSES, USDT_ADDRESSES, USDC_ADDRESSES } from '../constants';
import { parseBlockchainError } from '../utils/errorParser';

// 获取链配置
function getChainConfig(chainId: number) {
  switch (chainId) {
    case 97:
      return bscTestnet;
    case 56:
      return bsc;
    default:
      return bsc;
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
}

// 交易结果接口
export interface TradeResult {
  success: boolean;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  error?: string;
}

// 全局nonce管理器（追踪每个钱包的pending nonce）
const nonceManager: Map<string, number> = new Map();

// 获取并递增nonce（线程安全）
async function getAndIncrementNonce(
  publicClient: any,
  address: `0x${string}`
): Promise<number> {
  const key = address.toLowerCase();

  // 获取链上的pending nonce
  const chainNonce = await publicClient.getTransactionCount({
    address,
    blockTag: 'pending'
  });

  // 获取本地追踪的nonce
  const localNonce = nonceManager.get(key) || 0;

  // 使用两者中较大的值
  const nonce = Math.max(chainNonce, localNonce);

  // 更新本地追踪的nonce
  nonceManager.set(key, nonce + 1);

  return nonce;
}

// 重置钱包的nonce追踪（交易失败时调用）
export function resetNonceForAddress(address: string) {
  nonceManager.delete(address.toLowerCase());
}

// 交易服务类
export class TradingService {
  private chainId: number;
  private rpcUrl: string;
  private routerAddress: `0x${string}`;
  private publicClient: any;
  private chainConfig: any;

  constructor(chainId: number, rpcUrl: string, routerAddress: string) {
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
    return WBNB_ADDRESSES[this.chainId] || WBNB_ADDRESSES[56];
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
      return await getAndIncrementNonce(this.publicClient, address);
    } catch (error) {
      console.warn('获取 nonce 失败，使用默认值:', error);
      return 0;
    }
  }

  // 检查并授权代币
  private async checkAndApprove(
    walletClient: any,
    tokenAddress: `0x${string}`,
    ownerAddress: `0x${string}`,
    spenderAddress: `0x${string}`,
    amount: bigint
  ): Promise<boolean> {
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
        
        // 获取最新的 nonce
        const nonce = await this.getLatestNonce(ownerAddress);
        
        // 授权最大值
        const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        
        const approveTxHash = await walletClient.writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spenderAddress, maxApproval],
          nonce: nonce
        });

        console.log(`授权交易已发送: ${approveTxHash}, nonce: ${nonce}`);
        
        // 等待授权交易确认
        await this.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        console.log('授权成功');
      }

      return true;
    } catch (error: any) {
      console.error('授权失败:', error);
      throw new Error(`授权失败: ${error.message}`);
    }
  }

  // 获取代币精度
  private async getTokenDecimals(tokenAddress: `0x${string}`): Promise<number> {
    try {
      const decimals = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'decimals'
      }) as number;
      return decimals;
    } catch {
      return 18; // 默认精度
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
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      const wbnbAddress = this.getWBNBAddress();
      const path: `0x${string}`[] = [wbnbAddress, tokenAddress as `0x${string}`];
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
        amountIn = (availableBalance * BigInt(balancePercent)) / BigInt(100);
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
      const nonce = await this.getLatestNonce(walletAddress as `0x${string}`);

      // 添加Gas设置
      if (gasPrice) {
        txParams.gasPrice = parseUnits(gasPrice.toString(), 9); // Gwei to Wei
      }
      if (gasLimit) {
        txParams.gas = BigInt(gasLimit);
      }
      txParams.nonce = nonce;

      // 发送交易
      const txHash = await walletClient.writeContract(txParams);

      console.log(`交易已发送: ${txHash}`);

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
      return {
        success: false,
        error: parseBlockchainError(error)
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
        amountIn = (balance * BigInt(balancePercent)) / BigInt(100);
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
      await this.checkAndApprove(
        walletClient,
        spendTokenAddress,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn
      );

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
      return {
        success: false,
        error: parseBlockchainError(error)
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
        amountIn = (tokenBalance * BigInt(balancePercent)) / BigInt(100);
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
      await this.checkAndApprove(
        walletClient,
        tokenAddress as `0x${string}`,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn
      );

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
      return {
        success: false,
        error: parseBlockchainError(error)
      };
    }
  }

  // 卖出代币（换成原生币BNB）
  async sellForNative(params: TradeParams): Promise<TradeResult> {
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
      const walletClient = createWalletClient({
        account,
        chain: this.chainConfig,
        transport: http(this.rpcUrl)
      });

      const wbnbAddress = this.getWBNBAddress();
      const path: `0x${string}`[] = [tokenAddress as `0x${string}`, wbnbAddress];
      const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadline);

      // 获取代币精度
      const decimals = await this.getTokenDecimals(tokenAddress as `0x${string}`);

      // 获取代币余额
      const tokenBalance = await this.getTokenBalance(tokenAddress as `0x${string}`, walletAddress as `0x${string}`);

      // 根据不同模式计算实际卖出数量
      let amountIn: bigint;

      if (balancePercent && balancePercent > 0 && balancePercent <= 100) {
        // 模式1：使用代币余额的X%（卖出全部时使用）
        amountIn = (tokenBalance * BigInt(balancePercent)) / BigInt(100);
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
      await this.checkAndApprove(
        walletClient,
        tokenAddress as `0x${string}`,
        walletAddress as `0x${string}`,
        this.routerAddress,
        amountIn
      );

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
          amountIn: formatUnits(amountIn, decimals),
          amountOut: formatEther(expectedOut)
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
      return {
        success: false,
        error: parseBlockchainError(error)
      };
    }
  }

  // 执行交易（根据模式自动选择买入或卖出）
  async executeTrade(params: TradeParams): Promise<TradeResult> {
    const { mode, spendToken } = params;
    
    if (mode === 'pump') {
      // 拉盘 = 买入
      if (spendToken === 'BNB' || spendToken === 'tBNB') {
        return this.buyWithNative(params);
      } else if (spendToken === 'USDT' || spendToken === 'USDC') {
        return this.buyWithToken(params);
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

