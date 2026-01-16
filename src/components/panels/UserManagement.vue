<template>
  <div class="container-fluid py-3">
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 mb-1">用户管理</h2>
        <div class="text-muted small">创建和维护后台账号</div>
      </div>
      <button class="btn btn-outline-secondary btn-sm" @click="fetchAll" :disabled="loading">
        刷新
      </button>
    </div>

    <div class="row g-3">
      <div class="col-lg-4">
        <div class="card shadow-sm">
          <div class="card-body">
            <h3 class="h6 mb-3">创建用户</h3>
            <form class="d-grid gap-3" @submit.prevent="createUser">
              <div>
                <label class="form-label">用户名</label>
                <input v-model="form.username" class="form-control" placeholder="请输入用户名" required />
              </div>
              <div>
                <label class="form-label">密码</label>
                <input
                  v-model="form.password"
                  class="form-control"
                  type="password"
                  placeholder="请输入密码"
                  required
                />
              </div>
              <div>
                <label class="form-label">邮箱（可选）</label>
                <input v-model="form.email" class="form-control" type="email" placeholder="example@domain.com" />
              </div>
              <div>
                <label class="form-label">角色</label>
                <select v-model="form.roleName" class="form-select" required>
                  <option v-for="role in roleOptions" :key="role.name" :value="role.name">
                    {{ role.displayName || role.name }}
                  </option>
                </select>
              </div>

              <div v-if="formError" class="alert alert-danger py-2 mb-0">
                {{ formError }}
              </div>

              <button class="btn btn-primary" type="submit" :disabled="loading">
                {{ loading ? '提交中...' : '创建用户' }}
              </button>
            </form>
          </div>
        </div>
      </div>

      <div class="col-lg-8">
        <div class="card shadow-sm">
          <div class="card-body">
            <h3 class="h6 mb-3">用户列表</h3>
            <div v-if="loading" class="text-muted">加载中...</div>
            <div v-else>
              <div v-if="errorMessage" class="alert alert-danger py-2">
                {{ errorMessage }}
              </div>
              <div v-if="!users.length && !errorMessage" class="text-muted">暂无用户数据</div>
              <div v-else class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead>
                    <tr>
                      <th>用户名</th>
                      <th>角色</th>
                      <th>状态</th>
                      <th>创建者</th>
                      <th>创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="user in users" :key="user._id">
                      <td>{{ user.username }}</td>
                      <td>{{ user.role?.displayName || user.role?.name || '-' }}</td>
                      <td>
                        <span class="badge" :class="user.isActive ? 'bg-success' : 'bg-secondary'">
                          {{ user.isActive ? '启用' : '禁用' }}
                        </span>
                      </td>
                      <td>{{ user.createdBy?.username || '-' }}</td>
                      <td>{{ formatDate(user.createdAt) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { apiRequest } from '../../api';

interface RoleItem {
  _id: string;
  name: string;
  displayName?: string;
}

interface UserItem {
  _id: string;
  username: string;
  role?: RoleItem;
  isActive?: boolean;
  createdBy?: { username?: string };
  createdAt?: string;
}

const users = ref<UserItem[]>([]);
const roles = ref<RoleItem[]>([]);
const loading = ref(false);
const errorMessage = ref('');
const formError = ref('');

const form = reactive({
  username: '',
  password: '',
  email: '',
  roleName: 'trader'
});

const roleOptions = computed(() => roles.value.filter((role) => role.name !== 'super_admin'));

const fetchAll = async () => {
  loading.value = true;
  errorMessage.value = '';
  try {
    const roleResponse = await apiRequest<{ roles: RoleItem[] }>('/api/roles');
    roles.value = roleResponse.data?.roles || [];

    const availableRoles = roleOptions.value;
    if (availableRoles.length && !availableRoles.find((role) => role.name === form.roleName)) {
      form.roleName = availableRoles[0].name;
    }

    const userResponse = await apiRequest<{ users: UserItem[] }>('/api/users');
    users.value = userResponse.data?.users || [];
  } catch (error: any) {
    errorMessage.value = error?.message || '加载失败';
  } finally {
    loading.value = false;
  }
};

const createUser = async () => {
  formError.value = '';
  loading.value = true;
  try {
    await apiRequest('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username,
        password: form.password,
        email: form.email || undefined,
        roleName: form.roleName
      })
    });
    form.username = '';
    form.password = '';
    form.email = '';
    await fetchAll();
  } catch (error: any) {
    formError.value = error?.message || '创建失败';
  } finally {
    loading.value = false;
  }
};

const formatDate = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

onMounted(fetchAll);
</script>
