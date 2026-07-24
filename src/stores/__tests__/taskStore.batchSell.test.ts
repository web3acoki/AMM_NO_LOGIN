import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Task } from '../taskStore';

const mocks = vi.hoisted(() => ({
  executeTrade: vi.fn(),
  readTokenBalance: vi.fn(),
  checkV3SellApproval: vi.fn(),
  ensureV3SellApproval: vi.fn(),
  warmupTradingConnections: vi.fn(),
  warmupV3SellPreparation: vi.fn(),
  createTradingService: vi.fn(),
  prepareFourMemeSell: vi.fn(),
  executeFourMemeSell: vi.fn(),
  executeFourMemeTrade: vi.fn(),
  executeFourMemeTradeFast: vi.fn(),
  batchPrepareFourMemeRound: vi.fn(),
  createFourMemeService: vi.fn(),
  validatePons: vi.fn(async () => ({ valid: true })),
  httpTransport: vi.fn((url: string, options?: unknown) => ({ url, options })),
  publicClientsByUrl: new Map<string, any>(),
  publicClient: {
    readContract: vi.fn(async () => 1n),
    getTransactionCount: vi.fn(async (_params?: { address?: string; blockTag?: string }) => 7),
    waitForTransactionReceipt: vi.fn(),
  },
  walletClient: {
    sendTransaction: vi.fn(),
  },
  serverMode: false,
  loggedIn: false,
  withTransferLease: vi.fn(),
  withTransferLeases: vi.fn(),
  createServerTask: vi.fn(),
  startTaskRuntime: vi.fn(),
  heartbeatTaskRuntime: vi.fn(),
  stopTaskRuntime: vi.fn(),
  getTaskRuntimeStatus: vi.fn(),
  retainUntil: vi.fn(),
  walletStore: {
    localWallets: [] as Array<{ address: string; encrypted: string }>,
    walletBatches: [] as Array<{ wallets: Array<{ address: string; privateKey: string }> }>,
  },
  dexStore: {
    dexConfigs: [
      {
        id: 'uniswap-v3',
        chainId: 4663,
        routerAddress: '0x0000000000000000000000000000000000001000',
      },
      {
        id: 'pancake-v2-mainnet',
        chainId: 56,
        routerAddress: '0x0000000000000000000000000000000000002000',
      },
    ],
  },
}));

vi.mock('../../services/tradingService', () => ({
  createTradingService: mocks.createTradingService,
  resetNonceForAddress: vi.fn(),
  ZERO_TOKEN_BALANCE_CODE: 'ZERO_TOKEN_BALANCE',
}));

vi.mock('../walletStore', () => ({
  useWalletStore: () => mocks.walletStore,
}));

vi.mock('../dexStore', () => ({
  useDexStore: () => mocks.dexStore,
}));

vi.mock('../../services/taskApi', () => ({
  isLoggedIn: () => mocks.loggedIn,
  getTasks: vi.fn(async () => []),
  createTask: mocks.createServerTask,
  updateTask: vi.fn(),
  updateTaskStats: vi.fn(async () => undefined),
  deleteTask: vi.fn(),
}));

vi.mock('../../config', () => ({
  get ENABLE_LOGIN() {
    return mocks.serverMode;
  },
}));

vi.mock('../../services/fourMemeService', () => ({
  FourMemeService: class FourMemeService {},
  createFourMemeService: mocks.createFourMemeService,
  ANTI_SANDWICH_RPC: 'http://unused.test',
  getPremiumSellRpc: () => 'http://premium.test',
  resetNonceForAddress: vi.fn(),
}));

vi.mock('../../utils/priceCalculator', () => ({
  PriceCalculator: class PriceCalculator {},
}));

vi.mock('../../services/uniswapV3Service', () => ({
  UniswapV3Service: class UniswapV3Service {},
  formatV3PriceFraction: vi.fn(),
  getV3SpotPriceFraction: vi.fn(),
}));

vi.mock('../../services/ponsService', () => ({
  readAndValidatePonsLaunchedToken: mocks.validatePons,
}));

vi.mock('../../services/transferLeaseApi', () => ({
  withTransferLease: mocks.withTransferLease,
  withTransferLeases: mocks.withTransferLeases,
}));

vi.mock('../../services/taskRuntimeApi', () => ({
  createRuntimeId: () => 'runtime-test-id',
  getClientInstanceId: () => 'client-test-id',
  startTaskRuntime: mocks.startTaskRuntime,
  heartbeatTaskRuntime: mocks.heartbeatTaskRuntime,
  stopTaskRuntime: mocks.stopTaskRuntime,
  getTaskRuntimeStatus: mocks.getTaskRuntimeStatus,
  isTaskRuntimeBusy: (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'TASK_RUNTIME_BUSY'
  ),
  isTaskRuntimeRevoked: (error: unknown) => (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && ['TASK_RUNTIME_REVOKED', 'TASK_NOT_FOUND', 'COORDINATION_AUTH_REQUIRED'].includes(
      String(error.code),
    )
  ),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(({ transport }: { transport?: { url?: string } }) => (
      (transport?.url && mocks.publicClientsByUrl.get(transport.url)) || mocks.publicClient
    )),
    createWalletClient: vi.fn(({ account, chain }) => ({
      ...mocks.walletClient,
      account,
      chain,
    })),
    http: mocks.httpTransport,
  };
});

import {
  calculateNextRoundDelayMs,
  calculateTaskRuntimeHeartbeatRetryDelayMs,
  useTaskStore,
} from '../taskStore';
import { clearUnresolvedTransaction, getUnresolvedTransaction } from '../../services/unresolvedTransactionGuard';

const WALLET_A = '0x00000000000000000000000000000000000000a1';
const WALLET_B = '0x00000000000000000000000000000000000000b2';
const WALLET_C = '0x00000000000000000000000000000000000000c3';
const WALLET_D = '0x00000000000000000000000000000000000000d4';
const NEW_TOKEN_ADDRESS = '0x000000000000000000000000000000000000cafe';
const PREAPPROVAL_PRIVATE_KEY = `0x${'7'.padStart(64, '0')}` as Hex;
const PREAPPROVAL_WALLET = privateKeyToAccount(PREAPPROVAL_PRIVATE_KEY).address;

function makeTask(
  chainId: 4663 | 56,
  walletAddresses: string[],
  overrides: Partial<Task> = {},
): Task {
  const robinhood = chainId === 4663;
  return {
    id: `task-${chainId}`,
    name: `batch sell ${chainId}`,
    status: 'paused',
    config: {
      chainId,
      dexId: robinhood ? 'uniswap-v3' : 'pancake-v2-mainnet',
      rpcUrl: robinhood ? 'https://rpc.mainnet.chain.robinhood.com/' : 'https://bsc.test/',
      launchpadId: robinhood ? 'pons' : 'fourmeme',
      v3FeeTier: robinhood ? 10000 : undefined,
      tokenContract: '0x000000000000000000000000000000000000beef',
      innerTokenAddress: robinhood ? '0x000000000000000000000000000000000000beef' : undefined,
      targetPrice: 0,
      amountMin: 0.001,
      amountMax: 0.001,
      stopType: 'none',
      stopValue: 0,
      interval: 60,
      buyThreadCount: 0,
      sellThreadCount: 40,
      sellAll: true,
      marketType: robinhood ? 'inner' : 'outer',
      innerSlippage: robinhood ? 12 : undefined,
    },
    walletAddresses,
    logs: [],
    stats: {
      buyCount: 0,
      sellCount: 0,
      spentAmount: 0,
      elapsedTime: 0,
    },
    currentBuyWalletIndex: 0,
    currentSellWalletIndex: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installWallets(addresses: string[]) {
  mocks.walletStore.localWallets = addresses.map((address, index) => ({
    address,
    encrypted: `private-key-${index + 1}`,
  }));
}

function installTask(task: Task) {
  const store = useTaskStore();
  store.tasks = [task];
  return store;
}

function makeRpcClient() {
  return {
    readContract: vi.fn(),
    getTransactionCount: vi.fn(async () => 7),
    waitForTransactionReceipt: vi.fn(),
    getChainId: vi.fn(async () => 56),
  };
}

function makeAsterTaskConfig(): Task['config'] {
  return {
    chainId: 56,
    dexId: 'pancake-v2-mainnet',
    rpcUrl: 'https://bsc.test/',
    antiSandwichRpc: 'http://buy.test',
    launchpadId: 'fourmeme',
    tokenContract: '0x000000000000000000000000000000000000beef',
    innerTokenAddress: '0x000000000000000000000000000000000000beef',
    poolBaseToken: '0x000000000000000000000000000000000000a57e',
    targetPrice: 0,
    amountMin: 0.001,
    amountMax: 0.001,
    stopType: 'none',
    stopValue: 0,
    interval: 60,
    buyThreadCount: 1,
    sellThreadCount: 1,
    sellAll: true,
    marketType: 'inner',
    innerSlippage: 10,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.serverMode = false;
  mocks.loggedIn = false;
  mocks.withTransferLease.mockReset();
  mocks.withTransferLease.mockImplementation(
    async (_chainId: number, _address: string, callback: Function) => callback({
      assertActive: vi.fn(),
      retainUntil: mocks.retainUntil,
    }),
  );
  mocks.withTransferLeases.mockReset();
  mocks.withTransferLeases.mockImplementation(
    async (_chainId: number, addresses: string[], callback: Function) => {
      const guards = new Map(addresses.map(address => [address.toLowerCase(), {
        assertActive: vi.fn(),
        retainUntil: mocks.retainUntil,
      }]));
      return callback(guards);
    },
  );
  mocks.createServerTask.mockReset();
  mocks.createServerTask.mockResolvedValue({ _id: 'server-created-task' });
  mocks.startTaskRuntime.mockReset();
  mocks.startTaskRuntime.mockImplementation(async () => ({
    runtimeId: 'runtime-test-id',
    runtimeToken: 'runtime-test-token',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    runtimeDurationMs: 120_000,
    heartbeatIntervalMs: 60_000,
  }));
  mocks.heartbeatTaskRuntime.mockReset();
  mocks.heartbeatTaskRuntime.mockImplementation(async (
    _serverTaskId: string,
    runtimeId: string,
  ) => ({
    runtimeId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    runtimeDurationMs: 120_000,
  }));
  mocks.stopTaskRuntime.mockReset();
  mocks.stopTaskRuntime.mockResolvedValue(true);
  mocks.getTaskRuntimeStatus.mockReset();
  mocks.getTaskRuntimeStatus.mockResolvedValue({
    running: false,
    runtime: null,
  });
  mocks.executeTrade.mockReset();
  mocks.readTokenBalance.mockReset();
  mocks.readTokenBalance.mockResolvedValue(1n);
  mocks.checkV3SellApproval.mockReset();
  mocks.checkV3SellApproval.mockResolvedValue({ ready: true });
  mocks.ensureV3SellApproval.mockReset();
  mocks.ensureV3SellApproval.mockResolvedValue({ success: true, status: 'confirmed' });
  mocks.warmupTradingConnections.mockReset();
  mocks.warmupTradingConnections.mockResolvedValue(undefined);
  mocks.warmupV3SellPreparation.mockReset();
  mocks.warmupV3SellPreparation.mockResolvedValue(undefined);
  mocks.createTradingService.mockReset();
  mocks.createTradingService.mockReturnValue({
    executeTrade: mocks.executeTrade,
    readTokenBalance: mocks.readTokenBalance,
    checkV3SellApproval: mocks.checkV3SellApproval,
    ensureV3SellApproval: mocks.ensureV3SellApproval,
    warmupConnections: mocks.warmupTradingConnections,
    warmupV3SellPreparation: mocks.warmupV3SellPreparation,
  });
  mocks.prepareFourMemeSell.mockReset();
  mocks.executeFourMemeSell.mockReset();
  mocks.executeFourMemeTrade.mockReset();
  mocks.executeFourMemeTradeFast.mockReset();
  mocks.batchPrepareFourMemeRound.mockReset();
  mocks.createFourMemeService.mockReset();
  mocks.createFourMemeService.mockReturnValue({
    prepareSell: mocks.prepareFourMemeSell,
    executeSellDirect: mocks.executeFourMemeSell,
    executeTrade: mocks.executeFourMemeTrade,
    executeTradeFast: mocks.executeFourMemeTradeFast,
    batchPrepareRound: mocks.batchPrepareFourMemeRound,
    warmupConnections: vi.fn(async () => {}),
    warmupTradeRpc: vi.fn(async () => {}),
  });
  mocks.validatePons.mockClear();
  mocks.httpTransport.mockClear();
  mocks.publicClientsByUrl.clear();
  mocks.publicClient.readContract.mockClear();
  mocks.publicClient.getTransactionCount.mockReset();
  mocks.publicClient.getTransactionCount.mockResolvedValue(7);
  mocks.publicClient.waitForTransactionReceipt.mockReset();
  mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) => ({
    status: 'success',
    transactionHash: hash,
  }));
  mocks.walletClient.sendTransaction.mockReset();
  mocks.retainUntil.mockReset();
  mocks.walletStore.localWallets = [];
  mocks.walletStore.walletBatches = [];
  for (const chainId of [56, 4663]) {
    for (const walletAddress of [WALLET_A, WALLET_B, WALLET_C, WALLET_D, PREAPPROVAL_WALLET]) {
      clearUnresolvedTransaction(chainId, walletAddress);
    }
  }
});

