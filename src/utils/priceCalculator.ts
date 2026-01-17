import { createPublicClient, http, formatUnits, parseUnits, getAddress } from 'viem';
import { factoryAbi } from '../viem/abis/factory';
import { pairAbi } from '../viem/abis/pair';
import { erc20Abi } from '../viem/abis/erc20';
import { pancakeV2RouterAbi } from '../viem/abis/pancakeV2';

// WBNB 地址映射
const WBNB_ADDRESSES: Record<number, string> = {
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',   // BSC Mainnet
  97: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',   // BSC Testnet
};

export type TokenPair = {
  pairAddress: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  price: number;
  baseToken: string;
  // 路由信息（如果是通过中间币计算的价格）
  isRouted?: boolean;
  routePath?: string[];  // 例如: ['YS', 'BNB', 'USDT']
  intermediatePrice?: number;  // 中间币价格（如 BNB/USDT）
};

export class PriceCalculator {
  private client: any;
  private factoryAddress: string;
  private routerAddress: string;
  private baseTokens: string[];
  private chainId: number;

  constructor(rpcUrl: string, factoryAddress: string, baseTokens: string[], routerAddress?: string, chainId?: number) {
    this.client = createPublicClient({
      transport: http(rpcUrl),
    });
    // 使用getAddress确保地址是checksum格式
    this.factoryAddress = getAddress(factoryAddress);
    this.routerAddress = routerAddress ? getAddress(routerAddress) : '';
    this.baseTokens = baseTokens.map(addr => getAddress(addr));
    this.chainId = chainId || 56;
  }

  /**
   * 查找Token与基准币的交易对
   * @param tokenAddress 代币合约地址
   * @param quoteToken 可选的报价代币地址，如果提供则直接查找该交易对
   * @returns 找到的交易对信息，如果没找到返回null
   */
  async findTokenPair(tokenAddress: string, quoteToken?: string): Promise<TokenPair | null> {
    console.log(`开始查找代币 ${tokenAddress} 的交易对...`);

    // 如果指定了报价代币，优先使用 Router 计算价格
    if (quoteToken && this.routerAddress) {
      console.log(`使用 Router 计算价格...`);
      const routerPrice = await this.getPriceViaRouter(tokenAddress, quoteToken);
      if (routerPrice) {
        return routerPrice;
      }
      console.log('Router 价格计算失败，回退到池子储备计算...');
    }

    // 如果指定了报价代币，尝试直接查找交易对
    if (quoteToken) {
      try {
        console.log(`直接查找与报价代币 ${quoteToken} 的交易对...`);
        const normalizedTokenAddress = getAddress(tokenAddress);
        const normalizedQuoteToken = getAddress(quoteToken);

        // 尝试两种顺序：tokenA/tokenB 和 tokenB/tokenA
        let pairAddress = await this.client.readContract({
          address: this.factoryAddress as `0x${string}`,
          abi: factoryAbi,
          functionName: 'getPair',
          args: [normalizedTokenAddress as `0x${string}`, normalizedQuoteToken as `0x${string}`]
        }).catch(() => null);

        // 如果第一种顺序没找到，尝试反向
        if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') {
          pairAddress = await this.client.readContract({
            address: this.factoryAddress as `0x${string}`,
            abi: factoryAbi,
            functionName: 'getPair',
            args: [normalizedQuoteToken as `0x${string}`, normalizedTokenAddress as `0x${string}`]
          }).catch(() => null);
        }

        if (pairAddress && pairAddress !== '0x0000000000000000000000000000000000000000') {
          console.log(`找到直接交易对: ${pairAddress}`);
          const pairInfo = await this.getPairInfo(pairAddress as `0x${string}`, tokenAddress, quoteToken);
          if (pairInfo) {
            return pairInfo;
          }
        }

        // 如果没有直接交易对，尝试通过路由计算价格
        console.log(`未找到直接交易对，尝试路由计算...`);
        const routedPair = await this.findRoutedPrice(tokenAddress, quoteToken);
        if (routedPair) {
          return routedPair;
        }
      } catch (error) {
        console.warn(`查找与报价代币 ${quoteToken} 的交易对失败:`, error);
      }
    }

