import { describe, expect, it } from 'vitest';
import {
  getRuntimeRobinhoodRpcUrl,
  setRuntimeRobinhoodRpcUrl,
} from '../robinhoodRpcConfig';

describe('Robinhood runtime RPC config', () => {
  it('accepts an authenticated server-provided HTTP endpoint', () => {
    setRuntimeRobinhoodRpcUrl('https://paid-rpc.example/key');
    expect(getRuntimeRobinhoodRpcUrl()).toBe('https://paid-rpc.example/key');
  });

  it('rejects non-HTTP transports', () => {
    expect(() => setRuntimeRobinhoodRpcUrl('ws://paid-rpc.example/key')).toThrow(
      'Robinhood RPC 必须使用 HTTP 或 HTTPS 地址',
    );
  });
});
