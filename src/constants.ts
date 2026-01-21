// ============ 链配置 ============

// WBNB 地址映射
export const WBNB_ADDRESSES: Record<number, `0x${string}`> = {
  56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',   // BSC Mainnet
  97: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',   // BSC Testnet
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

export function getUsdtAddress(chainId: number): `0x${string}` | null {
  return USDT_ADDRESSES[chainId] || null;
}

export function getUsdcAddress(chainId: number): `0x${string}` | null {
  return USDC_ADDRESSES[chainId] || null;
}

export function getUsdtDecimals(chainId: number): number {
  return USDT_DECIMALS[chainId] || 18;
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

// ============ 默认值 ============

export const DEFAULT_DECIMALS = 18;
export const DEFAULT_GAS_RESERVE = '0.005'; // BNB
export const DEFAULT_DEADLINE = 1200; // 20分钟
