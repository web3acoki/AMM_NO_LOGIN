import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const mocks = vi.hoisted(() => ({
  decryptPrivateKeys: vi.fn(),
  validateTransfer: vi.fn(),
  isLoggedIn: vi.fn(),
  executeOneToManyTransfer: vi.fn(),
  withTransferLease: vi.fn(),
}));

vi.mock('../../services/walletApi', () => ({
  decryptPrivateKeys: mocks.decryptPrivateKeys,
  validateTransfer: mocks.validateTransfer,
  isLoggedIn: mocks.isLoggedIn,
}));

vi.mock('../../services/oneToManyTransferService', () => ({
  executeOneToManyTransfer: mocks.executeOneToManyTransfer,
}));

vi.mock('../../services/transferLeaseApi', () => ({
  withTransferLease: mocks.withTransferLease,
}));

import { useChainStore } from '../chainStore';
import { useWalletStore } from '../walletStore';

const SOURCE_PRIVATE_KEY = `0x${'1'.padStart(64, '0')}` as Hex;
const WRONG_PRIVATE_KEY = `0x${'2'.padStart(64, '0')}` as Hex;
const SOURCE_ADDRESS = privateKeyToAccount(SOURCE_PRIVATE_KEY).address;
const TARGET_ADDRESS = getAddress('0x000000000000000000000000000000000000cafe');
const EXTERNAL_TARGET_ADDRESS = getAddress('0x000000000000000000000000000000000000dead');
const TOKEN_ADDRESS = getAddress('0x000000000000000000000000000000000000beef');

function createNormalBatchSourceStore() {
  const chainStore = useChainStore();
  chainStore.setSelectedChain(4663);

  const walletStore = useWalletStore();
  walletStore.currentChainId = 4663;
  walletStore.walletBatches = [{
    id: 'normal-source-batch',
    remark: '普通钱包源批次',
    createdAt: new Date(0).toISOString(),
    walletType: 'normal',
    wallets: [{
      address: SOURCE_ADDRESS,
      privateKey: '',
      remark: '源钱包',
    }],
  }];
  walletStore.localWallets = [{
    address: TARGET_ADDRESS,
    walletType: 'normal',
    encrypted: '',
    remark: '目标钱包',
  }];
  return walletStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {});
  setActivePinia(createPinia());

  mocks.isLoggedIn.mockReturnValue(true);
  mocks.validateTransfer.mockResolvedValue({ valid: true });
  mocks.withTransferLease.mockImplementation(
    async (_chainId: number, _address: string, callback: (guard: any) => Promise<any>) => (
      callback({ assertActive: vi.fn() })
    ),
  );
  mocks.executeOneToManyTransfer.mockImplementation(async (options: any) => (
    options.targetAddresses.map((target: string, index: number) => ({
      source: options.sourceAddress,
      target,
      hash: `0x${String(index + 1).padStart(64, '0')}`,
      success: true,
      status: 'confirmed',
      retryable: false,
      amount: String(options.amount),
    }))
  ));
});

