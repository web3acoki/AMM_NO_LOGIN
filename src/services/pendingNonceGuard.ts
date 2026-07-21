export const WALLET_PENDING_PREDECESSOR_CODE = 'WALLET_PENDING_PREDECESSOR' as const;

export type WalletPendingPredecessorError = Error & {
  code: typeof WALLET_PENDING_PREDECESSOR_CODE;
  latestNonce: number;
  pendingNonce: number;
};

export function createWalletPendingPredecessorError(
  latestNonce: number,
  pendingNonce: number,
): WalletPendingPredecessorError {
  const pendingCount = Math.max(1, pendingNonce - latestNonce);
  const error = new Error(
    `钱包已有 ${pendingCount} 笔链上待确认前序交易，请先等待其完成`,
  ) as WalletPendingPredecessorError;
  error.code = WALLET_PENDING_PREDECESSOR_CODE;
  error.latestNonce = latestNonce;
  error.pendingNonce = pendingNonce;
  return error;
}

export function isWalletPendingPredecessorError(
  error: unknown,
): error is WalletPendingPredecessorError {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === WALLET_PENDING_PREDECESSOR_CODE;
}
