import { describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseEther,
  parseTransaction,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi } from '../../viem/abis/erc20';
import { executeOneToManyTransfer } from '../oneToManyTransferService';

const PRIVATE_KEY = `0x${'1'.padStart(64, '0')}` as Hex;
const SOURCE = privateKeyToAccount(PRIVATE_KEY).address;
const TOKEN = getAddress('0x000000000000000000000000000000000000beef');
const BASE_NONCE = 17;
const GAS_ESTIMATE = 21_000n;
const BUFFERED_GAS = 25_200n;
const ROBINHOOD_MAX_FEE = 300n;

const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain Test',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://unused.test'] } },
});

const bscChain = defineChain({
  id: 56,
  name: 'BSC Test',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['http://unused.test'] } },
});

function targets(count: number): Address[] {
  return Array.from({ length: count }, (_, index) => getAddress(
    `0x${(index + 10_000).toString(16).padStart(40, '0')}`,
  ));
}

type MockClientOptions = {
  nativeBalance?: bigint;
  tokenBalance?: bigint;
  latestNonce?: number;
  pendingNonce?: number;
  rejectBroadcastAt?: number;
  broadcastErrorAt?: number;
  broadcastErrorMessage?: string;
  broadcastGate?: Promise<void>;
  receiptGate?: Promise<void>;
  receiptError?: Error;
  transactionExists?: boolean;
  replacementReason?: 'repriced' | 'cancelled' | 'replaced';
  replacementHash?: Hash;
};

function createMockClient(options: MockClientOptions = {}) {
  const serializedTransactions: Hex[] = [];
  let broadcastAttempt = 0;

  const client = {
    estimateGas: vi.fn(async () => GAS_ESTIMATE),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 250n,
      maxPriorityFeePerGas: 0n,
    })),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 100n })),
    getGasPrice: vi.fn(async () => 100n),
    getBalance: vi.fn(async () => options.nativeBalance ?? 10n ** 30n),
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => (
      blockTag === 'latest'
        ? (options.latestNonce ?? BASE_NONCE)
        : (options.pendingNonce ?? BASE_NONCE)
    )),
    readContract: vi.fn(async () => options.tokenBalance ?? 10n ** 30n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      broadcastAttempt += 1;
      serializedTransactions.push(serializedTransaction);
      if (options.broadcastGate) await options.broadcastGate;
      if (options.rejectBroadcastAt === broadcastAttempt) {
        throw new Error('insufficient funds for gas * price + value');
      }
      if (options.broadcastErrorAt === broadcastAttempt) {
        throw new Error(options.broadcastErrorMessage ?? 'request timeout');
      }
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({
      hash,
      onReplaced,
    }: {
      hash: Hash;
      onReplaced?: (replacement: any) => void;
    }) => {
      if (options.receiptGate) await options.receiptGate;
      if (options.receiptError) throw options.receiptError;
      if (options.replacementReason) {
        onReplaced?.({ reason: options.replacementReason });
      }
      return {
        status: 'success' as const,
        transactionHash: options.replacementHash ?? hash,
      };
    }),
    getTransaction: vi.fn(async ({ hash }: { hash: Hash }) => {
      if (options.transactionExists) return { hash };
      throw new Error('transaction not found');
    }),
  };

  return { client, serializedTransactions };
}

function nativeOptions(
  targetAddresses: Address[],
  client: ReturnType<typeof createMockClient>['client'],
  overrides: Partial<Parameters<typeof executeOneToManyTransfer>[0]> = {},
) {
  return {
    chain: robinhoodChain,
    rpcUrl: 'http://unused.test',
    sourceAddress: SOURCE,
    targetAddresses,
    privateKey: PRIVATE_KEY,
    amount: 0.01,
    asset: { kind: 'native' as const, symbol: 'ETH' },
    dependencies: {
      publicClient: client as any,
      reconciliationAttempts: 1,
      confirmationTimeoutMs: 50,
      sleep: async () => undefined,
    },
    ...overrides,
  };
}