describe('walletStore one-to-many managed source execution', () => {
  it('uses a normal batch source with an external target, fetches only its missing key and preserves the ERC20 asset snapshot', async () => {
    const walletStore = createNormalBatchSourceStore();
    walletStore.setTargetToken({
      address: TOKEN_ADDRESS,
      symbol: 'TEST',
      name: 'Test Token',
      decimals: 9,
      chainId: 4663,
    });
    expect(walletStore.targetToken?.chainId).toBe(4663);
    mocks.decryptPrivateKeys.mockResolvedValue([{
      address: SOURCE_ADDRESS,
      privateKey: SOURCE_PRIVATE_KEY,
    }]);

    const callerSources = [SOURCE_ADDRESS];
    const callerTargets = [EXTERNAL_TARGET_ADDRESS];
    const execution = walletStore.batchTransferByAddresses(
      callerSources,
      callerTargets,
      '12.345678901',
      'token',
      'oneToMany',
    );

    // The Store must already have frozen caller-owned arrays before its first await.
    callerSources[0] = TARGET_ADDRESS;
    callerTargets[0] = SOURCE_ADDRESS;

    const results = await execution;

    expect(results).toHaveLength(1);
    expect(mocks.validateTransfer).toHaveBeenCalledWith(
      [SOURCE_ADDRESS],
      [],
    );
    expect(mocks.decryptPrivateKeys).toHaveBeenCalledTimes(1);
    expect(mocks.decryptPrivateKeys).toHaveBeenCalledWith([SOURCE_ADDRESS]);
    expect(mocks.withTransferLease).toHaveBeenCalledWith(
      4663,
      SOURCE_ADDRESS,
      expect.any(Function),
    );
    expect(mocks.executeOneToManyTransfer).toHaveBeenCalledWith(expect.objectContaining({
      sourceAddress: SOURCE_ADDRESS,
      targetAddresses: [EXTERNAL_TARGET_ADDRESS],
      privateKey: SOURCE_PRIVATE_KEY,
      amount: '12.345678901',
      asset: {
        kind: 'erc20',
        address: TOKEN_ADDRESS,
        symbol: 'TEST',
        decimals: 9,
      },
    }));
  });

  it('fails closed before acquiring a lease when the fetched key does not match the selected source', async () => {
    const walletStore = createNormalBatchSourceStore();
    mocks.decryptPrivateKeys.mockResolvedValue([{
      address: SOURCE_ADDRESS,
      privateKey: WRONG_PRIVATE_KEY,
    }]);

    await expect(walletStore.batchTransferByAddresses(
      [SOURCE_ADDRESS],
      [TARGET_ADDRESS],
      '0.01',
      'native',
      'oneToMany',
    )).rejects.toThrow('未找到与源钱包地址匹配的私钥');

    expect(mocks.withTransferLease).not.toHaveBeenCalled();
    expect(mocks.executeOneToManyTransfer).not.toHaveBeenCalled();
  });

  it('rejects an unmanaged one-to-many source at the Store/API boundary before key access', async () => {
    const walletStore = createNormalBatchSourceStore();
    mocks.validateTransfer.mockResolvedValue({
      valid: false,
      missingAddresses: [SOURCE_ADDRESS],
    });

    await expect(walletStore.batchTransferByAddresses(
      [SOURCE_ADDRESS],
      [TARGET_ADDRESS],
      '0.01',
      'native',
      'oneToMany',
    )).rejects.toThrow('一对多源钱包必须从当前账号的钱包批次选择');

    expect(mocks.decryptPrivateKeys).not.toHaveBeenCalled();
    expect(mocks.withTransferLease).not.toHaveBeenCalled();
    expect(mocks.executeOneToManyTransfer).not.toHaveBeenCalled();
    expect(mocks.validateTransfer).toHaveBeenCalledWith([SOURCE_ADDRESS], []);
  });

  it('rejects an account-owned source that is not present in any wallet batch', async () => {
    const walletStore = createNormalBatchSourceStore();
    walletStore.walletBatches = [];
    walletStore.localWallets.push({
      address: SOURCE_ADDRESS,
      walletType: 'normal',
      encrypted: SOURCE_PRIVATE_KEY,
      remark: 'standalone account wallet',
    });

    await expect(walletStore.batchTransferByAddresses(
      [SOURCE_ADDRESS],
      [TARGET_ADDRESS],
      '0.01',
      'native',
      'oneToMany',
    )).rejects.toThrow(/钱包批次选择/);

    expect(mocks.validateTransfer).not.toHaveBeenCalled();
    expect(mocks.decryptPrivateKeys).not.toHaveBeenCalled();
    expect(mocks.withTransferLease).not.toHaveBeenCalled();
    expect(mocks.executeOneToManyTransfer).not.toHaveBeenCalled();
  });

  it('allows an external target in legacy multi-source modes without an ownership lookup', async () => {
    const walletStore = createNormalBatchSourceStore();

    const results = await walletStore.batchTransferByAddresses(
      [SOURCE_ADDRESS],
      [EXTERNAL_TARGET_ADDRESS],
      '0.01',
      'native',
      'manyToOne',
      {
        privateKeyMap: {
          [SOURCE_ADDRESS]: SOURCE_PRIVATE_KEY,
        },
      },
    );

    expect(results).toHaveLength(1);
    expect(mocks.validateTransfer).not.toHaveBeenCalled();
    expect(mocks.executeOneToManyTransfer).toHaveBeenCalledWith(expect.objectContaining({
      sourceAddress: SOURCE_ADDRESS,
      targetAddresses: [EXTERNAL_TARGET_ADDRESS],
    }));
  });

  it('rejects stale ERC20 metadata from another chain before ownership or key access', async () => {
    const walletStore = createNormalBatchSourceStore();
    walletStore.setTargetToken({
      address: TOKEN_ADDRESS,
      symbol: 'STALE',
      name: 'Stale Cross-chain Token',
      decimals: 18,
      chainId: 56,
    });

    await expect(walletStore.batchTransferByAddresses(
      [SOURCE_ADDRESS],
      [TARGET_ADDRESS],
      '1',
      'token',
      'oneToMany',
    )).rejects.toThrow(
      '目标 ERC20 代币属于链 ID 56，与当前执行链 ID 4663 不一致，请在当前网络重新查询代币后再转账',
    );

    expect(mocks.validateTransfer).not.toHaveBeenCalled();
    expect(mocks.decryptPrivateKeys).not.toHaveBeenCalled();
    expect(mocks.withTransferLease).not.toHaveBeenCalled();
    expect(mocks.executeOneToManyTransfer).not.toHaveBeenCalled();
  });

  it('clears the chain-bound target token when the execution network changes', () => {
    const walletStore = createNormalBatchSourceStore();
    walletStore.setTargetToken({
      address: TOKEN_ADDRESS,
      symbol: 'TEST',
      name: 'Test Token',
      decimals: 18,
      chainId: 4663,
    });

    walletStore.setCurrentChainId(56);

    expect(walletStore.targetToken).toBeNull();
  });
});
