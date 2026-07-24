type BroadcastAction = () => Promise<void>;
type CancelAction = () => void;
type ValidateAction = () => void;

type DeferredEntry = {
  broadcast: BroadcastAction;
  cancel?: CancelAction;
  validate?: ValidateAction;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const CROSS_TASK_MIN_COLLECTION_MS = 900;
const CROSS_TASK_QUIET_MS = 350;
const CROSS_TASK_MAX_COLLECTION_MS = 2_000;
const PREPARATION_TIMEOUT_MS = 15_000;
const TASK_REGISTRATION_WINDOW_MS = 750;
const TASK_COHORT_TIMEOUT_MS = 30_000;
const CHAIN_SECOND_SAFE_OFFSET_MS = 100;

function broadcastEntries(entries: DeferredEntry[], alignToChainSecond = false): void {
  // Invoke every send function in the same JavaScript turn. All Robinhood
  // TradingService instances share one viem broadcast client, so these calls
  // become one JSON-RPC eth_sendRawTransaction batch across task boundaries.
  const invoke = () => {
    // A task barrier can wait in the shared wave (or a cross-task cohort) after
    // every wallet has signed. Revalidate every wallet lease immediately before
    // the first network write. Validation is deliberately synchronous and
    // side-effect free: if any lease was lost while waiting, cancel/reject the
    // entire cohort before invoking even one broadcast action.
    try {
      for (const entry of entries) entry.validate?.();
    } catch (error) {
      rejectEntries(
        entries,
        error instanceof Error
          ? error
          : new Error(String(error || 'Robinhood broadcast validation failed')),
      );
      return;
    }

    for (const entry of entries) {
      void Promise.resolve()
        .then(entry.broadcast)
        .then(entry.resolve, entry.reject);
    }
  };
  if (!alignToChainSecond) {
    invoke();
    return;
  }

  // Robinhood emits several L2 blocks per second, but explorer timestamps have
  // one-second precision. Even one HTTP batch can straddle an integer-second
  // boundary. Start the sole batch just after the next boundary so the normal
  // sub-second provider/sequencer processing window remains inside one second.
  const now = Date.now();
  const delay = (1_000 - (now % 1_000)) + CHAIN_SECOND_SAFE_OFFSET_MS;
  globalThis.setTimeout(invoke, delay);
}

function rejectEntries(entries: DeferredEntry[], error: Error): void {
  for (const entry of entries) {
    try {
      entry.cancel?.();
    } catch (cancelError) {
      // One nonce-cache cleanup must never prevent the remaining signed
      // transactions from being cancelled and rejected fail-closed.
      console.error('Robinhood broadcast cancellation failed:', cancelError);
    }
    entry.reject(error);
  }
}

class RobinhoodSellBroadcastWave {
  private pending: DeferredEntry[] = [];
  private quietTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private maximumTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private cohortStartedAt = 0;

  enqueue(entries: DeferredEntry[]): void {
    if (entries.length === 0) return;
    this.pending.push(...entries);
    const now = Date.now();
    if (this.cohortStartedAt === 0) {
      this.cohortStartedAt = now;
      this.maximumTimer = globalThis.setTimeout(
        () => this.flush(),
        CROSS_TASK_MAX_COLLECTION_MS,
      );
    }

    if (this.quietTimer !== undefined) globalThis.clearTimeout(this.quietTimer);
    const minimumReleaseAt = this.cohortStartedAt + CROSS_TASK_MIN_COLLECTION_MS;
    const quietReleaseAt = now + CROSS_TASK_QUIET_MS;
    const releaseAt = Math.max(minimumReleaseAt, quietReleaseAt);
    this.quietTimer = globalThis.setTimeout(
      () => this.flush(),
      Math.max(0, releaseAt - now),
    );
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    if (this.quietTimer !== undefined) globalThis.clearTimeout(this.quietTimer);
    if (this.maximumTimer !== undefined) globalThis.clearTimeout(this.maximumTimer);
    this.quietTimer = undefined;
    this.maximumTimer = undefined;
    this.cohortStartedAt = 0;
    const cohort = this.pending.splice(0);
    broadcastEntries(cohort);
  }
}

const sharedBroadcastWave = new RobinhoodSellBroadcastWave();

type TaskRegistrationState = {
  completed: boolean;
  entries: DeferredEntry[];
};

export type RobinhoodTaskBroadcastRegistration = {
  submit: (entries: DeferredEntry[]) => void;
  fail: () => void;
};

class RobinhoodTaskBroadcastCohort {
  private readonly registrations = new Set<TaskRegistrationState>();
  private sealed = false;
  private closed = false;
  private timedOutError: Error | undefined;
  private readonly sealTimer: ReturnType<typeof globalThis.setTimeout>;
  private readonly timeoutTimer: ReturnType<typeof globalThis.setTimeout>;

  constructor(private readonly onSealed: () => void) {
    this.sealTimer = globalThis.setTimeout(() => {
      if (this.closed) return;
      this.sealed = true;
      this.onSealed();
      this.flushIfComplete();
    }, TASK_REGISTRATION_WINDOW_MS);
    this.timeoutTimer = globalThis.setTimeout(() => {
      if (this.closed) return;
      this.closed = true;
      this.timedOutError = new Error('Robinhood task broadcast cohort preparation timed out');
      globalThis.clearTimeout(this.sealTimer);
      this.onSealed();
      const entries = [...this.registrations].flatMap(state => state.entries.splice(0));
      rejectEntries(entries, this.timedOutError);
    }, TASK_COHORT_TIMEOUT_MS);
  }

  get isSealed(): boolean {
    return this.sealed || this.closed;
  }

  register(): RobinhoodTaskBroadcastRegistration {
    if (this.isSealed) {
      throw new Error('Robinhood task broadcast cohort is already sealed');
    }
    const state: TaskRegistrationState = {
      completed: false,
      entries: [],
    };
    this.registrations.add(state);

    return {
      submit: entries => {
        if (state.completed) return;
        state.completed = true;
        if (this.closed) {
          rejectEntries(
            entries,
            this.timedOutError ?? new Error('Robinhood task broadcast cohort is closed'),
          );
          return;
        }
        state.entries.push(...entries);
        this.flushIfComplete();
      },
      fail: () => {
        if (state.completed) return;
        state.completed = true;
        this.flushIfComplete();
      },
    };
  }

  private flushIfComplete(): void {
    if (
      this.closed
      || !this.sealed
      || [...this.registrations].some(state => !state.completed)
    ) {
      return;
    }
    this.closed = true;
    globalThis.clearTimeout(this.sealTimer);
    globalThis.clearTimeout(this.timeoutTimer);
    const entries = [...this.registrations].flatMap(state => state.entries.splice(0));
    broadcastEntries(entries, true);
  }
}

class RobinhoodTaskBroadcastCoordinator {
  private activeCohort: RobinhoodTaskBroadcastCohort | undefined;

  register(): RobinhoodTaskBroadcastRegistration {
    if (!this.activeCohort || this.activeCohort.isSealed) {
      const cohort = new RobinhoodTaskBroadcastCohort(() => {
        if (this.activeCohort === cohort) this.activeCohort = undefined;
      });
      this.activeCohort = cohort;
    }
    return this.activeCohort.register();
  }
}

const taskBroadcastCoordinators = new Map<string, RobinhoodTaskBroadcastCoordinator>();

/**
 * Register a Robinhood task before any asynchronous runtime, allowance, quote,
 * nonce or fee preparation starts. Tasks registered on the same RPC within
 * the short start window form one fail-closed cohort. No prepared transaction
 * is submitted until every registered task either contributes its complete
 * signed batch or reports that it cannot participate.
 */
export function registerRobinhoodTaskBroadcastCohort(
  rpcUrl: string,
): RobinhoodTaskBroadcastRegistration {
  const key = rpcUrl.trim();
  let coordinator = taskBroadcastCoordinators.get(key);
  if (!coordinator) {
    coordinator = new RobinhoodTaskBroadcastCoordinator();
    taskBroadcastCoordinators.set(key, coordinator);
  }
  return coordinator.register();
}

export type RobinhoodSellBroadcastParticipant = {
  arrive: (
    broadcast: BroadcastAction,
    cancel?: CancelAction,
    validate?: ValidateAction,
  ) => Promise<void>;
  skip: () => void;
  fail: () => void;
};

export type RobinhoodSellBroadcastBarrierOptions = {
  /**
   * Pure sell-all rounds must not silently turn one preparation failure into a
   * partial sell. Mixed buy/sell rounds retain the legacy release-ready policy
   * because a benign zero-balance sell must not cancel unrelated buys.
   */
  abortOnParticipantFailure?: boolean;
  /**
   * Large pure-sell cohorts perform balance, quote, nonce and fee reads for
   * every wallet. Give those cohorts an adaptive preparation window while
   * retaining the short legacy timeout for ordinary mixed rounds.
   */
  preparationTimeoutMs?: number;
  onParticipantFailure?: (participantId?: string) => void;
};

/**
 * Two-phase Robinhood sell barrier:
 *  1. every wallet finishes balance/quote/nonce/fee work and signs locally;
 *  2. all successful participants enter one cross-task broadcast wave.
 *
 * A participant that fails preparation still reports completion, so the other
 * wallets cannot deadlock waiting for an entry that will never be signed.
 */
export class RobinhoodSellBroadcastBarrier {
  private completed = 0;
  private ready: DeferredEntry[] = [];
  private closed = false;
  private timedOutError: Error | undefined;
  private readonly pendingParticipants = new Map<symbol, string | undefined>();
  private readonly timeout: ReturnType<typeof globalThis.setTimeout>;

  constructor(
    private readonly expectedParticipants: number,
    private readonly taskRegistration?: RobinhoodTaskBroadcastRegistration,
    private readonly options: RobinhoodSellBroadcastBarrierOptions = {},
  ) {
    if (!Number.isInteger(expectedParticipants) || expectedParticipants <= 0) {
      throw new Error('Robinhood sell broadcast barrier requires at least one participant');
    }
    const preparationTimeoutMs = Math.max(
      1,
      Math.floor(options.preparationTimeoutMs ?? PREPARATION_TIMEOUT_MS),
    );
    this.timeout = globalThis.setTimeout(() => {
      if (this.closed) return;
      for (const participantId of this.pendingParticipants.values()) {
        this.notifyParticipantFailure(participantId);
      }
      this.abort(new Error('卖出批次准备超时，本批交易均未广播'));
    }, preparationTimeoutMs);
  }

  createParticipant(participantId?: string): RobinhoodSellBroadcastParticipant {
    let settled = false;
    const participantKey = Symbol(participantId);
    this.pendingParticipants.set(participantKey, participantId);
    const settleParticipant = () => {
      if (settled) return false;
      settled = true;
      this.pendingParticipants.delete(participantKey);
      return true;
    };
    return {
      arrive: async (broadcast, cancel, validate) => {
        if (!settleParticipant()) {
          throw new Error('Robinhood sell participant has already completed');
        }
        if (this.closed) {
          cancel?.();
          throw this.timedOutError ?? new Error('Robinhood sell broadcast barrier is closed');
        }

        const completion = new Promise<void>((resolve, reject) => {
          this.ready.push({ broadcast, cancel, validate, resolve, reject });
        });
        this.completeParticipant();
        return completion;
      },
      skip: () => {
        if (!settleParticipant()) return;
        if (this.closed) return;
        this.completeParticipant();
      },
      fail: () => {
        if (!settleParticipant()) return;
        // Once one strict participant aborts the cohort, later siblings fail
        // only because that cohort is already closed. Do not misattribute the
        // root failure to every wallet that was still preparing.
        if (this.closed) return;
        this.notifyParticipantFailure(participantId);
        if (this.options.abortOnParticipantFailure) {
          this.abort(new Error('卖出批次中有钱包准备失败，本批已签名交易均未广播'));
          return;
        }
        this.completeParticipant();
      },
    };
  }

  private notifyParticipantFailure(participantId?: string): void {
    try {
      this.options.onParticipantFailure?.(participantId);
    } catch (error) {
      // Failure accounting is diagnostic/control-plane state. It must never
      // prevent the fail-closed data-plane abort that protects signed nonces.
      console.error('Robinhood participant failure callback failed:', error);
    }
  }

  private abort(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.timedOutError = error;
    globalThis.clearTimeout(this.timeout);
    rejectEntries(this.ready.splice(0), error);
    this.taskRegistration?.fail();
  }

  private completeParticipant(): void {
    this.completed++;
    if (this.completed < this.expectedParticipants) return;
    if (this.completed > this.expectedParticipants) {
      throw new Error('Robinhood sell broadcast barrier participant overflow');
    }
    this.closed = true;
    globalThis.clearTimeout(this.timeout);
    const entries = this.ready.splice(0);
    if (this.taskRegistration) this.taskRegistration.submit(entries);
    else sharedBroadcastWave.enqueue(entries);
  }
}