describe('one-to-many source pipeline', () => {
  it('broadcasts 100 consecutive nonces before waiting for any receipt', async () => {
    let releaseReceipts!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipts = resolve;
    });
    const { client, serializedTransactions } = createMockClient({ receiptGate });
    const execution = executeOneToManyTransfer(nativeOptions(targets(100), client));

    await vi.waitFor(() => {
      expect(client.sendRawTransaction).toHaveBeenCalledTimes(100);
      expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(100);
    }, { timeout: 5_000 });

    const nonces = serializedTransactions.map(serialized => parseTransaction(serialized).nonce!);
    expect(nonces).toEqual(Array.from({ length: 100 }, (_, index) => BASE_NONCE + index));
    expect(new Set(nonces).size).toBe(100);

    const pendingNonceReads = client.getTransactionCount.mock.calls
      .filter(([request]) => request.blockTag === 'pending');
    expect(pendingNonceReads).toHaveLength(2); // base nonce + final race guard

    releaseReceipts();
    const results = await execution;
    expect(results).toHaveLength(100);
    expect(results.every(result => result.status === 'confirmed')).toBe(true);
  });

  it('publishes deterministic hashes before receipt polling finishes', async () => {
    let releaseReceipts!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipts = resolve;
    });
    const { client } = createMockClient({ receiptGate });
    const progressSnapshots: Array<Array<{ hash?: Hash; status: string }>> = [];
    const execution = executeOneToManyTransfer(nativeOptions(targets(3), client, {
      onProgress: (results) => {
        progressSnapshots.push(results.map((result) => ({
          hash: result.hash,
          status: result.status,
        })));
      },
    }));

    await vi.waitFor(() => {
      expect(client.sendRawTransaction).toHaveBeenCalledTimes(3);
      expect(progressSnapshots.some((snapshot) => (
        snapshot.length === 3 && snapshot.every((result) => result.status === 'pending' && result.hash)
      ))).toBe(true);
    });

    releaseReceipts();
    await execution;
  });

  it('publishes the signed hash before the RPC broadcast request resolves', async () => {
    let releaseBroadcast!: () => void;
    const broadcastGate = new Promise<void>((resolve) => {
      releaseBroadcast = resolve;
    });
    const { client } = createMockClient({ broadcastGate });
    const progressSnapshots: Array<Array<{ hash?: Hash; status: string }>> = [];
    const execution = executeOneToManyTransfer(nativeOptions(targets(1), client, {
      onProgress: (results) => {
        progressSnapshots.push(results.map((result) => ({
          hash: result.hash,
          status: result.status,
        })));
      },
    }));

    await vi.waitFor(() => {
      expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(progressSnapshots.some((snapshot) => (
        snapshot.length === 1 && snapshot[0].status === 'unknown' && Boolean(snapshot[0].hash)
      ))).toBe(true);
    });

    releaseBroadcast();
    const [result] = await execution;
    expect(result.status).toBe('confirmed');
  });

  it('keeps the hash after a deterministic RPC rejection and never sends a higher nonce', async () => {
    const { client, serializedTransactions } = createMockClient({
      rejectBroadcastAt: 37,
      receiptError: new Error('receipt not found'),
      transactionExists: false,
    });
    const results = await executeOneToManyTransfer(nativeOptions(targets(100), client));

    expect(client.sendRawTransaction).toHaveBeenCalledTimes(37);
    const nonces = serializedTransactions.map(serialized => parseTransaction(serialized).nonce!);
    expect(nonces).toEqual(Array.from({ length: 37 }, (_, index) => BASE_NONCE + index));
    expect(Math.max(...nonces)).toBe(BASE_NONCE + 36);
    expect(results.slice(0, 36).every(result => result.status === 'pending' && result.hash)).toBe(true);
    expect(results[36].status).toBe('unknown');
    expect(results[36].hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(results[36].retryable).toBe(false);
    expect(results.slice(37).every(result => result.status === 'not_sent')).toBe(true);
  });

  it('keeps the deterministic hash and forbids retry when receipt lookup times out', async () => {
    const { client } = createMockClient({
      receiptError: new Error('receipt timeout'),
      transactionExists: true,
    });
    const [result] = await executeOneToManyTransfer(nativeOptions(targets(1), client));

    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('pending');
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.nonce).toBe(BASE_NONCE);
    expect(result.retryable).toBe(false);
  });

  it('treats already-known raw transaction as accepted without rebuilding it', async () => {
    const { client } = createMockClient({
      broadcastErrorAt: 1,
      broadcastErrorMessage: 'already known',
    });
    const [result] = await executeOneToManyTransfer(nativeOptions(targets(1), client));

    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('confirmed');
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('stops after an ambiguous broadcast timeout and never sends a higher nonce', async () => {
    const { client } = createMockClient({
      broadcastErrorAt: 1,
      broadcastErrorMessage: 'request timeout',
      transactionExists: false,
      receiptError: new Error('receipt not found'),
    });
    const results = await executeOneToManyTransfer(nativeOptions(targets(3), client));

    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe('unknown');
    expect(results[0].hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(results[0].retryable).toBe(false);
    expect(results.slice(1).every(result => result.status === 'not_sent')).toBe(true);
  });

  it('recognizes a successful same-payload repricing and displays the final hash', async () => {
    const replacementHash = `0x${'ab'.repeat(32)}` as Hash;
    const { client } = createMockClient({
      replacementReason: 'repriced',
      replacementHash,
    });
    const [result] = await executeOneToManyTransfer(nativeOptions(targets(1), client));

    expect(result.status).toBe('confirmed');
    expect(result.hash).toBe(replacementHash);
    expect(result.error).toContain('同 nonce 加价');
  });

  it('preflights the entire native value and maximum gas budget before broadcasting', async () => {
    const targetAddresses = targets(3);
    const totalRequired = parseEther('1') * 3n + BUFFERED_GAS * 3n * ROBINHOOD_MAX_FEE;
    const { client } = createMockClient({ nativeBalance: totalRequired - 1n });

    await expect(executeOneToManyTransfer(nativeOptions(targetAddresses, client, {
      amount: 1,
    }))).rejects.toThrow('整批余额不足');
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('preflights the complete ERC20 balance and native gas budget', async () => {
    const targetAddresses = targets(3);
    const requiredTokenBalance = parseEther('2') * 3n;
    const { client } = createMockClient({ tokenBalance: requiredTokenBalance - 1n });

    await expect(executeOneToManyTransfer(nativeOptions(targetAddresses, client, {
      amount: 2,
      asset: {
        kind: 'erc20',
        address: TOKEN,
        symbol: 'TEST',
        decimals: 18,
      },
    }))).rejects.toThrow('整批 TEST 余额不足');
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.getBalance).toHaveBeenCalledTimes(1);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('uses EIP-1559 on Robinhood and encodes ERC20 transfer calldata correctly', async () => {
    const [target] = targets(1);
    const { client, serializedTransactions } = createMockClient();
    await executeOneToManyTransfer(nativeOptions([target], client, {
      amount: 2,
      asset: {
        kind: 'erc20',
        address: TOKEN,
        symbol: 'TEST',
        decimals: 18,
      },
    }));

    const transaction = parseTransaction(serializedTransactions[0]);
    expect(transaction.type).toBe('eip1559');
    expect(transaction.maxFeePerGas).toBe(ROBINHOOD_MAX_FEE);
    expect(transaction.maxPriorityFeePerGas ?? 0n).toBe(0n);
    expect(transaction.gasPrice).toBeUndefined();
    expect(transaction.to?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(transaction.value ?? 0n).toBe(0n);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data! });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([target, parseEther('2')]);
  });

  it('counts an ERC20 transfer as confirmed only when the receipt proves the exact movement', async () => {
    const [target] = targets(1);
    const amount = parseEther('2');
    const { client } = createMockClient();
    client.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hash }) => ({
      status: 'success' as const,
      transactionHash: hash,
      logs: [{
        address: TOKEN,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: 'Transfer',
          args: { from: SOURCE, to: target },
        }),
        data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
      }],
    }));

    const [result] = await executeOneToManyTransfer(nativeOptions([target], client, {
      amount: 2,
      asset: {
        kind: 'erc20',
        address: TOKEN,
        symbol: 'TEST',
        decimals: 18,
      },
    }));

    expect(result.status).toBe('confirmed');
    expect(result.success).toBe(true);
  });

  it('does not report ERC20 success when a successful receipt has no matching Transfer event', async () => {
    const [target] = targets(1);
    const { client } = createMockClient();
    const [result] = await executeOneToManyTransfer(nativeOptions([target], client, {
      amount: 2,
      asset: {
        kind: 'erc20',
        address: TOKEN,
        symbol: 'TEST',
        decimals: 18,
      },
    }));

    expect(result.status).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.error).toContain('未发现来源、目标和金额完全匹配');
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('preserves an 18-decimal native amount exactly from input to signed value', async () => {
    const exactAmount = '0.123456789012345678';
    const { client, serializedTransactions } = createMockClient();
    await executeOneToManyTransfer(nativeOptions(targets(1), client, {
      amount: exactAmount,
    }));

    const transaction = parseTransaction(serializedTransactions[0]);
    expect(transaction.value).toBe(parseEther(exactAmount));
  });

  it('keeps legacy gas pricing on BSC', async () => {
    const { client, serializedTransactions } = createMockClient();
    await executeOneToManyTransfer(nativeOptions(targets(1), client, {
      chain: bscChain,
      asset: { kind: 'native', symbol: 'BNB' },
    }));

    const transaction = parseTransaction(serializedTransactions[0]);
    expect(transaction.type).toBe('legacy');
    expect(transaction.gasPrice).toBe(100n);
    expect(transaction.maxFeePerGas).toBeUndefined();
    expect(client.estimateFeesPerGas).not.toHaveBeenCalled();
  });

  it('sweeps one native source to one target with EIP-1559 gas reserved exactly once', async () => {
    const nativeBalance = parseEther('1');
    const { client, serializedTransactions } = createMockClient({ nativeBalance });
    const [result] = await executeOneToManyTransfer(nativeOptions(targets(1), client, {
      amount: 0,
      transferAllBalance: true,
    }));

    const transaction = parseTransaction(serializedTransactions[0]);
    expect(transaction.type).toBe('eip1559');
    expect(transaction.value).toBe(nativeBalance - BUFFERED_GAS * ROBINHOOD_MAX_FEE);
    expect(result.status).toBe('confirmed');
    expect(result.amount).not.toBe('0');
  });

  it('sweeps one ERC20 source balance without a duplicate balance read', async () => {
    const tokenBalance = parseEther('123.456');
    const [target] = targets(1);
    const { client, serializedTransactions } = createMockClient({ tokenBalance });
    await executeOneToManyTransfer(nativeOptions([target], client, {
      amount: 0,
      transferAllBalance: true,
      asset: {
        kind: 'erc20',
        address: TOKEN,
        symbol: 'TEST',
        decimals: 18,
      },
    }));

    const transaction = parseTransaction(serializedTransactions[0]);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data! });
    expect(decoded.args).toEqual([target, tokenBalance]);
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });

  it('rejects transfer-all for multiple destinations before any RPC write', async () => {
    const { client } = createMockClient();
    await expect(executeOneToManyTransfer(nativeOptions(targets(2), client, {
      transferAllBalance: true,
    }))).rejects.toThrow('一对多不能对多个目标重复转出全部余额');
    expect(client.estimateGas).not.toHaveBeenCalled();
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects artificial intervals in the one-to-many fast path', async () => {
    const { client } = createMockClient();
    await expect(executeOneToManyTransfer(nativeOptions(targets(2), client, {
      intervalMs: 1_000,
    }))).rejects.toThrow('不支持逐笔转账间隔');
    expect(client.estimateGas).not.toHaveBeenCalled();
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate target addresses before any RPC call', async () => {
    const { client } = createMockClient();
    const [target] = targets(1);
    await expect(executeOneToManyTransfer(nativeOptions([target, target], client)))
      .rejects.toThrow('存在重复地址');
    expect(client.estimateGas).not.toHaveBeenCalled();
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects a self-transfer before any RPC call because it cannot move wallet funds', async () => {
    const { client } = createMockClient();
    await expect(executeOneToManyTransfer(nativeOptions([SOURCE], client)))
      .rejects.toThrow('与源钱包相同');
    expect(client.estimateGas).not.toHaveBeenCalled();
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('prevents two concurrent batches from using the same source nonce', async () => {
    let releaseReceipts!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipts = resolve;
    });
    const firstMock = createMockClient({ receiptGate });
    const secondMock = createMockClient();
    const firstExecution = executeOneToManyTransfer(nativeOptions(targets(1), firstMock.client));

    await vi.waitFor(() => {
      expect(firstMock.client.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    });
    await expect(executeOneToManyTransfer(nativeOptions(targets(1), secondMock.client)))
      .rejects.toThrow('已有一对多转账任务正在执行');
    expect(secondMock.client.sendRawTransaction).not.toHaveBeenCalled();

    releaseReceipts();
    await firstExecution;
  });

  it('stops before the next RPC write when the global lease is lost', async () => {
    const { client } = createMockClient();
    let guardChecks = 0;
    const results = await executeOneToManyTransfer(nativeOptions(targets(4), client, {
      leaseGuard: {
        assertActive() {
          guardChecks += 1;
          // Initial guard + final nonce guard + two accepted broadcasts.
          if (guardChecks > 4) throw new Error('源钱包全局锁已丢失');
        },
      },
    }));

    expect(client.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(results.slice(0, 2).every(result => result.status === 'confirmed')).toBe(true);
    expect(results.slice(2).every(result => result.status === 'not_sent')).toBe(true);
  });
});