afterEach(async () => {
  // The scheduler and retained settlements live outside Pinia component
  // lifetimes. Stop every task created by the current test so its next tick
  // cannot call mocks that a later test has already reset.
  const store = useTaskStore();
  for (const task of [...store.tasks]) {
    if (task.status === 'running' || task.status === 'paused') {
      store.stopTask(task.id, '测试清理');
    }
  }
  await Promise.resolve();
});

describe('automatic task cadence and Robinhood thread concurrency', () => {
  it('counts the previous round runtime toward the configured interval', () => {
    expect(calculateNextRoundDelayMs(1_000, 2, 1_500)).toBe(1_500);
    expect(calculateNextRoundDelayMs(1_000, 2, 3_000)).toBe(0);
    expect(calculateNextRoundDelayMs(1_000, 2, 8_000)).toBe(0);
  });

  it('retries a transient heartbeat before the authoritative runtime expires', () => {
    expect(calculateTaskRuntimeHeartbeatRetryDelayMs(1, 3_000, 9_000)).toBe(500);
    expect(calculateTaskRuntimeHeartbeatRetryDelayMs(2, 3_000, 9_000)).toBe(1_000);
    expect(calculateTaskRuntimeHeartbeatRetryDelayMs(9, 3_000, 700)).toBe(450);
  });

  it('starts different Robinhood wallets concurrently and reuses one V3 service', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    const firstReceipt = deferred<{ success: boolean; status: 'confirmed'; txHash: string }>();
    mocks.executeTrade.mockImplementation(({ walletAddress }: { walletAddress: string }) => (
      walletAddress.toLowerCase() === WALLET_A.toLowerCase()
        ? firstReceipt.promise
        : Promise.resolve({ success: true, status: 'confirmed', txHash: `0x${walletAddress.slice(-2)}` })
    ));

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.buyThreadCount = 3;
    task.config.sellThreadCount = 0;
    task.config.stopType = 'count';
    task.config.stopValue = 3;
    const store = installTask(task);

    const start = store.startTask(task.id);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(3));

    // Wallet A is still waiting for its receipt. Seeing B and C already inside
    // executeTrade proves the old same-market per-wallet serialization is gone.
    expect(mocks.executeTrade.mock.calls.map(call => call[0].walletAddress))
      .toEqual(expect.arrayContaining([WALLET_A, WALLET_B, WALLET_C]));
    expect(mocks.createTradingService).toHaveBeenCalledTimes(1);
    expect(mocks.warmupTradingConnections).toHaveBeenCalledTimes(1);
    expect(mocks.validatePons).toHaveBeenCalledTimes(1);

    firstReceipt.resolve({ success: true, status: 'confirmed', txHash: '0xa1' });
    await start;
    expect(store.tasks[0].stats.buyCount).toBe(3);
  });

  it('does not let three buy threads starve the sell direction when only three wallets are free', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.executeTrade.mockImplementation(async ({ walletAddress, mode }: {
      walletAddress: string;
      mode: 'pump' | 'dump';
    }) => ({
      success: true,
      status: 'confirmed',
      txHash: `0x${mode}${walletAddress.slice(-2)}`,
    }));

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.buyThreadCount = 3;
    task.config.sellThreadCount = 1;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(3));

    const firstRoundModes = mocks.executeTrade.mock.calls.map(call => call[0].mode);
    expect(firstRoundModes.filter(mode => mode === 'pump')).toHaveLength(2);
    expect(firstRoundModes.filter(mode => mode === 'dump')).toHaveLength(1);
    expect(task.stats.buyCount).toBe(2);
    expect(task.stats.sellCount).toBe(1);
    store.stopTask(task.id);
  });

  it('reserves the final finite-count slot for a real sell after three zero-balance wallets buy', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C, WALLET_D]);
    const balances = new Map<string, bigint>(
      [WALLET_A, WALLET_B, WALLET_C, WALLET_D]
        .map(address => [address.toLowerCase(), 0n] as const),
    );
    const buySettlements = new Map<
      string,
      ReturnType<typeof deferred<{ status: 'confirmed' }>>
    >();
    const acceptedModes: Array<'pump' | 'dump'> = [];

    mocks.readTokenBalance.mockImplementation(async (
      _tokenAddress: string,
      walletAddress: string,
    ) => balances.get(walletAddress.toLowerCase()) ?? 0n);
    mocks.executeTrade.mockImplementation(({
      walletAddress,
      mode,
    }: {
      walletAddress: string;
      mode: 'pump' | 'dump';
    }) => {
      const walletKey = walletAddress.toLowerCase();
      if (mode === 'dump') {
        if ((balances.get(walletKey) ?? 0n) === 0n) {
          return Promise.resolve({
            success: false,
            status: 'failed',
            code: 'ZERO_TOKEN_BALANCE',
            error: 'wallet has no token balance',
          });
        }
        balances.set(walletKey, 0n);
        acceptedModes.push('dump');
        return Promise.resolve({
          success: true,
          status: 'confirmed',
          txHash: `0xfinite-dump-${walletAddress.slice(-2)}`,
        });
      }

      const settlement = deferred<{ status: 'confirmed' }>();
      buySettlements.set(walletKey, settlement);
      acceptedModes.push('pump');
      return Promise.resolve({
        success: true,
        status: 'broadcast',
        txHash: `0xfinite-pump-${walletAddress.slice(-2)}`,
        settlement: settlement.promise.then(finality => {
          balances.set(walletKey, 10n);
          return finality;
        }),
      });
    });

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C, WALLET_D]);
    task.config.interval = 0.05;
    task.config.buyThreadCount = 3;
    task.config.sellThreadCount = 1;
    task.config.sellAll = false;
    task.config.stopType = 'count';
    task.config.stopValue = 4;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(buySettlements.size).toBe(3), { timeout: 2_000 });
    await vi.waitFor(
      () => expect(mocks.executeTrade.mock.calls.length).toBeGreaterThan(4),
      { timeout: 2_000 },
    );

    // The first three accepted writes are buys. While all three hashes are
    // still confirming, later ticks may probe a zero-balance sell wallet, but
    // must never consume the fourth count slot with another buy.
    expect(acceptedModes).toEqual(['pump', 'pump', 'pump']);
    expect(mocks.executeTrade.mock.calls.filter(call => call[0].mode === 'pump'))
      .toHaveLength(3);
    expect(task.stats.buyCount).toBe(0);
    expect(task.stats.sellCount).toBe(0);

    const [firstBuy, ...remainingBuys] = [...buySettlements.values()];
    firstBuy.resolve({ status: 'confirmed' });
    await vi.waitFor(() => expect(acceptedModes).toEqual([
      'pump',
      'pump',
      'pump',
      'dump',
    ]), { timeout: 2_000 });

    for (const settlement of remainingBuys) {
      settlement.resolve({ status: 'confirmed' });
    }
    await vi.waitFor(() => expect(task.status).toBe('stopped'), { timeout: 2_000 });

    expect(task.stats.buyCount).toBe(3);
    expect(task.stats.sellCount).toBe(1);
    expect(acceptedModes).toEqual(['pump', 'pump', 'pump', 'dump']);
  });

  it('accepts only one of two concurrent start requests and dispatches one first round', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const runtimeGate = deferred<{
      runtimeId: string;
      runtimeToken: string;
      expiresAt: string;
      runtimeDurationMs: number;
      heartbeatIntervalMs: number;
    }>();
    mocks.startTaskRuntime.mockReturnValue(runtimeGate.promise);
    mocks.executeTrade.mockResolvedValue({
      success: true,
      status: 'confirmed',
      txHash: '0xsingle-start',
    });

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-concurrent-start',
    });
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.stopType = 'count';
    task.config.stopValue = 1;
    const store = installTask(task);

    const firstStart = store.startTask(task.id);
    const duplicateStart = store.startTask(task.id);

    await expect(duplicateStart).resolves.toBe(false);
    expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.executeTrade).not.toHaveBeenCalled();

    runtimeGate.resolve({
      runtimeId: 'runtime-test-id',
      runtimeToken: 'runtime-test-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      runtimeDurationMs: 120_000,
      heartbeatIntervalMs: 60_000,
    });
    await expect(firstStart).resolves.toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(task.stats.buyCount).toBe(1));

    expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.executeTrade.mock.calls[0][0].walletAddress.toLowerCase())
      .toBe(WALLET_A.toLowerCase());
  });

  it('does not let a delayed stop for runtime A revoke the resumed runtime B', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    mocks.startTaskRuntime
      .mockResolvedValueOnce({
        runtimeId: 'runtime-a',
        runtimeToken: 'runtime-token-a',
        expiresAt,
        runtimeDurationMs: 120_000,
        heartbeatIntervalMs: 60_000,
      })
      .mockResolvedValueOnce({
        runtimeId: 'runtime-b',
        runtimeToken: 'runtime-token-b',
        expiresAt,
        runtimeDurationMs: 120_000,
        heartbeatIntervalMs: 60_000,
      });

    const delayedOldStop = deferred<boolean>();
    mocks.stopTaskRuntime.mockReturnValueOnce(delayedOldStop.promise);
    mocks.executeTrade.mockImplementation(async ({ walletAddress }: {
      walletAddress: string;
    }) => ({
      success: true,
      status: 'confirmed',
      txHash: `0xruntime-${walletAddress.slice(-2)}`,
    }));

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-delayed-runtime-stop',
    });
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    task.config.interval = 60;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(task.stats.buyCount).toBe(1));

    expect(store.pauseTask(task.id)).toBe(true);
    expect(mocks.stopTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.stopTaskRuntime).toHaveBeenNthCalledWith(
      1,
      'server-task-delayed-runtime-stop',
      {
        runtimeId: 'runtime-a',
        runtimeToken: 'runtime-token-a',
      },
    );

    expect(await store.resumeTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(task.stats.buyCount).toBe(2));
    expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(2);
    expect(task.status).toBe('running');
    expect(task.remoteRuntimeActive).toBe(true);

    delayedOldStop.resolve(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.stopTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.stopTaskRuntime).not.toHaveBeenCalledWith(
      'server-task-delayed-runtime-stop',
      expect.objectContaining({
        runtimeId: 'runtime-b',
        runtimeToken: 'runtime-token-b',
      }),
    );
    expect(task.status).toBe('running');
    expect(task.remoteRuntimeActive).toBe(true);
  });

  it('ignores runtime A heartbeat revocation after pause and resume installs runtime B', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    mocks.startTaskRuntime
      .mockResolvedValueOnce({
        runtimeId: 'heartbeat-runtime-a',
        runtimeToken: 'heartbeat-token-a',
        expiresAt,
        runtimeDurationMs: 120_000,
        heartbeatIntervalMs: 5,
      })
      .mockResolvedValueOnce({
        runtimeId: 'heartbeat-runtime-b',
        runtimeToken: 'heartbeat-token-b',
        expiresAt,
        runtimeDurationMs: 120_000,
        heartbeatIntervalMs: 60_000,
      });

    const staleHeartbeat = deferred<{
      runtimeId: string;
      expiresAt: string;
      runtimeDurationMs: number;
    }>();
    let runtimeAHeartbeatCalls = 0;
    mocks.heartbeatTaskRuntime.mockImplementation((
      _serverTaskId: string,
      runtimeId: string,
    ) => {
      if (runtimeId === 'heartbeat-runtime-a') {
        runtimeAHeartbeatCalls++;
        if (runtimeAHeartbeatCalls > 1) return staleHeartbeat.promise;
      }
      return Promise.resolve({
        runtimeId,
        expiresAt,
        runtimeDurationMs: 120_000,
      });
    });

    let tradeSequence = 0;
    mocks.executeTrade.mockImplementation(async () => ({
      success: true,
      status: 'confirmed',
      txHash: `0xheartbeat-${++tradeSequence}`,
    }));

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-stale-heartbeat',
    });
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    task.config.interval = 0.2;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    await vi.waitFor(
      () => expect(mocks.heartbeatTaskRuntime).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );
    expect(mocks.heartbeatTaskRuntime).toHaveBeenNthCalledWith(
      2,
      'server-task-stale-heartbeat',
      'heartbeat-runtime-a',
      'heartbeat-token-a',
    );

    expect(store.pauseTask(task.id)).toBe(true);
    expect(mocks.stopTaskRuntime).toHaveBeenNthCalledWith(
      1,
      'server-task-stale-heartbeat',
      {
        runtimeId: 'heartbeat-runtime-a',
        runtimeToken: 'heartbeat-token-a',
      },
    );
    expect(await store.resumeTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    expect(task.status).toBe('running');
    expect(task.remoteRuntimeActive).toBe(true);

    staleHeartbeat.reject(Object.assign(
      new Error('runtime A was already revoked'),
      { code: 'TASK_RUNTIME_REVOKED' },
    ));
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));

    expect(mocks.stopTaskRuntime).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('running');
    expect(task.remoteRuntimeActive).toBe(true);

    const tradesAfterStaleCatch = mocks.executeTrade.mock.calls.length;
    await vi.waitFor(
      () => expect(mocks.executeTrade.mock.calls.length).toBeGreaterThan(tradesAfterStaleCatch),
      { timeout: 2_000 },
    );
    expect(task.status).toBe('running');
    expect(task.remoteRuntimeActive).toBe(true);
  });

  it('refreshes a changed remote runtime identity without letting an old force-stop delete it', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-stale-force-stop',
    });
    task.status = 'stopped';
    task.remoteRuntimeActive = true;
    task.remoteRuntimeId = 'runtime-a';
    const store = installTask(task);

    mocks.stopTaskRuntime.mockResolvedValueOnce(false);
    mocks.getTaskRuntimeStatus.mockResolvedValueOnce({
      running: true,
      runtime: {
        runtimeId: 'runtime-b',
        clientInstanceId: 'other-page',
        clientBuildId: 'new-build',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });

    expect(store.stopTask(task.id, undefined, { forceServer: true })).toBe(true);
    await vi.waitFor(() => expect(mocks.getTaskRuntimeStatus).toHaveBeenCalledTimes(1));

    expect(mocks.stopTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.stopTaskRuntime).toHaveBeenCalledWith(
      'server-task-stale-force-stop',
      {
        runtimeId: 'runtime-a',
        force: true,
      },
    );
    expect(mocks.stopTaskRuntime).not.toHaveBeenCalledWith(
      'server-task-stale-force-stop',
      expect.objectContaining({ runtimeId: 'runtime-b' }),
    );
    expect(task.remoteRuntimeActive).toBe(true);
    expect(task.remoteRuntimeId).toBe('runtime-b');
  });

  it('keeps the force-stop retry visible when the server never confirms a local runtime stop', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);
    mocks.startTaskRuntime.mockResolvedValueOnce({
      runtimeId: 'runtime-a',
      runtimeToken: 'runtime-token-a',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      runtimeDurationMs: 120_000,
      heartbeatIntervalMs: 60_000,
    });
    mocks.stopTaskRuntime.mockRejectedValueOnce(new Error('temporary network failure'));

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-unconfirmed-stop',
    });
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    task.config.interval = 60;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    expect(task.remoteRuntimeId).toBe('runtime-a');
    expect(store.pauseTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.stopTaskRuntime).toHaveBeenCalledTimes(1));
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));

    expect(task.status).toBe('paused');
    expect(task.remoteRuntimeActive).toBe(true);
    expect(task.remoteRuntimeId).toBe('runtime-a');
    consoleError.mockRestore();
  });

  it('does not let a delayed force-stop status response overwrite a runtime started on this page', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const delayedOldStatus = deferred<{
      running: true;
      runtime: {
        runtimeId: string;
        clientInstanceId: string;
        clientBuildId: string;
        startedAt: string;
        heartbeatAt: string;
        expiresAt: string;
      };
    }>();
    mocks.stopTaskRuntime.mockResolvedValueOnce(false);
    mocks.getTaskRuntimeStatus.mockReturnValueOnce(delayedOldStatus.promise);
    mocks.startTaskRuntime.mockResolvedValueOnce({
      runtimeId: 'runtime-c',
      runtimeToken: 'runtime-token-c',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      runtimeDurationMs: 120_000,
      heartbeatIntervalMs: 60_000,
    });
    mocks.executeTrade.mockResolvedValue({
      success: false,
      status: 'failed',
      error: 'keep runtime C active for the identity assertion',
    });

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-delayed-force-status',
      status: 'stopped',
      remoteRuntimeActive: true,
      remoteRuntimeId: 'runtime-b',
    });
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    task.config.interval = 60;
    const store = installTask(task);

    expect(store.stopTask(task.id, undefined, { forceServer: true })).toBe(true);
    await vi.waitFor(() => expect(mocks.getTaskRuntimeStatus).toHaveBeenCalledTimes(1));

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(task.remoteRuntimeId).toBe('runtime-c'));
    expect(task.status).toBe('running');

    delayedOldStatus.resolve({
      running: true,
      runtime: {
        runtimeId: 'runtime-b',
        clientInstanceId: 'old-page',
        clientBuildId: 'old-build',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));

    expect(task.status).toBe('running');
    expect(task.remoteRuntimeActive).toBe(true);
    expect(task.remoteRuntimeId).toBe('runtime-c');
    expect(mocks.stopTaskRuntime).not.toHaveBeenCalledWith(
      'server-task-delayed-force-status',
      expect.objectContaining({ runtimeId: 'runtime-c' }),
    );
  });

  it('conditionally releases a delayed runtime B when another public action learns runtime C', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const delayedRuntimeB = deferred<{
      runtimeId: string;
      runtimeToken: string;
      expiresAt: string;
      runtimeDurationMs: number;
      heartbeatIntervalMs: number;
    }>();
    mocks.startTaskRuntime.mockReturnValueOnce(delayedRuntimeB.promise);
    mocks.getTaskRuntimeStatus.mockResolvedValueOnce({
      running: true,
      runtime: {
        runtimeId: 'runtime-c',
        clientInstanceId: 'other-page',
        clientBuildId: 'new-build',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-reordered-start-response',
    });
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    const store = installTask(task);

    const start = store.startTask(task.id);
    await vi.waitFor(() => expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(1));

    // stopTask is a public store action. With no local lease installed yet it
    // refreshes the authoritative server status and learns exact runtime C.
    expect(store.stopTask(task.id, undefined, { forceServer: true })).toBe(true);
    await vi.waitFor(() => expect(task.remoteRuntimeId).toBe('runtime-c'));

    delayedRuntimeB.resolve({
      runtimeId: 'runtime-b',
      runtimeToken: 'runtime-token-b',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      runtimeDurationMs: 120_000,
      heartbeatIntervalMs: 60_000,
    });

    await expect(start).resolves.toBe(false);
    expect(mocks.stopTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.stopTaskRuntime).toHaveBeenCalledWith(
      'server-task-reordered-start-response',
      {
        runtimeId: 'runtime-b',
        runtimeToken: 'runtime-token-b',
      },
    );
    expect(mocks.heartbeatTaskRuntime).not.toHaveBeenCalledWith(
      'server-task-reordered-start-response',
      'runtime-b',
      'runtime-token-b',
    );
    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(task.status).toBe('stopped');
    expect(task.remoteRuntimeActive).toBe(true);
    expect(task.remoteRuntimeId).toBe('runtime-c');
  });

  it('keeps an initially-zero remotely busy pure-sell wallet pending and sells it after release', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const busyError = Object.assign(
      new Error('TRANSFER_LEASE_BUSY: wallet is owned by another task'),
      { code: 'TRANSFER_LEASE_BUSY' },
    );
    let remoteBusy = true;
    let releasedLeaseAcquisitions = 0;
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, walletAddress: string, callback: Function) => {
        if (remoteBusy && walletAddress.toLowerCase() === WALLET_A.toLowerCase()) {
          throw busyError;
        }
        if (walletAddress.toLowerCase() === WALLET_A.toLowerCase()) {
          if (releasedLeaseAcquisitions >= 1) throw busyError;
          releasedLeaseAcquisitions++;
        }
        return callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
      },
    );

    let balanceReadCount = 0;
    mocks.readTokenBalance.mockImplementation(async () => {
      balanceReadCount++;
      return balanceReadCount === 1 ? 0n : 10n;
    });
    const broadcastedWallets: string[] = [];
    mocks.executeTrade.mockImplementation(async (params: {
      walletAddress: string;
      robinhoodBroadcastParticipant?: {
        arrive: (
          broadcast: () => Promise<void>,
          cancel?: () => void,
        ) => Promise<void>;
      };
    }) => {
      await params.robinhoodBroadcastParticipant?.arrive(async () => {
        broadcastedWallets.push(params.walletAddress.toLowerCase());
      });
      return {
        success: true,
        status: 'confirmed',
        txHash: '0xreleased-zero-wallet',
      };
    });

    const task = makeTask(4663, [WALLET_A], {
      _id: 'server-task-initial-zero-busy',
    });
    task.config.interval = 0.05;
    task.config.stopType = 'none';
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 1;
    task.config.sellAll = true;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    expect(task.status).toBe('running');
    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(balanceReadCount).toBe(1);

    remoteBusy = false;
    await vi.waitFor(
      () => expect(broadcastedWallets).toEqual([WALLET_A.toLowerCase()]),
      { timeout: 4_000 },
    );
    await vi.waitFor(
      () => expect(balanceReadCount).toBeGreaterThanOrEqual(2),
      { timeout: 2_000 },
    );

    expect(mocks.executeTrade).toHaveBeenCalled();
    expect(mocks.executeTrade.mock.calls[0][0].mode).toBe('dump');
    expect(task.status).toBe('running');
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('keeps a zero-balance pure-sell wallet covered while an unknown chain nonce is pending', async () => {
    installWallets([WALLET_A]);
    const monitorNonceRelease = deferred<void>();
    let initialNonceReads = 0;
    let tokenBalance = 0n;

    mocks.publicClient.getTransactionCount.mockImplementation((params?: {
      blockTag?: string;
    }) => {
      if (initialNonceReads < 2) {
        initialNonceReads++;
        return Promise.resolve(params?.blockTag === 'pending' ? 8 : 7);
      }
      return monitorNonceRelease.promise.then(() => 7);
    });
    mocks.readTokenBalance.mockImplementation(async () => tokenBalance);
    mocks.executeTrade.mockImplementation(async ({ mode }: {
      mode: 'pump' | 'dump';
    }) => {
      expect(mode).toBe('dump');
      expect(tokenBalance).toBeGreaterThan(0n);
      tokenBalance = 0n;
      return {
        success: true,
        status: 'confirmed',
        txHash: '0xpending-nonce-recovered-sell',
      };
    });

    const task = makeTask(4663, [WALLET_A]);
    task.config.interval = 0.05;
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 1;
    task.config.sellAll = true;
    task.config.stopType = 'none';
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => {
      const unresolved = getUnresolvedTransaction(4663, WALLET_A);
      expect(unresolved?.status).toBe('pending');
      expect(unresolved?.txHash).toBeUndefined();
    });

    expect(task.status).toBe('running');
    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(task.stats.sellCount).toBe(0);

    tokenBalance = 10n;
    monitorNonceRelease.resolve();

    await vi.waitFor(
      () => expect(mocks.executeTrade).toHaveBeenCalledTimes(1),
      { timeout: 4_000 },
    );
    await vi.waitFor(() => expect(task.stats.sellCount).toBe(1), { timeout: 2_000 });
    await vi.waitFor(() => expect(task.status).toBe('stopped'), { timeout: 2_000 });

    expect(getUnresolvedTransaction(4663, WALLET_A)).toBeUndefined();
    expect(mocks.executeTrade.mock.calls[0][0].walletAddress.toLowerCase())
      .toBe(WALLET_A.toLowerCase());
    expect(mocks.executeTrade.mock.calls[0][0].mode).toBe('dump');
  });

  it('linearizes a verified zero inside the wallet lease before a waiting buy can acquire it', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A, WALLET_B]);

    const slowWalletBVerification = deferred<void>();
    const walletALeaseReleased = deferred<void>();
    const events: string[] = [];
    const balanceReads = new Map<string, number>();
    const balances = new Map<string, bigint>([
      [WALLET_A.toLowerCase(), 0n],
      [WALLET_B.toLowerCase(), 0n],
    ]);
    let walletALeaseActive = false;
    let task!: Task;

    mocks.readTokenBalance.mockImplementation(async (
      _tokenAddress: string,
      walletAddress: string,
    ) => {
      const walletKey = walletAddress.toLowerCase();
      const readCount = (balanceReads.get(walletKey) ?? 0) + 1;
      balanceReads.set(walletKey, readCount);
      if (walletKey === WALLET_B.toLowerCase() && readCount === 2) {
        await slowWalletBVerification.promise;
      }
      return balances.get(walletKey) ?? 0n;
    });
    mocks.executeTrade.mockImplementation(async ({ walletAddress }: {
      walletAddress: string;
    }) => {
      balances.set(walletAddress.toLowerCase(), 0n);
      return {
        success: true,
        status: 'confirmed',
        txHash: `0xlinearized-sell-${walletAddress.slice(-2)}`,
      };
    });
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, walletAddress: string, callback: Function) => {
        const walletKey = walletAddress.toLowerCase();
        if (walletKey === WALLET_A.toLowerCase()) walletALeaseActive = true;
        const result = await callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
        if (walletKey === WALLET_A.toLowerCase()) {
          // markPureSellWalletCleared is private; its wallet-scoped success log
          // is the observable coverage transition. It must already exist while
          // the callback still owns A's lease.
          expect(task.logs.some(log => (
            log.type === 'success'
            && log.walletAddress?.toLowerCase() === WALLET_A.toLowerCase()
          ))).toBe(true);
          events.push('wallet-a-cleared-inside-lease');
          walletALeaseActive = false;
          events.push('wallet-a-lease-released');
          walletALeaseReleased.resolve();
        }
        return result;
      },
    );

    task = makeTask(4663, [WALLET_A, WALLET_B], {
      _id: 'server-task-zero-linearization',
    });
    task.config.interval = 60;
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 2;
    task.config.sellAll = true;
    task.config.stopType = 'none';
    const store = installTask(task);

    // This models another task already waiting to buy with A. Its write may
    // proceed immediately after A's lease is released, but not before the
    // zero-balance coverage transition inside that lease.
    const waitingBuy = (async () => {
      await walletALeaseReleased.promise;
      expect(walletALeaseActive).toBe(false);
      events.push('new-wallet-a-buy-after-release');
      balances.set(WALLET_A.toLowerCase(), 10n);
    })();

    const start = store.startTask(task.id);
    await waitingBuy;
    expect(events).toEqual([
      'wallet-a-cleared-inside-lease',
      'wallet-a-lease-released',
      'new-wallet-a-buy-after-release',
    ]);
    expect(task.status).toBe('running');
    expect(mocks.executeTrade).not.toHaveBeenCalled();

    slowWalletBVerification.resolve();
    await expect(start).resolves.toBe(true);
    await vi.waitFor(
      () => expect(mocks.executeTrade).toHaveBeenCalledTimes(1),
      { timeout: 2_000 },
    );
    await vi.waitFor(
      () => expect(task.status).toBe('stopped'),
      { timeout: 2_000 },
    );

    // A write that linearizes after A was cleared is a new operation, not a
    // stale-zero race. The whole-batch finalizer must observe the new balance,
    // reopen A, sell it, and only then complete at a fresh all-wallet zero
    // point.
    expect(events.slice(0, 3)).toEqual([
      'wallet-a-cleared-inside-lease',
      'wallet-a-lease-released',
      'new-wallet-a-buy-after-release',
    ]);
    expect(task.stats.sellCount).toBe(1);
    expect(mocks.executeTrade.mock.calls[0][0].walletAddress.toLowerCase())
      .toBe(WALLET_A.toLowerCase());
  });

  it('reallocates mixed directions after remote leases and preserves a sell when the original sell wallet is busy', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A, WALLET_B, WALLET_C, WALLET_D]);

    const busyError = Object.assign(
      new Error('TRANSFER_LEASE_BUSY: wallet is owned by another task'),
      { code: 'TRANSFER_LEASE_BUSY' },
    );
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, walletAddress: string, callback: Function) => {
        // Sell selection is intentionally first; WALLET_A is therefore the
        // original sell candidate. The remaining acquired wallets must be
        // reallocated to retain one real sell slot.
        if (walletAddress.toLowerCase() === WALLET_A.toLowerCase()) throw busyError;
        return callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
      },
    );
    mocks.executeTrade.mockImplementation(async ({ walletAddress, mode }: {
      walletAddress: string;
      mode: 'pump' | 'dump';
    }) => ({
      success: true,
      status: 'confirmed',
      txHash: `0xacquired-${mode}-${walletAddress.slice(-2)}`,
    }));

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C, WALLET_D], {
      _id: 'server-task-mixed-remote-reallocation',
    });
    task.config.buyThreadCount = 3;
    task.config.sellThreadCount = 1;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(
      () => expect(mocks.executeTrade).toHaveBeenCalledTimes(3),
      { timeout: 2_000 },
    );

    const executed = mocks.executeTrade.mock.calls.map(call => ({
      walletAddress: String(call[0].walletAddress).toLowerCase(),
      mode: call[0].mode as 'pump' | 'dump',
    }));
    expect(executed.filter(trade => trade.mode === 'pump')).toHaveLength(2);
    expect(executed.filter(trade => trade.mode === 'dump')).toHaveLength(1);
    expect(executed.map(trade => trade.walletAddress)).not.toContain(WALLET_A.toLowerCase());
    expect(executed.find(trade => trade.mode === 'dump')?.walletAddress)
      .toBe(WALLET_B.toLowerCase());
    expect(task.stats.buyCount).toBe(2);
    expect(task.stats.sellCount).toBe(1);
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('ignores an old start balance read that resolves zero after pause, token edit, and resume', async () => {
    installWallets([WALLET_A]);
    const oldBalanceRead = deferred<bigint>();
    const oldTokenAddress = '0x000000000000000000000000000000000000beef';
    const balanceReadTokens: string[] = [];
    mocks.readTokenBalance.mockImplementation(async (tokenAddress: string) => {
      balanceReadTokens.push(tokenAddress.toLowerCase());
      if (
        tokenAddress.toLowerCase() === oldTokenAddress.toLowerCase()
        && balanceReadTokens.filter(address => address === oldTokenAddress.toLowerCase()).length === 1
      ) {
        return oldBalanceRead.promise;
      }
      return 10n;
    });
    mocks.executeTrade.mockResolvedValue({
      success: false,
      status: 'failed',
      error: 'keep the resumed run open for the stale-start assertion',
    });

    const task = makeTask(4663, [WALLET_A]);
    task.config.interval = 60;
    task.config.stopType = 'none';
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 1;
    task.config.sellAll = true;
    const store = installTask(task);

    const oldStart = store.startTask(task.id);
    await vi.waitFor(() => expect(
      balanceReadTokens.filter(address => address === oldTokenAddress.toLowerCase()),
    ).toHaveLength(1));
    expect(task.status).toBe('running');

    expect(store.pauseTask(task.id)).toBe(true);
    expect(await store.updateTask(task.id, {
      config: {
        tokenContract: NEW_TOKEN_ADDRESS,
        innerTokenAddress: NEW_TOKEN_ADDRESS,
      },
    })).toBe(true);
    expect(await store.resumeTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));

    oldBalanceRead.resolve(0n);
    await expect(oldStart).resolves.toBe(false);
    await Promise.resolve();

    expect(task.config.tokenContract).toBe(NEW_TOKEN_ADDRESS);
    expect(task.status).toBe('running');
    expect(task.stats.sellCount).toBe(0);
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
    expect(
      balanceReadTokens.filter(address => address === oldTokenAddress.toLowerCase()),
    ).toHaveLength(1);
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('finishes a pure sell-all task only after every selected wallet is confirmed at zero balance', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    const balanceReads = new Map<string, number>();
    mocks.readTokenBalance.mockImplementation(async (
      _tokenAddress: string,
      walletAddress: string,
    ) => {
      const key = walletAddress.toLowerCase();
      const readCount = (balanceReads.get(key) ?? 0) + 1;
      balanceReads.set(key, readCount);
      if (key === WALLET_B.toLowerCase()) return 0n;
      return readCount === 1 ? 10n : 0n;
    });
    mocks.executeTrade.mockImplementation(async ({ walletAddress }: { walletAddress: string }) => ({
      success: true,
      status: 'confirmed',
      txHash: `0xsell${walletAddress.slice(-2)}`,
    }));

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.stopType = 'count';
    task.config.stopValue = 1;
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 20;
    task.config.sellAll = true;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(task.status).toBe('stopped'));

    // B was already empty, while A and C each needed a confirmed sale followed
    // by a second authoritative balance read. The count target of one must not
    // stop the clear-all task after only the first wallet.
    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(
      mocks.executeTrade.mock.calls.map(call => call[0].walletAddress.toLowerCase()),
    ).toEqual(expect.arrayContaining([
      WALLET_A.toLowerCase(),
      WALLET_C.toLowerCase(),
    ]));
    expect(task.stats.sellCount).toBe(2);
    // Every wallet is read once more under the final all-wallet lease barrier:
    // A/C after their post-sell reconciliation, and B after its initial
    // wallet-scoped zero verification.
    expect(balanceReads.get(WALLET_A.toLowerCase())).toBe(3);
    expect(balanceReads.get(WALLET_B.toLowerCase())).toBe(3);
    expect(balanceReads.get(WALLET_C.toLowerCase())).toBe(3);
    expect(task.logs.some(log => (
      log.message.includes('3/3 个钱包')
      && log.message.includes('同一钱包租约屏障内确认归零')
    ))).toBe(true);
  });

  it('does not let an old sell settlement clear a resumed task after its token changes', async () => {
    installWallets([WALLET_A]);
    const oldSettlement = deferred<{ status: 'confirmed' }>();
    const oldBroadcastAccepted = deferred<void>();
    let oldTokenBalanceReads = 0;
    mocks.readTokenBalance.mockImplementation(async (
      tokenAddress: string,
    ) => {
      if (tokenAddress.toLowerCase() === NEW_TOKEN_ADDRESS.toLowerCase()) return 10n;
      oldTokenBalanceReads++;
      return oldTokenBalanceReads === 1 ? 10n : 0n;
    });
    mocks.executeTrade.mockImplementationOnce(async (params: {
      walletAddress: string;
      onTransactionHash?: (hash: string, kind: 'trade') => void;
      robinhoodBroadcastParticipant?: {
        arrive: (broadcast: () => Promise<void>) => Promise<void>;
      };
    }) => {
      await params.robinhoodBroadcastParticipant?.arrive(async () => undefined);
      params.onTransactionHash?.('0xold-run', 'trade');
      oldBroadcastAccepted.resolve();
      return {
        success: true,
        status: 'broadcast',
        txHash: '0xold-run',
        settlement: oldSettlement.promise,
      };
    });

    const task = makeTask(4663, [WALLET_A]);
    task.config.stopType = 'none';
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 1;
    task.config.sellAll = true;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await oldBroadcastAccepted.promise;
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));
    expect(store.pauseTask(task.id)).toBe(true);
    expect(await store.updateTask(task.id, {
      config: {
        tokenContract: NEW_TOKEN_ADDRESS,
        innerTokenAddress: NEW_TOKEN_ADDRESS,
      },
    })).toBe(true);
    expect(await store.resumeTask(task.id)).toBe(true);
    expect(task.status).toBe('running');

    oldSettlement.resolve({ status: 'confirmed' });
    await vi.waitFor(() => expect(task.logs.some(log => (
      log.message.includes('旧运行批次交易已确认')
    ))).toBe(true));

    // The old token would now read zero. Without the run/coverage fence this
    // stale callback marked the same wallet cleared for the new token and
    // stopped the resumed task.
    expect(oldTokenBalanceReads).toBe(1);
    expect(task.stats.sellCount).toBe(0);
    expect(task.status).toBe('running');
    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
  });

  it('skips one remotely busy pure-sell wallet before the barrier and sells the other free wallets', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A, WALLET_B, WALLET_C]);

    const busyError = Object.assign(
      new Error('TRANSFER_LEASE_BUSY: wallet is owned by another task'),
      { code: 'TRANSFER_LEASE_BUSY' },
    );
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, walletAddress: string, callback: Function) => {
        if (walletAddress.toLowerCase() === WALLET_A.toLowerCase()) throw busyError;
        return callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
      },
    );

    const balanceReads = new Map<string, number>();
    mocks.readTokenBalance.mockImplementation(async (
      _tokenAddress: string,
      walletAddress: string,
    ) => {
      const key = walletAddress.toLowerCase();
      const readCount = (balanceReads.get(key) ?? 0) + 1;
      balanceReads.set(key, readCount);
      return readCount === 1 ? 10n : 0n;
    });
    const broadcastedWallets: string[] = [];
    mocks.executeTrade.mockImplementation(async (params: {
      walletAddress: string;
      robinhoodBroadcastParticipant?: {
        arrive: (broadcast: () => Promise<void>) => Promise<void>;
      };
    }) => {
      await params.robinhoodBroadcastParticipant?.arrive(async () => {
        broadcastedWallets.push(params.walletAddress.toLowerCase());
      });
      return {
        success: true,
        status: 'confirmed',
        txHash: `0xremote${params.walletAddress.slice(-2)}`,
      };
    });

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C], {
      _id: 'server-task-remote-busy',
    });
    task.config.stopType = 'none';
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 20;
    task.config.sellAll = true;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(
      () => expect(mocks.executeTrade).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );
    await vi.waitFor(
      () => expect(task.stats.sellCount).toBe(2),
      { timeout: 2_000 },
    );

    const executedWallets = mocks.executeTrade.mock.calls
      .map(call => String(call[0].walletAddress).toLowerCase());
    expect(executedWallets).toEqual(expect.arrayContaining([
      WALLET_B.toLowerCase(),
      WALLET_C.toLowerCase(),
    ]));
    expect(executedWallets).not.toContain(WALLET_A.toLowerCase());
    expect(broadcastedWallets).toEqual(expect.arrayContaining([
      WALLET_B.toLowerCase(),
      WALLET_C.toLowerCase(),
    ]));
    expect(task.status).toBe('running');
    expect(task.stats.sellCount).toBe(2);
    expect(balanceReads.get(WALLET_A.toLowerCase())).toBe(1);
    expect(task.logs.some(log => (
      log.message.includes('本轮跳过 1 个正被其他任务使用的钱包')
    ))).toBe(true);
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('keeps a buy task running when its only wallet lease is temporarily busy', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    const busyError = Object.assign(
      new Error('TRANSFER_LEASE_BUSY: wallet is owned by another task'),
      { code: 'TRANSFER_LEASE_BUSY' },
    );
    let remoteBusy = true;
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, _walletAddress: string, callback: Function) => {
        if (remoteBusy) throw busyError;
        return callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
      },
    );
    mocks.executeTrade.mockResolvedValue({
      success: true,
      status: 'confirmed',
      txHash: '0xbuy-after-wallet-release',
    });

    const task = makeTask(4663, [WALLET_A], {
      id: 'busy-wallet-buy-task',
      _id: 'server-busy-wallet-buy-task',
    });
    task.config.marketType = 'outer';
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.sellAll = false;
    task.config.stopType = 'none';
    task.config.interval = 0.05;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(() => expect(mocks.withTransferLease).toHaveBeenCalled());
    expect(task.status).toBe('running');
    expect(mocks.executeTrade).not.toHaveBeenCalled();

    remoteBusy = false;
    await vi.waitFor(
      () => expect(mocks.executeTrade).toHaveBeenCalled(),
      { timeout: 2_000 },
    );
    expect(task.status).toBe('running');
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('does not let a remotely busy wallet needing approval block an already-authorized wallet at startup', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A, WALLET_B]);

    const busyError = Object.assign(
      new Error('TRANSFER_LEASE_BUSY: wallet is owned by another task'),
      { code: 'TRANSFER_LEASE_BUSY' },
    );
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, walletAddress: string, callback: Function) => {
        if (walletAddress.toLowerCase() === WALLET_A.toLowerCase()) throw busyError;
        return callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
      },
    );
    mocks.checkV3SellApproval.mockImplementation(async (
      _tokenAddress: string,
      walletAddress: string,
    ) => (
      walletAddress.toLowerCase() === WALLET_A.toLowerCase()
        ? { ready: false, allowance: 0n }
        : { ready: true, allowance: 1n }
    ));

    const balanceReads = new Map<string, number>();
    mocks.readTokenBalance.mockImplementation(async (
      _tokenAddress: string,
      walletAddress: string,
    ) => {
      const key = walletAddress.toLowerCase();
      const readCount = (balanceReads.get(key) ?? 0) + 1;
      balanceReads.set(key, readCount);
      return key === WALLET_B.toLowerCase() && readCount > 1 ? 0n : 10n;
    });

    const broadcastedWallets: string[] = [];
    mocks.executeTrade.mockImplementation(async (params: {
      walletAddress: string;
      robinhoodBroadcastParticipant?: {
        arrive: (broadcast: () => Promise<void>) => Promise<void>;
      };
    }) => {
      await params.robinhoodBroadcastParticipant?.arrive(async () => {
        broadcastedWallets.push(params.walletAddress.toLowerCase());
      });
      return {
        success: true,
        status: 'confirmed',
        txHash: `0xstartup${params.walletAddress.slice(-2)}`,
      };
    });

    const task = makeTask(4663, [WALLET_A, WALLET_B], {
      _id: 'server-task-startup-busy-approval',
    });
    task.config.stopType = 'none';
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 20;
    task.config.sellAll = true;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(
      () => expect(task.stats.sellCount).toBe(1),
      { timeout: 2_000 },
    );

    expect(task.status).toBe('running');
    expect(mocks.ensureV3SellApproval).not.toHaveBeenCalled();
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
    expect(mocks.executeTrade.mock.calls[0][0].walletAddress.toLowerCase())
      .toBe(WALLET_B.toLowerCase());
    expect(broadcastedWallets).toEqual([WALLET_B.toLowerCase()]);
    expect(balanceReads.get(WALLET_A.toLowerCase())).toBe(1);
    expect(task.logs.some(log => (
      log.walletAddress?.toLowerCase() === WALLET_A.toLowerCase()
      && log.message.includes('当前不可安全认定清仓')
      && log.message.includes('保留在清仓队列')
    ))).toBe(true);
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('cancels the first strict batch for one missing key, then lets healthy wallets sell during its backoff', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A, WALLET_B, WALLET_C]);

    let removedFailingKey = false;
    mocks.withTransferLease.mockImplementation(
      async (_chainId: number, walletAddress: string, callback: Function) => {
        if (
          !removedFailingKey
          && walletAddress.toLowerCase() === WALLET_A.toLowerCase()
        ) {
          removedFailingKey = true;
          mocks.walletStore.localWallets = mocks.walletStore.localWallets.filter(
            wallet => wallet.address.toLowerCase() !== WALLET_A.toLowerCase(),
          );
        }
        return callback({
          assertActive: vi.fn(),
          retainUntil: mocks.retainUntil,
        });
      },
    );

    const broadcastedWallets: string[] = [];
    const cancelledWallets: string[] = [];
    mocks.executeTrade.mockImplementation(async (params: {
      walletAddress: string;
      robinhoodBroadcastParticipant?: {
        arrive: (
          broadcast: () => Promise<void>,
          cancel: () => void,
        ) => Promise<void>;
      };
    }) => {
      await params.robinhoodBroadcastParticipant?.arrive(
        async () => {
          broadcastedWallets.push(params.walletAddress.toLowerCase());
        },
        () => {
          cancelledWallets.push(params.walletAddress.toLowerCase());
        },
      );
      return {
        success: true,
        status: 'confirmed',
        txHash: `0xretry${params.walletAddress.slice(-2)}`,
      };
    });

    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C], {
      _id: 'server-task-preparation-backoff',
    });
    task.config.stopType = 'none';
    task.config.interval = 0.1;
    task.config.buyThreadCount = 0;
    task.config.sellThreadCount = 20;
    task.config.sellAll = true;
    const store = installTask(task);

    expect(await store.startTask(task.id)).toBe(true);
    await vi.waitFor(
      () => expect(cancelledWallets).toEqual(expect.arrayContaining([
        WALLET_B.toLowerCase(),
        WALLET_C.toLowerCase(),
      ])),
      { timeout: 2_000 },
    );
    expect(broadcastedWallets).toEqual([]);
    expect(task.logs.some(log => (
      log.walletAddress?.toLowerCase() === WALLET_A.toLowerCase()
      && log.message.includes('连续失败 1 次')
      && log.message.includes('本轮整批 0 广播')
    ))).toBe(true);

    // Wallet A is excluded by its one-second retry window. B and C therefore
    // form the next strict cohort by themselves instead of being cancelled
    // forever by the same broken wallet.
    await vi.waitFor(
      () => expect(broadcastedWallets).toEqual(expect.arrayContaining([
        WALLET_B.toLowerCase(),
        WALLET_C.toLowerCase(),
      ])),
      { timeout: 3_000 },
    );
    await vi.waitFor(
      () => expect(task.stats.sellCount).toBeGreaterThanOrEqual(2),
      { timeout: 2_000 },
    );
    expect(task.status).toBe('running');
    expect(store.stopTask(task.id)).toBe(true);
  });

  it('does not force-take over another page for creation-time Pons sell preparation', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    mocks.createServerTask.mockResolvedValueOnce({
      _id: 'server-task-background-preparation-busy',
    });
    mocks.getTaskRuntimeStatus.mockResolvedValue({
      running: true,
      runtime: {
        runtimeId: 'other-page-runtime',
        clientInstanceId: 'other-page-client',
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });
    mocks.startTaskRuntime.mockRejectedValueOnce(Object.assign(
      new Error('runtime is owned by another active page'),
      { code: 'TASK_RUNTIME_BUSY' },
    ));

    const config = { ...makeTask(4663, [WALLET_A]).config };
    config.buyThreadCount = 0;
    config.sellThreadCount = 1;
    config.sellAll = true;
    config.stopType = 'none';
    const store = useTaskStore();

    const task = await store.createTask(
      'background preparation must not take over',
      config,
      [WALLET_A],
    );
    await vi.waitFor(() => expect(
      task.logs.some(log => log.message.includes('runtime is owned by another active page')),
    ).toBe(true));

    expect(task.id).toBe('server-task-background-preparation-busy');
    expect(task.status).toBe('stopped');
    expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.getTaskRuntimeStatus).not.toHaveBeenCalled();
    expect(mocks.stopTaskRuntime).not.toHaveBeenCalled();
    expect(mocks.ensureV3SellApproval).not.toHaveBeenCalled();
  });

  it('hands the creation-time Pons runtime to Start without revoking it during the stopped-to-running gap', async () => {
    mocks.serverMode = true;
    mocks.loggedIn = true;
    installWallets([WALLET_A]);

    mocks.createServerTask.mockResolvedValueOnce({
      _id: 'server-task-background-runtime-handoff',
    });
    mocks.startTaskRuntime.mockResolvedValueOnce({
      runtimeId: 'runtime-a',
      runtimeToken: 'runtime-token-a',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      runtimeDurationMs: 120_000,
      heartbeatIntervalMs: 60_000,
    });
    const preparationGate = deferred<void>();
    mocks.warmupV3SellPreparation.mockReturnValueOnce(preparationGate.promise);
    mocks.executeTrade.mockResolvedValue({
      success: true,
      status: 'confirmed',
      txHash: '0xruntime-handoff-sell',
    });

    const config = { ...makeTask(4663, [WALLET_A]).config };
    config.sellThreadCount = 1;
    config.sellAll = false;
    config.stopType = 'none';
    const store = useTaskStore();

    const task = await store.createTask(
      'Pons background runtime handoff',
      config,
      [WALLET_A],
    );
    await vi.waitFor(() => expect(mocks.warmupV3SellPreparation).toHaveBeenCalledTimes(1));
    expect(task.remoteRuntimeId).toBe('runtime-a');
    expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(1);

    const start = store.startTask(task.id);
    // startTask installs its synchronous latch before its first await. The
    // background preparation is now allowed to finish while the UI task has
    // not yet crossed the stopped -> running handoff.
    expect(task.status).toBe('stopped');
    preparationGate.resolve();

    await expect(start).resolves.toBe(true);
    expect(task.status).toBe('running');
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
    expect(mocks.startTaskRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.stopTaskRuntime).not.toHaveBeenCalled();
  });

  it('prepares Pons sell approval at task creation and reuses the same job at Start', async () => {
    installWallets([WALLET_A, WALLET_B]);
    const approvalGate = deferred<void>();
    let approvalsReady = false;
    mocks.checkV3SellApproval.mockImplementation(async () => (
      approvalsReady ? { ready: true } : { ready: false, allowance: 0n }
    ));
    mocks.ensureV3SellApproval.mockImplementation(async () => {
      await approvalGate.promise;
      approvalsReady = true;
      return { success: true, status: 'confirmed' };
    });
    mocks.executeTrade.mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xsell' });
    const config = { ...makeTask(4663, [WALLET_A, WALLET_B]).config };
    config.sellThreadCount = 2;
    config.stopType = 'count';
    config.stopValue = 2;
    const store = useTaskStore();

    const task = await store.createTask('Pons prepared sell', config, [WALLET_A, WALLET_B]);
    await vi.waitFor(() => expect(mocks.ensureV3SellApproval).toHaveBeenCalledTimes(2));
    expect(task.status).toBe('stopped');
    expect(mocks.ensureV3SellApproval.mock.calls.every(call => call[1] === 0n)).toBe(true);
    expect(mocks.warmupV3SellPreparation).toHaveBeenCalledTimes(1);

    const start = store.startTask(task.id);
    await Promise.resolve();
    expect(mocks.executeTrade).not.toHaveBeenCalled();
    approvalGate.resolve();

    await expect(start).resolves.toBe(true);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    // Start performs only the in-memory ready check; it does not rebroadcast
    // approvals that were already sent by the creation-time job.
    expect(mocks.ensureV3SellApproval).toHaveBeenCalledTimes(2);
  });

  it('runs two same-token tasks concurrently when they use different wallets', async () => {
    installWallets([WALLET_A, WALLET_B]);
    const firstTaskReceipt = deferred<{ success: boolean; status: 'confirmed'; txHash: string }>();
    const secondTaskReceipt = deferred<{ success: boolean; status: 'confirmed'; txHash: string }>();
    mocks.executeTrade.mockImplementation(({ walletAddress }: { walletAddress: string }) => (
      walletAddress.toLowerCase() === WALLET_A.toLowerCase()
        ? firstTaskReceipt.promise
        : secondTaskReceipt.promise
    ));

    const taskA = makeTask(4663, [WALLET_A], { id: 'parallel-task-a' });
    const taskB = makeTask(4663, [WALLET_B], { id: 'parallel-task-b' });
    taskA.config.sellThreadCount = 1;
    taskB.config.sellThreadCount = 1;
    taskA.config.stopType = 'count';
    taskB.config.stopType = 'count';
    taskA.config.stopValue = 1;
    taskB.config.stopValue = 1;
    const store = useTaskStore();
    store.tasks = [taskA, taskB];

    const executionA = store.startTask(taskA.id);
    const executionB = store.startTask(taskB.id);

    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    expect(store.tasks.every(task => task.status === 'running')).toBe(true);

    firstTaskReceipt.resolve({ success: true, status: 'confirmed', txHash: '0xparallel-a' });
    secondTaskReceipt.resolve({ success: true, status: 'confirmed', txHash: '0xparallel-b' });
    await Promise.all([executionA, executionB]);

    expect(mocks.executeTrade.mock.calls.map(call => call[0].walletAddress))
      .toEqual(expect.arrayContaining([WALLET_A, WALLET_B]));
  });

  it('keeps both tasks running and retries only the shared wallet after its lease is released', async () => {
    installWallets([WALLET_A]);
    const firstTaskReceipt = deferred<{ success: boolean; status: 'confirmed'; txHash: string }>();
    const secondTaskReceipt = deferred<{ success: boolean; status: 'confirmed'; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => firstTaskReceipt.promise)
      .mockImplementationOnce(() => secondTaskReceipt.promise);

    const taskA = makeTask(4663, [WALLET_A], { id: 'shared-wallet-task-a' });
    const taskB = makeTask(4663, [WALLET_A], { id: 'shared-wallet-task-b' });
    for (const task of [taskA, taskB]) {
      task.config.sellThreadCount = 1;
      task.config.stopType = 'count';
      task.config.stopValue = 1;
      task.config.interval = 0.1;
    }
    const store = useTaskStore();
    store.tasks = [taskA, taskB];

    const executionA = store.startTask(taskA.id);
    const executionB = store.startTask(taskB.id);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    expect(store.tasks.every(task => task.status === 'running')).toBe(true);

    firstTaskReceipt.resolve({ success: true, status: 'confirmed', txHash: '0xshared-a' });
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    secondTaskReceipt.resolve({ success: true, status: 'confirmed', txHash: '0xshared-b' });
    await Promise.all([executionA, executionB]);

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
  });

  it('releases the shared wallet after accepted hashes so two tasks pipeline consecutive transactions', async () => {
    installWallets([WALLET_A]);
    const settlementA = deferred<{ status: 'confirmed' }>();
    const settlementB = deferred<{ status: 'confirmed' }>();
    mocks.executeTrade
      .mockResolvedValueOnce({
        success: true,
        status: 'broadcast',
        txHash: '0xpipelined-a',
        settlement: settlementA.promise,
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'broadcast',
        txHash: '0xpipelined-b',
        settlement: settlementB.promise,
      });

    const taskA = makeTask(4663, [WALLET_A], { id: 'pipelined-wallet-task-a' });
    const taskB = makeTask(4663, [WALLET_A], { id: 'pipelined-wallet-task-b' });
    for (const task of [taskA, taskB]) {
      task.config.marketType = 'outer';
      task.config.buyThreadCount = 1;
      task.config.sellThreadCount = 0;
      task.config.sellAll = false;
      task.config.stopType = 'none';
      task.config.interval = 60;
    }
    const store = useTaskStore();
    store.tasks = [taskA, taskB];

    expect(await store.startTask(taskA.id)).toBe(true);
    expect(await store.startTask(taskB.id)).toBe(true);
    await vi.waitFor(
      () => expect(mocks.executeTrade).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );

    // Neither receipt has settled, but both accepted hashes have already left
    // the short wallet critical section and both tasks remain schedulable.
    expect(taskA.stats.buyCount).toBe(0);
    expect(taskB.stats.buyCount).toBe(0);
    expect(taskA.status).toBe('running');
    expect(taskB.status).toBe('running');

    settlementA.resolve({ status: 'confirmed' });
    settlementB.resolve({ status: 'confirmed' });
    await vi.waitFor(() => {
      expect(taskA.stats.buyCount).toBe(1);
      expect(taskB.stats.buyCount).toBe(1);
    });
    expect(store.stopTask(taskA.id)).toBe(true);
    expect(store.stopTask(taskB.id)).toBe(true);
  });

  it('does not schedule the same wallet twice when thread count exceeds wallet count', async () => {
    installWallets([WALLET_A, WALLET_B]);
    mocks.executeTrade.mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xok' });

    const task = makeTask(4663, [WALLET_A, WALLET_B]);
    task.config.buyThreadCount = 5;
    task.config.sellThreadCount = 0;
    task.config.stopType = 'count';
    task.config.stopValue = 2;
    const store = installTask(task);

    await store.startTask(task.id);

    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    expect(new Set(mocks.executeTrade.mock.calls.map(call => call[0].walletAddress.toLowerCase())).size).toBe(2);
  });

  it('keeps fixed-rate Robinhood ticks moving across free wallets while an older hash confirms', async () => {
    installWallets([WALLET_A, WALLET_B]);
    const firstSettlement = deferred<{ status: 'confirmed' }>();
    mocks.executeTrade.mockImplementation(({ walletAddress }: { walletAddress: string }) => {
      if (walletAddress.toLowerCase() === WALLET_A.toLowerCase()) {
        return Promise.resolve({
          success: true,
          status: 'broadcast',
          txHash: '0xknown-a',
          settlement: firstSettlement.promise,
        });
      }
      return Promise.resolve({ success: true, status: 'confirmed', txHash: '0xconfirmed-b' });
    });

    const task = makeTask(4663, [WALLET_A, WALLET_B]);
    task.config.interval = 0.2;
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.stopType = 'none';
    const store = installTask(task);

    await store.startTask(task.id);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));

    expect(mocks.executeTrade.mock.calls[0][0].walletAddress).toBe(WALLET_A);
    expect(mocks.executeTrade.mock.calls[1][0].walletAddress).toBe(WALLET_B);
    expect(mocks.executeTrade.mock.calls[0][0].awaitConfirmation).toBe(false);
    expect(mocks.validatePons).toHaveBeenCalledTimes(1);
    expect(store.pauseTask(task.id)).toBe(true);

    firstSettlement.resolve({ status: 'confirmed' });
    await vi.waitFor(() => expect(store.tasks[0].stats.buyCount).toBe(2));
    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
  });
});

