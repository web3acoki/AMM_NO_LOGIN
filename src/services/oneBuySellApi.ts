import { apiRequest } from '../api';
import {
  TASK_RUNTIME_BUILD_ID,
  createRuntimeId,
  getClientInstanceId,
} from './taskRuntimeApi';

export type OneBuySellRunStatus = 'running' | 'paused' | 'stopped' | 'completed';
export type OneBuySellWalletStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'failed';
export type OneBuySellStep =
  | 'ready'
  | 'preflight'
  | 'buying'
  | 'waiting_sell'
  | 'approving'
  | 'selling'
  | 'transferring'
  | 'completed'
  | 'stopped'
  | 'failed';
export type OneBuySellLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface OneBuySellWalletSnapshot {
  address: string;
  remark?: string;
}

export interface OneBuySellGroupInput {
  name: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  batchId: string;
  firstWalletAddress: string;
  amountMin: string | number;
  amountMax: string | number;
  sellDelaySeconds: number;
  buySlippage: number;
  sellSlippage: number;
}

export interface OneBuySellRunConfig {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  v3FeeTier: number;
  batchId: string;
  batchRemark: string;
  amountMin: number;
  amountMax: number;
  sellDelaySeconds: number;
  buySlippage: number;
  sellSlippage: number;
}

