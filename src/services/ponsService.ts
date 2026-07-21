import {
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  toHex,
  zeroAddress,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import {
  ROBINHOOD_ARROW_RPC_URL,
  ROBINHOOD_ARROW_WS_URL,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_OFFICIAL_RPC_URL,
  ROBINHOOD_WETH_ADDRESS,
  PONS_V3_POOL_FEE,
  UNISWAP_V3_ROBINHOOD_ADDRESSES,
} from '../constants';
import { robinhood } from '../viem/chains/robinhood';

export { ROBINHOOD_CHAIN_ID, ROBINHOOD_EXPLORER_URL } from '../constants';
export const ROBINHOOD_HTTP_RPCS = [
  ROBINHOOD_OFFICIAL_RPC_URL,
  ROBINHOOD_ARROW_RPC_URL,
] as const;
export const ROBINHOOD_WSS_RPCS = [ROBINHOOD_ARROW_WS_URL] as const;
export const ROBINHOOD_EXPLORER = ROBINHOOD_EXPLORER_URL;
export const ROBINHOOD_CHAIN = robinhood;

export const PONS_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' as const;
export const PONS_LOCKER = '0x736D76699C26D0d966744cAe304C000d471f7F35' as const;
export const PONS_DEFAULT_CONFIG_ID = 0n;
export const PONS_DEFAULT_DEX_ID = 0n;

export const PONS_LAUNCHPAD_ABI = [
  {
    type: 'function', name: 'launchEnabled', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'getDexConfig', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{
      name: 'config', type: 'tuple', components: [
        { name: 'name', type: 'string' },
        { name: 'factory', type: 'address' },
        { name: 'positionManager', type: 'address' },
        { name: 'swapRouter', type: 'address' },
        { name: 'poolFee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'enabled', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function', name: 'getLaunchConfig', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{
      name: 'config', type: 'tuple', components: [
        { name: 'pairToken', type: 'address' },
        { name: 'graduationThreshold', type: 'uint256' },
        { name: 'initialTick', type: 'int24' },
        { name: 'supply', type: 'uint256' },
        { name: 'maxWalletBps', type: 'uint16' },
        { name: 'maxTxBps', type: 'uint16' },
        { name: 'restrictionBlocks', type: 'uint32' },
        { name: 'reservedFee', type: 'uint24' },
        { name: 'enabled', type: 'bool' },
        { name: 'routerRequiresDeadline', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function', name: 'getLaunchedToken', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{
      name: 'launched', type: 'tuple', components: [
        { name: 'token', type: 'address' },
        { name: 'deployer', type: 'address' },
        { name: 'pairedToken', type: 'address' },
        { name: 'positionManager', type: 'address' },
        { name: 'positionId', type: 'uint256' },
        { name: 'dexId', type: 'uint256' },
        { name: 'launchConfigId', type: 'uint256' },
        { name: 'restrictionsEndBlock', type: 'uint256' },
        { name: 'supply', type: 'uint256' },
        { name: 'isToken0', type: 'bool' },
        { name: 'poolFee', type: 'uint24' },
        { name: 'exists', type: 'bool' },
        { name: 'initialBuyAmount', type: 'uint256' },
      ],
    }],
  },
  {
    type: 'function', name: 'graduationStatus', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'pairedPrincipal', type: 'uint256' },
      { name: 'threshold', type: 'uint256' },
      { name: 'graduated', type: 'bool' },
    ],
  },
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      {
        name: 'params', type: 'tuple', components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'logo', type: 'string' },
          { name: 'description', type: 'string' },
          {
            name: 'socials', type: 'tuple', components: [
              { name: 'twitter', type: 'string' },
              { name: 'telegram', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'farcaster', type: 'string' },
            ],
          },
          { name: 'feeWallet', type: 'address' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'dexId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'event', name: 'TokenLaunched',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'deployer', type: 'address', indexed: true },
      { name: 'dexFactory', type: 'address', indexed: true },
      { name: 'pairToken', type: 'address', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'dexId', type: 'uint256', indexed: false },
      { name: 'launchConfigId', type: 'uint256', indexed: false },
      { name: 'positionId', type: 'uint256', indexed: false },
      { name: 'restrictionsEndBlock', type: 'uint256', indexed: false },
      { name: 'initialBuyAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export interface PonsLaunchConfig {
  pairToken: Address;
  graduationThreshold: bigint;
  initialTick: number;
  supply: bigint;
  maxWalletBps: number;
  maxTxBps: number;
  restrictionBlocks: number;
  reservedFee: number;
  enabled: boolean;
  routerRequiresDeadline: boolean;
}

export interface PonsDexConfig {
  name: string;
  factory: Address;
  positionManager: Address;
  swapRouter: Address;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}

export interface PonsRuntimeConfig {
  launchEnabled: boolean;
  launchFee: bigint;
  launch: PonsLaunchConfig;
  dex: PonsDexConfig;
}

export interface PonsLaunchedToken {
  token: Address;
  deployer: Address;
  pairedToken: Address;
  positionManager: Address;
  positionId: bigint;
  dexId: bigint;
  launchConfigId: bigint;
  restrictionsEndBlock: bigint;
  supply: bigint;
  isToken0: boolean;
  poolFee: number;
  exists: boolean;
  initialBuyAmount: bigint;
}

export interface ValidatedPonsLaunchedToken {
  launched: PonsLaunchedToken;
  dex: PonsDexConfig;
}

export interface PonsLaunchInput {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  feeWallet: Address;
  developerBuy: bigint;
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
  salt?: `0x${string}`;
}

export interface PonsLaunchResult {
  hash: Hash;
  token: Address | null;
  receipt: TransactionReceipt;
  predictedToken: Address;
  initialBuyAmount: bigint | null;
  developerTokensReceived: bigint;
  developerBuyVerified: boolean;
  gasEstimate: bigint;
  gasLimit: bigint;
  estimatedGasCost: bigint;
}

const ERC20_TRANSFER_ABI = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
}] as const;

export function createPonsPublicClient(rpcUrl: string = ROBINHOOD_HTTP_RPCS[0]) {
  return createPublicClient({
    chain: ROBINHOOD_CHAIN,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2, retryDelay: 400 }),
  });
}

export async function readPonsRuntimeConfig(
  client: PublicClient = createPonsPublicClient(),
): Promise<PonsRuntimeConfig> {
  const [launchEnabled, launchFee, launch, dex] = await Promise.all([
    client.readContract({ address: PONS_FACTORY, abi: PONS_LAUNCHPAD_ABI, functionName: 'launchEnabled' }),
    client.readContract({ address: PONS_FACTORY, abi: PONS_LAUNCHPAD_ABI, functionName: 'launchFee' }),
    client.readContract({
      address: PONS_FACTORY,
      abi: PONS_LAUNCHPAD_ABI,
      functionName: 'getLaunchConfig',
      args: [PONS_DEFAULT_CONFIG_ID],
    }),
    client.readContract({
      address: PONS_FACTORY,
      abi: PONS_LAUNCHPAD_ABI,
      functionName: 'getDexConfig',
      args: [PONS_DEFAULT_DEX_ID],
    }),
  ]);

  return {
    launchEnabled,
    launchFee,
    launch: {
      pairToken: launch.pairToken,
      graduationThreshold: launch.graduationThreshold,
      initialTick: launch.initialTick,
      supply: launch.supply,
      maxWalletBps: launch.maxWalletBps,
      maxTxBps: launch.maxTxBps,
      restrictionBlocks: launch.restrictionBlocks,
      reservedFee: launch.reservedFee,
      enabled: launch.enabled,
      routerRequiresDeadline: launch.routerRequiresDeadline,
    },
    dex: {
      name: dex.name,
      factory: dex.factory,
      positionManager: dex.positionManager,
      swapRouter: dex.swapRouter,
      poolFee: dex.poolFee,
      tickSpacing: dex.tickSpacing,
      enabled: dex.enabled,
    },
  };
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizePonsDexConfig(dex: {
  name: string;
  factory: Address;
  positionManager: Address;
  swapRouter: Address;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}): PonsDexConfig {
  return {
    name: dex.name,
    factory: dex.factory,
    positionManager: dex.positionManager,
    swapRouter: dex.swapRouter,
    poolFee: dex.poolFee,
    tickSpacing: dex.tickSpacing,
    enabled: dex.enabled,
  };
}

/**
 * Fail closed unless a mutable Pons DEX entry still points at the official
 * Robinhood Uniswap V3 1% deployment.
 */
export function assertOfficialPonsDexConfig(dex: PonsDexConfig): void {
  if (
    !dex.enabled
    || dex.poolFee !== PONS_V3_POOL_FEE
    || !sameAddress(dex.factory, UNISWAP_V3_ROBINHOOD_ADDRESSES.factory)
    || !sameAddress(dex.swapRouter, UNISWAP_V3_ROBINHOOD_ADDRESSES.swapRouter02)
    || !sameAddress(dex.positionManager, UNISWAP_V3_ROBINHOOD_ADDRESSES.positionManager)
  ) {
    throw new Error('Pons DEX 配置不是已启用的官方 Robinhood Uniswap V3 1% 部署');
  }
}

/**
 * Read the token record and its current dexId entry in one validation path.
 * Call this again immediately before any approval or trade: the Pons owner can
 * mutate DEX entries after a token has launched.
 */
export async function readAndValidatePonsLaunchedToken(
  client: PublicClient,
  token: Address,
): Promise<ValidatedPonsLaunchedToken> {
  const rawLaunched = await client.readContract({
    address: PONS_FACTORY,
    abi: PONS_LAUNCHPAD_ABI,
    functionName: 'getLaunchedToken',
    args: [token],
  });
  const launched: PonsLaunchedToken = {
    token: rawLaunched.token,
    deployer: rawLaunched.deployer,
    pairedToken: rawLaunched.pairedToken,
    positionManager: rawLaunched.positionManager,
    positionId: rawLaunched.positionId,
    dexId: rawLaunched.dexId,
    launchConfigId: rawLaunched.launchConfigId,
    restrictionsEndBlock: rawLaunched.restrictionsEndBlock,
    supply: rawLaunched.supply,
    isToken0: rawLaunched.isToken0,
    poolFee: rawLaunched.poolFee,
    exists: rawLaunched.exists,
    initialBuyAmount: rawLaunched.initialBuyAmount,
  };
  if (!launched.exists || !sameAddress(launched.token, token)) {
    throw new Error('getLaunchedToken 未确认该代币属于当前 Pons Factory');
  }
  if (
    !sameAddress(launched.pairedToken, ROBINHOOD_WETH_ADDRESS)
    || launched.poolFee !== PONS_V3_POOL_FEE
    || !sameAddress(launched.positionManager, UNISWAP_V3_ROBINHOOD_ADDRESSES.positionManager)
  ) {
    throw new Error('Pons 代币记录不是官方 WETH / Uniswap V3 1% 基线');
  }

  const rawDex = await client.readContract({
    address: PONS_FACTORY,
    abi: PONS_LAUNCHPAD_ABI,
    functionName: 'getDexConfig',
    args: [launched.dexId],
  });
  const dex = normalizePonsDexConfig(rawDex);
  assertOfficialPonsDexConfig(dex);
  if (
    launched.poolFee !== dex.poolFee
    || !sameAddress(launched.positionManager, dex.positionManager)
  ) {
    throw new Error('Pons 代币记录与当前官方 DEX 配置不一致');
  }
  return { launched, dex };
}

export function validatePonsLaunch(input: PonsLaunchInput): void {
  if (!/^[A-Za-z0-9 ]{1,32}$/.test(input.name.trim())) {
    throw new Error('代币名称只能包含字母、数字和空格，最多 32 个字符');
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(input.symbol.trim())) {
    throw new Error('代币符号只能包含字母和数字，最多 10 个字符');
  }
  if (input.description.length > 256) throw new Error('代币描述最多 256 个字符');
  if (!input.logo.startsWith('ipfs://')) throw new Error('请先上传代币图片到 Pons IPFS');
  if (input.developerBuy < 0n) throw new Error('开发者预购金额不能为负数');
}

export function createPonsSalt(seed: string): `0x${string}` {
  return keccak256(toHex(`${seed}:${Date.now()}:${crypto.getRandomValues(new Uint32Array(1))[0]}`));
}

export async function launchPonsToken(args: {
  input: PonsLaunchInput;
  walletClient: WalletClient;
  publicClient: PublicClient;
  account: Account;
}): Promise<PonsLaunchResult> {
  validatePonsLaunch(args.input);
  // Pons owner 可以修改发射和 DEX 配置；签名前必须无条件重读链上状态，
  // 不能信任准备界面传入的缓存快照。
  const runtime = await readPonsRuntimeConfig(args.publicClient);
  if (!runtime.launchEnabled || !runtime.launch.enabled || !runtime.dex.enabled) {
    throw new Error('Pons 当前未开放发射或配置已停用');
  }
  // Owner-mutable config is revalidated immediately before the transaction.
  validatePonsLaunch(args.input);
  if (
    !sameAddress(runtime.launch.pairToken, ROBINHOOD_WETH_ADDRESS)
  ) {
    throw new Error('Pons 当前链上配置不是官方 Robinhood Uniswap V3 1% 池，已拒绝发射');
  }
  assertOfficialPonsDexConfig(runtime.dex);

  const salt = args.input.salt ?? createPonsSalt(`${args.account.address}:${args.input.symbol}`);
  const launchArgs = [
    {
      name: args.input.name.trim(),
      symbol: args.input.symbol.trim().toUpperCase(),
      logo: args.input.logo.trim(),
      description: args.input.description.trim(),
      socials: {
        twitter: args.input.twitter?.trim() ?? '',
        telegram: args.input.telegram?.trim() ?? '',
        discord: args.input.discord?.trim() ?? '',
        website: args.input.website?.trim() ?? '',
        farcaster: args.input.farcaster?.trim() ?? '',
      },
      feeWallet: args.input.feeWallet,
    },
    PONS_DEFAULT_CONFIG_ID,
    PONS_DEFAULT_DEX_ID,
    salt,
  ] as const;
  const value = runtime.launchFee + args.input.developerBuy;
  const contractRequest = {
    account: args.account,
    chain: ROBINHOOD_CHAIN,
    address: PONS_FACTORY,
    abi: PONS_LAUNCHPAD_ABI,
    functionName: 'launchToken',
    args: launchArgs,
    value,
  } as const;

  const balance = await args.publicClient.getBalance({ address: args.account.address });
  if (balance < value) {
    throw new Error('主钱包 ETH 余额不足以支付 Pons 创建费和开发者预购');
  }

  // Simulate the exact calldata, salt and msg.value that will be signed. This
  // preserves unlimited developer buys while still rejecting real reverts.
  const simulation = await args.publicClient.simulateContract(contractRequest);
  const predictedToken = simulation.result;
  const gasEstimate = await args.publicClient.estimateContractGas(contractRequest);
  const gasLimit = gasEstimate + (gasEstimate / 5n);
  // Robinhood Chain uses EIP-1559 transactions. Pin the exact fee caps used
  // for signing so the preflight balance budget cannot be lower than the
  // transaction's eventual upfront gas requirement.
  const fees = await args.publicClient.estimateFeesPerGas<typeof ROBINHOOD_CHAIN, 'eip1559'>({
    chain: ROBINHOOD_CHAIN,
    type: 'eip1559',
  });
  const estimatedGasCost = gasLimit * fees.maxFeePerGas;
  if (balance < value + estimatedGasCost) {
    throw new Error('主钱包 ETH 余额不足以支付 Pons 创建费、开发者预购和预计 Gas');
  }

  const hash = await args.walletClient.writeContract({
    ...contractRequest,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  const receipt = await args.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Pons 发射交易失败: ${hash}`);

  let token: Address | null = null;
  let initialBuyAmount: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PONS_FACTORY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: PONS_LAUNCHPAD_ABI,
        eventName: 'TokenLaunched',
        data: log.data,
        topics: log.topics,
      });
      token = decoded.args.token;
      initialBuyAmount = decoded.args.initialBuyAmount;
      break;
    } catch {
      // Ignore unrelated factory logs.
    }
  }

  let developerTokensReceived = 0n;
  const developerBuyRecipient = sameAddress(args.input.feeWallet, zeroAddress)
    ? args.account.address
    : args.input.feeWallet;
  if (token) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== token.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: ERC20_TRANSFER_ABI,
          eventName: 'Transfer',
          data: log.data,
          topics: log.topics,
        });
        if (sameAddress(decoded.args.to, developerBuyRecipient)) {
          developerTokensReceived += decoded.args.value;
        }
      } catch {
        // Ignore Approval and other token logs.
      }
    }
  }

  const launchIdentityVerified = !!token && sameAddress(token, predictedToken);
  const developerBuyVerified = args.input.developerBuy === 0n
    ? launchIdentityVerified && initialBuyAmount === 0n
    : (
      launchIdentityVerified
      && initialBuyAmount === args.input.developerBuy
      && developerTokensReceived > 0n
    );

  return {
    hash,
    token,
    receipt,
    predictedToken,
    initialBuyAmount,
    developerTokensReceived,
    developerBuyVerified,
    gasEstimate,
    gasLimit,
    estimatedGasCost,
  };
}

export async function uploadPonsImage(file: File): Promise<string> {
  if (file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('图片必须小于 5 MB');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');
  }
  const form = new FormData();
  form.append('image', file);
  const headers = new Headers();
  const token = localStorage.getItem('amm_token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch('/api/pons/image', { method: 'POST', headers, body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.uri !== 'string' || !data.uri.startsWith('ipfs://')) {
    throw new Error(data.error || 'Pons 图片上传失败');
  }
  return data.uri;
}

export async function requestPonsVerification(token: Address): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const authToken = localStorage.getItem('amm_token');
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  const response = await fetch('/api/pons/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Pons 代币验证请求失败');
  }
}