describe.each([
  { chainId: 4663 as const, label: 'Robinhood Uniswap V3' },
  { chainId: 56 as const, label: 'BSC Pancake V2' },
])('$label task batch sell ordering', ({ chainId }) => {
  it('does not start the next wallet until the previous wallet is confirmed', async () => {
    installWallets([WALLET_A, WALLET_B]);
    const first = deferred<{ success: boolean; status: string; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0x02' });

    const store = installTask(makeTask(chainId, [WALLET_A, WALLET_B]));
    const execution = store.batchSellForTask(`task-${chainId}`);

    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    expect(mocks.executeTrade.mock.calls[0][0].walletAddress).toBe(WALLET_A);
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);

    first.resolve({ success: true, status: 'confirmed', txHash: '0x01' });
    await execution;

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(mocks.executeTrade.mock.calls[1][0].walletAddress).toBe(WALLET_B);
    expect(mocks.executeTrade.mock.calls[0][0].balancePercent).toBe(100);
    expect(mocks.executeTrade.mock.calls[1][0].balancePercent).toBe(100);
    expect(mocks.executeTrade.mock.calls[0][0].slippage).toBe(chainId === 4663 ? 12 : 30);
    expect(mocks.createTradingService).toHaveBeenCalledTimes(1);
    if (chainId === 4663) {
      expect(mocks.validatePons).toHaveBeenCalledTimes(1);
    }
  });
});

