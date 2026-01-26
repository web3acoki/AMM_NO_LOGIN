/**
 * FourMeme 直接买入方法 - 简化版分析
 * 基于已知的成功交易分析参数
 */

import { createPublicClient, http, formatEther, parseEther } from 'viem';
import { bsc } from 'viem/chains';

const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com')
});

// 已知的成功买入交易
const KNOWN_BUY_TXS = [
  '0x0e3d36ac07f30332dee2e73df7bab99cddbf13b7f8a508f0bdfaea21b917eaae',
  '0x8c8889868da270c14c52b34bf0d6be168a6ac8936c7f607f24b00d82ba85bc47',
];

async function analyzeKnownTxs() {
  console.log('='.repeat(70));
  console.log('分析已知的 0x87f27655 买入交易');
  console.log('='.repeat(70));

  for (const txHash of KNOWN_BUY_TXS) {
    console.log('\n' + '-'.repeat(70));
    console.log('交易:', txHash);

    try {
      const tx = await client.getTransaction({ hash: txHash });
      const receipt = await client.getTransactionReceipt({ hash: txHash });

      console.log('\n基本信息:');
      console.log('  From:', tx.from);
      console.log('  To:', tx.to);
      console.log('  Value:', formatEther(tx.value), 'BNB');
      console.log('  Status:', receipt.status);

      // 解析参数
      const params = tx.input.slice(10);
      const tokenAddress = '0x' + params.slice(24, 64);
      const param1 = BigInt('0x' + params.slice(64, 128));
      const param2 = BigInt('0x' + params.slice(128, 192));

      console.log('\n参数解析:');
      console.log('  参数0 (代币地址):', tokenAddress);
      console.log('  参数1 (原始值):', param1.toString());
      console.log('  参数1 (18 decimals):', Number(param1) / 1e18);
      console.log('  参数2:', param2.toString());

      // 找收到的代币
      const receivedLog = receipt.logs.find(l =>
        l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
        ('0x' + l.topics[2].slice(26)).toLowerCase() === tx.from.toLowerCase()
      );

      if (receivedLog) {
        const received = BigInt(receivedLog.data);
        console.log('\n收到代币:');
        console.log('  代币地址:', receivedLog.address);
        console.log('  原始数量:', received.toString());
        console.log('  数量 (18 decimals):', Number(received) / 1e18);

        // 分析 param1 含义
        if (param1 > 0n) {
          console.log('\n参数1 分析:');
          console.log('  param1 <= received ?', param1 <= received);
          if (param1 <= received) {
            console.log('  ✓ param1 是 minAmountOut (最小输出量)');
          }
        } else {
          console.log('\n参数1 = 0，表示不设置最小输出限制');
        }
      }
    } catch (e) {
      console.log('  错误:', e.message);
    }
  }
}

function buildBuyCalldata(tokenAddress, minAmountOut = 0n, flags = 0n) {
  const methodSelector = '0x87f27655';

  // 编码参数
  const encodedToken = tokenAddress.slice(2).toLowerCase().padStart(64, '0');
  const encodedMinOut = minAmountOut.toString(16).padStart(64, '0');
  const encodedFlags = flags.toString(16).padStart(64, '0');

  return methodSelector + encodedToken + encodedMinOut + encodedFlags;
}

async function main() {
  try {
    await analyzeKnownTxs();

    console.log('\n' + '='.repeat(70));
    console.log('FourMeme 直接买入方法总结');
    console.log('='.repeat(70));

    console.log(`
【方法信息】
  选择器: 0x87f27655
  目标合约: ${FOURMEME_CONTRACT}

【参数说明】
  参数0 (address): 代币地址 - 要购买的 FourMeme 代币
  参数1 (uint256): 最小输出量 - 期望收到的最少代币数量
                   设为 0 表示不限制 (接受任何数量)
  参数2 (uint256): 标志位 - 通常设为 0

【调用示例】
  假设要用 0.01 BNB 购买代币 0xb2b9cecd8e2e5a2bbc11c88c4227926bcf5d4444
`);

    const exampleToken = '0xb2b9cecd8e2e5a2bbc11c88c4227926bcf5d4444';
    const exampleCalldata = buildBuyCalldata(exampleToken, 0n, 0n);

    console.log('  交易对象:');
    console.log(JSON.stringify({
      to: FOURMEME_CONTRACT,
      value: parseEther('0.01').toString(),
      data: exampleCalldata,
      gasLimit: 200000
    }, null, 4));

    console.log(`
【完整的 calldata 编码方法】
  1. 方法选择器: 0x87f27655
  2. 代币地址: 左填充到 32 字节
  3. minAmountOut: 左填充到 32 字节 (可设为 0)
  4. flags: 左填充到 32 字节 (设为 0)

  calldata = 0x87f27655 + tokenAddress(64 hex) + minOut(64 hex) + flags(64 hex)

【重要提示】
  - 这个方法只适用于 FourMeme 内盘代币（未毕业的代币）
  - 已毕业的代币需要通过 DEX 路由买入
  - value 参数是发送的 BNB 数量，决定了购买金额
`);

  } catch (error) {
    console.error('错误:', error);
  }
}

main();
