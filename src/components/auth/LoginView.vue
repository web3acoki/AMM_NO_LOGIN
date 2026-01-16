<template>
  <div class="login-page d-flex align-items-center justify-content-center bg-light">
    <div class="card shadow-sm login-card">
      <div class="card-body">
        <h1 class="h5 mb-3">AMM 登录</h1>
        <p class="text-muted small mb-4">请输入账号与密码进入管理后台</p>

        <form @submit.prevent="handleLogin" class="d-grid gap-3">
          <div>
            <label class="form-label">账号</label>
            <input
              v-model="username"
              type="text"
              class="form-control"
              placeholder="请输入账号"
              autocomplete="username"
              required
            />
          </div>
          <div>
            <label class="form-label">密码</label>
            <input
              v-model="password"
              type="password"
              class="form-control"
              placeholder="请输入密码"
              autocomplete="current-password"
              required
            />
          </div>

          <div v-if="errorMessage" class="alert alert-danger py-2 mb-0">
            {{ errorMessage }}
          </div>

          <button class="btn btn-primary" type="submit" :disabled="loading">
            {{ loading ? '登录中...' : '登录' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { apiRequest } from '../../api';

const emit = defineEmits<{
  (event: 'logged-in', payload: { user: any; token: string }): void;
}>();

const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMessage = ref('');

const handleLogin = async () => {
  loading.value = true;
  errorMessage.value = '';
  try {
    const response = await apiRequest<{ user: any; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value
      })
    });

    const token = response.data?.token;
    if (!token) {
      throw new Error('登录失败，请检查账号密码');
    }

    emit('logged-in', {
      user: response.data?.user,
      token
    });
  } catch (error: any) {
    errorMessage.value = error?.message || '登录失败';
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 420px;
}
</style>
