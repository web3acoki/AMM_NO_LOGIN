/**
 * 分析 FourMeme 最简单的买入方法
 * 方法选择器: 0x98d1091d
 * Input 大小: 96 bytes (3个参数)
 */

import { createPublicClient, http, formatEther, keccak256, toHex } from 'viem';
import { bsc } from 'viem/chains';

const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com')
});

async function analyzeSimpleBuy() {
  console.log('='.repeat(60));
  console.log('分析简单买入方法 0x98d1091d');
  console.log('='.repeat(60));

  // 获取这个交易
  const txHash = '0x3ca2e2d5b765f3ee1e3bd686ba21816b2b1c2c16b508369414ea7969c288c179';

  const tx = await client.getTransaction({ hash: txHash });
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  console.log('\n交易信息:');
  console.log('  Hash:', tx.hash);
  console.log('  From:', tx.from);
  console.log('  To:', tx.to);
  console.log('  Value:', formatEther(tx.value), 'BNB');
  console.log('  Gas Price:', Number(tx.gasPrice) / 1e9, 'Gwei');
  console.log('  Status:', receipt.status);

  // 解析 input
  const methodSelector = tx.input.slice(0, 10);
  const params = tx.input.slice(10);

  console.log('\n方法选择器:', methodSelector);
  console.log('参数数据长度:', params.length / 2, 'bytes');
  console.log('参数个数:', params.length / 64, '个 (每个32字节)');

  console.log('\n参数解析:');
  for (let i = 0; i < params.length / 64; i++) {
    const word = params.slice(i * 64, (i + 1) * 64);
    const value = BigInt('0x' + word);

    if (word.startsWith('000000000000000000000000') && word.slice(24) !== '0000000000000000000000000000000000000000') {
      console.log(`  参数 ${i}: 地址 0x${word.slice(24)}`);
    } else if (value < BigInt(1e15)) {
      console.log(`  参数 ${i}: 数值 ${value}`);
    } else {
      console.log(`  参数 ${i}: 大数 ${value} (可能是金额: ${Number(value) / 1e18})`);
    }
  }

  // 分析事件日志
  console.log('\n事件日志:');
  for (const log of receipt.logs) {
    console.log(`\n  地址: ${log.address}`);
    console.log(`  Topic[0]: ${log.topics[0]?.slice(0, 20)}...`);

    // Transfer 事件
    if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
      const from = '0x' + log.topics[1].slice(26);
      const to = '0x' + log.topics[2].slice(26);
      const amount = BigInt(log.data);
      console.log(`  类型: Transfer`);
      console.log(`    From: ${from}`);
      console.log(`    To: ${to}`);
      console.log(`    Amount: ${amount}`);
    }
  }

  // 找到用户收到的代币
  const receivedToken = receipt.logs.find(log =>
    log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
    ('0x' + log.topics[2].slice(26)).toLowerCase() === tx.from.toLowerCase()
  );

  if (receivedToken) {
    console.log('\n用户收到的代币:');
    console.log('  代币地址:', receivedToken.address);
    console.log('  数量:', BigInt(receivedToken.data).toString());
  }
}

async function findMoreSimpleBuys() {
  console.log('\n' + '='.repeat(60));
  console.log('查找更多使用简单方法的交易');
  console.log('='.repeat(60));

  const blockNumber = await client.getBlockNumber();

  // 获取最近的 Trade 事件
  const tradeLogs = await client.getLogs({
    address: FOURMEME_CONTRACT,
    fromBlock: blockNumber - 10000n,
    toBlock: 'latest',
    topics: ['0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942']
  });

  console.log(`找到 ${tradeLogs.length} 个 Trade 事件\n`);

  // 收集简单方法的交易
  const simpleMethods = new Map();
  let count = 0;

  for (const log of tradeLogs) {
    if (count >= 200) break;
    count++;

    try {
      const tx = await client.getTransaction({ hash: log.transactionHash });
      const inputSize = (tx.input.length - 10) / 2;

      // 只看小于 200 bytes 的简单方法
      if (inputSize <= 200 && tx.value > 0n) {
        const method = tx.input.slice(0, 10);

        if (!simpleMethods.has(method)) {
          simpleMethods.set(method, []);
        }
        simpleMethods.get(method).push({
          hash: tx.hash,
          inputSize,
          value: formatEther(tx.value),
          to: tx.to
        });
      }
    } catch (e) {
      // skip
    }
  }

  console.log('简单买入方法 (input <= 200 bytes):');
  for (const [method, txs] of simpleMethods) {
    console.log(`\n方法: ${method}`);
    console.log(`  交易数量: ${txs.length}`);
    console.log(`  Input大小: ${txs[0].inputSize} bytes`);
    console.log(`  目标合约: ${txs[0].to}`);
    console.log(`  示例交易:`);
    for (const tx of txs.slice(0, 3)) {
      console.log(`    ${tx.hash} (${tx.value} BNB)`);
    }
  }
}

async function tryDecodeMethodSignature() {
  console.log('\n' + '='.repeat(60));
  console.log('尝试猜测方法签名');
  console.log('='.repeat(60));

  // 常见的简单买入方法签名 (3个参数)
  const possibleSignatures = [
    'buy(address,uint256,uint256)',
    'buyTokens(address,uint256,uint256)',
    'swap(address,uint256,uint256)',
    'purchase(address,uint256,uint256)',
    'buyToken(address,uint256,address)',
    'buy(address,address,uint256)',
    'trade(address,uint256,uint256)',
    'execute(address,uint256,uint256)',
    'buyExactIn(address,uint256,uint256)',
    'swapExactIn(address,uint256,uint256)',
  ];

  console.log('\n计算可能的方法选择器:');
  for (const sig of possibleSignatures) {
    const selector = keccak256(toHex(sig)).slice(0, 10);
    const match = selector === '0x98d1091d' ? ' ✓ 匹配!' : '';
    console.log(`  ${sig.padEnd(40)} => ${selector}${match}`);
  }

  // 目标选择器
  console.log('\n目标选择器: 0x98d1091d');
}

async function analyzeContractDirectly() {
  console.log('\n' + '='.repeat(60));
  console.log('检查交易的目标合约');
  console.log('='.repeat(60));

  const txHash = '0x3ca2e2d5b765f3ee1e3bd686ba21816b2b1c2c16b508369414ea7969c288c179';
  const tx = await client.getTransaction({ hash: txHash });

  console.log('\n交易目标合约:', tx.to);
  console.log('FourMeme 主合约:', FOURMEME_CONTRACT);
  console.log('是否直接调用主合约:', tx.to.toLowerCase() === FOURMEME_CONTRACT.toLowerCase() ? '是' : '否');

  if (tx.to.toLowerCase() !== FOURMEME_CONTRACT.toLowerCase()) {
    console.log('\n这个交易调用的是另一个合约，可能是:');
    console.log('  - 聚合器/路由器');
    console.log('  - 另一个入口合约');
    console.log('  - Proxy 合约');

    // 检查这个合约是否也接收过其他简单买入
    console.log('\n让我查看这个合约的其他交易...');
  }
}

async function main() {
  try {
    await analyzeSimpleBuy();
    await analyzeContractDirectly();
    await findMoreSimpleBuys();
    await tryDecodeMethodSignature();

    console.log('\n' + '='.repeat(60));
    console.log('分析完成');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('错误:', error);
  }
}

main();
