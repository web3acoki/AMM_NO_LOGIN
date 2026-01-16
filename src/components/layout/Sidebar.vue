<template>
  <div class="sidebar d-flex flex-column p-3">
    <div class="mb-4">
      <div class="fw-semibold fs-5">AMM 管理台</div>
      <div class="text-muted small">控制面板</div>
    </div>
    <nav class="nav flex-column gap-1">
      <button
        v-for="item in items"
        :key="item.key"
        class="btn text-start sidebar-item"
        :class="item.key === activeKey ? 'btn-primary' : 'btn-light'"
        type="button"
        @click="$emit('select', item.key)"
      >
        <span class="me-2">{{ item.icon }}</span>
        {{ item.label }}
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  items: { key: string; label: string; icon?: string }[];
  activeKey: string;
}>();

defineEmits<{
  (event: 'select', key: string): void;
}>();
</script>

<style scoped>
.sidebar {
  width: 240px;
  min-height: 100vh;
  background: #ffffff;
  border-right: 1px solid #e9ecef;
}

.sidebar-item {
  border: 1px solid transparent;
}

.sidebar-item.btn-light:hover {
  border-color: #dee2e6;
  background: #f8f9fa;
}
</style>
