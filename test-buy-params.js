/**
 * FourMeme 直接买入方法分析 - 深入研究参数含义
 */

import { createPublicClient, http, formatEther, formatUnits, parseEther } from 'viem';
import { bsc } from 'viem/chains';

const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com')
});

async function analyzeMultipleBuys() {
  console.log('='.repeat(70));
  console.log('分析多个 0x87f27655 买入交易，理解参数含义');
  console.log('='.repeat(70));

  const blockNumber = await client.getBlockNumber();

  // 获取 Trade 事件
  const tradeLogs = await client.getLogs({
    address: FOURMEME_CONTRACT,
    fromBlock: blockNumber - 20000n,
    toBlock: 'latest',
    topics: ['0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942']
  });

  console.log(`找到 ${tradeLogs.length} 个 Trade 事件，筛选 0x87f27655 方法...\n`);

  const results = [];
  let count = 0;

  for (const log of tradeLogs) {
    if (count >= 10) break;

    try {
      const tx = await client.getTransaction({ hash: log.transactionHash });

      if (tx.input.startsWith('0x87f27655') && tx.value > 0n) {
        count++;
        const receipt = await client.getTransactionReceipt({ hash: tx.hash });

        // 解析参数
        const params = tx.input.slice(10);
        const tokenAddress = '0x' + params.slice(24, 64);
        const param1 = BigInt('0x' + params.slice(64, 128));
        const param2 = BigInt('0x' + params.slice(128, 192));

        // 找到收到的代币数量
        const receivedLog = receipt.logs.find(l =>
          l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
          ('0x' + l.topics[2].slice(26)).toLowerCase() === tx.from.toLowerCase()
        );

        const tokensReceived = receivedLog ? BigInt(receivedLog.data) : 0n;

        results.push({
          hash: tx.hash,
          bnbSpent: tx.value,
          tokenAddress,
          param1,
          param2,
          tokensReceived,
          status: receipt.status
        });
      }
    } catch (e) {
      // skip
    }
  }

  console.log('分析结果:\n');
  console.log('| 交易 | BNB 花费 | 参数1 | 参数2 | 收到代币 | 状态 |');
  console.log('|------|----------|-------|-------|----------|------|');

  for (const r of results) {
    const bnb = formatEther(r.bnbSpent);
    const tokens = r.tokensReceived > 0n ? (Number(r.tokensReceived) / 1e18).toFixed(2) : '0';
    console.log(`| ${r.hash.slice(0, 10)}... | ${bnb} | ${r.param1} | ${r.param2} | ${tokens} | ${r.status} |`);
  }

  // 分析参数模式
  console.log('\n\n【参数分析】');
  console.log('\n参数1 分析:');
  for (const r of results) {
    const ratio = r.tokensReceived > 0n && r.param1 > 0n
      ? Number(r.tokensReceived) / Number(r.param1)
      : 0;
    console.log(`  param1=${r.param1}, received=${r.tokensReceived}, ratio=${ratio.toFixed(4)}`);
  }

  console.log('\n参数2 值统计:');
  const param2Values = new Map();
  for (const r of results) {
    const key = r.param2.toString();
    param2Values.set(key, (param2Values.get(key) || 0) + 1);
  }
  for (const [val, cnt] of param2Values) {
    console.log(`  ${val}: ${cnt} 次`);
  }

  return results;
}

