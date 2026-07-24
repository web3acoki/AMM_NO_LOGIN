import { describe, expect, it } from 'vitest';
import {
  assertTargetTokenQueryContextCurrent,
  createTransferExecutionContextGuard,
} from '../transferAssetContext';

const token = {
  address: '0x00000000000000000000000000000000000000a1',
  chainId: 4663,
  decimals: 18,
  symbol: 'TEST',
};

describe('transfer asset context guards', () => {
  it('accepts a token query result only for the chain and address that started it', () => {
    expect(() => assertTargetTokenQueryContextCurrent(
      { chainId: 4663, address: token.address },
      4663,
      token.address.toUpperCase(),
    )).not.toThrow();
  });

  it('rejects an old-chain token query result after the network changes', () => {
    expect(() => assertTargetTokenQueryContextCurrent(
      { chainId: 56, address: token.address },
      4663,
      token.address,
    )).toThrow(/网络或代币地址已切换/);
  });

  it('rejects a token query result after the requested address changes', () => {
    expect(() => assertTargetTokenQueryContextCurrent(
      { chainId: 4663, address: token.address },
      4663,
      '0x00000000000000000000000000000000000000b2',
    )).toThrow(/网络或代币地址已切换/);
  });

  it('rejects a changed target-token chain or decimals before a later transfer plan', () => {
    const guard = createTransferExecutionContextGuard({
      chainId: 4663,
      rpcUrl: 'https://rpc.example',
      targetToken: token,
    });

    expect(() => guard.assertCurrent({
      chainId: 4663,
      rpcUrl: 'https://rpc.example',
      targetToken: { ...token, chainId: 56 },
    })).toThrow(/后续转账未发送/);
    expect(() => guard.assertCurrent({
      chainId: 4663,
      rpcUrl: 'https://rpc.example',
      targetToken: { ...token, decimals: 6 },
    })).toThrow(/后续转账未发送/);
    expect(() => guard.assertCurrent({
      chainId: 4663,
      rpcUrl: 'https://rpc.example',
      targetToken: { ...token, symbol: 'OTHER' },
    })).toThrow(/后续转账未发送/);
  });

  it('rejects a same-chain RPC change before a later transfer plan', () => {
    const guard = createTransferExecutionContextGuard({
      chainId: 4663,
      rpcUrl: 'https://rpc-a.example',
      targetToken: token,
    });

    expect(() => guard.assertCurrent({
      chainId: 4663,
      rpcUrl: 'https://rpc-b.example',
      targetToken: token,
    })).toThrow(/RPC/);
  });

  it('remains invalid after a brief switch away and back', () => {
    const context = {
      chainId: 4663,
      rpcUrl: 'https://rpc.example',
      targetToken: token,
    };
    const guard = createTransferExecutionContextGuard(context);
    guard.invalidate();

    expect(() => guard.assertCurrent({ ...context, targetToken: { ...token } })).toThrow(/后续转账未发送/);
  });
});
