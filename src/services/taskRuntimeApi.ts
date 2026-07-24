import { apiRequest } from '../api';

export const TASK_RUNTIME_BUILD_ID = __AMM_BUILD_ID__;

export interface TaskRuntimeLease {
  runtimeId: string;
  runtimeToken: string;
  expiresAt: string;
  runtimeDurationMs: number;
  heartbeatIntervalMs: number;
}

export interface TaskRuntimeHeartbeat {
  runtimeId: string;
  expiresAt: string;
  runtimeDurationMs: number;
}

export interface PublicTaskRuntime {
  runtimeId: string;
  clientInstanceId: string;
  clientBuildId: string;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type TaskRuntimeStopRequest =
  | {
      runtimeId: string;
      runtimeToken: string;
      force?: never;
    }
  | {
      runtimeId: string;
      force: true;
      runtimeToken?: never;
    };

export function createRuntimeId(): string {
  return crypto.randomUUID();
}

export function getClientInstanceId(): string {
  const fallback = `instance-${crypto.randomUUID()}`;
  if (typeof sessionStorage === 'undefined') return fallback;

  const storageKey = 'amm_task_client_instance_v1';
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    sessionStorage.setItem(storageKey, fallback);
  } catch {
    return fallback;
  }
  return fallback;
}

export async function startTaskRuntime(
  taskId: string,
  runtimeId: string,
  clientInstanceId: string,
): Promise<TaskRuntimeLease> {
  const response = await apiRequest<TaskRuntimeLease>(`/api/tasks/${taskId}/runtime/start`, {
    method: 'POST',
    body: JSON.stringify({
      runtimeId,
      clientInstanceId,
      clientBuildId: TASK_RUNTIME_BUILD_ID,
    }),
  });
  return response.data!;
}

export async function heartbeatTaskRuntime(
  taskId: string,
  runtimeId: string,
  runtimeToken: string,
): Promise<TaskRuntimeHeartbeat> {
  const response = await apiRequest<TaskRuntimeHeartbeat>(`/api/tasks/${taskId}/runtime/heartbeat`, {
    method: 'POST',
    headers: {
      'X-Task-Runtime-Token': runtimeToken,
    },
    body: JSON.stringify({ runtimeId }),
  });
  return response.data!;
}

export async function stopTaskRuntime(
  taskId: string,
  request: TaskRuntimeStopRequest,
): Promise<boolean> {
  const runtimeToken = 'runtimeToken' in request
    ? request.runtimeToken
    : undefined;
  const response = await apiRequest<{ revoked: boolean }>(`/api/tasks/${taskId}/runtime/stop`, {
    method: 'POST',
    headers: runtimeToken
      ? { 'X-Task-Runtime-Token': runtimeToken }
      : undefined,
    body: JSON.stringify(
      'force' in request
        ? { runtimeId: request.runtimeId, force: true }
        : { runtimeId: request.runtimeId },
    ),
  });
  return Boolean(response.data?.revoked);
}

export async function getTaskRuntimeStatus(taskId: string): Promise<{
  running: boolean;
  runtime: PublicTaskRuntime | null;
}> {
  const response = await apiRequest<{
    running: boolean;
    runtime: PublicTaskRuntime | null;
  }>(`/api/tasks/${taskId}/runtime`);
  return response.data!;
}

export function isTaskRuntimeBusy(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'TASK_RUNTIME_BUSY';
}

export function isTaskRuntimeRevoked(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'TASK_RUNTIME_REVOKED'
    || error.code === 'TASK_NOT_FOUND'
    || error.code === 'COORDINATION_AUTH_REQUIRED';
}