export interface OneBuySellWalletProgress {
  orderIndex: number;
  address: string;
  status: OneBuySellWalletStatus;
  step: OneBuySellStep;
  randomBuyAmount?: string;
  safeBuyMax?: string;
  buyTxHash?: `0x${string}`;
  buyConfirmedAt?: string;
  sellAt?: string;
  approvalTxHash?: `0x${string}`;
  approvalConfirmedAt?: string;
  sellTxHash?: `0x${string}`;
  sellConfirmedAt?: string;
  transferTxHash?: `0x${string}`;
  transferConfirmedAt?: string;
  transferTo?: string;
  transferredEth?: string;
  finalEthBalance?: string;
  finalTokenBalance?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface OneBuySellLog {
  timestamp: string;
  level: OneBuySellLogLevel;
  message: string;
  walletAddress?: string;
  txHash?: `0x${string}`;
}

export interface OneBuySellRun {
  _id: string;
  userId: string;
  groupId: string;
  runNumber: number;
  status: OneBuySellRunStatus;
  config: OneBuySellRunConfig;
  walletOrder: string[];
  walletProgress: OneBuySellWalletProgress[];
  currentWalletIndex: number;
  currentStep: OneBuySellStep | 'paused';
  sellAt?: string;
  pauseReason?: string;
  logs?: OneBuySellLog[];
  startedAt?: string;
  pausedAt?: string;
  stoppedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OneBuySellGroup {
  _id: string;
  name: string;
  chainId: 4663;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  v3FeeTier: 10000;
  batchId: string;
  batchRemark: string;
  wallets: OneBuySellWalletSnapshot[];
  firstWalletAddress: string;
  walletOrder: string[];
  amountMin: number;
  amountMax: number;
  sellDelaySeconds: number;
  buySlippage: number;
  sellSlippage: number;
  runCount: number;
  latestRunId?: string;
  latestRunStatus: 'none' | OneBuySellRunStatus;
  latestRun?: OneBuySellRun | null;
  runtimeActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OneBuySellStatePatch {
  currentWalletIndex?: number;
  currentStep?: Exclude<OneBuySellRun['currentStep'], 'paused'>;
  sellAt?: string | null;
  pauseReason?: string;
  status?: 'completed';
  walletIndex?: number;
  wallet?: Partial<Omit<OneBuySellWalletProgress, 'orderIndex' | 'address'>>;
  log?: {
    timestamp?: string;
    level: OneBuySellLogLevel;
    message: string;
    walletAddress?: string;
    txHash?: `0x${string}`;
  };
}

export interface OneBuySellRuntimeLease {
  runtimeId: string;
  runtimeToken: string;
  expiresAt: string;
  runtimeDurationMs: number;
  heartbeatIntervalMs: number;
}

export async function listOneBuySellGroups(): Promise<OneBuySellGroup[]> {
  const response = await apiRequest<OneBuySellGroup[]>('/api/one-buy-sell/groups');
  return response.data || [];
}

export async function getOneBuySellGroup(groupId: string): Promise<{
  group: OneBuySellGroup;
  runs: OneBuySellRun[];
  runtimeActive: boolean;
}> {
  const response = await apiRequest<{
    group: OneBuySellGroup;
    runs: OneBuySellRun[];
    runtimeActive: boolean;
  }>(`/api/one-buy-sell/groups/${groupId}`);
  return response.data!;
}

export async function createOneBuySellGroup(
  input: OneBuySellGroupInput,
): Promise<OneBuySellGroup> {
  const response = await apiRequest<OneBuySellGroup>('/api/one-buy-sell/groups', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.data!;
}

export async function updateOneBuySellGroup(
  groupId: string,
  input: OneBuySellGroupInput,
): Promise<OneBuySellGroup> {
  const response = await apiRequest<OneBuySellGroup>(`/api/one-buy-sell/groups/${groupId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return response.data!;
}

export async function deleteOneBuySellGroup(groupId: string): Promise<void> {
  await apiRequest(`/api/one-buy-sell/groups/${groupId}`, { method: 'DELETE' });
}

export async function createOneBuySellRun(groupId: string): Promise<OneBuySellRun> {
  const response = await apiRequest<OneBuySellRun>(
    `/api/one-buy-sell/groups/${groupId}/runs`,
    { method: 'POST' },
  );
  return response.data!;
}

export async function getOneBuySellRun(runId: string): Promise<{
  run: OneBuySellRun;
  runtimeActive: boolean;
}> {
  const response = await apiRequest<{
    run: OneBuySellRun;
    runtimeActive: boolean;
  }>(`/api/one-buy-sell/runs/${runId}`);
  return response.data!;
}

export async function patchOneBuySellRunState(
  runId: string,
  runtime: Pick<OneBuySellRuntimeLease, 'runtimeId' | 'runtimeToken'>,
  patch: OneBuySellStatePatch,
): Promise<OneBuySellRun> {
  const response = await apiRequest<OneBuySellRun>(
    `/api/one-buy-sell/runs/${runId}/state`,
    {
      method: 'PATCH',
      headers: { 'X-One-Buy-Sell-Runtime-Token': runtime.runtimeToken },
      body: JSON.stringify({ ...patch, runtimeId: runtime.runtimeId }),
    },
  );
  return response.data!;
}

export async function controlOneBuySellRun(
  runId: string,
  action: 'pause' | 'stop',
  reason = '',
): Promise<OneBuySellRun> {
  const response = await apiRequest<OneBuySellRun>(
    `/api/one-buy-sell/runs/${runId}/control`,
    {
      method: 'POST',
      body: JSON.stringify({ action, reason }),
    },
  );
  return response.data!;
}

export async function startOneBuySellRuntime(
  runId: string,
): Promise<OneBuySellRuntimeLease> {
  const response = await apiRequest<OneBuySellRuntimeLease>(
    `/api/one-buy-sell/runs/${runId}/runtime/start`,
    {
      method: 'POST',
      body: JSON.stringify({
        runtimeId: createRuntimeId(),
        clientInstanceId: getClientInstanceId(),
        clientBuildId: TASK_RUNTIME_BUILD_ID,
      }),
    },
  );
  return response.data!;
}

export async function heartbeatOneBuySellRuntime(
  runId: string,
  runtime: Pick<OneBuySellRuntimeLease, 'runtimeId' | 'runtimeToken'>,
): Promise<{ runtimeId: string; expiresAt: string; runtimeDurationMs: number }> {
  const response = await apiRequest<{
    runtimeId: string;
    expiresAt: string;
    runtimeDurationMs: number;
  }>(`/api/one-buy-sell/runs/${runId}/runtime/heartbeat`, {
    method: 'POST',
    headers: { 'X-One-Buy-Sell-Runtime-Token': runtime.runtimeToken },
    body: JSON.stringify({ runtimeId: runtime.runtimeId }),
  });
  return response.data!;
}

export function isOneBuySellRuntimeRevoked(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String(error.code || '');
  return code === 'ONE_BUY_SELL_RUNTIME_REVOKED'
    || code === 'ONE_BUY_SELL_RESERVATION_LOST'
    || code === 'ONE_BUY_SELL_RUN_NOT_RUNNING';
}
