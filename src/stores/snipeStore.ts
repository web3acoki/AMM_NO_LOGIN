/**
 * 狙击任务状态管理
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  SnipeService,
  createSnipeService,
  type SnipeTaskConfig,
  type SnipeLog,
  type SnipeWallet,
  type TokenCreatedEvent,
  type BuyResult
} from '../services/snipeService';
import { useChainStore } from './chainStore';
import { useWalletStore } from './walletStore';

// 生成唯一 ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

export const useSnipeStore = defineStore('snipe', () => {
  // ==================== 状态 ====================

  const tasks = ref<SnipeTaskConfig[]>([]);
  const activeServices = ref<Map<string, SnipeService>>(new Map());
  const taskLogs = ref<Map<string, SnipeLog[]>>(new Map());
  const currentTaskId = ref<string | null>(null);

  // ==================== 计算属性 ====================

  const currentTask = computed(() => {
    if (!currentTaskId.value) return null;
    return tasks.value.find(t => t.id === currentTaskId.value) || null;
  });

  const currentLogs = computed(() => {
    if (!currentTaskId.value) return [];
    return taskLogs.value.get(currentTaskId.value) || [];
  });

  const runningTasks = computed(() => {
    return tasks.value.filter(t => t.status === 'running');
  });

  const pendingTasks = computed(() => {
    return tasks.value.filter(t => t.status === 'pending');
  });

  // ==================== 任务管理 ====================

  /**
   * 创建新任务
   */
  function createTask(config: {
    targetWallet: string;
    buyAmount: number;
    gasPrice: number;
    gasLimit: number;
    walletAddresses?: string[];  // 从钱包列表选择
    batchId?: string;            // 或从批次选择
    customHttpRpc?: string;      // 自定义 HTTP RPC
    customWssRpc?: string;       // 自定义 WebSocket
  }): SnipeTaskConfig {
    const walletStore = useWalletStore();

    // 获取执行钱包
    let snipeWallets: SnipeWallet[] = [];

    if (config.batchId) {
      // 从批次获取钱包
      const batch = walletStore.walletBatches.find(b => b.id === config.batchId);
      if (batch) {
        snipeWallets = batch.wallets.map(w => ({
          address: w.address,
          privateKey: w.privateKey,
          remark: w.remark
        }));
      }
    } else if (config.walletAddresses && config.walletAddresses.length > 0) {
      // 从钱包地址列表获取
      for (const addr of config.walletAddresses) {
        const wallet = walletStore.localWallets.find(
          w => w.address.toLowerCase() === addr.toLowerCase()
        );
        if (wallet && wallet.encrypted) {
          snipeWallets.push({
            address: wallet.address,
            privateKey: wallet.encrypted,
            remark: wallet.remark
          });
        }
      }
    } else {
      // 使用已勾选的钱包 (selectedWalletAddresses)
      for (const addr of walletStore.selectedWalletAddresses) {
        const wallet = walletStore.localWallets.find(
          w => w.address.toLowerCase() === addr.toLowerCase()
        );
        if (wallet && wallet.encrypted) {
          snipeWallets.push({
            address: wallet.address,
            privateKey: wallet.encrypted,
            remark: wallet.remark
          });
        }
      }
    }

    const task: SnipeTaskConfig = {
      id: generateId(),
      targetWallet: config.targetWallet,
      buyAmount: config.buyAmount,
      gasPrice: config.gasPrice,
      gasLimit: config.gasLimit,
      wallets: snipeWallets,
      status: 'pending',
      createdAt: Date.now(),
      customHttpRpc: config.customHttpRpc,
      customWssRpc: config.customWssRpc
    };

    tasks.value.push(task);
    taskLogs.value.set(task.id, []);

    return task;
  }

  /**
   * 删除任务
   */
  function deleteTask(taskId: string) {
    // 停止运行中的任务
    const service = activeServices.value.get(taskId);
    if (service) {
      service.destroy();
      activeServices.value.delete(taskId);
    }

    // 删除任务
    const index = tasks.value.findIndex(t => t.id === taskId);
    if (index !== -1) {
      tasks.value.splice(index, 1);
    }

    // 删除日志
    taskLogs.value.delete(taskId);

    // 如果删除的是当前任务，清空选择
    if (currentTaskId.value === taskId) {
      currentTaskId.value = null;
    }
  }

  /**
   * 选择当前任务
   */
  function selectTask(taskId: string | null) {
    currentTaskId.value = taskId;
  }

  // ==================== 任务控制 ====================

  /**
   * 启动任务
   */
  async function startTask(taskId: string): Promise<boolean> {
    const task = tasks.value.find(t => t.id === taskId);
    if (!task) {
      console.error('任务不存在:', taskId);
      return false;
    }

    if (task.status === 'running') {
      console.warn('任务已在运行中');
      return false;
    }

    if (task.wallets.length === 0) {
      addLog(taskId, 'error', '没有可用的执行钱包');
      return false;
    }

    const chainStore = useChainStore();

    // 创建服务（优先使用自定义节点，否则使用默认节点）
    const service = createSnipeService(
      task,
      chainStore.selectedChainId,
      task.customHttpRpc,
      task.customWssRpc
    );

    // 设置回调
    service.setOnLog((log) => {
      addLog(taskId, log.type, log.message, log.data);
    });

    service.setOnTokenFound((event) => {
      addLog(taskId, 'success', `发现目标代币: ${event.token}`, event);
    });

    service.setOnBuyComplete((results) => {
      const successCount = results.filter(r => r.success).length;
      addLog(taskId, 'info', `买入完成: ${successCount}/${results.length} 成功`, results);
    });

    service.setOnStatusChange((status) => {
      const t = tasks.value.find(t => t.id === taskId);
      if (t) {
        t.status = status;
      }
    });

    // 保存服务实例
    activeServices.value.set(taskId, service);

    // 启动
    try {
      await service.start();
      return true;
    } catch (error: any) {
      addLog(taskId, 'error', `启动失败: ${error.message}`);
      task.status = 'failed';
      return false;
    }
  }

  /**
   * 停止任务
   */
  function stopTask(taskId: string) {
    const service = activeServices.value.get(taskId);
    if (service) {
      service.stop();
      activeServices.value.delete(taskId);
    }

    const task = tasks.value.find(t => t.id === taskId);
    if (task && task.status === 'running') {
      task.status = 'stopped';
    }

    addLog(taskId, 'info', '任务已停止');
  }

  // ==================== 日志管理 ====================

  /**
   * 添加日志
   */
  function addLog(taskId: string, type: SnipeLog['type'], message: string, data?: any) {
    const logs = taskLogs.value.get(taskId) || [];
    logs.push({
      timestamp: Date.now(),
      type,
      message,
      data
    });
    taskLogs.value.set(taskId, logs);
  }

  /**
   * 清空日志
   */
  function clearLogs(taskId: string) {
    taskLogs.value.set(taskId, []);
  }

  /**
   * 获取任务日志
   */
  function getTaskLogs(taskId: string): SnipeLog[] {
    return taskLogs.value.get(taskId) || [];
  }

  // ==================== 返回 ====================

  return {
    // 状态
    tasks,
    currentTaskId,
    taskLogs,

    // 计算属性
    currentTask,
    currentLogs,
    runningTasks,
    pendingTasks,

    // 任务管理
    createTask,
    deleteTask,
    selectTask,

    // 任务控制
    startTask,
    stopTask,

    // 日志管理
    addLog,
    clearLogs,
    getTaskLogs
  };
});
