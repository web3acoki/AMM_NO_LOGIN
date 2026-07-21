import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  http,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { erc20Abi } from '../viem/abis/erc20';
import {
  swapRouter02Abi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
  uniswapV3QuoterV2Abi,
} from '../viem/abis/uniswapV3';
import { robinhood } from '../viem/chains/robinhood';
import {
  PONS_V3_POOL_FEE,
  ROBINHOOD_ARROW_RPC_URL,
  ROBINHOOD_OFFICIAL_RPC_URL,
  ROBINHOOD_WETH_ADDRESS,
  UNISWAP_V3_ROBINHOOD_ADDRESSES,
} from '../constants';

const Q192 = 2n ** 192n;

export interface TokenMetadata {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

export interface V3PoolSnapshot {
  address: Address;
  token0: Address;
  token1: Address;
  token0Metadata: TokenMetadata;
  token1Metadata: TokenMetadata;
  fee: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  unlocked: boolean;
}

export interface V3PriceFraction {
  baseToken: Address;
  quoteToken: Address;
  numerator: bigint;
  denominator: bigint;
}

export interface V3QuoteExactInputSingleParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee?: number;
  sqrtPriceLimitX96?: bigint;
  quoterAddress?: Address;
}

export interface V3QuoteExactInputSingleResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

export interface V3QuoteExactOutputSingleParams {
  tokenIn: Address;
  tokenOut: Address;
  amountOut: bigint;
  fee?: number;
  sqrtPriceLimitX96?: bigint;
  quoterAddress?: Address;
}

export interface V3QuoteExactOutputSingleResult {
  amountIn: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

export interface V3ExactInputSingleParams {
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee?: number;
  sqrtPriceLimitX96?: bigint;
}

export interface V3TransactionRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface V3NativeBuyParams {
  tokenOut: Address;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee?: number;
  sqrtPriceLimitX96?: bigint;
  routerAddress?: Address;
  wrappedNativeAddress?: Address;
}

export interface V3TokenToNativeSellParams {
  tokenIn: Address;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  fee?: number;
  sqrtPriceLimitX96?: bigint;
  routerAddress?: Address;
  wrappedNativeAddress?: Address;
}

export interface UniswapV3ServiceOptions {
  factoryAddress?: Address;
  quoterAddress?: Address;
  routerAddress?: Address;
  wrappedNativeAddress?: Address;
  defaultFee?: number;
}

function assertFee(fee: number): void {
  if (!Number.isInteger(fee) || fee < 0 || fee >= 1_000_000) {
    throw new Error(`Invalid Uniswap V3 fee: ${fee}`);
  }
}

function assertPositiveAmount(amount: bigint, field: string): void {
  if (amount <= 0n) {
    throw new Error(`${field} must be greater than zero`);
  }
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function createRobinhoodPublicClient(rpcUrl?: string) {
  const transport = rpcUrl
    ? http(rpcUrl)
    : fallback([
        http(ROBINHOOD_OFFICIAL_RPC_URL),
        http(ROBINHOOD_ARROW_RPC_URL),
      ]);

  return createPublicClient({
    chain: robinhood,
    transport,
  });
}

export async function readTokenMetadata(
  publicClient: PublicClient,
  tokenAddress: Address,
): Promise<TokenMetadata> {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'name',
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'symbol',
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'totalSupply',
    }),
  ]);

  const normalizedDecimals = Number(decimals);
  if (!Number.isInteger(normalizedDecimals) || normalizedDecimals < 0 || normalizedDecimals > 255) {
    throw new Error(`Token ${tokenAddress} returned invalid decimals`);
  }

  return {
    address: tokenAddress,
    name: String(name),
    symbol: String(symbol),
    decimals: normalizedDecimals,
    totalSupply: totalSupply as bigint,
  };
}

