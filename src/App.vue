<template>
  <LoginView v-if="requireLogin && (!ready || !isAuthenticated)" @logged-in="handleLoggedIn" />
  <div v-else class="app-layout">
    <Sidebar
      :items="sidebarItems"
      :active-key="activePanel"
      :collapsed="sidebarCollapsed"
      @select="handleSelect"
      @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
    />
    <main class="main-content">
      <header class="d-flex align-items-center justify-content-between px-4 py-3 border-bottom bg-white">
        <div>
          <div class="fw-semibold">{{ currentTitle }}</div>
          <div class="text-muted small">欢迎回来，{{ displayUsername }}</div>
        </div>
        <button v-if="requireLogin" class="btn btn-outline-secondary btn-sm" @click="handleLogout">退出登录</button>
      </header>

      <section class="content-area">
        <keep-alive include="WalletManagePanel,BatchTransferPanel,TaskManagePanel">
          <component :is="currentComponent" />
        </keep-alive>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiRequest } from './api';
import { ENABLE_LOGIN, DEFAULT_USERNAME } from './config';
import LoginView from './components/auth/LoginView.vue';
import Sidebar from './components/layout/Sidebar.vue';
import WalletManagePanel from './components/panels/WalletManagePanel.vue';
import BatchTransferPanel from './components/panels/BatchTransferPanel.vue';
import TaskManagePanel from './components/panels/TaskManagePanel.vue';
import UserManagement from './components/panels/UserManagement.vue';
import AnalysisPanel from './components/panels/AnalysisPanel.vue';

const requireLogin = ENABLE_LOGIN;

const activePanel = ref<'users' | 'wallet' | 'transfer' | 'task' | 'analysis'>('wallet');
const sidebarCollapsed = ref(false);
const currentUser = ref<any>(null);
const isAuthenticated = ref(false);
const ready = ref(false);

const displayUsername = computed(() => {
  if (!requireLogin) return DEFAULT_USERNAME;
  return currentUser.value?.username || DEFAULT_USERNAME;
});

const sidebarItems = [
  { key: 'wallet', label: '钱包管理', icon: '💰' },
  { key: 'transfer', label: '批量转账', icon: '💸' },
  { key: 'task', label: '任务管理', icon: '📋' },
  { key: 'users', label: '用户管理', icon: '👥' },
  { key: 'analysis', label: '分析面板', icon: '📈' }
];

const currentTitle = computed(() => {
  const item = sidebarItems.find((entry) => entry.key === activePanel.value);
  return item ? item.label : '面板';
});

const currentComponent = computed(() => {
  switch (activePanel.value) {
    case 'wallet': return WalletManagePanel;
    case 'transfer': return BatchTransferPanel;
    case 'task': return TaskManagePanel;
    case 'users': return UserManagement;
    case 'analysis': return AnalysisPanel;
    default: return WalletManagePanel;
  }
});

const handleSelect = (key: string) => {
  activePanel.value = key as 'users' | 'wallet' | 'transfer' | 'task' | 'analysis';
};

const loadSession = async () => {
  // 如果不需要登录，直接设置为就绪状态
  if (!requireLogin) {
    ready.value = true;
    return;
  }

  const token = localStorage.getItem('amm_token');
  if (!token) {
    ready.value = true;
    return;
  }
  try {
    const response = await apiRequest<{ user: any }>('/api/auth/me');
    currentUser.value = response.data?.user;
    isAuthenticated.value = true;
  } catch (error) {
    localStorage.removeItem('amm_token');
  } finally {
    ready.value = true;
  }
};

const handleLoggedIn = (payload: { user: any; token: string }) => {
  localStorage.setItem('amm_token', payload.token);
  currentUser.value = payload.user;
  isAuthenticated.value = true;
  ready.value = true;
};

const handleLogout = async () => {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // ignore
  }
  localStorage.removeItem('amm_token');
  currentUser.value = null;
  isAuthenticated.value = false;
};

onMounted(loadSession);
</script>

<style>
body {
  background-color: #f8fafc;
  overflow-x: hidden;
}

.app-layout {
  display: flex;
  min-height: 100vh;
  background: #f8fafc;
}

.main-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-x: auto;
}

.content-area {
  flex: 1;
  min-height: calc(100vh - 64px);
  background: #f8fafc;
  overflow-x: auto;
}
</style>
