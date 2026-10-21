<template>
  <div class="container-fluid py-3 integration-settings-panel">
    <div class="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3">
      <div>
        <h2 class="h5 mb-1">第三方平台配置</h2>
        <p class="text-muted small mb-0">仅管理员可见；敏感信息由后端加密保存，不会回传原文。</p>
      </div>
      <div class="d-flex gap-2">
        <button class="btn btn-outline-secondary btn-sm" :disabled="loading || saving" @click="loadSettings">
          重新加载
        </button>
        <button class="btn btn-primary btn-sm" :disabled="loading || saving" @click="saveSettings">
          {{ saving ? '保存中…' : '保存并立即生效' }}
        </button>
      </div>
    </div>

    <div class="alert alert-info py-2">
      <div class="fw-semibold">目标平台已锁定：DEX Screener</div>
      <div class="small">
        允许的网页来源为
        <a href="https://dexscreener.com/" target="_blank" rel="noopener noreferrer">https://dexscreener.com/</a>；
        管理员不能在前端改成其他目标域名。
      </div>
    </div>

    <div v-if="successMessage" class="alert alert-success py-2">{{ successMessage }}</div>
    <div v-if="errorMessage" class="alert alert-danger py-2">{{ errorMessage }}</div>

    <div v-if="loading" class="card shadow-sm">
      <div class="card-body text-muted">正在加载第三方平台配置…</div>
    </div>

    <div v-else class="row g-3">
      <div class="col-12 col-xl-7">
        <div class="card shadow-sm h-100">
          <div class="card-header d-flex align-items-center justify-content-between">
            <div>
              <div class="fw-semibold">IPFoxy 动态住宅代理</div>
              <div class="text-muted small">管理员共享套餐；支持粘性会话和逐请求轮换。</div>
            </div>
            <span class="badge" :class="ipFoxyProxyReady ? 'text-bg-success' : 'text-bg-secondary'">
              {{ ipFoxyProxyReady ? '代理可调用' : '代理未配置' }}
            </span>
          </div>
          <div class="card-body">
            <div class="form-check form-switch mb-3">
              <input id="ipfoxy-enabled" v-model="form.ipFoxy.enabled" class="form-check-input" type="checkbox">
              <label class="form-check-label" for="ipfoxy-enabled">启用 IPFoxy</label>
            </div>

            <div class="row g-3">
              <div class="col-12 col-md-6">
                <label class="form-label">API User ID（可选，用于流量查询）</label>
                <input
                  v-model.trim="secrets.ipFoxy.apiId"
                  type="password"
                  autocomplete="new-password"
                  class="form-control"
                  placeholder="留空表示保留已保存值"
                >
                <CredentialHint
                  :credential="settings?.ipFoxy.apiId"
                  v-model:clear="clearSecrets.ipFoxy.apiId"
                />
                <div class="form-text">与下方代理账号分开，不影响代理连接。</div>
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">API Token（可选，用于流量查询）</label>
                <input
                  v-model.trim="secrets.ipFoxy.apiToken"
                  type="password"
                  autocomplete="new-password"
                  class="form-control"
                  placeholder="留空表示保留已保存值"
                >
                <CredentialHint
                  :credential="settings?.ipFoxy.apiToken"
                  v-model:clear="clearSecrets.ipFoxy.apiToken"
                />
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">动态代理账号</label>
                <input
                  v-model.trim="secrets.ipFoxy.proxyUsername"
                  type="password"
                  autocomplete="new-password"
                  class="form-control"
                  placeholder="例如 customer-xxxx"
                >
                <CredentialHint
                  :credential="settings?.ipFoxy.proxyUsername"
                  v-model:clear="clearSecrets.ipFoxy.proxyUsername"
                />
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">动态代理密码</label>
                <input
                  v-model.trim="secrets.ipFoxy.proxyPassword"
                  type="password"
                  autocomplete="new-password"
                  class="form-control"
                  placeholder="不是 IPFoxy 网站登录密码"
                >
                <CredentialHint
                  :credential="settings?.ipFoxy.proxyPassword"
                  v-model:clear="clearSecrets.ipFoxy.proxyPassword"
                />
              </div>

              <div class="col-12 col-md-6">
                <label class="form-label">IPFoxy 接入线路</label>
                <select v-model="form.ipFoxy.proxyHost" class="form-select">
                  <option value="gate.ipfoxy.io">默认正式入口（gate）</option>
                  <option value="gate-sg.ipfoxy.io">亚太线路（gate-sg）</option>
                  <option value="gate-us.ipfoxy.io">美洲线路（gate-us）</option>
                </select>
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label">默认国家</label>
                <input
                  v-model.trim="form.ipFoxy.defaultCountry"
                  maxlength="2"
                  class="form-control text-uppercase"
                  placeholder="US"
                >
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label">粘性时长</label>
                <select v-model.number="form.ipFoxy.defaultTtlMinutes" class="form-select">
                  <option :value="30">30 分钟</option>
                  <option :value="60">60 分钟</option>
                </select>
              </div>
            </div>

            <div class="rounded border bg-light p-3 mt-3 small">
              固定协议：HTTP；固定端口：58688。代理凭据只在后端构造连接时解密，不返回浏览器。
            </div>

            <div class="d-flex flex-wrap gap-2 mt-3">
              <button class="btn btn-outline-primary btn-sm" :disabled="testingIpFoxy || !ipFoxyApiReady" @click="queryTraffic">
                {{ testingIpFoxy ? '查询中…' : '查询套餐流量' }}
              </button>
              <button class="btn btn-outline-warning btn-sm" :disabled="testingEgress || !ipFoxyProxyReady" @click="checkEgress">
                {{ testingEgress ? '检测中…' : '检测代理出口（消耗少量流量）' }}
              </button>
            </div>
            <div v-if="ipFoxyTestMessage" class="alert alert-secondary py-2 mt-3 mb-0 small">
              {{ ipFoxyTestMessage }}
            </div>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-5">
        <div class="card shadow-sm h-100">
          <div class="card-header d-flex align-items-center justify-content-between">
            <div>
              <div class="fw-semibold">CaptchaRun</div>
              <div class="text-muted small">由管理员统一承担识别费用。</div>
            </div>
            <span class="badge" :class="captchaReady ? 'text-bg-success' : 'text-bg-secondary'">
              {{ captchaReady ? '可调用' : '未完整配置' }}
            </span>
          </div>
          <div class="card-body">
            <div class="form-check form-switch mb-3">
              <input id="captcha-enabled" v-model="form.captchaRun.enabled" class="form-check-input" type="checkbox">
              <label class="form-check-label" for="captcha-enabled">启用 CaptchaRun</label>
            </div>

            <label class="form-label">CaptchaRun API Token</label>
            <input
              v-model.trim="secrets.captchaRun.apiToken"
              type="password"
              autocomplete="new-password"
              class="form-control"
              placeholder="留空表示保留已保存值"
            >
            <CredentialHint
              :credential="settings?.captchaRun.apiToken"
              v-model:clear="clearSecrets.captchaRun.apiToken"
            />

            <div class="form-check form-switch mt-4">
              <input
                id="captcha-paid-enabled"
                v-model="form.captchaRun.allowTaskCreation"
                class="form-check-input"
                type="checkbox"
              >
              <label class="form-check-label" for="captcha-paid-enabled">允许创建付费识别任务</label>
            </div>

            <div class="alert alert-warning small mt-3 mb-0">
              保存 Token 本身不会扣费。只有未来业务流程调用“创建任务”接口时才会产生费用；
              当前仍受每分钟最多 5 个任务的后端限流保护。
            </div>

            <dl class="row small mt-4 mb-0">
              <dt class="col-5">允许来源</dt>
              <dd class="col-7"><code>dexscreener.com</code></dd>
              <dt class="col-5">支持类型</dt>
              <dd class="col-7 mb-0">Turnstile、reCAPTCHA、hCaptcha</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, reactive, ref, type PropType } from 'vue';
