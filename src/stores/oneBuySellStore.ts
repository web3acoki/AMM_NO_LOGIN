import { defineStore } from 'pinia';
import {
  controlOneBuySellRun,
  createOneBuySellGroup,
  createOneBuySellRun,
  deleteOneBuySellGroup,
  getOneBuySellGroup,
  getOneBuySellRun,
  listOneBuySellGroups,
  updateOneBuySellGroup,
  type OneBuySellGroup,
  type OneBuySellGroupInput,
  type OneBuySellRun,
} from '../services/oneBuySellApi';
import {
  OneBuySellRunner,
  assertOneBuySellPrivateKeys,
  preflightFirstOneBuySellWallet,
} from '../services/oneBuySellExecution';
import { useWalletStore } from './walletStore';

const runners = new Map<string, OneBuySellRunner>();

function apiErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error || '操作失败');
  const value = error as {
    message?: string;
    code?: string;
    data?: {
      duplicateAddresses?: string[];
      missingAddresses?: string[];
      conflicts?: Array<{ address?: string }>;
    };
  };
  if (value.code === 'ONE_BUY_SELL_DUPLICATE_WALLETS') {
    return `钱包批次存在重复地址：${value.data?.duplicateAddresses?.join('、') || value.message}`;
  }
  if (value.code === 'ONE_BUY_SELL_PRIVATE_KEY_MISSING') {
    return `以下钱包缺少匹配私钥：${value.data?.missingAddresses?.join('、') || value.message}`;
  }
  if (value.code === 'ONE_BUY_SELL_WALLET_CONFLICT') {
    return `以下钱包正在被其他“一买一卖”组使用：${
      value.data?.conflicts?.map(item => item.address).filter(Boolean).join('、') || value.message
    }`;
  }
  if (value.code === 'ONE_BUY_SELL_RUNTIME_BUSY') {
    return '该组正在另一个页面运行，请先在原页面暂停或停止';
  }
  if (value.code === 'ONE_BUY_SELL_GROUP_COMPLETED') {
    return '这个组已经完成，不能再次运行；如需再跑一次请新建组';
  }
  return value.message || '操作失败';
}