describe('ambiguous broadcast results', () => {
  it.each(['pending', 'unknown'] as const)(
    'keeps a %s hash protected while later wallets continue',
    async (status) => {
      const ambiguousHash = `0x${'ac'.repeat(32)}`;
      installWallets([WALLET_A, WALLET_B, WALLET_C]);
      mocks.executeTrade
        .mockResolvedValueOnce({
          success: false,
          status,
          txHash: ambiguousHash,
          error: 'receipt unavailable',
        })
        .mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xconfirmed' });

      const store = installTask(makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]));
      await store.batchSellForTask('task-4663');

      expect(mocks.executeTrade).toHaveBeenCalledTimes(3);
      expect(mocks.executeTrade.mock.calls[0][0].walletAddress).toBe(WALLET_A);
      expect(mocks.executeTrade.mock.calls.slice(1).map(call => call[0].walletAddress))
        .toEqual([WALLET_B, WALLET_C]);
      expect(store.tasks[0].logs.some(log => log.txHash === ambiguousHash)).toBe(true);
      expect(taskLogs(store).some(message => message.includes('继续处理后续钱包'))).toBe(true);

      // 再次点击和自动任务都会只跳过 A；不会重发 A，也不会因 A
      // 阻塞 B/C 或把整个自动任务暂停。
      await store.batchSellForTask('task-4663');
      expect(await store.startTask('task-4663')).toBe(true);
      await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(7));
      expect(mocks.executeTrade.mock.calls.filter(call => call[0].walletAddress === WALLET_A))
        .toHaveLength(1);
      expect(store.tasks[0].status).toBe('running');
      expect(taskLogs(store).some(message => message.includes('只暂时跳过该钱包'))).toBe(true);
      store.pauseTask('task-4663');
    },
  );
});