import {
  checkIpFoxyEgress,
  getIntegrationSettings,
  getIntegrationStatus,
  getIpFoxyTraffic,
  updateIntegrationSettings,
  type IntegrationSettings,
  type IntegrationSettingsUpdate,
  type MaskedCredential
} from '../../services/integrationApi';

const CredentialHint = defineComponent({
  name: 'CredentialHint',
  props: {
    credential: {
      type: Object as PropType<MaskedCredential | undefined>,
      default: undefined
    },
    clear: {
      type: Boolean,
      default: false
    }
  },
  emits: ['update:clear'],
  setup(props, { emit }) {
    return () => h('div', { class: 'd-flex justify-content-between align-items-center gap-2 mt-1 small' }, [
      h(
        'span',
        { class: props.credential?.configured ? 'text-success' : 'text-muted' },
        props.credential?.configured ? `已保存：${props.credential.masked}` : '尚未保存'
      ),
      props.credential?.configured
        ? h('label', { class: 'form-check mb-0 text-danger' }, [
          h('input', {
            class: 'form-check-input me-1',
            type: 'checkbox',
            checked: props.clear,
            onChange: (event: Event) => emit('update:clear', (event.target as HTMLInputElement).checked)
          }),
          '清除'
        ])
        : null
    ]);
  }
});

