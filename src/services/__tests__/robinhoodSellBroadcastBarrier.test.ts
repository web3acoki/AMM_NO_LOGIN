import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RobinhoodSellBroadcastBarrier,
  registerRobinhoodTaskBroadcastCohort,
} from '../robinhoodSellBroadcastBarrier';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('RobinhoodSellBroadcastBarrier', () => {
  it('does not broadcast any prepared wallet until the entire sell batch is ready', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(3);
    const participants = [
      barrier.createParticipant(),
      barrier.createParticipant(),
      barrier.createParticipant(),
    ];
    const broadcasts: number[] = [];

    const first = participants[0].arrive(async () => { broadcasts.push(1); });
    const second = participants[1].arrive(async () => { broadcasts.push(2); });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(broadcasts).toEqual([]);

    const third = participants[2].arrive(async () => { broadcasts.push(3); });
    await vi.advanceTimersByTimeAsync(899);
    expect(broadcasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await Promise.all([first, second, third]);
    expect(broadcasts.sort()).toEqual([1, 2, 3]);
  });

  it('releases prepared wallets when another participant fails before signing', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(2);
    const ready = barrier.createParticipant();
    const failed = barrier.createParticipant();
    const broadcast = vi.fn(async () => undefined);

    const completion = ready.arrive(broadcast);
    failed.fail();
    await vi.advanceTimersByTimeAsync(900);

    await completion;
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('cancels every prepared transaction when a pure sell participant fails', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(
      2,
      undefined,
      { abortOnParticipantFailure: true },
    );
    const ready = barrier.createParticipant();
    const failed = barrier.createParticipant();
    const broadcast = vi.fn(async () => undefined);
    const cancel = vi.fn();

    const completion = ready.arrive(broadcast, cancel);
    failed.fail();

    await expect(completion).rejects.toThrow('本批已签名交易均未广播');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('treats an authoritative zero-balance skip as a benign strict-batch completion', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(
      2,
      undefined,
      { abortOnParticipantFailure: true },
    );
    const ready = barrier.createParticipant('ready-wallet');
    const empty = barrier.createParticipant('empty-wallet');
    const broadcast = vi.fn(async () => undefined);

    const completion = ready.arrive(broadcast);
    empty.skip();
    await vi.advanceTimersByTimeAsync(900);

    await completion;
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('cancels the whole shared wave when one wallet lease is lost while waiting to broadcast', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(
      2,
      undefined,
      { abortOnParticipantFailure: true },
    );
    const first = barrier.createParticipant('first-wallet');
    const second = barrier.createParticipant('second-wallet');
    const firstBroadcast = vi.fn(async () => undefined);
    const secondBroadcast = vi.fn(async () => undefined);
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    let secondLeaseActive = true;

    const firstCompletion = first.arrive(
      firstBroadcast,
      firstCancel,
      () => undefined,
    );
    const secondCompletion = second.arrive(
      secondBroadcast,
      secondCancel,
      () => {
        if (!secondLeaseActive) throw new Error('source wallet lease lost');
      },
    );
    const firstRejection = expect(firstCompletion).rejects.toThrow('source wallet lease lost');
    const secondRejection = expect(secondCompletion).rejects.toThrow('source wallet lease lost');

    // Both participants were ready, but the shared wave deliberately waits
    // before submission. Losing one lease during that window must still result
    // in an all-wallet, zero-broadcast cancellation.
    secondLeaseActive = false;
    await vi.advanceTimersByTimeAsync(900);

    await Promise.all([firstRejection, secondRejection]);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondCancel).toHaveBeenCalledTimes(1);
    expect(firstBroadcast).not.toHaveBeenCalled();
    expect(secondBroadcast).not.toHaveBeenCalled();
  });

  it('attributes a strict preparation abort only to its root wallet', async () => {
    const onParticipantFailure = vi.fn();
    const barrier = new RobinhoodSellBroadcastBarrier(
      3,
      undefined,
      {
        abortOnParticipantFailure: true,
        onParticipantFailure,
      },
    );
    const ready = barrier.createParticipant('ready-wallet');
    const rootFailure = barrier.createParticipant('root-wallet');
    const closedSibling = barrier.createParticipant('sibling-wallet');
    const completion = ready.arrive(vi.fn(async () => undefined));

    rootFailure.fail();
    closedSibling.fail();

    await expect(completion).rejects.toThrow('本批已签名交易均未广播');
    expect(onParticipantFailure).toHaveBeenCalledTimes(1);
    expect(onParticipantFailure).toHaveBeenCalledWith('root-wallet');
  });

  it('still aborts the signed cohort when failure accounting itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const barrier = new RobinhoodSellBroadcastBarrier(
        2,
        undefined,
        {
          abortOnParticipantFailure: true,
          onParticipantFailure: () => {
            throw new Error('accounting failed');
          },
        },
      );
      const ready = barrier.createParticipant('ready-wallet');
      const failed = barrier.createParticipant('failed-wallet');
      const broadcast = vi.fn(async () => undefined);
      const cancel = vi.fn();
      const completion = ready.arrive(broadcast, cancel);

      failed.fail();

      await expect(completion).rejects.toThrow('本批已签名交易均未广播');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(broadcast).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('attributes a preparation timeout only to participants that never completed', async () => {
    const onParticipantFailure = vi.fn();
    const barrier = new RobinhoodSellBroadcastBarrier(
      2,
      undefined,
      {
        abortOnParticipantFailure: true,
        preparationTimeoutMs: 1_000,
        onParticipantFailure,
      },
    );
    const ready = barrier.createParticipant('ready-wallet');
    barrier.createParticipant('hung-wallet');
    const completion = ready.arrive(vi.fn(async () => undefined));
    const rejection = expect(completion).rejects.toThrow('卖出批次准备超时');

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(onParticipantFailure).toHaveBeenCalledTimes(1);
    expect(onParticipantFailure).toHaveBeenCalledWith('hung-wallet');
  });

  it('allows a large pure-sell cohort to use an extended preparation window', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(
      2,
      undefined,
      {
        abortOnParticipantFailure: true,
        preparationTimeoutMs: 60_000,
      },
    );
    const ready = barrier.createParticipant();
    const failed = barrier.createParticipant();
    const cancel = vi.fn();
    const completion = ready.arrive(vi.fn(async () => undefined), cancel);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancel).not.toHaveBeenCalled();

    failed.fail();
    await expect(completion).rejects.toThrow('本批已签名交易均未广播');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps task barriers in one wave when their preparation finishes hundreds of milliseconds apart', async () => {
    const firstBarrier = new RobinhoodSellBroadcastBarrier(1);
    const secondBarrier = new RobinhoodSellBroadcastBarrier(1);
    const broadcastTimes: number[] = [];

    const first = firstBarrier.createParticipant().arrive(async () => {
      broadcastTimes.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(broadcastTimes).toEqual([]);

    const second = secondBarrier.createParticipant().arrive(async () => {
      broadcastTimes.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(349);
    expect(broadcastTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await Promise.all([first, second]);
    expect(broadcastTimes).toHaveLength(2);
    expect(new Set(broadcastTimes).size).toBe(1);
  });

  it('holds a fast task for a concurrently registered slow task and releases one shared submit turn', async () => {
    const rpcKey = `https://cohort-${crypto.randomUUID()}.example`;
    const firstRegistration = registerRobinhoodTaskBroadcastCohort(rpcKey);
    const secondRegistration = registerRobinhoodTaskBroadcastCohort(rpcKey);
    const firstBarrier = new RobinhoodSellBroadcastBarrier(1, firstRegistration);
    const secondBarrier = new RobinhoodSellBroadcastBarrier(1, secondRegistration);
    const broadcastTimes: number[] = [];

    const first = firstBarrier.createParticipant().arrive(async () => {
      broadcastTimes.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(broadcastTimes).toEqual([]);

    const second = secondBarrier.createParticipant().arrive(async () => {
      broadcastTimes.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(1_100);

    await Promise.all([first, second]);
    expect(broadcastTimes).toHaveLength(2);
    expect(new Set(broadcastTimes).size).toBe(1);
    expect(broadcastTimes[0] % 1_000).toBe(100);
  });

  it('cancels prepared nonces instead of broadcasting a partial batch after timeout', async () => {
    const barrier = new RobinhoodSellBroadcastBarrier(2);
    const ready = barrier.createParticipant();
    const cancel = vi.fn();
    const completion = ready.arrive(vi.fn(async () => undefined), cancel);
    const rejection = expect(completion).rejects.toThrow('卖出批次准备超时');

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