export async function getV3Pool(
  publicClient: PublicClient,
  tokenA: Address,
  tokenB: Address,
  fee: number = PONS_V3_POOL_FEE,
  factoryAddress: Address = UNISWAP_V3_ROBINHOOD_ADDRESSES.factory,
): Promise<V3PoolSnapshot | null> {
  if (sameAddress(tokenA, tokenB)) {
    throw new Error('A Uniswap V3 pool requires two different tokens');
  }
  assertFee(fee);

  const poolAddress = await publicClient.readContract({
    address: factoryAddress,
    abi: uniswapV3FactoryAbi,
    functionName: 'getPool',
    args: [tokenA, tokenB, fee],
  }) as Address;

  if (sameAddress(poolAddress, zeroAddress)) {
    return null;
  }

  const [token0, token1, poolFee, tickSpacing, liquidity, slot0] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: 'token0',
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: 'token1',
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: 'fee',
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: 'tickSpacing',
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: 'liquidity',
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: 'slot0',
    }),
  ]);

  const [token0Metadata, token1Metadata] = await Promise.all([
    readTokenMetadata(publicClient, token0 as Address),
    readTokenMetadata(publicClient, token1 as Address),
  ]);

  const slot = slot0 as readonly [bigint, number, number, number, number, number, boolean];
  return {
    address: poolAddress,
    token0: token0 as Address,
    token1: token1 as Address,
    token0Metadata,
    token1Metadata,
    fee: Number(poolFee),
    tickSpacing: Number(tickSpacing),
    liquidity: liquidity as bigint,
    sqrtPriceX96: slot[0],
    tick: Number(slot[1]),
    unlocked: slot[6],
  };
}

export async function findV3Pools(
  publicClient: PublicClient,
  tokenA: Address,
  tokenB: Address,
  fees: readonly number[] = [PONS_V3_POOL_FEE],
  factoryAddress: Address = UNISWAP_V3_ROBINHOOD_ADDRESSES.factory,
): Promise<V3PoolSnapshot[]> {
  const pools = await Promise.all(
    fees.map(fee => getV3Pool(publicClient, tokenA, tokenB, fee, factoryAddress)),
  );
  return pools.filter((pool): pool is V3PoolSnapshot => pool !== null);
}

export function getV3SpotPriceFraction(
  pool: V3PoolSnapshot,
  baseToken: Address,
  quoteToken: Address,
): V3PriceFraction {
  if (pool.sqrtPriceX96 === 0n) {
    throw new Error('The Uniswap V3 pool has not been initialized');
  }
  const squaredPrice = pool.sqrtPriceX96 * pool.sqrtPriceX96;

  if (sameAddress(baseToken, pool.token0) && sameAddress(quoteToken, pool.token1)) {
    return {
      baseToken,
      quoteToken,
      numerator: squaredPrice * (10n ** BigInt(pool.token0Metadata.decimals)),
      denominator: Q192 * (10n ** BigInt(pool.token1Metadata.decimals)),
    };
  }

  if (sameAddress(baseToken, pool.token1) && sameAddress(quoteToken, pool.token0)) {
    return {
      baseToken,
      quoteToken,
      numerator: Q192 * (10n ** BigInt(pool.token1Metadata.decimals)),
      denominator: squaredPrice * (10n ** BigInt(pool.token0Metadata.decimals)),
    };
  }

  throw new Error('The requested price direction does not match this pool');
}

export function formatV3PriceFraction(
  price: V3PriceFraction,
  precision = 18,
): string {
  if (!Number.isInteger(precision) || precision < 0 || precision > 100) {
    throw new Error(`Invalid price precision: ${precision}`);
  }
  if (price.denominator === 0n) {
    throw new Error('Cannot format a price with a zero denominator');
  }

  const integer = price.numerator / price.denominator;
  if (precision === 0) return integer.toString();

  const scale = 10n ** BigInt(precision);
  const fraction = ((price.numerator % price.denominator) * scale) / price.denominator;
  const fractionText = fraction.toString().padStart(precision, '0').replace(/0+$/, '');
  return fractionText ? `${integer}.${fractionText}` : integer.toString();
}

