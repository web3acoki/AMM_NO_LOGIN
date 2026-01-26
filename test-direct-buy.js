/**
 * 深入分析 FourMeme 直接买入方法
 * 方法选择器: 0x87f27655 (直接调用主合约，96 bytes)
 * 方法选择器: 0xedf9e251 (直接调用主合约，128 bytes)
 */

import { createPublicClient, http, formatEther, keccak256, toHex, parseEther } from 'viem';
import { bsc } from 'viem/chains';

const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.publicnode.com')
});

async function analyzeDirectBuyMethod() {
  console.log('='.repeat(70));
  console.log('分析 FourMeme 直接买入方法 0x87f27655');
  console.log('='.repeat(70));

  // 获取示例交易
  const txHash = '0x0e3d36ac07f30332dee2e73df7bab99cddbf13b7f8a508f0bdfaea21b917eaae';

  const tx = await client.getTransaction({ hash: txHash });
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  console.log('\n【交易基本信息】');
  console.log('  Hash:', tx.hash);
  console.log('  From (买家):', tx.from);
  console.log('  To (合约):', tx.to);
  console.log('  Value:', formatEther(tx.value), 'BNB');
  console.log('  Gas Price:', Number(tx.gasPrice) / 1e9, 'Gwei');
  console.log('  Gas Used:', receipt.gasUsed.toString());
  console.log('  Status:', receipt.status);

  // 解析 input
  const methodSelector = tx.input.slice(0, 10);
  const params = tx.input.slice(10);

  console.log('\n【方法调用分析】');
  console.log('  方法选择器:', methodSelector);
  console.log('  参数总长度:', params.length / 2, 'bytes');
  console.log('  参数个数:', params.length / 64, '个');

  console.log('\n【参数详细解析】');
  const decodedParams = [];
  for (let i = 0; i < params.length / 64; i++) {
    const word = params.slice(i * 64, (i + 1) * 64);
    const value = BigInt('0x' + word);

    let paramType = '';
    let paramValue = '';

    if (word.startsWith('000000000000000000000000') && word.slice(24) !== '0000000000000000000000000000000000000000') {
      paramType = 'address';
      paramValue = '0x' + word.slice(24);
    } else if (value < 1000n) {
      paramType = 'uint (small)';
      paramValue = value.toString();
    } else {
      paramType = 'uint256';
      paramValue = value.toString();
    }

    decodedParams.push({ type: paramType, value: paramValue, raw: word });
    console.log(`  参数 ${i}:`);
    console.log(`    类型: ${paramType}`);
    console.log(`    值: ${paramValue}`);
  }

  // 分析代币转账
  console.log('\n【代币转账分析】');
  const transferLogs = receipt.logs.filter(log =>
    log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  );

  for (const log of transferLogs) {
    const from = '0x' + log.topics[1].slice(26);
    const to = '0x' + log.topics[2].slice(26);
    const amount = BigInt(log.data);

    // 标记关键转账
    let note = '';
    if (to.toLowerCase() === tx.from.toLowerCase()) {
      note = ' ← 【用户收到的代币】';
    }
    if (from.toLowerCase() === FOURMEME_CONTRACT.toLowerCase()) {
      note = ' ← 【从 FourMeme 转出】';
    }

    console.log(`\n  代币: ${log.address}`);
    console.log(`  From: ${from}`);
    console.log(`  To: ${to}${note}`);
    console.log(`  Amount: ${amount}`);
  }

  // 找到用户收到的代币
  const receivedToken = transferLogs.find(log =>
    ('0x' + log.topics[2].slice(26)).toLowerCase() === tx.from.toLowerCase()
  );

  if (receivedToken) {
    console.log('\n【买入结果】');
    console.log('  买入的代币:', receivedToken.address);
    console.log('  收到数量:', BigInt(receivedToken.data).toString());
    console.log('  花费 BNB:', formatEther(tx.value));

    // 检查参数 0 是否就是代币地址
    console.log('\n【参数验证】');
    console.log('  参数 0 是否为代币地址:', decodedParams[0].value.toLowerCase() === receivedToken.address.toLowerCase() ? '✓ 是' : '✗ 否');
  }

  return { methodSelector, params: decodedParams };
}

async function analyzeMethod2() {
  console.log('\n' + '='.repeat(70));
  console.log('分析 FourMeme 直接买入方法 0xedf9e251 (128 bytes)');
  console.log('='.repeat(70));

  // 获取示例交易
  const txHash = '0x97b15915d4aee52be4796444346c3490832bf6ebf70dcbc6198f5cfde0f74f75';

  const tx = await client.getTransaction({ hash: txHash });
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  console.log('\n【交易基本信息】');
  console.log('  Hash:', tx.hash);
  console.log('  From (买家):', tx.from);
  console.log('  To (合约):', tx.to);
  console.log('  Value:', formatEther(tx.value), 'BNB');

  // 解析 input
  const params = tx.input.slice(10);

  console.log('\n【参数详细解析】');
  for (let i = 0; i < params.length / 64; i++) {
    const word = params.slice(i * 64, (i + 1) * 64);
    const value = BigInt('0x' + word);

    if (word.startsWith('000000000000000000000000') && word.slice(24) !== '0000000000000000000000000000000000000000') {
      console.log(`  参数 ${i}: address 0x${word.slice(24)}`);
    } else if (value < 1000n) {
      console.log(`  参数 ${i}: uint ${value}`);
    } else {
      console.log(`  参数 ${i}: uint256 ${value}`);
    }
  }

  // 找到用户收到的代币
  const transferLogs = receipt.logs.filter(log =>
    log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
    ('0x' + log.topics[2].slice(26)).toLowerCase() === tx.from.toLowerCase()
  );

  if (transferLogs.length > 0) {
    console.log('\n【买入结果】');
    console.log('  买入的代币:', transferLogs[0].address);
    console.log('  收到数量:', BigInt(transferLogs[0].data).toString());
  }
}