const settings = ref<IntegrationSettings | null>(null);
const loading = ref(true);
const saving = ref(false);
const testingIpFoxy = ref(false);
const testingEgress = ref(false);
const successMessage = ref('');
const errorMessage = ref('');
const ipFoxyTestMessage = ref('');

const form = reactive({
  ipFoxy: {
    enabled: false,
    proxyHost: 'gate.ipfoxy.io' as IntegrationSettings['ipFoxy']['proxyHost'],
    defaultCountry: 'US',
    defaultTtlMinutes: 30 as 30 | 60
  },
  captchaRun: {
    enabled: false,
    allowTaskCreation: false
  }
});

const secrets = reactive({
  ipFoxy: { apiId: '', apiToken: '', proxyUsername: '', proxyPassword: '' },
  captchaRun: { apiToken: '' }
});

const clearSecrets = reactive({
  ipFoxy: { apiId: false, apiToken: false, proxyUsername: false, proxyPassword: false },
  captchaRun: { apiToken: false }
});

const ipFoxyApiReady = computed(() => Boolean(
  form.ipFoxy.enabled
  && settings.value?.ipFoxy.apiId.configured
  && settings.value?.ipFoxy.apiToken.configured
));

const ipFoxyProxyReady = computed(() => Boolean(
  form.ipFoxy.enabled
  && settings.value?.ipFoxy.proxyUsername.configured
  && settings.value?.ipFoxy.proxyPassword.configured
));

const captchaReady = computed(() => Boolean(
  form.captchaRun.enabled && settings.value?.captchaRun.apiToken.configured
));

function resetSecretInputs() {
  secrets.ipFoxy.apiId = '';
  secrets.ipFoxy.apiToken = '';
  secrets.ipFoxy.proxyUsername = '';
  secrets.ipFoxy.proxyPassword = '';
  secrets.captchaRun.apiToken = '';
  clearSecrets.ipFoxy.apiId = false;
  clearSecrets.ipFoxy.apiToken = false;
  clearSecrets.ipFoxy.proxyUsername = false;
  clearSecrets.ipFoxy.proxyPassword = false;
  clearSecrets.captchaRun.apiToken = false;
}

function applySettings(value: IntegrationSettings) {
  settings.value = value;
  form.ipFoxy.enabled = value.ipFoxy.enabled;
  form.ipFoxy.proxyHost = value.ipFoxy.proxyHost;
  form.ipFoxy.defaultCountry = value.ipFoxy.defaultCountry;
  form.ipFoxy.defaultTtlMinutes = value.ipFoxy.defaultTtlMinutes;
  form.captchaRun.enabled = value.captchaRun.enabled;
  form.captchaRun.allowTaskCreation = value.captchaRun.allowTaskCreation;
  resetSecretInputs();
}

async function loadSettings() {
  loading.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const value = await getIntegrationSettings();
    applySettings(value);
  } catch (error: any) {
    errorMessage.value = error?.message || '加载配置失败';
  } finally {
    loading.value = false;
  }
}