export async function quoteV3ExactInputSingle(
  publicClient: PublicClient,
  params: V3QuoteExactInputSingleParams,
): Promise<V3QuoteExactInputSingleResult> {
  const fee = params.fee ?? PONS_V3_POOL_FEE;
  assertFee(fee);
  assertPositiveAmount(params.amountIn, 'amountIn');

  const { result } = await publicClient.simulateContract({
    address: params.quoterAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.quoterV2,
    abi: uniswapV3QuoterV2Abi,
    functionName: 'quoteExactInputSingle',
    args: [{
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      fee,
      sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
    }],
  });

  const quote = result as readonly [bigint, bigint, number, bigint];
  return {
    amountOut: quote[0],
    sqrtPriceX96After: quote[1],
    initializedTicksCrossed: Number(quote[2]),
    gasEstimate: quote[3],
  };
}

export async function quoteV3ExactOutputSingle(
  publicClient: PublicClient,
  params: V3QuoteExactOutputSingleParams,
): Promise<V3QuoteExactOutputSingleResult> {
  const fee = params.fee ?? PONS_V3_POOL_FEE;
  assertFee(fee);
  assertPositiveAmount(params.amountOut, 'amountOut');

  const { result } = await publicClient.simulateContract({
    address: params.quoterAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.quoterV2,
    abi: uniswapV3QuoterV2Abi,
    functionName: 'quoteExactOutputSingle',
    args: [{
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amount: params.amountOut,
      fee,
      sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
    }],
  });

  const quote = result as readonly [bigint, bigint, number, bigint];
  return {
    amountIn: quote[0],
    sqrtPriceX96After: quote[1],
    initializedTicksCrossed: Number(quote[2]),
    gasEstimate: quote[3],
  };
}

export function applySlippageBps(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`Invalid slippage BPS: ${slippageBps}`);
  }
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function buildV3ExactInputSingleCalldata(
  params: V3ExactInputSingleParams,
): Hex {
  const fee = params.fee ?? PONS_V3_POOL_FEE;
  assertFee(fee);
  assertPositiveAmount(params.amountIn, 'amountIn');
  if (params.amountOutMinimum < 0n) {
    throw new Error('amountOutMinimum cannot be negative');
  }

  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee,
      recipient: params.recipient,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
    }],
  });
}

export function buildV3NativeBuyTransaction(
  params: V3NativeBuyParams,
): V3TransactionRequest {
  const routerAddress = params.routerAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02;
  const wrappedNativeAddress = params.wrappedNativeAddress ?? ROBINHOOD_WETH_ADDRESS;

  return {
    to: routerAddress,
    data: buildV3ExactInputSingleCalldata({
      tokenIn: wrappedNativeAddress,
      tokenOut: params.tokenOut,
      recipient: params.recipient,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      fee: params.fee,
      sqrtPriceLimitX96: params.sqrtPriceLimitX96,
    }),
    value: params.amountIn,
  };
}

export function buildV3TokenToNativeSellTransaction(
  params: V3TokenToNativeSellParams,
): V3TransactionRequest {
  if (params.deadline <= 0n) {
    throw new Error('deadline must be a positive Unix timestamp');
  }

  const routerAddress = params.routerAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02;
  const wrappedNativeAddress = params.wrappedNativeAddress ?? ROBINHOOD_WETH_ADDRESS;
  const swapData = buildV3ExactInputSingleCalldata({
    tokenIn: params.tokenIn,
    tokenOut: wrappedNativeAddress,
    // Router02 must receive WETH so it can unwrap it in the same multicall.
    recipient: routerAddress,
    amountIn: params.amountIn,
    amountOutMinimum: params.amountOutMinimum,
    fee: params.fee,
    sqrtPriceLimitX96: params.sqrtPriceLimitX96,
  });
  const unwrapData = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: 'unwrapWETH9',
    args: [params.amountOutMinimum, params.recipient],
  });

  return {
    to: routerAddress,
    data: encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: 'multicall',
      args: [params.deadline, [swapData, unwrapData]],
    }),
    value: 0n,
  };
}

