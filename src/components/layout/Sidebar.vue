<template>
  <div class="sidebar d-flex flex-column" :class="{ 'sidebar-collapsed': collapsed }">
    <!-- 头部 -->
    <div class="sidebar-header p-3 d-flex justify-content-between align-items-center">
      <div v-if="!collapsed">
        <div class="fw-semibold fs-5">AMM 管理台</div>
        <div class="text-muted small">控制面板</div>
      </div>
      <button class="btn btn-sm btn-light" @click="$emit('toggle-collapse')" :title="collapsed ? '展开侧边栏' : '收起侧边栏'">
        <i class="bi" :class="collapsed ? 'bi-chevron-right' : 'bi-chevron-left'"></i>
      </button>
    </div>

    <!-- 导航 -->
    <nav class="nav flex-column gap-1 p-2 flex-grow-1">
      <button
        v-for="item in items"
        :key="item.key"
        class="btn text-start sidebar-item"
        :class="item.key === activeKey ? 'btn-primary' : 'btn-light'"
        type="button"
        @click="$emit('select', item.key)"
        :title="collapsed ? item.label : ''"
      >
        <span :class="collapsed ? '' : 'me-2'">{{ item.icon }}</span>
        <span v-if="!collapsed">{{ item.label }}</span>
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  items: { key: string; label: string; icon?: string }[];
  activeKey: string;
  collapsed?: boolean;
}>();

defineEmits<{
  (event: 'select', key: string): void;
  (event: 'toggle-collapse'): void;
}>();
</script>

<style scoped>
.sidebar {
  width: 220px;
  min-width: 220px;
  min-height: 100vh;
  background: #ffffff;
  border-right: 1px solid #e9ecef;
  transition: width 0.2s ease, min-width 0.2s ease;
  flex-shrink: 0;
}

.sidebar-collapsed {
  width: 60px;
  min-width: 60px;
}

.sidebar-header {
  border-bottom: 1px solid #e9ecef;
  min-height: 70px;
}

.sidebar-collapsed .sidebar-header {
  justify-content: center !important;
}

.sidebar-item {
  border: 1px solid transparent;
  white-space: nowrap;
}

.sidebar-collapsed .sidebar-item {
  text-align: center !important;
  padding: 0.5rem;
}

.sidebar-item.btn-light:hover {
  border-color: #dee2e6;
  background: #f8f9fa;
}
</style>