    // 如果没有指定报价代币或指定报价代币没找到，遍历所有基准币
    for (const baseToken of this.baseTokens) {
      try {
        console.log(`检查与基准币 ${baseToken} 的交易对...`);

        // 调用Factory合约的getPair方法
        // 确保所有地址都是checksum格式
        const normalizedTokenAddress = getAddress(tokenAddress);
        const normalizedBaseToken = getAddress(baseToken);

        const pairAddress = await this.client.readContract({
          address: this.factoryAddress as `0x${string}`,
          abi: factoryAbi,
          functionName: 'getPair',
          args: [normalizedTokenAddress as `0x${string}`, normalizedBaseToken as `0x${string}`]
        });

        // 检查是否找到有效的交易对（非零地址）
        if (pairAddress && pairAddress !== '0x0000000000000000000000000000000000000000') {
          console.log(`找到交易对: ${pairAddress}`);

          // 获取交易对详细信息
          const pairInfo = await this.getPairInfo(pairAddress as `0x${string}`, tokenAddress, baseToken);
          if (pairInfo) {
            return pairInfo;
          }
        }
      } catch (error) {
        console.warn(`查找与基准币 ${baseToken} 的交易对失败:`, error);
        continue;
      }
    }

    console.log('未找到任何交易对');
    return null;
  }

  /**
   * 通过路由计算价格（例如：YS -> BNB -> USDT）
   * @param tokenAddress 代币地址
   * @param quoteToken 目标报价代币（如 USDT）
   * @returns 计算后的交易对信息
   */
  private async findRoutedPrice(tokenAddress: string, quoteToken: string): Promise<TokenPair | null> {
    const normalizedTokenAddress = getAddress(tokenAddress);
    const normalizedQuoteToken = getAddress(quoteToken);

    // 遍历所有基准币作为中间币
    for (const intermediateToken of this.baseTokens) {
      const normalizedIntermediate = getAddress(intermediateToken);

      // 跳过目标报价代币本身
      if (normalizedIntermediate.toLowerCase() === normalizedQuoteToken.toLowerCase()) {
        continue;
      }

      try {
        console.log(`尝试路由: Token -> ${normalizedIntermediate} -> ${normalizedQuoteToken}`);

        // 1. 查找 Token/中间币 交易对
        const pair1Address = await this.client.readContract({
          address: this.factoryAddress as `0x${string}`,
          abi: factoryAbi,
          functionName: 'getPair',
          args: [normalizedTokenAddress as `0x${string}`, normalizedIntermediate as `0x${string}`]
        }).catch(() => null);

        if (!pair1Address || pair1Address === '0x0000000000000000000000000000000000000000') {
          continue;
        }

        // 2. 查找 中间币/报价代币 交易对
        const pair2Address = await this.client.readContract({
          address: this.factoryAddress as `0x${string}`,
          abi: factoryAbi,
          functionName: 'getPair',
          args: [normalizedIntermediate as `0x${string}`, normalizedQuoteToken as `0x${string}`]
        }).catch(() => null);

        if (!pair2Address || pair2Address === '0x0000000000000000000000000000000000000000') {
          continue;
        }

        console.log(`找到路由: ${pair1Address} -> ${pair2Address}`);

        // 3. 获取两个交易对的价格信息
        const pair1Info = await this.getPairInfo(pair1Address as `0x${string}`, tokenAddress, intermediateToken);
        const pair2Info = await this.getPairInfo(pair2Address as `0x${string}`, intermediateToken, quoteToken);

        if (pair1Info && pair2Info) {
          // 4. 计算最终价格: Token/中间币 价格 × 中间币/报价代币 价格
          const finalPrice = pair1Info.price * pair2Info.price;

          console.log(`路由价格计算: ${pair1Info.price} (Token/${intermediateToken.slice(0,6)}) × ${pair2Info.price} (${intermediateToken.slice(0,6)}/${quoteToken.slice(0,6)}) = ${finalPrice}`);

          // 返回路由计算的结果
          return {
            pairAddress: pair1Address as string,  // 使用第一个交易对地址
            token0: pair1Info.token0,
            token1: pair1Info.token1,
            reserve0: pair1Info.reserve0,
            reserve1: pair1Info.reserve1,
            price: finalPrice,
            baseToken: normalizedQuoteToken,
            isRouted: true,
            routePath: [normalizedTokenAddress, normalizedIntermediate, normalizedQuoteToken],
            intermediatePrice: pair2Info.price
          };
        }
      } catch (error) {
        console.warn(`路由 ${intermediateToken} 计算失败:`, error);
        continue;
      }
    }

    console.log('未找到可用的价格路由');
    return null;
  }

  /**
   * 获取交易对的详细信息
   * @param pairAddress 交易对合约地址
   * @param tokenAddress 代币地址
   * @param baseToken 基准币地址
   * @returns 交易对信息
   */
  private async getPairInfo(pairAddress: `0x${string}`, tokenAddress: string, baseToken: string): Promise<TokenPair | null> {
    try {
      // 获取交易对的储备量
      const reserves = await this.client.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: 'getReserves'
      });

      // 获取token0和token1地址
      const token0 = await this.client.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: 'token0'
      });

      const token1 = await this.client.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: 'token1'
      });

      // 获取代币精度（确保地址是checksum格式）
      const normalizedTokenAddress = getAddress(tokenAddress);
      const normalizedBaseToken = getAddress(baseToken);
      const tokenDecimals = await this.getTokenDecimals(normalizedTokenAddress as `0x${string}`);
      const baseTokenDecimals = await this.getTokenDecimals(normalizedBaseToken as `0x${string}`);

      // 计算价格（使用checksum格式比较）
      const normalizedToken0 = getAddress(token0 as string);
      const normalizedToken1 = getAddress(token1 as string);
      let price = 0;
      if (normalizedToken0.toLowerCase() === normalizedTokenAddress.toLowerCase()) {
        // token0是目标代币，token1是基准币
        price = Number(formatUnits(reserves[1], baseTokenDecimals)) / Number(formatUnits(reserves[0], tokenDecimals));
      } else {
        // token1是目标代币，token0是基准币
        price = Number(formatUnits(reserves[0], baseTokenDecimals)) / Number(formatUnits(reserves[1], tokenDecimals));
      }

      return {
        pairAddress: pairAddress,
        token0: normalizedToken0,
        token1: normalizedToken1,
        reserve0: reserves[0],
        reserve1: reserves[1],
        price: price,
        baseToken: normalizedBaseToken
      };
    } catch (error) {
      console.error('获取交易对信息失败:', error);
      return null;
    }
  }

  /**
   * 获取代币精度
   * @param tokenAddress 代币合约地址
   * @returns 代币精度
   */
  private async getTokenDecimals(tokenAddress: `0x${string}`): Promise<number> {
    try {
      const decimals = await this.client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'decimals'
      });
      return Number(decimals);
    } catch (error) {
      console.warn(`获取代币 ${tokenAddress} 精度失败，使用默认值18:`, error);
      return 18; // 默认精度
    }
  }

  /**
   * 使用 Router 的 getAmountsOut 计算价格（包含最优路径）
   * @param tokenAddress 代币地址
   * @param quoteToken 报价代币地址
   * @returns 价格信息
   */
  async getPriceViaRouter(tokenAddress: string, quoteToken: string): Promise<TokenPair | null> {
    if (!this.routerAddress) {
      console.log('未配置 Router 地址，跳过 Router 价格计算');
      return null;
    }

    const normalizedTokenAddress = getAddress(tokenAddress);
    const normalizedQuoteToken = getAddress(quoteToken);
    const wbnbAddress = WBNB_ADDRESSES[this.chainId];

    if (!wbnbAddress) {
      console.log(`未找到 chainId ${this.chainId} 的 WBNB 地址`);
      return null;
    }

    const normalizedWbnb = getAddress(wbnbAddress);

    try {
      // 获取代币精度
      const tokenDecimals = await this.getTokenDecimals(normalizedTokenAddress as `0x${string}`);
      const quoteDecimals = await this.getTokenDecimals(normalizedQuoteToken as `0x${string}`);

      // 使用 1 个代币计算价格
      const amountIn = parseUnits('1', tokenDecimals);

      // 尝试不同的路径
      const paths: `0x${string}`[][] = [
        // 路径1: Token -> WBNB -> QuoteToken
        [normalizedTokenAddress as `0x${string}`, normalizedWbnb as `0x${string}`, normalizedQuoteToken as `0x${string}`],
        // 路径2: Token -> QuoteToken (直接)
        [normalizedTokenAddress as `0x${string}`, normalizedQuoteToken as `0x${string}`],
      ];

      let bestPrice = 0;
      let bestPath: `0x${string}`[] | null = null;
      let isRouted = false;

      for (const path of paths) {
        try {
          console.log(`尝试路径: ${path.map(p => p.slice(0, 10)).join(' -> ')}`);

          const amounts = await this.client.readContract({
            address: this.routerAddress as `0x${string}`,
            abi: pancakeV2RouterAbi,
            functionName: 'getAmountsOut',
            args: [amountIn, path]
          }) as bigint[];

          const outputAmount = amounts[amounts.length - 1];
          const price = Number(formatUnits(outputAmount, quoteDecimals));

          console.log(`路径价格: ${price}`);

          // 选择输出最多的路径（最优价格）
          if (price > bestPrice) {
            bestPrice = price;
            bestPath = path;
            isRouted = path.length > 2;
          }
        } catch (error) {
          console.log(`路径失败: ${path.map(p => p.slice(0, 10)).join(' -> ')}`);
          continue;
        }
      }

      if (bestPath && bestPrice > 0) {
        console.log(`最优路径: ${bestPath.map(p => p.slice(0, 10)).join(' -> ')}, 价格: ${bestPrice}`);

        // 获取直接交易对的池子储备量（用于计算市值）
        let reserve0 = BigInt(0);
        let reserve1 = BigInt(0);
        let pairAddress = this.routerAddress;
        let token0Addr = normalizedTokenAddress;
        let token1Addr = normalizedQuoteToken;

        try {
          // 查找 Token/QuoteToken 的直接交易对
          const directPairAddress = await this.client.readContract({
            address: this.factoryAddress as `0x${string}`,
            abi: factoryAbi,
            functionName: 'getPair',
            args: [normalizedTokenAddress as `0x${string}`, normalizedQuoteToken as `0x${string}`]
          }).catch(() => null);

          if (directPairAddress && directPairAddress !== '0x0000000000000000000000000000000000000000') {
            pairAddress = directPairAddress as string;
            // 获取储备量
            const reserves = await this.client.readContract({
              address: directPairAddress as `0x${string}`,
              abi: pairAbi,
              functionName: 'getReserves'
            }).catch(() => null) as [bigint, bigint, number] | null;

            if (reserves) {
              // 获取 token0 地址
              const t0 = await this.client.readContract({
                address: directPairAddress as `0x${string}`,
                abi: pairAbi,
                functionName: 'token0'
              }).catch(() => null) as string | null;

              if (t0) {
                token0Addr = t0;
                token1Addr = t0.toLowerCase() === normalizedTokenAddress.toLowerCase()
                  ? normalizedQuoteToken
                  : normalizedTokenAddress;
                reserve0 = reserves[0];
                reserve1 = reserves[1];
                console.log(`池子储备量: reserve0=${reserve0}, reserve1=${reserve1}`);
              }
            }
          }
        } catch (e) {
          console.log('获取池子储备量失败，继续使用价格信息');
        }

        return {
          pairAddress: pairAddress,
          token0: token0Addr,
          token1: token1Addr,
          reserve0: reserve0,
          reserve1: reserve1,
          price: bestPrice,
          baseToken: normalizedQuoteToken,
          isRouted: isRouted,
          routePath: isRouted ? bestPath : undefined
        };
      }
    } catch (error) {
      console.error('Router 价格计算失败:', error);
    }

    return null;
  }

  /**
   * 根据目标价格计算需要交换的代币数量
   * @param pairInfo 交易对信息
   * @param targetPrice 目标价格
   * @param isBuy 是否为买入操作
   * @returns 需要交换的代币数量
   */
  calculateSwapAmount(pairInfo: TokenPair, targetPrice: number, isBuy: boolean): bigint {
    const { reserve0, reserve1, token0, token1 } = pairInfo;
    
    // 简化的价格计算（实际应该考虑滑点和手续费）
    if (isBuy) {
      // 买入：提高代币价格
      // 这里使用简化的恒定乘积公式
      const currentPrice = Number(reserve1) / Number(reserve0);
      const priceRatio = targetPrice / currentPrice;
      
      // 计算需要投入的基准币数量
      const baseTokenAmount = Number(reserve1) * (priceRatio - 1);
      return BigInt(Math.floor(baseTokenAmount));
    } else {
      // 卖出：降低代币价格
      const currentPrice = Number(reserve1) / Number(reserve0);
      const priceRatio = currentPrice / targetPrice;
      
      // 计算需要卖出的代币数量
      const tokenAmount = Number(reserve0) * (priceRatio - 1);
      return BigInt(Math.floor(tokenAmount));
    }
  }
}
