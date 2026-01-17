const { createPublicClient, http, keccak256, encodePacked, getAddress, formatUnits } = require('viem');
const { bsc } = require('viem/chains');

// 代币地址
const TOKEN_ADDRESS = '0x06f840f1a43b325efa0d3d16b855bb5ce4d14444';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

// 多个 DEX 的 Factory 配置
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

const pairAbi = [
  {
    inputs: [],
    name: 'getReserves',
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'token0',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'token1',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  }
];

// 计算池子地址
function computePairAddress(factoryAddr, tokenA, tokenB, initCodeHash) {
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

async function main() {
  const client = createPublicClient({
    chain: bsc,
    transport: http('https://bsc-dataseed.binance.org')
  });

  console.log('='.repeat(60));
  console.log('代币地址:', TOKEN_ADDRESS);
  console.log('WBNB 地址:', WBNB_ADDRESS);
  console.log('='.repeat(60));

  let totalBnb = 0;
  const foundPools = [];

  for (const dex of DEX_CONFIGS) {
    const pairAddress = computePairAddress(dex.factory, TOKEN_ADDRESS, WBNB_ADDRESS, dex.initCodeHash);
    console.log(`\n[${dex.name}]`);
    console.log(`  池子地址: ${pairAddress}`);

    try {
      const reserves = await client.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: 'getReserves'
      });

      const token0 = await client.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: 'token0'
      });

      console.log(`  token0: ${token0}`);
      console.log(`  reserve0: ${reserves[0].toString()}`);
      console.log(`  reserve1: ${reserves[1].toString()}`);

      // 确定哪个是 WBNB
      const isToken0Wbnb = token0.toLowerCase() === WBNB_ADDRESS.toLowerCase();
      const wbnbReserve = isToken0Wbnb ? reserves[0] : reserves[1];
      const tokenReserve = isToken0Wbnb ? reserves[1] : reserves[0];

      const wbnbAmount = Number(formatUnits(wbnbReserve, 18));
      const tokenAmount = Number(formatUnits(tokenReserve, 18));

      console.log(`  WBNB 数量: ${wbnbAmount}`);
      console.log(`  代币数量: ${tokenAmount}`);

      if (wbnbAmount > 0) {
        totalBnb += wbnbAmount;
        foundPools.push({
          dex: dex.name,
          pairAddress,
          wbnbAmount,
          tokenAmount
        });
      }
    } catch (e) {
      console.log(`  无效池子或无流动性`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('找到的有效池子:');
  for (const pool of foundPools) {
    console.log(`  [${pool.dex}] ${pool.pairAddress}`);
    console.log(`    WBNB: ${pool.wbnbAmount.toFixed(4)}`);
  }
  console.log('='.repeat(60));
  console.log(`总 BNB 数量: ${totalBnb.toFixed(4)}`);
  console.log('='.repeat(60));
}

main().catch(console.error);
