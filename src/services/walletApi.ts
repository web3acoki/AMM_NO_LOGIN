/**
 * 钱包 API 服务
 * 用于与后端钱包接口通信
 */

import { apiRequest } from '../api';

export interface WalletData {
  _id?: string;
  address: string;
  walletType?: 'main' | 'normal';
  remark?: string;
  nativeBalance?: string;
  tokenBalance?: string;
  createdAt?: string;
}

export interface WalletBatchData {
  _id?: string;
  batchId: string;
  remark?: string;
  walletType?: 'main' | 'normal';
  walletCount?: number;
  wallets?: Array<{
    address: string;
    remark?: string;
  }>;
  createdAt?: string;
}

export interface WalletStats {
  userWalletCount: number;
  userBatchCount: number;
  userBatchWalletCount: number;
  userTotalCount: number;
  globalCount: number;
  globalLimit: number;
}

export interface MigrationResult {
  wallets: { added: number; skipped: number };
  batches: { added: number; skipped: number };
}

// 获取钱包统计
export async function getWalletStats(): Promise<WalletStats> {
  const response = await apiRequest<WalletStats>('/api/wallets/stats');
  return response.data!;
}

// 获取用户钱包列表
export async function getWallets(): Promise<WalletData[]> {
  const response = await apiRequest<WalletData[]>('/api/wallets');
  return response.data || [];
}

// 添加单个钱包
export async function addWallet(wallet: {
  address: string;
  privateKey: string;
  walletType?: 'main' | 'normal';
  remark?: string;
}): Promise<WalletData> {
  const response = await apiRequest<WalletData>('/api/wallets', {
    method: 'POST',
    body: JSON.stringify(wallet)
  });
  return response.data!;
}

// 批量添加钱包
export async function addWallets(wallets: Array<{
  address: string;
  privateKey: string;
  walletType?: 'main' | 'normal';
  remark?: string;
}>): Promise<{ added: number; skipped: number; errors: any[] }> {
  const response = await apiRequest<{ added: number; skipped: number; errors: any[] }>('/api/wallets/batch-add', {
    method: 'POST',
    body: JSON.stringify({ wallets })
  });
  return response.data!;
}

// 更新钱包
export async function updateWallet(id: string, data: {
  walletType?: 'main' | 'normal';
  remark?: string;
  nativeBalance?: string;
  tokenBalance?: string;
}): Promise<WalletData> {
  const response = await apiRequest<WalletData>(`/api/wallets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
  return response.data!;
}

// 删除单个钱包
export async function deleteWallet(id: string): Promise<void> {
  await apiRequest(`/api/wallets/${id}`, {
    method: 'DELETE'
  });
}

// 批量删除钱包
export async function deleteWallets(ids: string[]): Promise<{ deleted: number }> {
  const response = await apiRequest<{ deleted: number }>('/api/wallets/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
  return response.data!;
}

// 获取钱包批次列表
export async function getBatches(): Promise<WalletBatchData[]> {
  const response = await apiRequest<WalletBatchData[]>('/api/wallets/batches');
  return response.data || [];
}

// 添加钱包批次
export async function addBatch(batch: {
  batchId: string;
  remark?: string;
  walletType?: 'main' | 'normal';
  wallets: Array<{
    address: string;
    privateKey: string;
    remark?: string;
  }>;
}): Promise<WalletBatchData> {
  const response = await apiRequest<WalletBatchData>('/api/wallets/batches', {
    method: 'POST',
    body: JSON.stringify(batch)
  });
  return response.data!;
}

// 删除钱包批次
export async function deleteBatch(id: string): Promise<void> {
  await apiRequest(`/api/wallets/batches/${id}`, {
    method: 'DELETE'
  });
}

// 解密私钥（用于交易）
export async function decryptPrivateKeys(addresses: string[]): Promise<Array<{
  address: string;
  privateKey: string;
}>> {
  const response = await apiRequest<Array<{ address: string; privateKey: string }>>('/api/wallets/decrypt', {
    method: 'POST',
    body: JSON.stringify({ addresses })
  });
  return response.data || [];
}

// 验证转账地址所有权
export async function validateTransfer(sourceAddresses: string[], targetAddresses: string[]): Promise<{
  valid: boolean;
  missingAddresses?: string[];
}> {
  const response = await apiRequest<{ valid: boolean; missingAddresses?: string[] }>('/api/wallets/validate-transfer', {
    method: 'POST',
    body: JSON.stringify({ sourceAddresses, targetAddresses })
  });
  return response.data!;
}

// 迁移本地钱包到服务器
export async function migrateWallets(data: {
  wallets: Array<{
    address: string;
    encrypted: string;
    walletType?: 'main' | 'normal';
    remark?: string;
    nativeBalance?: string;
    tokenBalance?: string;
  }>;
  batches: Array<{
    id: string;
    remark?: string;
    walletType?: 'main' | 'normal';
    wallets: Array<{
      address: string;
      privateKey: string;
      remark?: string;
    }>;
  }>;
}): Promise<MigrationResult> {
  const response = await apiRequest<MigrationResult>('/api/wallets/migrate', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  return response.data!;
}

// 检查是否已登录
export function isLoggedIn(): boolean {
  return !!localStorage.getItem('amm_token');
}
