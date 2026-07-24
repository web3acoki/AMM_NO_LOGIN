export type TransferTargetTokenContext = {
  address?: string | null;
  chainId?: number | null;
  decimals?: number | null;
  symbol?: string | null;
};

export type TargetTokenQuerySnapshot = {
  chainId: number;
  address: string;
};

export type TransferExecutionContext = {
  chainId: number;
  rpcUrl: string;
  targetToken: TransferTargetTokenContext | null | undefined;
};

function normalizeAddress(address: string | null | undefined): string {
  return String(address || '').trim().toLowerCase();
}

function normalizeRpcUrl(rpcUrl: string): string {
  return String(rpcUrl || '').trim();
}

/**
 * Prevent a token metadata response from an old chain/address request from
 * becoming the active transfer asset after the user changes context.
 */
export function assertTargetTokenQueryContextCurrent(
  snapshot: TargetTokenQuerySnapshot,
  currentChainId: number,
  currentAddress: string,
): void {
  if (
    currentChainId !== snapshot.chainId
    || normalizeAddress(currentAddress) !== normalizeAddress(snapshot.address)
  ) {
    throw new Error('读取代币期间网络或代币地址已切换，请在当前上下文重新读取');
  }
}

export function getTransferTargetTokenIdentity(
  token: TransferTargetTokenContext | null | undefined,
): string | null {
  if (!token) return null;
  return [
    String(token.chainId ?? ''),
    normalizeAddress(token.address),
    String(token.decimals ?? ''),
    String(token.symbol ?? '').trim(),
  ].join(':');
}

/**
 * A stateful guard is used because checking only the current values would miss
 * a switch-away-and-back while an earlier transfer round is still awaiting
 * confirmation.
 */
export function createTransferExecutionContextGuard(
  context: TransferExecutionContext,
) {
  const chainId = context.chainId;
  const rpcUrl = normalizeRpcUrl(context.rpcUrl);
  const targetTokenIdentity = getTransferTargetTokenIdentity(context.targetToken);
  let invalidated = false;

  return {
    invalidate(): void {
      invalidated = true;
    },

    assertCurrent(currentContext: TransferExecutionContext): void {
      if (
        invalidated
        || currentContext.chainId !== chainId
        || normalizeRpcUrl(currentContext.rpcUrl) !== rpcUrl
        || getTransferTargetTokenIdentity(currentContext.targetToken) !== targetTokenIdentity
      ) {
        throw new Error('执行期间网络、RPC 或目标代币发生过切换。已广播结果保留，后续转账未发送');
      }
    },
  };
}
