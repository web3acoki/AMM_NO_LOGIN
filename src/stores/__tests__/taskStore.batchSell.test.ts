import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Task } from '../taskStore';

const mocks = vi.hoisted(() => ({
  executeTrade: vi.fn(),
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
}));

vi.mock('../walletStore', () => ({
  useWalletStore: () => mocks.walletStore,
}));

vi.mock('../dexStore', () => ({
  useDexStore: () => mocks.dexStore,
}));

vi.mock('../../services/taskApi', () => ({
  isLoggedIn: () => false,
  getTasks: vi.fn(async () => []),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  updateTaskStats: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('../../config', () => ({
  ENABLE_LOGIN: false,
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
  withTransferLease: vi.fn(async (_chainId: number, _address: string, callback: Function) => callback({
    assertActive: vi.fn(),
    retainUntil: mocks.retainUntil,
  })),
  withMarketLease: vi.fn(async (_chainId: number, _tokenAddress: string, callback: Function) => callback({
    assertActive: vi.fn(),
  })),
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

import { useTaskStore } from '../taskStore';
import { clearUnresolvedTransaction, getUnresolvedTransaction } from '../../services/unresolvedTransactionGuard';

const WALLET_A = '0x00000000000000000000000000000000000000a1';
const WALLET_B = '0x00000000000000000000000000000000000000b2';
const WALLET_C = '0x00000000000000000000000000000000000000c3';
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
  mocks.executeTrade.mockReset();
  mocks.createTradingService.mockReset();
  mocks.createTradingService.mockReturnValue({ executeTrade: mocks.executeTrade });
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
    for (const walletAddress of [WALLET_A, WALLET_B, WALLET_C, PREAPPROVAL_WALLET]) {
      clearUnresolvedTransaction(chainId, walletAddress);
    }
  }
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
    'stops the wallet pipeline on %s with a hash and never resends it',
    async (status) => {
      installWallets([WALLET_A, WALLET_B, WALLET_C]);
      mocks.executeTrade.mockResolvedValueOnce({
        success: false,
        status,
        txHash: '0xalready-broadcast',
        error: 'receipt unavailable',
      });

      const store = installTask(makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]));
      await store.batchSellForTask('task-4663');

      expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
      expect(mocks.executeTrade.mock.calls[0][0].walletAddress).toBe(WALLET_A);
      expect(store.tasks[0].logs.some(log => log.txHash === '0xalready-broadcast')).toBe(true);
      expect(taskLogs(store).some(message => message.includes('未发送'))).toBe(true);

      // 同一会话内立即重复点击或恢复任务都必须被 unresolved 守卫拦截，
      // 不能把“停止当前循环”误当成可以再次广播。
      await store.batchSellForTask('task-4663');
      expect(await store.startTask('task-4663')).toBe(false);
      expect(mocks.executeTrade).toHaveBeenCalledTimes(1);
      expect(taskLogs(store).some(message => message.includes('上一笔交易仍待确认'))).toBe(true);
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

  it('pauses and drains every same-chain running task that shares a wallet', async () => {
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
      expect(store.tasks.find(task => task.id === taskB.id)?.status).toBe('paused');
    });
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);

    firstRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic-a' });
    await vi.waitFor(() => expect(mocks.executeTrade).toHaveBeenCalledTimes(2));
    await Promise.all([automaticA, automaticB, manualExecution]);

    // task-b 已经排进本地锁队列，但在取得锁前被批卖暂停，所以不能再广播。
    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(store.tasks.every(task => task.status === 'paused')).toBe(true);
  });

  it('pauses a different-wallet task on the same chain and token before manual sell', async () => {
    installWallets([WALLET_A, WALLET_B]);
    const activeRound = deferred<{ success: boolean; status: string; txHash: string }>();
    mocks.executeTrade
      .mockImplementationOnce(() => activeRound.promise)
      .mockResolvedValueOnce({ success: true, status: 'confirmed', txHash: '0xmanual-same-token' });

    const taskA = makeTask(4663, [WALLET_A], { id: 'same-token-a' });
    const taskB = makeTask(4663, [WALLET_B], { id: 'same-token-b' });
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
      expect(store.tasks.find(task => task.id === taskB.id)?.status).toBe('paused');
    });
    expect(mocks.executeTrade).toHaveBeenCalledTimes(1);

    activeRound.resolve({ success: true, status: 'confirmed', txHash: '0xautomatic-same-token' });
    await Promise.all([automaticA, automaticB, manualExecution]);

    expect(mocks.executeTrade).toHaveBeenCalledTimes(2);
    expect(mocks.executeTrade.mock.calls[1][0].walletAddress).toBe(WALLET_A);
    expect(store.tasks.every(task => task.status === 'paused')).toBe(true);
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

  it('stops all later wallets when a broadcast hash has no final receipt', async () => {
    const pendingHash = `0x${'bc'.repeat(32)}`;
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.prepareFourMemeSell.mockResolvedValue({
      success: true,
      needsApproval: false,
      sellAmount: 123n,
    });
    mocks.executeFourMemeSell.mockResolvedValue({
      success: true,
      status: 'pending',
      txHash: pendingHash,
      transactionKind: 'trade',
      reconciliationRpcUrl: 'http://unused.test',
      receiptRequired: true,
    });
    const task = makeTask(56, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.marketType = 'inner';
    task.config.innerTokenAddress = task.config.tokenContract;
    const store = installTask(task);
    await store.batchSellForTask(task.id);

    expect(mocks.prepareFourMemeSell).toHaveBeenCalledTimes(1);
    expect(mocks.executeFourMemeSell).toHaveBeenCalledTimes(1);
    expect(store.tasks[0].logs.some(log => log.txHash === pendingHash)).toBe(true);
    expect(getUnresolvedTransaction(56, WALLET_A)).toMatchObject({
      txHash: pendingHash,
      rpcUrl: 'http://unused.test',
      receiptRequired: true,
    });
    expect(taskLogs(store).filter(message => message.includes('未发送：前一笔卖出仍在待确认或状态未知')))
      .toHaveLength(2);
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
  it('sends zero transactions when a later manual-batch wallet already has a pending predecessor', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.publicClient.getTransactionCount.mockImplementation(async (params?: {
      address?: string;
      blockTag?: string;
    }) => (
      params?.address?.toLowerCase() === WALLET_B.toLowerCase() && params.blockTag === 'pending' ? 8 : 7
    ));
    const store = installTask(makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]));

    await store.batchSellForTask('task-4663');

    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(taskLogs(store).some(message => (
      message.includes(WALLET_B.slice(0, 10))
      && message.includes('链上待确认前序交易')
      && message.includes('0 笔发送')
    ))).toBe(true);
  });

  it('pauses an automatic round and sends zero transactions when any later participant is pending', async () => {
    installWallets([WALLET_A, WALLET_B, WALLET_C]);
    mocks.publicClient.getTransactionCount.mockImplementation(async (params?: {
      address?: string;
      blockTag?: string;
    }) => (
      params?.address?.toLowerCase() === WALLET_C.toLowerCase() && params.blockTag === 'pending' ? 12 : 11
    ));
    const task = makeTask(4663, [WALLET_A, WALLET_B, WALLET_C]);
    task.config.sellThreadCount = 3;
    const store = installTask(task);

    await store.startTask(task.id);

    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(store.tasks[0].status).toBe('paused');
    expect(taskLogs(store).some(message => message.includes('本轮权威预检未通过，0 笔发送'))).toBe(true);
  });

  it('fails closed with zero sends when the authoritative nonce RPC is unavailable', async () => {
    installWallets([WALLET_A, WALLET_B]);
    mocks.publicClient.getTransactionCount.mockRejectedValue(new Error('nonce RPC offline'));
    const store = installTask(makeTask(56, [WALLET_A, WALLET_B]));

    await store.batchSellForTask('task-56');

    expect(mocks.executeTrade).not.toHaveBeenCalled();
    expect(taskLogs(store).some(message => (
      message.includes('nonce RPC offline') && message.includes('0 笔发送')
    ))).toBe(true);
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
    expect(await store.startTask(task.id)).toBe(false);
    expect(mocks.executeFourMemeTrade).not.toHaveBeenCalled();
    expect(mocks.executeFourMemeTradeFast).not.toHaveBeenCalled();
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
