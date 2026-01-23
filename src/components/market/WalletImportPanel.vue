<template>
  <div>
    <div class="d-flex justify-content-between align-items-center">
      <h2 class="h6 mb-0">批量导入钱包</h2>
      <span class="text-muted small">当前链：{{ selectedChainName }}</span>
    </div>

    <!-- 从文件导入 -->
    <div class="row g-2 mt-2">
      <div class="col-12 col-md-4">
        <input class="form-control form-control-sm" type="file" accept=".txt,.csv" @change="handleFileChange" />
      </div>
      <div class="col-6 col-md-2">
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
      <div class="col-12 col-md-3 d-grid">
        <button class="btn btn-primary btn-sm" @click="importWallets" :disabled="!selectedFile || importing">
          {{ importing ? '导入中...' : '开始导入' }}
        </button>
      </div>
    </div>
    <div class="row g-2 mt-2">
      <div class="col-12">
        <div class="form-check form-check-inline">
          <input
            type="checkbox"
            class="form-check-input"
            id="createBatchCheck"
            v-model="createBatch"
          >
          <label class="form-check-label small" for="createBatchCheck">
            同时生成钱包任务批次（用于批量操作）
          </label>
        </div>
      </div>
    </div>
    <div class="small text-muted mt-2">
      支持 .txt 和 .csv 文件，每行一个私钥（64位十六进制），CSV格式支持带表头或不带表头，重复自动跳过。
    </div>

    <div v-if="result" class="alert alert-info small mt-2">
      导入完成：成功 {{ result.added }}，重复 {{ result.duplicates }}{{ result.invalid !== undefined ? `，无效 ${result.invalid}` : '' }}。
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
const createBatch = ref(true);
const result = ref<{ added: number; duplicates: number; invalid?: number } | null>(null);
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

// 解析CSV内容，提取私钥
function parseCSVContent(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const privateKeys: string[] = [];
  const privateKeyRegex = /^(0x)?[0-9a-fA-F]{64}$/;

  for (const line of lines) {
    // 尝试按逗号分割（CSV格式）
    const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));

    for (const part of parts) {
      // 跳过表头类的内容
      if (part.toLowerCase().includes('private') ||
          part.toLowerCase().includes('key') ||
          part.toLowerCase().includes('address') ||
          part.toLowerCase() === 'id' ||
          part.toLowerCase() === 'index') {
        continue;
      }

      // 检查是否为有效的私钥格式
      if (privateKeyRegex.test(part)) {
        privateKeys.push(part);
      }
    }
  }

  return privateKeys;
}

// 解析TXT内容，提取私钥
function parseTXTContent(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const privateKeyRegex = /^(0x)?[0-9a-fA-F]{64}$/;

  return lines.filter(line => privateKeyRegex.test(line));
}

async function importWallets() {
  if (!selectedFile.value) {
    alert('请先选择文件');
    return;
  }

  const text = await selectedFile.value.text();
  const fileName = selectedFile.value.name.toLowerCase();

  let privateKeys: string[];

  if (fileName.endsWith('.csv')) {
    privateKeys = parseCSVContent(text);
  } else {
    privateKeys = parseTXTContent(text);
  }

  if (privateKeys.length === 0) {
    alert('文件中未找到有效的私钥');
    return;
  }

  result.value = walletStore.importWalletsFromPrivateKeys(privateKeys, {
    walletType: walletType.value,
    remark: remark.value,
  });

  // 如果勾选了生成批次且有成功导入的钱包
  if (createBatch.value && result.value.added > 0) {
    try {
      await walletStore.createBatchFromPrivateKeys(privateKeys, remark.value || '导入批次', walletType.value);
    } catch (error: any) {
      console.error('创建批次失败:', error);
    }
  }

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