export const useOneBuySellStore = defineStore('oneBuySell', {
  state: () => ({
    groups: [] as OneBuySellGroup[],
    selectedGroupId: '' as string,
    selectedRuns: [] as OneBuySellRun[],
    loading: false,
    saving: false,
    busyRunIds: [] as string[],
    error: '',
  }),

  getters: {
    selectedGroup(state): OneBuySellGroup | undefined {
      return state.groups.find(group => group._id === state.selectedGroupId);
    },
  },

  actions: {
    setError(error: unknown) {
      this.error = apiErrorMessage(error);
    },

    clearError() {
      this.error = '';
    },

    upsertGroup(group: OneBuySellGroup) {
      const index = this.groups.findIndex(item => item._id === group._id);
      if (index >= 0) this.groups[index] = group;
      else this.groups.unshift(group);
    },

    applyRun(run: OneBuySellRun) {
      const groupIndex = this.groups.findIndex(group => group._id === run.groupId);
      if (groupIndex >= 0) {
        const group = this.groups[groupIndex];
        this.groups[groupIndex] = {
          ...group,
          latestRunId: run._id,
          latestRunStatus: run.status,
          latestRun: run,
          runtimeActive: runners.has(run._id) && run.status === 'running',
        };
      }
      const runIndex = this.selectedRuns.findIndex(item => item._id === run._id);
      if (runIndex >= 0) this.selectedRuns[runIndex] = run;
      else if (this.selectedGroupId === run.groupId) this.selectedRuns.unshift(run);
    },

    async loadGroups() {
      this.loading = true;
      this.clearError();
      try {
        this.groups = await listOneBuySellGroups();
        if (this.selectedGroupId && !this.groups.some(group => group._id === this.selectedGroupId)) {
          this.selectedGroupId = '';
          this.selectedRuns = [];
        }
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },

    async selectGroup(groupId: string) {
      this.selectedGroupId = groupId;
      try {
        const detail = await getOneBuySellGroup(groupId);
        this.selectedRuns = detail.runs;
      } catch (error) {
        this.setError(error);
      }
    },

    async saveGroup(input: OneBuySellGroupInput, groupId?: string) {
      this.saving = true;
      this.clearError();
      try {
        const group = groupId
          ? await updateOneBuySellGroup(groupId, input)
          : await createOneBuySellGroup(input);
        this.upsertGroup(group);
        this.selectedGroupId = group._id;
        return group;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.saving = false;
      }
    },

    async removeGroup(groupId: string) {
      this.clearError();
      try {
        await deleteOneBuySellGroup(groupId);
        this.groups = this.groups.filter(group => group._id !== groupId);
        if (this.selectedGroupId === groupId) {
          this.selectedGroupId = '';
          this.selectedRuns = [];
        }
      } catch (error) {
        this.setError(error);
        throw error;
      }
    },

    async startGroup(groupId: string) {
      this.clearError();
      const group = this.groups.find(item => item._id === groupId);
      if (!group) throw new Error('组不存在');
      if (group.latestRunStatus === 'completed') {
        const error = new Error('这个组已经完成，不能再次运行；如需再跑一次请新建组');
        this.setError(error);
        throw error;
      }

      const walletStore = useWalletStore();
      try {
        const privateKeys = await walletStore.getPrivateKeysForAddresses(group.walletOrder);
        assertOneBuySellPrivateKeys(group.walletOrder, privateKeys);
        // Validate funds and warm the paid RPC before creating a run. If the
        // first wallet is short, Start is rejected and no empty run is saved.
        await preflightFirstOneBuySellWallet(group);
        const run = await createOneBuySellRun(groupId);
        this.applyRun(run);
        this.launchRunner(run, privateKeys);
        return run;
      } catch (error) {
        this.setError(error);
        throw error;
      }
    },

    async continueRun(runId: string) {
      this.clearError();
      if (runners.has(runId)) return;
      try {
        const detail = await getOneBuySellRun(runId);
        if (!['paused', 'running'].includes(detail.run.status)) {
          throw new Error('只有暂停或页面中断的运行可以继续');
        }
        const walletStore = useWalletStore();
        const privateKeys = await walletStore.getPrivateKeysForAddresses(detail.run.walletOrder);
        this.applyRun(detail.run);
        this.launchRunner(detail.run, privateKeys);
      } catch (error) {
        this.setError(error);
        throw error;
      }
    },

    launchRunner(
      run: OneBuySellRun,
      privateKeys: Array<{ address: string; privateKey: string }>,
    ) {
      if (runners.has(run._id)) return;
      const runner = new OneBuySellRunner(run, privateKeys, {
        onRunUpdated: updated => this.applyRun(updated),
        onRuntimeLost: message => {
          this.error = message;
          const group = this.groups.find(item => item._id === run.groupId);
          if (group) group.runtimeActive = false;
        },
        onFinished: updated => this.applyRun(updated),
      });
      runners.set(run._id, runner);
      if (!this.busyRunIds.includes(run._id)) this.busyRunIds.push(run._id);
      const group = this.groups.find(item => item._id === run.groupId);
      if (group) group.runtimeActive = true;

      void runner.execute()
        .then(updated => this.applyRun(updated))
        .catch(error => this.setError(error))
        .finally(() => {
          runners.delete(run._id);
          this.busyRunIds = this.busyRunIds.filter(id => id !== run._id);
          const currentGroup = this.groups.find(item => item._id === run.groupId);
          if (currentGroup) currentGroup.runtimeActive = false;
          void this.loadGroups().catch(() => undefined);
        });
    },

    async pauseRun(runId: string) {
      this.clearError();
      runners.get(runId)?.cancelLocal();
      try {
        const run = await controlOneBuySellRun(runId, 'pause', '用户手动暂停');
        runners.delete(runId);
        this.busyRunIds = this.busyRunIds.filter(id => id !== runId);
        this.applyRun(run);
      } catch (error) {
        this.setError(error);
        throw error;
      }
    },

    async stopRun(runId: string) {
      this.clearError();
      runners.get(runId)?.cancelLocal();
      try {
        const run = await controlOneBuySellRun(runId, 'stop', '用户手动停止');
        runners.delete(runId);
        this.busyRunIds = this.busyRunIds.filter(id => id !== runId);
        this.applyRun(run);
      } catch (error) {
        this.setError(error);
        throw error;
      }
    },

    isLocallyRunning(runId?: string): boolean {
      return Boolean(runId && runners.has(runId));
    },
  },
});
