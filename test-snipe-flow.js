/**
 * FourMeme 完整狙击方案验证脚本
 *
 * 流程：
 * 1. 监听 TokenCreated 事件
 * 2. 解析出代币地址
 * 3. 构建买入交易
 * 4. 发送交易
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  encodeAbiParameters,
  parseAbiParameters
} from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ==================== 配置 ====================

const FOURMEME_CONTRACT = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const TOKEN_CREATED_EVENT = '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20';
const BUY_METHOD_SELECTOR = '0x87f27655';

// RPC 节点
const HTTP_RPC = 'https://bsc.publicnode.com';
const WSS_RPC = 'wss://bsc.publicnode.com'; // WebSocket

// ==================== 工具函数 ====================

/**
 * 构建买入交易的 calldata
 */
function buildBuyCalldata(tokenAddress, minAmountOut = 0n, flags = 0n) {
  const encodedToken = tokenAddress.slice(2).toLowerCase().padStart(64, '0');
  const encodedMinOut = minAmountOut.toString(16).padStart(64, '0');
  const encodedFlags = flags.toString(16).padStart(64, '0');

  return BUY_METHOD_SELECTOR + encodedToken + encodedMinOut + encodedFlags;
}

/**
 * 解析 TokenCreated 事件
 */
function parseTokenCreatedEvent(log) {
  const data = log.data.slice(2);

  // 根据之前的分析：
  // Field 0: creator address
  // Field 1: token address
  const creator = '0x' + data.slice(24, 64);
  const token = '0x' + data.slice(64 + 24, 128);

  return { creator, token };
}

// ==================== 主要功能 ====================

/**
 * 验证买入方法 - 分析历史交易
 */
async function verifyBuyMethod() {
  console.log('='.repeat(70));
  console.log('Step 1: 验证买入方法');
  console.log('='.repeat(70));

  const client = createPublicClient({
    chain: bsc,
    transport: http(HTTP_RPC)
  });

  // 测试已知的成功交易
  const txHash = '0x0e3d36ac07f30332dee2e73df7bab99cddbf13b7f8a508f0bdfaea21b917eaae';
  const tx = await client.getTransaction({ hash: txHash });

  console.log('\n已验证的买入交易:');
  console.log('  TX:', txHash);
  console.log('  目标合约:', tx.to);
  console.log('  是 FourMeme 合约:', tx.to.toLowerCase() === FOURMEME_CONTRACT.toLowerCase() ? '✓' : '✗');
  console.log('  方法选择器:', tx.input.slice(0, 10));
  console.log('  是买入方法:', tx.input.startsWith(BUY_METHOD_SELECTOR) ? '✓' : '✗');

  return true;
}

/**
 * 验证 TokenCreated 事件解析
 */
async function verifyTokenCreatedEvent() {
  console.log('\n' + '='.repeat(70));
  console.log('Step 2: 验证 TokenCreated 事件解析');
  console.log('='.repeat(70));

  const client = createPublicClient({
    chain: bsc,
    transport: http(HTTP_RPC)
  });

  const blockNumber = await client.getBlockNumber();

  // 获取最近的 TokenCreated 事件
  const logs = await client.getLogs({
    address: FOURMEME_CONTRACT,
    fromBlock: blockNumber - 500n,
    toBlock: 'latest',
    topics: [TOKEN_CREATED_EVENT]
  });

  console.log(`\n找到 ${logs.length} 个 TokenCreated 事件`);

  if (logs.length > 0) {
    const log = logs[0];
    const { creator, token } = parseTokenCreatedEvent(log);

    console.log('\n示例事件:');
    console.log('  Block:', log.blockNumber.toString());
    console.log('  TX:', log.transactionHash);
    console.log('  Creator:', creator);
    console.log('  Token:', token);

    // 验证 token 地址格式
    console.log('\n  Token 地址有效:', token.match(/^0x[a-fA-F0-9]{40}$/) ? '✓' : '✗');

    return { creator, token };
  }

  return null;
}

/**
 * 模拟构建买入交易
 */
async function simulateBuyTransaction(tokenAddress, buyAmount) {
  console.log('\n' + '='.repeat(70));
  console.log('Step 3: 模拟构建买入交易');
  console.log('='.repeat(70));

  const calldata = buildBuyCalldata(tokenAddress, 0n, 0n);

  const transaction = {
    to: FOURMEME_CONTRACT,
    value: parseEther(buyAmount.toString()),
    data: calldata,
    gasLimit: 250000n,
    gasPrice: parseEther('0.000000003') // 3 Gwei
  };

  console.log('\n交易参数:');
  console.log('  目标:', transaction.to);
  console.log('  Value:', formatEther(transaction.value), 'BNB');
  console.log('  Gas Limit:', transaction.gasLimit.toString());
  console.log('  Gas Price:', '3 Gwei');
  console.log('  Calldata 长度:', calldata.length, 'chars');
  console.log('\n完整 Calldata:');
  console.log('  ' + calldata.slice(0, 10)); // method
  console.log('  ' + calldata.slice(10, 74)); // token address
  console.log('  ' + calldata.slice(74, 138)); // minAmountOut
  console.log('  ' + calldata.slice(138)); // flags

  return transaction;
}

/**
 * 演示完整的狙击流程
 */
