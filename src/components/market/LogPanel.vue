<template>
  <div>
    <div class="d-flex justify-content-between align-items-center">
      <h2 class="h6 mb-0">日志</h2>
      <div class="d-flex gap-2">
        <button class="btn btn-outline-secondary btn-sm" @click="clear">清空</button>
        <button class="btn btn-outline-primary btn-sm" @click="exportJson">导出 JSON</button>
      </div>
    </div>
    <div class="border rounded mt-2" style="height: 360px; overflow: auto; background: #fff">
      <div class="p-2 small" v-for="(l, idx) in logs" :key="idx">
        <span class="text-muted">{{ new Date(l.time).toLocaleString() }}</span>
        <span class="mx-2">{{ l.message }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useLogStore } from '../../stores/logStore';

const logStore = useLogStore();
const { logs } = storeToRefs(logStore);

function clear() { logStore.clear(); }
function exportJson() { logStore.exportJson(); }
</script>

