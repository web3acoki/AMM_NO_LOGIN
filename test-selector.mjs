import { encodeFunctionData, keccak256, toHex } from 'viem';

const FOURMEME_ABI = [
  {
    name: 'buyTokenAMAP',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'origin', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'funds', type: 'uint256' },
      { name: 'minAmount', type: 'uint256' }
    ],
    outputs: []
  }
];

// 测试编码
const callData = encodeFunctionData({
  abi: FOURMEME_ABI,
  functionName: 'buyTokenAMAP',
  args: [
    0n,
    '0xae446495ee33154fb21f3b39d9446aabba07ffff',
    100000000000000000n,
    0n
  ]
});

console.log('生成的 calldata:');
console.log(callData);
console.log('');
console.log('方法选择器:', callData.slice(0, 10));
console.log('');

// 手动计算选择器
const sig = 'buyTokenAMAP(uint256,address,uint256,uint256)';
const manualSelector = keccak256(toHex(sig)).slice(0, 10);
console.log('手动计算的选择器:', manualSelector);
