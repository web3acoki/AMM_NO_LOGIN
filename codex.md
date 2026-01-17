# AMM Bot 开发笔记 (Codex)

## 项目概述

AMM Bot 是一个基于 Vue 3 + TypeScript 的 DeFi 市值管理工具，主要用于 BSC 链上的代币交易和流动性管理。

---

## 最近更新记录

### 2026-01-17 更新

#### 1. RPC 节点选择优化

**文件**: `src/components/market/LiquidityPoolQuery.vue`

新增 `formatRpcUrl()` 函数，在下拉框中显示节点 URL 的主机名：

```typescript
function formatRpcUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
}
```

下拉框显示格式：`{{ opt.name }} ({{ formatRpcUrl(opt.url) }})`

---

#### 2. 价格显示优化 - 避免科学计数法

**文件**: `src/components/market/LiquidityPoolQuery.vue`

新增 `formatPriceFull()` 函数，确保显示完整小数位：

```typescript
function formatPriceFull(price: number): string {
  if (price === 0) return '0';

  // 转换为字符串，避免科学计数法
  const str = price.toFixed(20);

  // 去除末尾多余的0，但保留至少小数点后的数字
  const trimmed = str.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

  return trimmed;
}
```

---

#### 3. 市值显示功能 (池子 BNB 数量)

**重要概念**: 在 DeFi 中，"市值"通常指池子中的 BNB 数量（单边流动性），而非传统金融中的 `价格 × 总供应量`。

**文件**: `src/components/market/LiquidityPoolQuery.vue`

##### 多 DEX 支持

添加多个 DEX 的 Factory 配置，用于查找有效的流动性池：

```typescript
const DEX_CONFIGS = [
  {
    name: 'PancakeSwap V2',
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    initCodeHash: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5'
  },
  {
    name: 'PancakeSwap V2 (alt)',
    factory: '0xcA143Ce0Fe65960E6Aa4D42C8D3cE161c2B6604f',
    initCodeHash: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5'
  },
  {
    name: 'BiSwap',
    factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
    initCodeHash: '0xfea293c909d87cd4153593f077b76bb7e94340200f4ee84211ae8e4f9bd7ffdf'
  },
  {
    name: 'ApeSwap',
    factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
    initCodeHash: '0xf4ccce374816856d11f00e4069e7cada164065686fbef53c6167a63ec2fd8c5b'
  },
  {
    name: 'BabySwap',
    factory: '0x86407bEa2078ea5f5EB5A52B2caA963bC1F889Da',
    initCodeHash: '0x48c8bec5512d397a5d512fbb7d83d515e7b6d91e9838730e97ab59429f581697'
  },
  {
    name: 'MDEX',
    factory: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
    initCodeHash: '0x0d994d996174b05cfc7bed897dc1b20b4c458fc8d64fe98bc78b3c64a6b4d093'
  },
];
```

##### CREATE2 地址计算

使用 CREATE2 算法计算池子地址，避免调用 Factory 合约的 `getPair` 方法（某些 RPC 节点可能不支持）：

```typescript
function computePairAddress(factoryAddr: string, tokenA: string, tokenB: string, initCodeHash: string): string {
  const factory = getAddress(factoryAddr);
  const addrA = getAddress(tokenA);
  const addrB = getAddress(tokenB);

  const [token0, token1] = addrA.toLowerCase() < addrB.toLowerCase()
    ? [addrA, addrB]
    : [addrB, addrA];

  const salt = keccak256(encodePacked(['address', 'address'], [token0, token1]));

  const addr = keccak256(
    encodePacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factory, salt, initCodeHash]
    )
  );

  return getAddress('0x' + addr.slice(-40));
}
```

##### 查找有效池子

遍历所有 DEX 配置，找到第一个有流动性的池子：