function addSecret(
  target: Record<string, unknown>,
  valueField: string,
  value: string,
  clearField: string,
  clear: boolean
) {
  if (value) target[valueField] = value;
  if (clear) target[clearField] = true;
}

async function saveSettings() {
  errorMessage.value = '';
  successMessage.value = '';
  ipFoxyTestMessage.value = '';
  const country = form.ipFoxy.defaultCountry.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    errorMessage.value = '默认国家必须填写两个字母的国家代码，例如 US、SG。';
    return;
  }

  const ipFoxy: NonNullable<IntegrationSettingsUpdate['ipFoxy']> = {
    enabled: form.ipFoxy.enabled,
    proxyHost: form.ipFoxy.proxyHost,
    defaultCountry: country,
    defaultTtlMinutes: form.ipFoxy.defaultTtlMinutes
  };
  addSecret(ipFoxy, 'apiId', secrets.ipFoxy.apiId, 'clearApiId', clearSecrets.ipFoxy.apiId);
  addSecret(ipFoxy, 'apiToken', secrets.ipFoxy.apiToken, 'clearApiToken', clearSecrets.ipFoxy.apiToken);
  addSecret(
    ipFoxy,
    'proxyUsername',
    secrets.ipFoxy.proxyUsername,
    'clearProxyUsername',
    clearSecrets.ipFoxy.proxyUsername
  );
  addSecret(
    ipFoxy,
    'proxyPassword',
    secrets.ipFoxy.proxyPassword,
    'clearProxyPassword',
    clearSecrets.ipFoxy.proxyPassword
  );

  const captchaRun: NonNullable<IntegrationSettingsUpdate['captchaRun']> = {
    enabled: form.captchaRun.enabled,
    allowTaskCreation: form.captchaRun.allowTaskCreation
  };
  addSecret(
    captchaRun,
    'apiToken',
    secrets.captchaRun.apiToken,
    'clearApiToken',
    clearSecrets.captchaRun.apiToken
  );

  saving.value = true;
  try {
    const value = await updateIntegrationSettings({ ipFoxy, captchaRun });
    applySettings(value);
    await getIntegrationStatus();
    successMessage.value = '配置已加密保存，并已对后续服务调用立即生效。';
  } catch (error: any) {
    errorMessage.value = error?.message || '保存配置失败';
  } finally {
    saving.value = false;
  }
}

async function queryTraffic() {
  testingIpFoxy.value = true;
  errorMessage.value = '';
  ipFoxyTestMessage.value = '';
  try {
    const result: any = await getIpFoxyTraffic();
    const total = result.total_mb ?? result.totalMb ?? '-';
    const remain = result.remain_mb ?? result.remainMb ?? '-';
    const expire = result.expire_time
      ? new Date(Number(result.expire_time) * 1000).toLocaleString()
      : '-';
    ipFoxyTestMessage.value = `套餐总量：${total} MB；剩余：${remain} MB；到期时间：${expire}`;
  } catch (error: any) {
    errorMessage.value = error?.message || '查询 IPFoxy 流量失败';
  } finally {
    testingIpFoxy.value = false;
  }
}

async function checkEgress() {
  testingEgress.value = true;
  errorMessage.value = '';
  ipFoxyTestMessage.value = '';
  try {
    const result: any = await checkIpFoxyEgress({
      rotation: 'sticky',
      countryCode: form.ipFoxy.defaultCountry.toUpperCase(),
      sessionId: `admin_${Date.now()}`,
      ttlMinutes: form.ipFoxy.defaultTtlMinutes
    });
    const exitIp = result?.data?.ip || result?.data || '请求成功';
    ipFoxyTestMessage.value = `代理出口检测结果：${typeof exitIp === 'string' ? exitIp : JSON.stringify(exitIp)}`;
  } catch (error: any) {
    errorMessage.value = error?.message || '检测 IPFoxy 出口失败';
  } finally {
    testingEgress.value = false;
  }
}

onMounted(loadSettings);
</script>

<style scoped>
.integration-settings-panel {
  min-width: 980px;
}

code {
  word-break: break-all;
}
</style>
