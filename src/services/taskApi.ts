/**
 * 任务 API 服务
 * 用于与后端任务接口通信
 */

import { apiRequest } from '../api';
import type { TaskConfig, TaskStats } from '../stores/taskStore';

// 服务端返回的任务数据（不含运行时字段）
export interface TaskServerData {
  _id: string;
  name: string;
  config: TaskConfig;
  walletAddresses: string[];
  stats: TaskStats;
  currentBuyWalletIndex: number;
  currentSellWalletIndex: number;
  runtimeActive?: boolean;
  runtimeId?: string;
  createdAt?: string;
  updatedAt?: string;
}

// 获取用户任务列表
export async function getTasks(): Promise<TaskServerData[]> {
  const response = await apiRequest<TaskServerData[]>('/api/tasks');
  return response.data || [];
}

// 创建任务
export async function createTask(data: {
  name: string;
  config: TaskConfig;
  walletAddresses: string[];
}): Promise<TaskServerData> {
  const response = await apiRequest<TaskServerData>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  return response.data!;
}

// 更新任务
export async function updateTask(id: string, data: {
  name?: string;
  config?: TaskConfig;
  walletAddresses?: string[];
}): Promise<TaskServerData> {
  const response = await apiRequest<TaskServerData>(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
  return response.data!;
}

// 更新任务统计（轻量接口）
export async function updateTaskStats(id: string, data: {
  stats: TaskStats;
  currentBuyWalletIndex: number;
  currentSellWalletIndex: number;
}): Promise<void> {
  await apiRequest(`/api/tasks/${id}/stats`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

// 删除单个任务
export async function deleteTask(id: string): Promise<void> {
  await apiRequest(`/api/tasks/${id}`, {
    method: 'DELETE'
  });
}

// 批量删除任务
export async function deleteTasks(ids: string[]): Promise<{ deleted: number }> {
  const response = await apiRequest<{ deleted: number }>('/api/tasks/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
  return response.data!;
}

// 批量更新代币地址
export async function batchUpdateTokenAddress(taskIds: string[], tokenAddress: string): Promise<{ updated: number }> {
  const response = await apiRequest<{ updated: number }>('/api/tasks/batch-update-token', {
    method: 'POST',
    body: JSON.stringify({ taskIds, tokenAddress })
  });
  return response.data!;
}

// 清空所有任务
export async function clearAllTasks(): Promise<{ deleted: number }> {
  const response = await apiRequest<{ deleted: number }>('/api/tasks/clear-all', {
    method: 'POST'
  });
  return response.data!;
}

// 检查是否已登录
export function isLoggedIn(): boolean {
  return !!localStorage.getItem('amm_token');
}
