// ============ 链配置 ============

export const ROBINHOOD_CHAIN_ID = 4663 as const;

export const ROBINHOOD_OFFICIAL_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com/';
// Robinhood's documented write endpoint.  Transaction broadcasts go directly
// to the sequencer instead of competing with high-volume read traffic on the
// rate-limited public RPC endpoint.
export const ROBINHOOD_SEQUENCER_RPC_URL = 'https://sequencer.mainnet.chain.robinhood.com/';
export const ROBINHOOD_ARROW_RPC_URL = 'https://rpc.arrowrpc.com';
export const ROBINHOOD_ARROW_WS_URL = 'wss://ws.arrowrpc.com';
export const ROBINHOOD_EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export const ROBINHOOD_WETH_ADDRESS: `0x${string}` =
  '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

export const UNISWAP_V3_ROBINHOOD_ADDRESSES = {
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
  positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  multicall: '0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  weth: ROBINHOOD_WETH_ADDRESS,
} as const satisfies Record<string, `0x${string}`>;

// Pons launches currently use the Uniswap V3 1% tier. Keep the value explicit
// at call sites because a V3 pool is identified by tokenA/tokenB/fee.
export const PONS_V3_POOL_FEE = 10_000 as const;

export const WRAPPED_NATIVE_ADDRESSES: Readonly<Record<number, `0x${string}`>> = {
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  97: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
  [ROBINHOOD_CHAIN_ID]: ROBINHOOD_WETH_ADDRESS,
};

// WBNB 地址映射
export const WBNB_ADDRESSES: Record<number, `0x${string}`> = {
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',   // BSC Mainnet
  97: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',   // BSC Testnet
};

// Do not put Robinhood WETH in WBNB_ADDRESSES: legacy callers use that map to
// select PancakeSwap paths. New multi-chain code should use this map/helper.
export const WETH_ADDRESSES: Readonly<Record<number, `0x${string}`>> = {
  [ROBINHOOD_CHAIN_ID]: ROBINHOOD_WETH_ADDRESS,
};

// USDT 地址映射
export const USDT_ADDRESSES: Record<number, `0x${string}`> = {
  56: '0x55d398326f99059fF775485246999027B3197955',   // BSC Mainnet
  97: '0x4Be45C88db35383F713ABC1adFA816200e0B8B56',   // BSC Testnet
  66: '0x382bb369d343125bfb2117af9c149795c6c65c50',   // OKX Chain
};

// USDC 地址映射
export const USDC_ADDRESSES: Record<number, `0x${string}`> = {
  56: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',   // BSC Mainnet
  97: '0x64544969ed7EBf5f083679233325356EbE738930',   // BSC Testnet
};

// USDT 精度配置
export const USDT_DECIMALS: Record<number, number> = {
  56: 18,
  97: 18,
  66: 18,
};

// 批量转账合约地址
export const BATCH_TRANSFER_CONTRACTS: Record<number, `0x${string}`> = {
  56: '0x0000000000000000000000000000000000000000', // BSC主网（需部署）
  97: '0xa859587fb766a44198dc7f4eb92ea9a056f842fa', // BSC测试网（已部署）
  66: '0x0000000000000000000000000000000000000000', // OKX Chain（需部署）
};

// ============ 工具函数 ============

export function getWbnbAddress(chainId: number): `0x${string}` | null {
  return WBNB_ADDRESSES[chainId] || null;
}

export function getWrappedNativeAddress(chainId: number): `0x${string}` | null {
  return WRAPPED_NATIVE_ADDRESSES[chainId] || null;
}

export function getUsdtAddress(chainId: number): `0x${string}` | null {
  return USDT_ADDRESSES[chainId] || null;
}

export function getUsdcAddress(chainId: number): `0x${string}` | null {
  return USDC_ADDRESSES[chainId] || null;
}

export function getUsdtDecimals(chainId: number): number | null {
  return USDT_DECIMALS[chainId] ?? null;
}

export function getBatchTransferContract(chainId: number): `0x${string}` | null {
  const address = BATCH_TRANSFER_CONTRACTS[chainId];
  if (!address || address === '0x0000000000000000000000000000000000000000') {
    return null;
  }
  return address;
}

// ============ 正则表达式 ============

export const PRIVATE_KEY_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;
export const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

// ASTER 代币地址（仅 BSC 主网功能使用）
export const ASTER_TOKEN_ADDRESS: `0x${string}` = '0x000ae314e2a2172a039b26378814c252734f556a';
export const ASTER_DECIMALS = 18;

// ============ 默认值 ============

export const DEFAULT_DECIMALS = 18;
export const DEFAULT_GAS_RESERVE = '0.005'; // 当前链原生币（BNB / ETH）
export const DEFAULT_DEADLINE = 1200; // 20分钟
