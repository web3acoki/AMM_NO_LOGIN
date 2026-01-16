<template>
  <div>
    <div class="d-flex justify-content-between align-items-center">
      <h2 class="h6 mb-0">批量导入钱包</h2>
      <span class="text-muted small">当前链：{{ selectedChainName }}</span>
    </div>
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
    <div v-if="result" class="alert alert-info small mt-2">
      导入完成：成功 {{ result.added }}，重复 {{ result.duplicates }}，无效 {{ result.invalid }}。
    </div>
    <div v-if="importing" class="small text-muted mt-1">正在刷新余额...</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useWalletStore } from '../../stores/walletStore';
import { useChainStore } from '../../stores/chainStore';

const walletStore = useWalletStore();
const chainStore = useChainStore();

const selectedFile = ref<File | null>(null);
const walletType = ref<'main' | 'normal'>('normal');
const remark = ref('');
const result = ref<{ added: number; duplicates: number; invalid: number } | null>(null);
const importing = ref(false);

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
</script>