describe('task/manual sell mutual exclusion', () => {
  it('pauses a running task and waits for its active round before manual batch sell starts', async () => {
    installWallets([WALLET_A]);
    const activeRound = deferred<{ success: boolean; status: string; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => activeRound.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0xmanual' });

    const task = makeTask(4663, [WALLET_A], { status: 'paused' });
    task.config.sellThreadCount = 1;
    const store = installTask(task);
    const automaticExecution = store.startTask(task.id);

    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    const manualExecution = store.batchSellForTask(task.id);

    await vi.waitFor(() => expect(store.tasks[0].status).toBe('paused'));
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);

    activeRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic' });
    await Promise.all([automaticExecution, manualExecution]);

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(store.tasks[0].status).toBe('paused');
  });

  it('still drains an active round when the user paused the task before clicking batch sell', async () => {
    installWallets([WALLET_A]);
    const activeRound = deferred<{ success: boolean; status: string; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => activeRound.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0xmanual-after-pause' });

    const task = makeTask(4663, [WALLET_A]);
    task.config.sellThreadCount = 1;
    const store = installTask(task);
    const automaticExecution = store.startTask(task.id);

    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));
    expect(store.pauseTask(task.id)).toBe(true);
    const manualExecution = store.batchSellForTask(task.id);

    await Promise.resolve();
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);

    activeRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic-before-pause' });
    await Promise.all([automaticExecution, manualExecution]);

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(store.tasks[0].status).toBe('paused');
  });

  it('pauses only the manual target while another task skips the shared wallet', async () => {
    installWallets([WALLET_A]);
    const firstRound = deferred<{ success: boolean; status: string; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => firstRound.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0xmanual' });

    const taskA = makeTask(4663, [WALLET_A], { id: 'task-a' });
    const taskB = makeTask(4663, [WALLET_A], { id: 'task-b' });
    taskA.config.sellThreadCount = 1;
    taskB.config.sellThreadCount = 1;
    const store = useTaskStore();
    store.tasks = [taskA, taskB];

    const automaticA = store.startTask(taskA.id);
    const automaticB = store.startTask(taskB.id);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(1));

    const manualExecution = store.batchSellForTask(taskA.id);
    await vi.waitFor(() => {
      expect(store.tasks.find(task => task.id === taskA.id)?.status).toBe('paused');
      expect(store.tasks.find(task => task.id === taskB.id)?.status).toBe('running');
    });
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);

    firstRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic-a' });
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    await Promise.all([automaticA, automaticB, manualExecution]);

    // task-b 已经排进本地钱包队列，但批卖接管该钱包后只取消这个钱包，
    // 不暂停 task-b；第二次调用来自手工卖出。
    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(store.tasks.find(task => task.id === taskA.id)?.status).toBe('paused');
    expect(store.tasks.find(task => task.id === taskB.id)?.status).toBe('running');
    expect(store.stopTask(taskB.id)).toBe(true);
  });

  it('keeps a different-wallet task on the same chain and token running during manual sell', async () => {
    installWallets([WALLET_A, WALLET_B]);
    const activeRound = deferred<{ success: boolean; status: string; txHash: string }>();
    const secondActiveRound = deferred<{ success: boolean; status: string; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => activeRound.promise)
      .mockImplementationOnce(() => secondActiveRound.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0xmanual-same-token' });

    const taskA = makeTask(4663, [WALLET_A], { id: 'same-token-a' });
    const taskB = makeTask(4663, [WALLET_B], { id: 'same-token-b' });
    taskA.config.sellThreadCount = 1;
    taskB.config.sellThreadCount = 1;
    const store = useTaskStore();
    store.tasks = [taskA, taskB];

    const automaticA = store.startTask(taskA.id);
    const automaticB = store.startTask(taskB.id);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));

    const manualExecution = store.batchSellForTask(taskA.id);
    await vi.waitFor(() => {
      expect(store.tasks.find(task => task.id === taskA.id)?.status).toBe('paused');
      expect(store.tasks.find(task => task.id === taskB.id)?.status).toBe('running');
    });
    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);

    // The same-token task remains live because its source wallet is distinct.
    // Stop it explicitly only to keep the test's fixed-rate timer from
    // dispatching a later round after this assertion.
    expect(store.stopTask(taskB.id)).toBe(true);
    activeRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic-same-token' });
    secondActiveRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic-task-b' });
    await Promise.all([automaticA, automaticB, manualExecution]);

    expect(mocks.executeTrade).toHaveBeenCalledTimes(3);
    expect(mocks.executeTrade.mock.calls[2][0].walletAddress).toBe(WALLET_A);
    expect(store.tasks.find(task => task.id === taskA.id)?.status).toBe('paused');
    expect(store.tasks.find(task => task.id === taskB.id)?.status).toBe('stopped');
  });
});