async function tryFindMethodABI() {
  console.log('\n' + '='.repeat(70));
  console.log('尝试从交易数据反推方法 ABI');
  console.log('='.repeat(70));

  // 获取一个示例交易
  const txHash = '0x0e3d36ac07f30332dee2e73df7bab99cddbf13b7f8a508f0bdfaea21b917eaae';
  const tx = await client.getTransaction({ hash: txHash });
  const params = tx.input.slice(10);

  console.log('\n原始参数:');
  console.log('  param0 (64 hex chars):', '0x' + params.slice(0, 64));
  console.log('  param1 (64 hex chars):', '0x' + params.slice(64, 128));
  console.log('  param2 (64 hex chars):', '0x' + params.slice(128, 192));

  // 解析
  const param0 = '0x' + params.slice(24, 64); // address
  const param1 = BigInt('0x' + params.slice(64, 128));
  const param2 = BigInt('0x' + params.slice(128, 192));

  console.log('\n解析结果:');
  console.log('  param0 (address):', param0);
  console.log('  param1 (uint256):', param1.toString());
  console.log('  param1 解释: 这个值 =', Number(param1) / 1e18, '(如果是18位小数)');
  console.log('  param2 (uint256):', param2.toString());

  // 交易花费
  console.log('\n交易花费:', formatEther(tx.value), 'BNB');

  // 如果 param1 是 minAmountOut，它应该小于实际收到的代币
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const receivedLog = receipt.logs.find(l =>
    l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
    ('0x' + l.topics[2].slice(26)).toLowerCase() === tx.from.toLowerCase()
  );

  if (receivedLog) {
    const received = BigInt(receivedLog.data);
    console.log('\n实际收到代币:', received.toString());
    console.log('实际收到 (18 decimals):', Number(received) / 1e18);

    if (param1 > 0n && received >= param1) {
      console.log('\n✓ param1 可能是 minAmountOut (最小输出量)');
      console.log('  received >= param1:', received >= param1);
    } else if (param1 === 0n) {
      console.log('\n✓ param1 = 0, 说明不设置最小输出限制');
    }
  }

  console.log('\n【推测的方法签名】');
  console.log('  buyToken(address token, uint256 minAmountOut, uint256 flags)');
  console.log('  或');
  console.log('  buy(address token, uint256 minAmountOut, uint256 referrer)');
}

async function buildBuyCalldata(tokenAddress, minAmountOut = 0n, flags = 0n) {
  console.log('\n' + '='.repeat(70));
  console.log('构建买入交易 Calldata');
  console.log('='.repeat(70));

  const methodSelector = '0x87f27655';

  // 编码参数
  const encodedToken = tokenAddress.slice(2).toLowerCase().padStart(64, '0');
  const encodedMinOut = minAmountOut.toString(16).padStart(64, '0');
  const encodedFlags = flags.toString(16).padStart(64, '0');

  const calldata = methodSelector + encodedToken + encodedMinOut + encodedFlags;

  console.log('\n参数:');
  console.log('  代币地址:', tokenAddress);
  console.log('  最小输出:', minAmountOut.toString());
  console.log('  Flags:', flags.toString());

  console.log('\n编码后的 Calldata:');
  console.log(calldata);

  console.log('\n完整交易对象:');
  console.log(JSON.stringify({
    to: FOURMEME_CONTRACT,
    data: calldata,
    value: '买入金额 (wei)',
    gasLimit: '200000',
    gasPrice: '3000000000' // 3 Gwei
  }, null, 2));

  return calldata;
}

async function main() {
  try {
    await analyzeMultipleBuys();
    await tryFindMethodABI();
    await buildBuyCalldata('0xb2b9cecd8e2e5a2bbc11c88c4227926bcf5d4444', 0n, 0n);

    console.log('\n' + '='.repeat(70));
    console.log('结论');
    console.log('='.repeat(70));

    console.log(`
【FourMeme 直接买入方法】

方法选择器: 0x87f27655

参数:
  1. token (address) - 要买入的代币地址
  2. minAmountOut (uint256) - 最小输出量，设为 0 表示不限制
  3. flags (uint256) - 标志位，通常设为 0

调用方式:
  to: ${FOURMEME_CONTRACT}
  value: 买入的 BNB 数量 (wei)
  data: 0x87f27655 + 编码后的参数

示例 (买入 0.01 BNB):
  to: ${FOURMEME_CONTRACT}
  value: 10000000000000000 (0.01 BNB)
  data: 0x87f27655 + token地址(32bytes) + 0(32bytes) + 0(32bytes)
`);

  } catch (error) {
    console.error('错误:', error);
  }
}

main();