export function buildV3ApprovalTransaction(
  tokenAddress: Address,
  amount: bigint,
  spenderAddress: Address = UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
): V3TransactionRequest {
  if (amount < 0n) {
    throw new Error('approval amount cannot be negative');
  }

  return {
    to: tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spenderAddress, amount],
    }),
    value: 0n,
  };
}

export async function getV3Allowance(
  publicClient: PublicClient,
  tokenAddress: Address,
  ownerAddress: Address,
  spenderAddress: Address = UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02,
): Promise<bigint> {
  return await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ownerAddress, spenderAddress],
  }) as bigint;
}

export class UniswapV3Service {
  readonly publicClient: PublicClient;
  readonly factoryAddress: Address;
  readonly quoterAddress: Address;
  readonly routerAddress: Address;
  readonly wrappedNativeAddress: Address;
  readonly defaultFee: number;

  constructor(publicClient: PublicClient, options: UniswapV3ServiceOptions = {}) {
    this.publicClient = publicClient;
    this.factoryAddress = options.factoryAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.factory;
    this.quoterAddress = options.quoterAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.quoterV2;
    this.routerAddress = options.routerAddress ?? UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02;
    this.wrappedNativeAddress = options.wrappedNativeAddress ?? ROBINHOOD_WETH_ADDRESS;
    this.defaultFee = options.defaultFee ?? PONS_V3_POOL_FEE;
    assertFee(this.defaultFee);
  }

  getPool(tokenA: Address, tokenB: Address, fee = this.defaultFee) {
    return getV3Pool(this.publicClient, tokenA, tokenB, fee, this.factoryAddress);
  }

  findPools(tokenA: Address, tokenB: Address, fees: readonly number[] = [this.defaultFee]) {
    return findV3Pools(this.publicClient, tokenA, tokenB, fees, this.factoryAddress);
  }

  quoteExactInputSingle(params: Omit<V3QuoteExactInputSingleParams, 'fee' | 'quoterAddress'> & { fee?: number }) {
    return quoteV3ExactInputSingle(this.publicClient, {
      ...params,
      fee: params.fee ?? this.defaultFee,
      quoterAddress: this.quoterAddress,
    });
  }

  quoteExactOutputSingle(params: Omit<V3QuoteExactOutputSingleParams, 'fee' | 'quoterAddress'> & { fee?: number }) {
    return quoteV3ExactOutputSingle(this.publicClient, {
      ...params,
      fee: params.fee ?? this.defaultFee,
      quoterAddress: this.quoterAddress,
    });
  }

  buildNativeBuyTransaction(params: Omit<V3NativeBuyParams, 'fee' | 'routerAddress' | 'wrappedNativeAddress'> & { fee?: number }) {
    return buildV3NativeBuyTransaction({
      ...params,
      fee: params.fee ?? this.defaultFee,
      routerAddress: this.routerAddress,
      wrappedNativeAddress: this.wrappedNativeAddress,
    });
  }

  buildTokenToNativeSellTransaction(params: Omit<V3TokenToNativeSellParams, 'fee' | 'routerAddress' | 'wrappedNativeAddress'> & { fee?: number }) {
    return buildV3TokenToNativeSellTransaction({
      ...params,
      fee: params.fee ?? this.defaultFee,
      routerAddress: this.routerAddress,
      wrappedNativeAddress: this.wrappedNativeAddress,
    });
  }

  buildApprovalTransaction(tokenAddress: Address, amount: bigint) {
    return buildV3ApprovalTransaction(tokenAddress, amount, this.routerAddress);
  }

  getAllowance(tokenAddress: Address, ownerAddress: Address) {
    return getV3Allowance(this.publicClient, tokenAddress, ownerAddress, this.routerAddress);
  }
}
