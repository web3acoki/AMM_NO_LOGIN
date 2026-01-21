/**
 * 统一的区块链错误解析工具
 * 将底层错误信息转换为用户友好的中文描述
 */

export function parseBlockchainError(error: any): string {
  const message = error?.message || error?.toString() || '未知错误';
  const lowerMessage = message.toLowerCase();

  // ============ 余额相关错误 ============
  if (lowerMessage.includes('insufficient funds') || lowerMessage.includes('insufficient balance')) {
    return '余额不足，无法支付转账金额和Gas费';
  }
  if (lowerMessage.includes('exceeds balance') || lowerMessage.includes('transfer amount exceeds balance')) {
    return '转账金额超过代币余额';
  }
  if (lowerMessage.includes('erc20: transfer amount')) {
    return '代币余额不足';
  }

  // ============ Gas相关错误 ============
  if (lowerMessage.includes('gas too low') || lowerMessage.includes('intrinsic gas too low')) {
    return 'Gas设置过低，交易无法执行';
  }
  if (lowerMessage.includes('out of gas')) {
    return 'Gas耗尽，交易执行失败';
  }

  // ============ Nonce相关错误 ============
  if (lowerMessage.includes('nonce too low') || lowerMessage.includes('nonce has already been used') || lowerMessage.includes('nonce provided')) {
    return 'Nonce冲突，交易已被覆盖或已执行';
  }
  if (lowerMessage.includes('replacement transaction underpriced')) {
    return 'Nonce冲突，替换交易Gas价格过低';
  }

  // ============ 网络相关错误 ============
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return '网络超时，请检查网络连接';
  }
  if (lowerMessage.includes('network') || lowerMessage.includes('connection')) {
    return '网络连接错误，请检查RPC节点';
  }

  // ============ 交易执行错误 ============
  if (lowerMessage.includes('rejected') || lowerMessage.includes('denied')) {
    return '交易被节点拒绝';
  }
  if (lowerMessage.includes('reverted') || lowerMessage.includes('execution reverted')) {
    // 尝试提取具体原因
    const revertMatch = message.match(/reason="([^"]+)"/);
    if (revertMatch) {
      return `合约执行失败: ${revertMatch[1]}`;
    }
    return '合约执行失败（可能是滑点或流动性不足）';
  }

  // ============ 滑点相关错误 ============
  if (lowerMessage.includes('insufficient_output_amount') || lowerMessage.includes('slippage')) {
    return '滑点过大，价格变化超出预期';
  }

  // ============ 授权相关错误 ============
  if (lowerMessage.includes('allowance') || lowerMessage.includes('erc20: insufficient allowance')) {
    return '代币授权额度不足';
  }

  // ============ 地址相关错误 ============
  if (lowerMessage.includes('invalid address')) {
    return '无效的钱包地址';
  }

  // ============ 合约相关错误 ============
  if (lowerMessage.includes('returned no data') ||
      lowerMessage.includes('not a contract') ||
      lowerMessage.includes('contractfunctionzerodataerror')) {
    return '合约不存在或调用失败';
  }

  // 返回截断的原始错误信息
  const cleanMessage = message.replace(/^Error:\s*/i, '');
  const maxLength = 80;
  return cleanMessage.length > maxLength ? cleanMessage.substring(0, maxLength) + '...' : cleanMessage;
}

// 别名，保持向后兼容
export const parseTransferError = parseBlockchainError;
export const parseTransactionError = parseBlockchainError;
