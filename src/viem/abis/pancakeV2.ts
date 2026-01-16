// PancakeSwap V2 Router ABI - 完整版本
export const pancakeV2RouterAbi = [
  // 查询函数
  {
    "type": "function",
    "name": "getAmountsOut",
    "stateMutability": "view",
    "inputs": [
      { "name": "amountIn", "type": "uint256" },
      { "name": "path", "type": "address[]" }
    ],
    "outputs": [{ "name": "amounts", "type": "uint256[]" }]
  },
  {
    "type": "function",
    "name": "getAmountsIn",
    "stateMutability": "view",
    "inputs": [
      { "name": "amountOut", "type": "uint256" },
      { "name": "path", "type": "address[]" }
    ],
    "outputs": [{ "name": "amounts", "type": "uint256[]" }]
  },
  {
    "type": "function",
    "name": "WETH",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address" }]
  },
  
  // 用原生币(BNB)买代币
  {
    "type": "function",
    "name": "swapExactETHForTokens",
    "stateMutability": "payable",
    "inputs": [
      { "name": "amountOutMin", "type": "uint256" },
      { "name": "path", "type": "address[]" },
      { "name": "to", "type": "address" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": [{ "name": "amounts", "type": "uint256[]" }]
  },
  
  // 用原生币(BNB)买代币 - 支持手续费代币
  {
    "type": "function",
    "name": "swapExactETHForTokensSupportingFeeOnTransferTokens",
    "stateMutability": "payable",
    "inputs": [
      { "name": "amountOutMin", "type": "uint256" },
      { "name": "path", "type": "address[]" },
      { "name": "to", "type": "address" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": []
  },
  
  // 卖代币换原生币(BNB)
  {
    "type": "function",
    "name": "swapExactTokensForETH",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "amountIn", "type": "uint256" },
      { "name": "amountOutMin", "type": "uint256" },
      { "name": "path", "type": "address[]" },
      { "name": "to", "type": "address" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": [{ "name": "amounts", "type": "uint256[]" }]
  },
  
  // 卖代币换原生币(BNB) - 支持手续费代币
  {
    "type": "function",
    "name": "swapExactTokensForETHSupportingFeeOnTransferTokens",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "amountIn", "type": "uint256" },
      { "name": "amountOutMin", "type": "uint256" },
      { "name": "path", "type": "address[]" },
      { "name": "to", "type": "address" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": []
  },
  
  // 代币换代币
  {
    "type": "function",
    "name": "swapExactTokensForTokens",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "amountIn", "type": "uint256" },
      { "name": "amountOutMin", "type": "uint256" },
      { "name": "path", "type": "address[]" },
      { "name": "to", "type": "address" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": [{ "name": "amounts", "type": "uint256[]" }]
  },
  
  // 代币换代币 - 支持手续费代币
  {
    "type": "function",
    "name": "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "amountIn", "type": "uint256" },
      { "name": "amountOutMin", "type": "uint256" },
      { "name": "path", "type": "address[]" },
      { "name": "to", "type": "address" },
      { "name": "deadline", "type": "uint256" }
    ],
    "outputs": []
  }
] as const;