describe('BSC FourMeme manual batch sell', () => {
  it('completes prepare and final sell result wallet-by-wallet instead of using two concurrent phases', async () => {
    installWallets([WALLET_A, WALLET_B]);
    mocks.prepareFourMemeSell.mockResolvedValue({
      success: true,
      needsApproval: false,
      sellAmount: 123n,
    });
    const firstFinalResult = deferred<{ success: boolean; status: 'confirmed'; txHash: string }>();
    mocks.executeFourMemeSell
      .mockImplementationOnce(() => firstFinalResult.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0xbsc-2' });

    const task = makeTask(56, [WALLET_A, WALLET_B]);
    task.config.marketType = 'inner';
    task.config.innerTokenAddress = task.config.tokenContract;
    const store = installTask(task);
    const execution = store.batchSellForTask(task.id);

    await vi.waitFor(() => expect(mocks.executeFourMemeSell).toHaveBeenCalledTimes(1));
    expect(mocks.prepareFourMemeSell).toHaveBeenCalledTimes(1);
    expect(mocks.prepareFourMemeSell.mock.calls[0][0].walletAddress).toBe(WALLET_A);

    firstFinalResult.resolve({ success: true, status: 'confirmed', txHash: '0xbsc-1' });
    await execution;

    expect(mocks.createFourMemeService).toHaveBeenCalledWith(
      56,
      'http://unused.test',
      'http://premium.test',
    );
    expect(mocks.prepareFourMemeSell).toHaveBeenCalledTimes(2);
    expect(mocks.executeFourMemeSell).toHaveBeenCalledTimes(2);
    expect(mocks.prepareFourMemeSell.mock.calls[1][0].walletAddress).toBe(WALLET_B);
    expect(mocks.executeFourMemeSell.mock.calls[1][0].walletAddress).toBe(WALLET_B);
  });

  it('protects a broadcast hash with no final receipt and continues later wallets', async () => {
    const pendingHash = `0x${'bc'.repeat(32)}`;
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.prepareFourMemeSell.mockResolvedValue({
      success: true,
      needsApproval: false,
      sellAmount: 123n,
    });
    mocks.executeFourMemeSell
      .mockResolvedValueOnce({
        success: true,
        status: 'pending',
        txHash: pendingHash,
        transactionKind: 'trade',
        reconciliationRpcUrl: 'http://unused.test',
        receiptRequired: true,
      })
      .mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xbsc-confirmed' });
    const task = makeTask(56, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.marketType = 'inner';
    task.config.innerTokenAddress = task.config.tokenContract;
    const store = installTask(task);
    await store.batchSellForTask(task.id);

    expect(mocks.prepareFourMemeSell).toHaveBeenCalledTimes(3);
    expect(mocks.executeFourMemeSell).toHaveBeenCalledTimes(3);
    expect(store.tasks[0].logs.some(log => log.txHash === pendingHash)).toBe(true);
    expect(getUnresolvedTransaction(56, WALLET_A)).toMatchObject({
      txHash: pendingHash,
      rpcUrl: 'http://unused.test',
      receiptRequired: true,
    });
    expect(taskLogs(store).some(message => message.includes('继续处理后续钱包'))).toBe(true);
  });

  it('does not retry an unresolved approval wallet but continues with later wallets', async () => {
    const approvalHash = `0x${'ad'.repeat(32)}`;
    installWallets([WALLET_A, WALLET_B]);
    mocks.prepareFourMemeSell
      .mockResolvedValueOnce({
        success: false,
        status: 'pending',
        transactionKind: 'approval',
        reconciliationRpcUrl: 'http://unused.test',
        receiptRequired: true,
        txHash: approvalHash,
        error: 'peer approval receipt pending',
      })
      .mockResolvedValueOnce({
        success: true,
        needsApproval: false,
        sellAmount: 123n,
      });
    mocks.executeFourMemeSell.mockResolvedValue({
      success: true,
      status: 'confirmed',
      txHash: `0x${'ae'.repeat(32)}`,
    });
    const task = makeTask(56, [WALLET_A, WALLET_B]);
    task.config.marketType = 'inner';
    task.config.innerTokenAddress = task.config.tokenContract;
    const store = installTask(task);

    await store.batchSellForTask(task.id);

    expect(mocks.prepareFourMemeSell).toHaveBeenCalledTimes(2);
    expect(mocks.prepareFourMemeSell.mock.calls.map(call => call[0].walletAddress))
      .toEqual([WALLET_A, WALLET_B]);
    expect(mocks.executeFourMemeSell).toHaveBeenCalledTimes(1);
    expect(mocks.executeFourMemeSell.mock.calls[0][0].walletAddress).toBe(WALLET_B);
    expect(taskLogs(store).some(message => message.includes('授权不改变曲线，继续处理后续钱包'))).toBe(true);
  });
});

describe('outer-market approval-only ambiguity', () => {
  it('continues later wallets without retrying the wallet whose approval is unresolved', async () => {
    const approvalHash = `0x${'af'.repeat(32)}`;
    installWallets([WALLET_A, WALLET_B]);
    mocks.executeTrade
      .mockResolvedValueOnce({
        success: false,
        status: 'pending',
        transactionKind: 'approval',
        txHash: approvalHash,
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'confirmed',
        txHash: `0x${'b0'.repeat(32)}`,
      });
    const store = installTask(makeTask(56, [WALLET_A, WALLET_B]));

    await store.batchSellForTask('task-56');

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(mocks.executeTrade.mock.calls.map(call => call[0].walletAddress))
      .toEqual([WALLET_A, WALLET_B]);
    expect(taskLogs(store).some(message => message.includes('继续处理后续钱包'))).toBe(true);
  });
});

describe('BSC FourMeme automatic fast-path allowance direction', () => {
  it.each([
    {
      buyAllowanceSufficient: true,
      sellAllowanceSufficient: false,
      fastDirection: 'buy' as const,
      slowDirection: 'sell' as const,
    },
    {
      buyAllowanceSufficient: false,
      sellAllowanceSufficient: true,
      fastDirection: 'sell' as const,
      slowDirection: 'buy' as const,
    },
  ])(
    'uses each direction own allowance when the same wallet buys and sells (fast $fastDirection)',
    async ({ buyAllowanceSufficient, sellAllowanceSufficient, fastDirection, slowDirection }) => {
      installWallets([WALLET_A]);
      mocks.batchPrepareFourMemeRound.mockResolvedValue(new Map([[WALLET_A.toLowerCase(), {
        tokenBalance: 123n,
        buyAllowanceSufficient,
        sellAllowanceSufficient,
      }]]));
      mocks.executeFourMemeTradeFast.mockResolvedValue({
        success: true,
        status: 'confirmed',
        txHash: '0xfast',
      });
      mocks.executeFourMemeTrade.mockResolvedValue({
        success: true,
        status: 'confirmed',
        txHash: '0xslow',
      });

      const task = makeTask(56, [WALLET_A], { preApprovalDone: true });
      task.config.marketType = 'inner';
      task.config.innerTokenAddress = task.config.tokenContract;
      task.config.poolBaseToken = '0x000000000000000000000000000000000000a57e';
      task.config.buyThreadCount = 1;
      task.config.sellThreadCount = 1;
      task.config.stopType = 'count';
      task.config.stopValue = 2;
      const store = installTask(task);

      await store.startTask(task.id);

      expect(mocks.executeFourMemeTradeFast).toHaveBeenCalledTimes(1);
      expect(mocks.executeFourMemeTradeFast.mock.calls[0][0].mode).toBe(fastDirection);
      expect(mocks.executeFourMemeTrade).toHaveBeenCalledTimes(1);
      expect(mocks.executeFourMemeTrade.mock.calls[0][0].mode).toBe(slowDirection);
    },
  );
});

describe('authoritative whole-batch nonce preflight', () => {
  it('skips a later wallet with a pending predecessor and sells the other wallets', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.publicClient.getTransactionCount.mockImplementation(async (params?: {
      address?: string;
      blockTag?: string;
    }) => (
      params?.address?.toLowerCase() === WALLET_B.toLowerCase() && params.blockTag === 'pending' ? 8 : 7
    ));
    mocks.executeTrade.mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xconfirmed' });
    const store = installTask(makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]));

    await store.batchSellForTask('task-4663');

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(mocks.executeTrade.mock.calls.map(call => call[0].walletAddress))
      .toEqual([WALLET_A, WALLET_C]);
    expect(taskLogs(store).some(message => (
      message.includes(WALLET_B.slice(0, 10))
      && message.includes('链上待确认前序交易')
      && message.includes('只跳过该钱包')
    ))).toBe(true);
  });

  it('does not repeat a whole-round Robinhood nonce preflight before per-wallet execution', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.publicClient.getTransactionCount.mockRejectedValue(new Error('round nonce preflight must not run'));
    mocks.executeTrade.mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xconfirmed' });
    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.sellThreadCount = 3;
    task.config.stopType = 'count';
    task.config.stopValue = 3;
    const store = installTask(task);

    await store.startTask(task.id);
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(3));

    expect(mocks.publicClient.getTransactionCount).not.toHaveBeenCalled();
    expect(store.tasks[0].stats.sellCount).toBe(3);
  });

  it('skips every wallet when none can be checked against the authoritative nonce RPC', async () => {
    installWallets([WALLET_A, WALLET_B]);
    mocks.publicClient.getTransactionCount.mockRejectedValue(new Error('nonce RPC offline'));
    const store = installTask(makeTask(56, [WALLET_A, WALLET_B]));

    await store.batchSellForTask('task-56');

    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(taskLogs(store).some(message => (
      message.includes('nonce RPC offline') && message.includes('只跳过该钱包')
    ))).toBe(true);
    expect(taskLogs(store).some(message => message.includes('没有可安全发送的钱包'))).toBe(true);
  });

  it('preflights a BSC outer-market buy through the same task RPC used for broadcast fallback', async () => {
    installWallets([WALLET_A]);
    mocks.executeTrade.mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xbuy' });
    const task = makeTask(56, [WALLET_A]);
    task.config.buyThreadCount = 1;
    task.config.sellThreadCount = 0;
    task.config.stopType = 'count';
    task.config.stopValue = 1;
    const store = installTask(task);

    await store.startTask(task.id);

    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
    expect(mocks.httpTransport).toHaveBeenCalledWith('https://bsc.test/', { timeout: 10_000 });
    expect(mocks.httpTransport).not.toHaveBeenCalledWith('http://unused.test', { timeout: 10_000 });
  });
});

