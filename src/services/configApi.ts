/**
 * 配置 API 服务
 * 获取服务端运行时配置（如付费 RPC 节点地址）
 */

import { apiRequest } from '../api';

export interface ServerConfig {
  premiumRpcUrl: string;
  premiumRpcUrlsByChain?: Partial<Record<number, string>>;
}

// 获取服务端配置
export async function getServerConfig(): Promise<ServerConfig> {
  const response = await apiRequest<ServerConfig>('/api/config');
  return response.data!;
}
