import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  http,
  isAddress,
  isHash,
  type Address,
  type Hash,
} from 'viem';

export const UNRESOLVED_TRANSACTION_STRICT_WINDOW_MS = 2 * 60 * 1000;

const STORAGE_PREFIX = 'amm:unresolved-transaction:v1';
const SUPPORTED_CHAIN_IDS = new Set([56, 66, 97, 4663] as const);

export type UnresolvedTransactionChainId = 56 | 66 | 97 | 4663;
export type UnresolvedTransactionStatus = 'pending' | 'unknown';

export interface UnresolvedTransactionRecord {
  chainId: UnresolvedTransactionChainId;
  walletAddress: Address;
  status: UnresolvedTransactionStatus;
  txHash?: Hash;
  /** Only the saved RPC observing this exact successful receipt may clear the guard. */
  receiptRequired?: boolean;
  rpcUrl: string;
  recordedAt: number;
}

export interface MarkUnresolvedTransactionInput {
  chainId: number;
  walletAddress: string;
  status: UnresolvedTransactionStatus;
  txHash?: string;
  receiptRequired?: boolean;
  rpcUrl: string;
}

export interface CheckUnresolvedTransactionInput {
  chainId: number;
  walletAddress: string;
  /** Prefer the task's current endpoint over the endpoint saved with the record. */
  rpcUrl?: string;
}

export type UnresolvedTransactionBlockReason =
  | 'strict-window'
  | 'pending-nonce'
  | 'rpc-unavailable'
  | 'nonce-inconsistent'
  | 'receipt-required'
  | 'receipt-inconsistent';

export type UnresolvedTransactionClearReason =
  | 'none'
  | 'receipt-settled'
  | 'nonce-settled';

export type UnresolvedTransactionCheck =
  | {
      blocked: true;
      reason: UnresolvedTransactionBlockReason;
      record: UnresolvedTransactionRecord;
      message: string;
    }
  | {
      blocked: false;
      reason: UnresolvedTransactionClearReason;
      record?: UnresolvedTransactionRecord;
    };

const records = new Map<string, UnresolvedTransactionRecord>();

function normalizeChainId(chainId: number): UnresolvedTransactionChainId {
  if (!Number.isInteger(chainId) || !SUPPORTED_CHAIN_IDS.has(chainId as UnresolvedTransactionChainId)) {
    throw new Error(`不支持的待确认交易守卫链 ID: ${chainId}`);
  }
  return chainId as UnresolvedTransactionChainId;
}

function normalizeWalletAddress(walletAddress: string): Address {
  const trimmed = walletAddress.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new Error(`无效的钱包地址: ${walletAddress}`);
  }
  return trimmed.toLowerCase() as Address;
}

function normalizeRpcUrl(rpcUrl: string): string {
  const trimmed = rpcUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('待确认交易守卫的 RPC URL 无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('待确认交易守卫的 RPC URL 只允许 http/https');
  }
  return trimmed;
}

function normalizeHash(txHash: string | undefined): Hash | undefined {
  if (txHash === undefined || txHash === '') return undefined;
  if (!isHash(txHash)) throw new Error(`无效的交易哈希: ${txHash}`);
  return txHash.toLowerCase() as Hash;
}

