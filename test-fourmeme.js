/**
 * FourMeme 合约分析脚本
 * 目标：找到不需要API签名，可以直接调用的买入方法
 */

import { createPublicClient, http, parseEther, formatEther, keccak256, toHex } from 'viem';
import { bsc } from 'viem/chains';

const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com')
});

// 已知的事件签名
const EVENTS = {
  TokenCreated: '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20',
  Trade: '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942',
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};

// 收集所有方法选择器及其使用情况
async function analyzeAllMethods() {
  console.log('='.repeat(60));
  console.log('Step 1: 收集所有调用 FourMeme 合约的方法');
  console.log('='.repeat(60));

  const blockNumber = await client.getBlockNumber();
  console.log('当前区块:', blockNumber.toString());

  // 获取合约的所有交易（通过 Trade 事件）
  const tradeLogs = await client.getLogs({
    address: FOURMEME_CONTRACT,
    fromBlock: blockNumber - 2000n,
    toBlock: 'latest',
    topics: [EVENTS.Trade]
  });

  console.log(`找到 ${tradeLogs.length} 个 Trade 事件\n`);

  // 统计方法使用情况
  const methodStats = new Map();

  for (const log of tradeLogs.slice(0, 100)) {
    try {
      const tx = await client.getTransaction({ hash: log.transactionHash });
      const method = tx.input.slice(0, 10);
      const inputSize = (tx.input.length - 10) / 2;
      const value = Number(tx.value) / 1e18;

      if (!methodStats.has(method)) {
        methodStats.set(method, {
          count: 0,
          minInputSize: Infinity,
          maxInputSize: 0,
          minValue: Infinity,
          maxValue: 0,
          samples: []
        });
      }

      const stats = methodStats.get(method);
      stats.count++;
      stats.minInputSize = Math.min(stats.minInputSize, inputSize);
      stats.maxInputSize = Math.max(stats.maxInputSize, inputSize);
      stats.minValue = Math.min(stats.minValue, value);
      stats.maxValue = Math.max(stats.maxValue, value);

      if (stats.samples.length < 3 && value > 0) {
        stats.samples.push(tx.hash);
      }
    } catch (e) {
      // skip
    }
  }

  console.log('方法统计结果:');
  console.log('-'.repeat(60));

  const sortedMethods = [...methodStats.entries()].sort((a, b) => b[1].count - a[1].count);

  for (const [method, stats] of sortedMethods) {
    console.log(`\n方法: ${method}`);
    console.log(`  调用次数: ${stats.count}`);
    console.log(`  Input大小: ${stats.minInputSize} - ${stats.maxInputSize} bytes`);
    console.log(`  Value范围: ${stats.minValue.toFixed(4)} - ${stats.maxValue.toFixed(4)} BNB`);
    if (stats.samples.length > 0) {
      console.log(`  示例交易: ${stats.samples[0]}`);
    }
  }

  return sortedMethods;
}

// 深入分析特定方法
async function analyzeMethod(methodSelector, txHash) {
  console.log('\n' + '='.repeat(60));
  console.log(`Step 2: 深入分析方法 ${methodSelector}`);
  console.log('='.repeat(60));

  const tx = await client.getTransaction({ hash: txHash });
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  console.log('\n交易信息:');
  console.log(`  From: ${tx.from}`);
  console.log(`  To: ${tx.to}`);
  console.log(`  Value: ${formatEther(tx.value)} BNB`);
  console.log(`  Gas Price: ${Number(tx.gasPrice) / 1e9} Gwei`);
  console.log(`  Gas Used: ${receipt.gasUsed.toString()}`);

  const input = tx.input.slice(10);
  const wordCount = input.length / 64;

  console.log(`\nInput 分析 (${wordCount} 个 32字节 words):`);

  // 逐个解析参数
  for (let i = 0; i < Math.min(wordCount, 20); i++) {
    const word = input.slice(i * 64, (i + 1) * 64);
    const value = BigInt('0x' + word);

    let interpretation = '';

    // 尝试解释
    if (word.startsWith('000000000000000000000000') && word.slice(24) !== '0000000000000000000000000000000000000000') {
      interpretation = `地址: 0x${word.slice(24)}`;
    } else if (value < 1000n) {
      interpretation = `小数值: ${value}`;
    } else if (value < BigInt(1e18)) {
      interpretation = `数值: ${value}`;
    } else if (value < BigInt(1e30)) {
      interpretation = `可能是金额: ${Number(value) / 1e18} (18 decimals)`;
    } else {
      interpretation = `大数/哈希`;
    }

    console.log(`  [${i.toString().padStart(2)}] ${interpretation}`);
  }

  // 分析事件日志
  console.log('\n事件日志:');
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === FOURMEME_CONTRACT.toLowerCase()) {
      console.log(`\n  合约事件 @ ${log.address}`);
      console.log(`    Topic[0]: ${log.topics[0]}`);

      if (log.topics[0] === EVENTS.Trade) {
        console.log('    类型: Trade 事件');
        // 解析 Trade 事件数据
        const data = log.data.slice(2);
        console.log(`    Token: 0x${data.slice(24, 64)}`);
        console.log(`    User: 0x${data.slice(64 + 24, 128)}`);
      }
    }
  }
}