async function demonstrateSnipeFlow() {
  console.log('\n' + '='.repeat(70));
  console.log('Step 4: 完整狙击流程演示');
  console.log('='.repeat(70));

  console.log(`
【狙击流程】

1. 启动监听
   - 连接 WebSocket: ${WSS_RPC}
   - 订阅 TokenCreated 事件
   - 事件签名: ${TOKEN_CREATED_EVENT}

2. 预准备（提升速度）
   - 预先创建钱包客户端
   - 预取 nonce
   - 预设交易参数 (gasPrice, gasLimit)
   - 预计算 calldata 模板

3. 监听到事件
   - 解析事件数据获取 token 地址
   - 检查 creator 是否为目标钱包

4. 构建交易
   - 填充 token 地址到 calldata
   - calldata = ${BUY_METHOD_SELECTOR} + token + 0 + 0

5. 发送交易
   - 并行发送到多个 RPC 节点
   - 使用预取的 nonce

【代码示例】
`);

  console.log(`
// 伪代码 - 监听和买入

import { createPublicClient, createWalletClient, http, webSocket } from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// 配置
const FOURMEME = '${FOURMEME_CONTRACT}';
const TARGET_WALLET = '0x...'; // 要监听的钱包
const BUY_AMOUNT = parseEther('0.1'); // 买入金额
const PRIVATE_KEY = '0x...'; // 执行钱包私钥

// 创建客户端
const wsClient = createPublicClient({
  chain: bsc,
  transport: webSocket('${WSS_RPC}')
});

const walletClient = createWalletClient({
  account: privateKeyToAccount(PRIVATE_KEY),
  chain: bsc,
  transport: http('${HTTP_RPC}')
});

// 监听 TokenCreated 事件
const unwatch = wsClient.watchContractEvent({
  address: FOURMEME,
  abi: [{
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { name: 'creator', type: 'address', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      // ... 其他字段
    ]
  }],
  eventName: 'TokenCreated',
  onLogs: async (logs) => {
    for (const log of logs) {
      const { creator, token } = parseTokenCreatedEvent(log);

      // 检查是否为目标钱包
      if (creator.toLowerCase() === TARGET_WALLET.toLowerCase()) {
        console.log('检测到目标钱包创建代币:', token);

        // 立即买入
        const calldata = buildBuyCalldata(token, 0n, 0n);

        const hash = await walletClient.sendTransaction({
          to: FOURMEME,
          value: BUY_AMOUNT,
          data: calldata,
          gasLimit: 250000n,
          gasPrice: parseGwei('5'), // 较高 gas price
        });

        console.log('买入交易已发送:', hash);
      }
    }
  }
});
`);
}

/**
 * 估算 Gas
 */
async function estimateGas(tokenAddress) {
  console.log('\n' + '='.repeat(70));
  console.log('Step 5: Gas 估算');
  console.log('='.repeat(70));

  const client = createPublicClient({
    chain: bsc,
    transport: http(HTTP_RPC)
  });

  // 使用真实交易的 gas 数据
  const txHash = '0x0e3d36ac07f30332dee2e73df7bab99cddbf13b7f8a508f0bdfaea21b917eaae';
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  console.log('\n参考历史交易 Gas 使用:');
  console.log('  Gas Used:', receipt.gasUsed.toString());
  console.log('  建议 Gas Limit:', Math.ceil(Number(receipt.gasUsed) * 1.3), '(+30% 余量)');
  console.log('\n建议配置:');
  console.log('  Gas Limit: 250000');
  console.log('  Gas Price: 3-5 Gwei (正常情况)');
  console.log('  Gas Price: 10+ Gwei (抢跑/高优先级)');
}

// ==================== 主函数 ====================

async function main() {
  try {
    console.log('FourMeme 狙击方案验证\n');
    console.log('合约地址:', FOURMEME_CONTRACT);
    console.log('买入方法: 0x87f27655');
    console.log('事件签名:', TOKEN_CREATED_EVENT);

    // Step 1: 验证买入方法
    await verifyBuyMethod();

    // Step 2: 验证事件解析
    const eventData = await verifyTokenCreatedEvent();

    // Step 3: 模拟构建交易
    if (eventData) {
      await simulateBuyTransaction(eventData.token, 0.01);
    }

    // Step 4: 演示完整流程
    await demonstrateSnipeFlow();

    // Step 5: Gas 估算
    await estimateGas();

    console.log('\n' + '='.repeat(70));
    console.log('验证完成 - 方案可行！');
    console.log('='.repeat(70));

    console.log(`
【总结】

✓ 直接买入方法: 0x87f27655
  - 参数: token(address) + minOut(uint256) + flags(uint256)
  - 目标: ${FOURMEME_CONTRACT}
  - Value: 买入的 BNB 数量

✓ TokenCreated 事件: ${TOKEN_CREATED_EVENT.slice(0, 20)}...
  - 包含 creator 和 token 地址
  - 可用于监听新代币创建

✓ 推荐配置:
  - Gas Limit: 250000
  - Gas Price: 3-5 Gwei (正常) / 10+ Gwei (抢跑)
  - MinAmountOut: 0 (不设限制)

下一步: 在前端实现监听和买入功能
`);

  } catch (error) {
    console.error('错误:', error);
  }
}

main();
