import { describe, expect, it } from 'vitest';
import { ROBINHOOD_OFFICIAL_RPC_URL } from '../../constants';
import {
  ROBINHOOD_CREATE_TOKEN_RPC_URL,
  resolveCreateTokenRpcUrl,
} from '../createTokenRpc';

describe('create-token RPC selection', () => {
  it('pins Robinhood token creation to the official RPC', () => {
    expect(resolveCreateTokenRpcUrl('robinhood', 'https://paid-rpc.example/private')).toBe(
      ROBINHOOD_OFFICIAL_RPC_URL,
    );
    expect(ROBINHOOD_CREATE_TOKEN_RPC_URL).toBe(ROBINHOOD_OFFICIAL_RPC_URL);
  });

  it('preserves the selected RPC for BSC token creation', () => {
    expect(resolveCreateTokenRpcUrl('bscMainnet', 'https://bsc.example')).toBe(
      'https://bsc.example',
    );
    expect(resolveCreateTokenRpcUrl('bscTestnet', 'https://bsc-testnet.example')).toBe(
      'https://bsc-testnet.example',
    );
  });
});