```typescript
async function findValidPairAddress(tokenAddress: string, quoteAddress: string, client: any): Promise<{
  pairAddress: string;
  dexName: string;
  reserve0: bigint;
  reserve1: bigint;
  token0: string;
} | null> {
  for (const dex of DEX_CONFIGS) {
    const pairAddress = computePairAddress(dex.factory, tokenAddress, quoteAddress, dex.initCodeHash);

    try {
      const reserves = await client.readContract({
        address: pairAddress as `0x${string}`,
        abi: pairAbi,
        functionName: 'getReserves'
      });

      if (reserves[0] > 0n || reserves[1] > 0n) {
        const token0 = await client.readContract({
          address: pairAddress as `0x${string}`,
          abi: pairAbi,
          functionName: 'token0'
        });

        return {
          pairAddress,
          dexName: dex.name,
          reserve0: reserves[0],
          reserve1: reserves[1],
          token0: token0 as string
        };
      }
    } catch (e) {
      // 继续尝试下一个 DEX
    }
  }

  return null;
}
```

##### 市值计算

市值 = 池子中的 BNB 数量（单边）：

```typescript
// 确定哪个是报价代币 (WBNB)
const isToken0Quote = poolInfo.token0.toLowerCase() === quoteAddress.toLowerCase();
const quoteReserve = isToken0Quote ? poolInfo.reserve0 : poolInfo.reserve1;

// 市值 = 池子 BNB 数量
const quoteAmount = Number(quoteReserve) / (10 ** quoteDecimals);
marketCap.value = quoteAmount;
```

##### 市值格式化

```typescript
function formatMarketCap(value: number): string {
  if (value >= 1000000) {
    return (value / 1000000).toFixed(2) + 'M';
  } else if (value >= 1000) {
    return (value / 1000).toFixed(2) + 'K';
  } else {
    return value.toFixed(4);
  }
}
```

---

#### 4. 停止按钮修复

**文件**: `src/components/market/LiquidityPoolQuery.vue`

添加 `handleStopUpdate()` 函数，仅在自动刷新时显示停止按钮：

```typescript
function handleStopUpdate() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  isUpdating.value = false;
}
```

---

## 技术要点

### viem 库使用

项目使用 `viem` 库进行链上交互：

```typescript
import { createPublicClient, http, keccak256, encodePacked, getAddress, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
```

### BigInt 精度处理

处理大数时注意精度问题：

```typescript
// 错误写法 - 会丢失精度
BigInt(10 ** 18)

// 正确写法
10n ** BigInt(decimals)
```

### 地址规范化

在进行地址比较或计算时，必须先规范化：

```typescript
import { getAddress } from 'viem';

// 规范化地址（转为 checksum 格式）
const normalizedAddress = getAddress(rawAddress);
```

---

## 文件结构

```
src/
├── components/
│   ├── market/
│   │   ├── LiquidityPoolQuery.vue  # 资金池查询（含价格、市值显示）
│   │   ├── NetworkSelector.vue      # 网络/RPC 选择
│   │   ├── WalletImportPanel.vue    # 钱包导入
│   │   ├── WalletTable.vue          # 钱包列表
│   │   ├── TaskList.vue             # 任务列表
│   │   ├── TaskConfigForm.vue       # 任务配置表单
│   │   └── DexPanel.vue             # DEX 面板
│   └── panels/
│       └── MarketPanel.vue          # 市值管理主面板
├── stores/
│   ├── chainStore.ts                # 链配置存储
│   ├── walletStore.ts               # 钱包存储
│   └── taskStore.ts                 # 任务存储
├── viem/
│   └── abis/
│       ├── erc20.ts                 # ERC20 ABI
│       ├── factory.ts               # Factory ABI
│       └── pair.ts                  # Pair ABI
└── utils/
    └── priceCalculator.ts           # 价格计算工具
```

---

## 常见问题

### Q: 为什么市值和 ave.ai 显示不一致？

A: 确保使用正确的 DEX。不同 DEX 的池子地址不同，流动性也不同。本项目会遍历多个 DEX 找到第一个有流动性的池子。

### Q: 价格显示为科学计数法怎么办？

A: 使用 `formatPriceFull()` 函数格式化价格，避免 JavaScript 的 `Number.toString()` 自动转换为科学计数法。

### Q: 如何添加新的 DEX 支持？

A: 在 `DEX_CONFIGS` 数组中添加新的配置项，需要提供：
- `name`: DEX 名称
- `factory`: Factory 合约地址
- `initCodeHash`: 用于 CREATE2 计算的 init code hash

---

## 调试工具

### debug-pool.js

用于调试池子地址计算的独立脚本，可以测试多个 DEX 的池子查找：

```bash
node debug-pool.js
```
