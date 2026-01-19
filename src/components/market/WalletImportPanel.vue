<template>
  <div>
    <div class="d-flex justify-content-between align-items-center">
      <h2 class="h6 mb-0">批量导入钱包</h2>
      <span class="text-muted small">当前链：{{ selectedChainName }}</span>
    </div>

    <!-- 从文件导入 -->
    <div class="row g-2 mt-2">
      <div class="col-12 col-md-4">
        <input class="form-control form-control-sm" type="file" accept=".txt" @change="handleFileChange" />
      </div>
      <div class="col-6 col-md-3">
        <select class="form-select form-select-sm" v-model="walletType">
          <option value="main">主钱包</option>
          <option value="normal">普通钱包</option>
        </select>
      </div>
      <div class="col-6 col-md-3">
        <input
          class="form-control form-control-sm"
          v-model="remark"
          placeholder="批量备注（可选）"
        />
      </div>
      <div class="col-12 col-md-2 d-grid">
        <button class="btn btn-primary btn-sm" @click="importWallets" :disabled="!selectedFile || importing">
          {{ importing ? '导入中...' : '开始导入' }}
        </button>
      </div>
    </div>
    <div class="small text-muted mt-2">
      支持 .txt 文件，每行一个私钥（64位十六进制），重复自动跳过。
    </div>

    <!-- 从批次导入 -->
    <div v-if="walletBatches.length > 0" class="mt-3 pt-3 border-top">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="small fw-bold">从钱包批次导入</span>
      </div>
      <div class="row g-2 align-items-end">
        <div class="col-12 col-md-5">
          <select class="form-select form-select-sm" v-model="selectedBatchId">
            <option value="">-- 选择批次 --</option>
            <option v-for="batch in walletBatches" :key="batch.id" :value="batch.id">
              {{ batch.remark }} ({{ batch.wallets.length }} 个钱包)
            </option>
          </select>
        </div>
        <div class="col-6 col-md-3">
          <select class="form-select form-select-sm" v-model="batchImportType">
            <option value="main">主钱包</option>
            <option value="normal">普通钱包</option>
          </select>
        </div>
        <div class="col-6 col-md-4 d-grid">
          <button
            class="btn btn-outline-primary btn-sm"
            @click="importFromBatch"
            :disabled="!selectedBatchId || batchImporting"
          >
            <span v-if="batchImporting">
              <span class="spinner-border spinner-border-sm me-1"></span>导入中...
            </span>
            <span v-else>
              <i class="bi bi-box-arrow-in-down me-1"></i>从批次导入
            </span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="result" class="alert alert-info small mt-2">
      导入完成：成功 {{ result.added }}，重复 {{ result.duplicates }}{{ result.invalid !== undefined ? `，无效 ${result.invalid}` : '' }}。
    </div>
    <div v-if="importing" class="small text-muted mt-1">正在刷新余额...</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';

const walletStore = useWalletStore();
const chainStore = useChainStore();
const { walletBatches } = storeToRefs(walletStore);

const selectedFile = ref<File | null>(null);
const walletType = ref<'main' | 'normal'>('normal');
const remark = ref('');
const result = ref<{ added: number; duplicates: number; invalid?: number } | null>(null);
const importing = ref(false);

// 批次导入相关
const selectedBatchId = ref('');
const batchImportType = ref<'main' | 'normal'>('normal');
const batchImporting = ref(false);

const selectedChainName = computed(() => {
  const chain = chainStore.chains.find((entry) => entry.id === chainStore.selectedChainId);
  return chain ? `${chain.name} (${chain.governanceToken})` : '未知网络';
});

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  selectedFile.value = input.files?.[0] ?? null;
  result.value = null;
}

async function importWallets() {
  if (!selectedFile.value) {
    alert('请先选择 .txt 文件');
    return;
  }

  const text = await selectedFile.value.text();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (lines.length === 0) {
    alert('文件内容为空');
    return;
  }

  result.value = walletStore.importWalletsFromPrivateKeys(lines, {
    walletType: walletType.value,
    remark: remark.value,
  });

  if (result.value.added > 0) {
    importing.value = true;
    try {
      await walletStore.refreshAllBalances();
    } finally {
      importing.value = false;
    }
  }
}

async function importFromBatch() {
  if (!selectedBatchId.value) {
    alert('请先选择批次');
    return;
  }

  batchImporting.value = true;
  try {
    const importResult = walletStore.importWalletsFromBatch(selectedBatchId.value, batchImportType.value);
    result.value = importResult;

    if (importResult.added > 0) {
      await walletStore.refreshAllBalances();
      alert(`成功导入 ${importResult.added} 个钱包${importResult.duplicates > 0 ? `，${importResult.duplicates} 个重复已跳过` : ''}`);
    } else if (importResult.duplicates > 0) {
      alert(`所有钱包都已存在，${importResult.duplicates} 个重复已跳过`);
    }
  } catch (error: any) {
    alert(error.message || '导入失败');
  } finally {
    batchImporting.value = false;
  }
}
</script>