// 尝试找出最简单的买入方法
async function findSimplestBuyMethod() {
  console.log('\n' + '='.repeat(60));
  console.log('Step 3: 寻找最简单的买入方法');
  console.log('='.repeat(60));

  const blockNumber = await client.getBlockNumber();

  // 获取最近的 Trade 事件
  const tradeLogs = await client.getLogs({
    address: FOURMEME_CONTRACT,
    fromBlock: blockNumber - 5000n,
    toBlock: 'latest',
    topics: [EVENTS.Trade]
  });

  console.log(`分析 ${tradeLogs.length} 个交易...\n`);

  // 找最小 input size 的买入交易（value > 0）
  let simplestTx = null;
  let minInputSize = Infinity;

  for (const log of tradeLogs) {
    try {
      const tx = await client.getTransaction({ hash: log.transactionHash });

      // 只看买入交易（发送了 BNB）
      if (tx.value > 0n) {
        const inputSize = (tx.input.length - 10) / 2;

        if (inputSize < minInputSize) {
          minInputSize = inputSize;
          simplestTx = tx;
          console.log(`发现更简单的买入: ${tx.hash}`);
          console.log(`  方法: ${tx.input.slice(0, 10)}, Input: ${inputSize} bytes, Value: ${formatEther(tx.value)} BNB`);
        }
      }
    } catch (e) {
      // skip
    }
  }

  if (simplestTx) {
    console.log('\n最简单的买入交易:');
    console.log(`  Hash: ${simplestTx.hash}`);
    console.log(`  方法: ${simplestTx.input.slice(0, 10)}`);
    console.log(`  Input size: ${minInputSize} bytes`);
    console.log(`  Value: ${formatEther(simplestTx.value)} BNB`);
    return simplestTx;
  }

  return null;
}

// 分析 TokenCreated 事件结构
async function analyzeTokenCreatedEvent() {
  console.log('\n' + '='.repeat(60));
  console.log('Step 4: 分析 TokenCreated 事件结构');
  console.log('='.repeat(60));

  const blockNumber = await client.getBlockNumber();

  const logs = await client.getLogs({
    address: FOURMEME_CONTRACT,
    fromBlock: blockNumber - 1000n,
    toBlock: 'latest',
    topics: [EVENTS.TokenCreated]
  });

  console.log(`找到 ${logs.length} 个 TokenCreated 事件\n`);

  if (logs.length > 0) {
    const log = logs[0];
    console.log('示例事件:');
    console.log(`  Block: ${log.blockNumber}`);
    console.log(`  TX: ${log.transactionHash}`);

    const data = log.data.slice(2);
    const wordCount = data.length / 64;

    console.log(`\n事件数据 (${wordCount} 个字段):`);

    // Field 0: creator
    console.log(`  [0] Creator: 0x${data.slice(24, 64)}`);
    // Field 1: token
    console.log(`  [1] Token: 0x${data.slice(64 + 24, 128)}`);

    // 其他字段
    for (let i = 2; i < Math.min(wordCount, 8); i++) {
      const word = data.slice(i * 64, (i + 1) * 64);
      const value = BigInt('0x' + word);
      console.log(`  [${i}] ${value < 1000000n ? value.toString() : '0x' + word.slice(0, 16) + '...'}`);
    }
  }
}

// 检查是否有简单的 buy 函数
async function checkForSimpleBuyFunction() {
  console.log('\n' + '='.repeat(60));
  console.log('Step 5: 检查常见的买入方法签名');
  console.log('='.repeat(60));

  // 常见的买入方法签名
  const commonBuyMethods = [
    'buy(address)',
    'buy(address,uint256)',
    'buy(address,uint256,uint256)',
    'buyToken(address)',
    'buyToken(address,uint256)',
    'buyTokens(address)',
    'buyTokens(address,uint256)',
    'swap(address,uint256)',
    'swapETHForTokens(address)',
    'swapExactETHForTokens(uint256,address)',
    'purchase(address)',
    'purchase(address,uint256)',
    'mint(address)',
    'mint(address,uint256)',
  ];

  console.log('计算方法选择器:\n');

  for (const method of commonBuyMethods) {
    const selector = keccak256(toHex(method)).slice(0, 10);
    console.log(`  ${method.padEnd(40)} => ${selector}`);
  }

  // 对比已发现的方法
  console.log('\n已发现的方法:');
  console.log('  0x519ebb10 - createAndBuy (创建+买入)');
  console.log('  0x0b3f5cf9 - 聚合器买入 (需要复杂参数)');
  console.log('  0x3e0f9c3c - ?');
  console.log('  0x2942640a - ?');
  console.log('  0x3e11741f - ?');
}

// 主函数
async function main() {
  try {
    console.log('FourMeme 合约分析');
    console.log('合约地址:', FOURMEME_CONTRACT);
    console.log('');

    // Step 1: 收集所有方法
    const methods = await analyzeAllMethods();

    // Step 2: 分析最常用的方法
    if (methods.length > 0) {
      const [topMethod, stats] = methods[0];
      if (stats.samples.length > 0) {
        await analyzeMethod(topMethod, stats.samples[0]);
      }
    }

    // Step 3: 找最简单的买入方法
    const simplestTx = await findSimplestBuyMethod();

    // Step 4: 分析 TokenCreated 事件
    await analyzeTokenCreatedEvent();

    // Step 5: 检查常见方法签名
    await checkForSimpleBuyFunction();

    console.log('\n' + '='.repeat(60));
    console.log('分析完成');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('错误:', error);
  }
}

main();