async function guessMethodSignature() {
  console.log('\n' + '='.repeat(70));
  console.log('尝试破解方法签名');
  console.log('='.repeat(70));

  // 基于分析，参数可能是:
  // - 参数0: 代币地址 (address)
  // - 参数1: 最小输出量 (uint256)
  // - 参数2: 一个小数值 (可能是 slippage 或 referrer code)

  const possibleSignatures = [
    // 3 参数版本 (96 bytes)
    'buyToken(address,uint256,uint256)',
    'buy(address,uint256,uint256)',
    'buyTokens(address,uint256,uint256)',
    'swapETHForTokens(address,uint256,uint256)',
    'buyWithETH(address,uint256,uint256)',
    'purchaseToken(address,uint256,uint256)',
    'buyMeme(address,uint256,uint256)',
    'buyInternalToken(address,uint256,uint256)',
    'swapBNBForToken(address,uint256,uint256)',
    'buyFromCurve(address,uint256,uint256)',
    'buyToken(address,uint256,uint8)',
    'buy(address,uint256,uint8)',
    'buyMemeToken(address,uint256,uint256)',
    'buyTokenWithBNB(address,uint256,uint256)',
    'buy(address,uint256,bool)',
    // 4 参数版本 (128 bytes)
    'buyToken(address,uint256,uint256,uint256)',
    'buy(address,uint256,uint256,uint256)',
    'buyToken(address,uint256,uint256,address)',
    'buy(address,address,uint256,uint256)',
  ];

  console.log('\n计算方法选择器:');
  console.log('目标: 0x87f27655 (3参数) 和 0xedf9e251 (4参数)\n');

  for (const sig of possibleSignatures) {
    const selector = keccak256(toHex(sig)).slice(0, 10);
    let match = '';
    if (selector === '0x87f27655') match = ' ✓✓✓ 匹配 3参数方法!';
    if (selector === '0xedf9e251') match = ' ✓✓✓ 匹配 4参数方法!';
    if (match) {
      console.log(`  ${sig.padEnd(50)} => ${selector}${match}`);
    }
  }

  // 如果没找到，扩大搜索范围
  console.log('\n扩大搜索范围...');

  const moreSigs = [
    'buyTokensOnCurve(address,uint256,uint256)',
    'purchaseTokens(address,uint256,uint256)',
    'swapIn(address,uint256,uint256)',
    'buyIn(address,uint256,uint256)',
    'tokenBuy(address,uint256,uint256)',
    'memeBuy(address,uint256,uint256)',
    'curveBuy(address,uint256,uint256)',
    'internalBuy(address,uint256,uint256)',
    'directBuy(address,uint256,uint256)',
    'buyDirect(address,uint256,uint256)',
  ];

  for (const sig of moreSigs) {
    const selector = keccak256(toHex(sig)).slice(0, 10);
    let match = '';
    if (selector === '0x87f27655') match = ' ✓✓✓ 匹配!';
    if (selector === '0xedf9e251') match = ' ✓✓✓ 匹配!';
    if (match) {
      console.log(`  ${sig.padEnd(50)} => ${selector}${match}`);
    }
  }
}

async function testBuildTransaction() {
  console.log('\n' + '='.repeat(70));
  console.log('构建买入交易示例');
  console.log('='.repeat(70));

  // 基于分析，构建交易参数
  const tokenAddress = '0x74c2f126badf15126b6d93e617840c3ac75d4444'; // 示例代币
  const minTokenOut = BigInt('1000000000000000000'); // 最小获得 1 个代币
  const slippageOrRef = BigInt(100); // 可能是滑点 100 = 1%?

  console.log('\n交易参数:');
  console.log('  方法选择器: 0x87f27655');
  console.log('  参数 0 (代币地址):', tokenAddress);
  console.log('  参数 1 (最小输出):', minTokenOut.toString());
  console.log('  参数 2 (滑点/ref):', slippageOrRef.toString());

  // 编码 calldata
  const calldata = '0x87f27655' +
    tokenAddress.slice(2).padStart(64, '0') +
    minTokenOut.toString(16).padStart(64, '0') +
    slippageOrRef.toString(16).padStart(64, '0');

  console.log('\n编码后的 calldata:');
  console.log(calldata);

  console.log('\n完整交易:');
  console.log({
    to: FOURMEME_CONTRACT,
    data: calldata,
    value: parseEther('0.01').toString() + ' wei (0.01 BNB)',
  });
}

async function main() {
  try {
    await analyzeDirectBuyMethod();
    await analyzeMethod2();
    await guessMethodSignature();
    await testBuildTransaction();

    console.log('\n' + '='.repeat(70));
    console.log('分析完成');
    console.log('='.repeat(70));
  } catch (error) {
    console.error('错误:', error);
  }
}

main();
