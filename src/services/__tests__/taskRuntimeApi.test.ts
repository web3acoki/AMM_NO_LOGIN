import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  heartbeatTaskRuntime,
  startTaskRuntime,
  stopTaskRuntime,
} from '../taskRuntimeApi';

const TASK_ID = '507f1f77bcf86cd799439011';
const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';
const RUNTIME_TOKEN = 'ab'.repeat(32);

describe('task runtime API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'test-auth-token'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it('starts a runtime with the client/build identity and coordination fence', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        runtimeId: RUNTIME_ID,
        runtimeToken: RUNTIME_TOKEN,
        expiresAt: '2026-07-23T00:00:12.000Z',
        runtimeDurationMs: 12000,
        heartbeatIntervalMs: 3000,
      },
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const lease = await startTaskRuntime(TASK_ID, RUNTIME_ID, 'instance-1');

    expect(lease.runtimeToken).toBe(RUNTIME_TOKEN);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/api/tasks/${TASK_ID}/runtime/start`);
    const headers = request.headers as Headers;
    expect(headers.get('X-AMM-Coordination-Version')).toBe('3');
    expect(headers.get('Authorization')).toBe('Bearer test-auth-token');
    expect(JSON.parse(String(request.body))).toMatchObject({
      runtimeId: RUNTIME_ID,
      clientInstanceId: 'instance-1',
    });
  });

  it('heartbeats and conditionally stops only the matching runtime/token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          runtimeId: RUNTIME_ID,
          expiresAt: '2026-07-23T00:00:12.000Z',
          runtimeDurationMs: 12000,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { revoked: true },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await heartbeatTaskRuntime(TASK_ID, RUNTIME_ID, RUNTIME_TOKEN);
    expect(await stopTaskRuntime(TASK_ID, {
      runtimeId: RUNTIME_ID,
      runtimeToken: RUNTIME_TOKEN,
    })).toBe(true);

    const heartbeatHeaders = fetchMock.mock.calls[0][1].headers as Headers;
    const stopHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(heartbeatHeaders.get('X-Task-Runtime-Token')).toBe(RUNTIME_TOKEN);
    expect(heartbeatHeaders.get('X-AMM-Coordination-Version')).toBe('3');
    expect(stopHeaders.get('X-Task-Runtime-Token')).toBe(RUNTIME_TOKEN);
    expect(stopHeaders.get('X-AMM-Coordination-Version')).toBe('3');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      runtimeId: RUNTIME_ID,
    });
  });

  it('force-stops only the explicitly observed runtime id without a token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { revoked: true },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await stopTaskRuntime(TASK_ID, {
      runtimeId: RUNTIME_ID,
      force: true,
    })).toBe(true);

    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = request.headers as Headers;
    expect(headers.get('X-Task-Runtime-Token')).toBeNull();
    expect(JSON.parse(String(request.body))).toEqual({
      runtimeId: RUNTIME_ID,
      force: true,
    });
  });
});