describe('ASTER pre-approval cross-RPC barrier', () => {
  const maxUint128 = BigInt('0xffffffffffffffffffffffffffffffff');
  const approvalHash = `0x${'ef'.repeat(32)}`;

  function installPreApprovalWallet() {
    mocks.walletStore.localWallets = [{
      address: PREAPPROVAL_WALLET,
      encrypted: PREAPPROVAL_PRIVATE_KEY,
    }];
  }

  it('does not mark pre-approval ready until the other enabled execution RPC sees the receipt', async () => {
    installPreApprovalWallet();
    const buyClient = makeRpcClient();
    const sellClient = makeRpcClient();
    let resolvePeerReceipt!: (value: { status: 'success'; transactionHash: string }) => void;
    const peerReceipt = new Promise<{ status: 'success'; transactionHash: string }>(resolve => {
      resolvePeerReceipt = resolve;
    });
    buyClient.readContract.mockImplementation(async ({ address }: { address: string }) => (
      mocks.walletClient.sendTransaction.mock.calls.length === 0
        && address.toLowerCase() === '0x000000000000000000000000000000000000a57e'
        ? 0n
        : maxUint128
    ));
    sellClient.readContract.mockResolvedValue(maxUint128);
    buyClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: approvalHash });
    sellClient.waitForTransactionReceipt.mockReturnValue(peerReceipt);
    mocks.walletClient.sendTransaction.mockResolvedValue(approvalHash);
    mocks.publicClientsByUrl.set('http://buy.test', buyClient);
    mocks.publicClientsByUrl.set('http://premium.test', sellClient);
    const store = useTaskStore();

    const task = await store.createTask('cross-rpc preapproval', makeAsterTaskConfig(), [PREAPPROVAL_WALLET]);
    await vi.waitFor(() => expect(sellClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1));

    expect(task.preApprovalDone).not.toBe(true);
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);

    resolvePeerReceipt({ status: 'success', transactionHash: approvalHash });
    await vi.waitFor(() => expect(task.preApprovalDone).toBe(true));
    expect(sellClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: approvalHash,
      timeout: 120000,
    });
  });

  it('keeps fast-path disabled and retains the wallet when the peer receipt times out', async () => {
    installPreApprovalWallet();
    const buyClient = makeRpcClient();
    const sellClient = makeRpcClient();
    buyClient.readContract.mockResolvedValue(0n);
    buyClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: approvalHash });
    const timeout = new Error('peer timeout');
    timeout.name = 'WaitForTransactionReceiptTimeoutError';
    sellClient.waitForTransactionReceipt.mockRejectedValue(timeout);
    mocks.walletClient.sendTransaction.mockResolvedValue(approvalHash);
    mocks.publicClientsByUrl.set('http://buy.test', buyClient);
    mocks.publicClientsByUrl.set('http://premium.test', sellClient);
    const store = useTaskStore();

    const task = await store.createTask('cross-rpc timeout', makeAsterTaskConfig(), [PREAPPROVAL_WALLET]);
    await vi.waitFor(() => expect(task.logs.some(log => log.message.includes('预授权收尾'))).toBe(true));

    expect(task.preApprovalDone).toBe(false);
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(getUnresolvedTransaction(56, PREAPPROVAL_WALLET)).toMatchObject({
      txHash: approvalHash,
      rpcUrl: 'http://premium.test',
      receiptRequired: true,
    });
    expect(await store.startTask(task.id)).toBe(true);
    expect(task.status).toBe('running');
    expect(mocks.executeFourMemeTrade).not.toHaveBeenCalled();
    expect(mocks.executeFourMemeTradeFast).not.toHaveBeenCalled();
    expect(task.logs.some(log => log.message.includes('只暂时跳过该钱包'))).toBe(true);
    store.pauseTask(task.id);
  });

  it('does not enable fast-path when no write is needed but an enabled execution RPC has stale allowance', async () => {
    installPreApprovalWallet();
    const buyClient = makeRpcClient();
    const sellClient = makeRpcClient();
    buyClient.readContract.mockResolvedValue(maxUint128);
    sellClient.readContract.mockResolvedValue(0n);
    mocks.publicClientsByUrl.set('http://buy.test', buyClient);
    mocks.publicClientsByUrl.set('http://premium.test', sellClient);
    const store = useTaskStore();

    const task = await store.createTask('stale allowance', makeAsterTaskConfig(), [PREAPPROVAL_WALLET]);
    await vi.waitFor(() => expect(
      task.logs.some(log => log.message.includes('不会启用快速路径')),
    ).toBe(true));

    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(task.logs.some(log => log.message.includes('不会启用快速路径'))).toBe(true);
  });

  it('keeps both execution RPCs ready even before a later direction switch', async () => {
    installPreApprovalWallet();
    const buyClient = makeRpcClient();
    const sellClient = makeRpcClient();
    buyClient.readContract.mockResolvedValue(maxUint128);
    sellClient.readContract.mockResolvedValue(maxUint128);
    mocks.publicClientsByUrl.set('http://buy.test', buyClient);
    mocks.publicClientsByUrl.set('http://premium.test', sellClient);
    const config = makeAsterTaskConfig();
    config.sellThreadCount = 0;
    const store = useTaskStore();

    const task = await store.createTask('buy only preapproval', config, [PREAPPROVAL_WALLET]);
    await vi.waitFor(() => expect(task.preApprovalDone).toBe(true));

    expect(sellClient.readContract).toHaveBeenCalled();
  });

  it('prevents an invalidated old pre-approval job from restoring readiness after task edits', async () => {
    installPreApprovalWallet();
    const buyClient = makeRpcClient();
    const sellClient = makeRpcClient();
    let resolveOldPeer!: (value: { status: 'success'; transactionHash: string }) => void;
    const oldPeer = new Promise<{ status: 'success'; transactionHash: string }>(resolve => {
      resolveOldPeer = resolve;
    });
    buyClient.readContract.mockImplementation(async ({ address }: { address: string }) => (
      address.toLowerCase() === '0x000000000000000000000000000000000000a57e' ? 0n : maxUint128
    ));
    sellClient.readContract.mockResolvedValue(maxUint128);
    buyClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: approvalHash });
    sellClient.waitForTransactionReceipt.mockReturnValue(oldPeer);
    mocks.walletClient.sendTransaction.mockResolvedValue(approvalHash);
    mocks.publicClientsByUrl.set('http://buy.test', buyClient);
    mocks.publicClientsByUrl.set('http://premium.test', sellClient);
    const store = useTaskStore();
    const task = await store.createTask('edit invalidation', makeAsterTaskConfig(), [PREAPPROVAL_WALLET]);
    await vi.waitFor(() => expect(sellClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1));

    buyClient.readContract.mockResolvedValue(maxUint128);
    sellClient.readContract.mockResolvedValue(0n);
    const newToken = '0x000000000000000000000000000000000000cafe';
    await store.updateTask(task.id, {
      config: { tokenContract: newToken, innerTokenAddress: newToken },
    });
    await vi.waitFor(() => expect(
      task.logs.some(log => log.message.includes('不会启用快速路径')),
    ).toBe(true));
    expect(task.preApprovalDone).toBe(false);

    resolveOldPeer({ status: 'success', transactionHash: approvalHash });
    await Promise.resolve();
    await Promise.resolve();
    expect(task.preApprovalDone).toBe(false);
    expect(mocks.walletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('invalidates readiness and rechecks execution endpoints after batch token replacement', async () => {
    installPreApprovalWallet();
    const buyClient = makeRpcClient();
    const sellClient = makeRpcClient();
    buyClient.readContract.mockResolvedValue(maxUint128);
    sellClient.readContract.mockResolvedValue(maxUint128);
    mocks.publicClientsByUrl.set('http://buy.test', buyClient);
    mocks.publicClientsByUrl.set('http://premium.test', sellClient);
    const store = useTaskStore();
    const task = await store.createTask('batch token invalidation', makeAsterTaskConfig(), [PREAPPROVAL_WALLET]);
    await vi.waitFor(() => expect(task.preApprovalDone).toBe(true));

    sellClient.readContract.mockResolvedValue(0n);
    await store.batchUpdateTokenAddress(
      [task.id],
      '0x000000000000000000000000000000000000d00d',
    );
    await vi.waitFor(() => expect(
      task.logs.some(log => log.message.includes('不会启用快速路径')),
    ).toBe(true));

    expect(task.preApprovalDone).toBe(false);
    expect(mocks.walletClient.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('wallet normalization', () => {
  it('deduplicates wallet addresses case-insensitively before any chain write', async () => {
    installWallets([WALLET_A, WALLET_B]);
    mocks.executeTrade.mockResolvedValue({ success: true, status: 'confirmed', txHash: '0xok' });

    const store = installTask(makeTask(4663, [
      WALLET_A,
      WALLET_A.toUpperCase().replace('0X', '0x'),
      WALLET_B,
      WALLET_B,
    ]));
    await store.batchSellForTask('task-4663');

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(mocks.executeTrade.mock.calls.map(call => call[0].walletAddress.toLowerCase()))
      .toEqual([WALLET_A.toLowerCase(), WALLET_B.toLowerCase()]);
  });
});

function taskLogs(store: ReturnType<typeof useTaskStore>): string[] {
  return store.tasks[0]?.logs.map(log => log.message) ?? [];
}