function recordKey(chainId: UnresolvedTransactionChainId, walletAddress: Address): string {
  return `${chainId}:${walletAddress.toLowerCase()}`;
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}:${key}`;
}

function getSessionStorage(): Storage | undefined {
  try {
    if (typeof globalThis === 'undefined' || !('sessionStorage' in globalThis)) return undefined;
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function persistRecord(key: string, record: UnresolvedTransactionRecord): void {
  try {
    getSessionStorage()?.setItem(storageKey(key), JSON.stringify(record));
  } catch {
    // The in-memory guard remains active when browser storage is unavailable.
  }
}

function removePersistedRecord(key: string): void {
  try {
    getSessionStorage()?.removeItem(storageKey(key));
  } catch {
    // Removing an in-memory record is still useful in restricted browsers.
  }
}

function parseStoredRecord(raw: string, expectedKey: string): UnresolvedTransactionRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    const chainId = normalizeChainId(Number(candidate.chainId));
    const walletAddress = normalizeWalletAddress(String(candidate.walletAddress ?? ''));
    const status = candidate.status;
    if (status !== 'pending' && status !== 'unknown') return undefined;
    if (typeof candidate.rpcUrl !== 'string') return undefined;
    const rpcUrl = normalizeRpcUrl(candidate.rpcUrl);
    if (typeof candidate.recordedAt !== 'number' || !Number.isFinite(candidate.recordedAt) || candidate.recordedAt < 0) {
      return undefined;
    }
    const txHash = candidate.txHash === undefined
      ? undefined
      : normalizeHash(String(candidate.txHash));
    const receiptRequired = candidate.receiptRequired === true;
    if (receiptRequired && !txHash) return undefined;
    const record: UnresolvedTransactionRecord = {
      chainId,
      walletAddress,
      status,
      txHash,
      rpcUrl,
      recordedAt: candidate.recordedAt,
    };
    if (receiptRequired) record.receiptRequired = true;
    return recordKey(chainId, walletAddress) === expectedKey ? record : undefined;
  } catch {
    return undefined;
  }
}

function readRecord(key: string): UnresolvedTransactionRecord | undefined {
  const memoryRecord = records.get(key);
  if (memoryRecord) return memoryRecord;

  let raw: string | null = null;
  try {
    raw = getSessionStorage()?.getItem(storageKey(key)) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  const storedRecord = parseStoredRecord(raw, key);
  if (!storedRecord) {
    removePersistedRecord(key);
    return undefined;
  }
  records.set(key, storedRecord);
  return storedRecord;
}

function clearRecordIfCurrent(key: string, expected: UnresolvedTransactionRecord): void {
  if (records.get(key) !== expected) return;
  records.delete(key);
  removePersistedRecord(key);
}

function isReceiptNotFound(error: unknown): boolean {
  return error instanceof TransactionReceiptNotFoundError
    || (
      typeof error === 'object'
      && error !== null
      && 'name' in error
      && error.name === 'TransactionReceiptNotFoundError'
    );
}

/**
 * Records a broadcast whose final outcome is not yet known. Only public chain
 * metadata is persisted; callers cannot pass a private key to this API.
 */
export function markUnresolvedTransaction(
  input: MarkUnresolvedTransactionInput,
): UnresolvedTransactionRecord {
  const chainId = normalizeChainId(input.chainId);
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const txHash = normalizeHash(input.txHash);
  if (input.receiptRequired && !txHash) {
    throw new Error('必须提供交易哈希才能启用强制回执对账');
  }
  const record: UnresolvedTransactionRecord = {
    chainId,
    walletAddress,
    status: input.status,
    txHash,
    rpcUrl: normalizeRpcUrl(input.rpcUrl),
    recordedAt: Date.now(),
  };
  if (input.receiptRequired) record.receiptRequired = true;
  const key = recordKey(chainId, walletAddress);
  records.set(key, record);
  persistRecord(key, record);
  return record;
}

export function getUnresolvedTransaction(
  chainIdInput: number,
  walletAddressInput: string,
): UnresolvedTransactionRecord | undefined {
  const chainId = normalizeChainId(chainIdInput);
  const walletAddress = normalizeWalletAddress(walletAddressInput);
  return readRecord(recordKey(chainId, walletAddress));
}

export function clearUnresolvedTransaction(chainIdInput: number, walletAddressInput: string): void {
  const chainId = normalizeChainId(chainIdInput);
  const walletAddress = normalizeWalletAddress(walletAddressInput);
  const key = recordKey(chainId, walletAddress);
  records.delete(key);
  removePersistedRecord(key);
}

/**
 * Fails closed while a previous broadcast may still consume this wallet's next
 * nonce. During the first two minutes no RPC request can make the guard pass.
 */
export async function checkUnresolvedTransaction(
  input: CheckUnresolvedTransactionInput,
): Promise<UnresolvedTransactionCheck> {
  const chainId = normalizeChainId(input.chainId);
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const key = recordKey(chainId, walletAddress);
  const record = readRecord(key);
  if (!record) return { blocked: false, reason: 'none' };

  const elapsedMs = Date.now() - record.recordedAt;
  if (elapsedMs < UNRESOLVED_TRANSACTION_STRICT_WINDOW_MS) {
    const remainingSeconds = Math.ceil(
      (UNRESOLVED_TRANSACTION_STRICT_WINDOW_MS - Math.max(0, elapsedMs)) / 1000,
    );
    return {
      blocked: true,
      reason: 'strict-window',
      record,
      message: `该钱包上一笔交易仍待确认，至少再等待 ${remainingSeconds} 秒后检查链上状态`,
    };
  }

  let rpcUrl: string;
  try {
    // A peer-receipt barrier is tied to the lagging execution endpoint saved
    // in the record. A caller's current/default RPC must never override it.
    rpcUrl = normalizeRpcUrl(record.receiptRequired ? record.rpcUrl : (input.rpcUrl ?? record.rpcUrl));
  } catch {
    return {
      blocked: true,
      reason: 'rpc-unavailable',
      record,
      message: '上一笔交易状态未确定，且当前 RPC 配置不可用，禁止继续发送',
    };
  }

  const publicClient = createPublicClient({ transport: http(rpcUrl) });

  if (record.txHash) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: record.txHash });
      if (receipt.status === 'success') {
        clearRecordIfCurrent(key, record);
        return { blocked: false, reason: 'receipt-settled', record };
      }
      if (receipt.status === 'reverted') {
        if (record.receiptRequired) {
          return {
            blocked: true,
            reason: 'receipt-inconsistent',
            record,
            message: '另一交易节点返回了与执行节点不一致的回执，禁止继续发送',
          };
        }
        clearRecordIfCurrent(key, record);
        return { blocked: false, reason: 'receipt-settled', record };
      }
    } catch (error) {
      if (!isReceiptNotFound(error)) {
        return {
          blocked: true,
          reason: 'rpc-unavailable',
          record,
          message: '无法确认上一笔交易的回执，禁止继续发送以避免 nonce 冲突',
        };
      }
      if (record.receiptRequired) {
        return {
          blocked: true,
          reason: 'receipt-required',
          record,
          message: '另一交易节点尚未同步到指定交易回执，禁止继续发送',
        };
      }
    }
  }

  if (record.receiptRequired) {
    return {
      blocked: true,
      reason: 'receipt-required',
      record,
      message: '另一交易节点尚未返回指定交易的成功回执，禁止继续发送',
    };
  }

  try {
    const [pendingNonce, latestNonce] = await Promise.all([
      publicClient.getTransactionCount({ address: walletAddress, blockTag: 'pending' }),
      publicClient.getTransactionCount({ address: walletAddress, blockTag: 'latest' }),
    ]);
    if (pendingNonce > latestNonce) {
      return {
        blocked: true,
        reason: 'pending-nonce',
        record,
        message: '该钱包仍有链上 pending nonce，禁止发送下一笔交易',
      };
    }
    if (pendingNonce === latestNonce) {
      clearRecordIfCurrent(key, record);
      return { blocked: false, reason: 'nonce-settled', record };
    }
    return {
      blocked: true,
      reason: 'nonce-inconsistent',
      record,
      message: 'RPC 返回的 pending nonce 小于 latest nonce，状态不一致，禁止继续发送',
    };
  } catch {
    return {
      blocked: true,
      reason: 'rpc-unavailable',
      record,
      message: '无法核对上一笔交易的 pending/latest nonce，禁止继续发送',
    };
  }
}
