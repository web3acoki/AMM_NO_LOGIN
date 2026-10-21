<template>
  <div class="container-fluid py-3">
    <div class="row g-3">
      <div class="col-12">
        <div class="card shadow-sm">
          <div class="card-body">
            <div class="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3">
              <div>
                <h5 class="mb-1">Dexscreener 动态 IP 浏览器</h5>
                <div class="text-muted small">
                  页面在服务器浏览器中运行，页面资源和后续交互均通过同一个 IPFoxy 粘性出口。
                </div>
              </div>
              <div class="d-flex flex-wrap gap-2" v-if="session">
                <span class="badge text-bg-secondary">服务器 {{ session.serverIp || '未知' }}</span>
                <span class="badge" :class="session.egressVerified ? 'text-bg-success' : 'text-bg-danger'">
                  动态出口 {{ session.proxyIp || '未确认' }}
                </span>
              </div>
            </div>

            <div class="alert alert-info py-2 small" role="alert">
              这里显示的是服务端远程画面。复制链接到本机浏览器打开时不会经过 IPFoxy，只有在下方画面中的操作才使用动态出口。
            </div>

            <div class="row g-3 align-items-end">
              <div class="col-md-3">
                <label class="form-label">公链</label>
                <select v-model="form.chain" class="form-select" :disabled="starting">
                  <option v-for="chain in chains" :key="chain.slug" :value="chain.slug">
                    {{ chain.label }}（{{ chain.slug }}）
                  </option>
                </select>
              </div>
              <div class="col-md-5">
                <label class="form-label">代币地址</label>
                <input
                  v-model.trim="form.tokenAddress"
                  class="form-control font-monospace"
                  :disabled="starting"
                  placeholder="输入 0x 开头的代币合约地址"
                  @keyup.enter="startSession"
                />
              </div>
              <div class="col-md-2 col-6">
                <label class="form-label">出口国家</label>
                <input
                  v-model.trim="form.countryCode"
                  class="form-control text-uppercase"
                  maxlength="2"
                  :disabled="starting"
                  placeholder="US"
                />
              </div>
              <div class="col-md-2 col-6">
                <label class="form-label">会话时长</label>
                <select v-model="form.ttlMinutes" class="form-select" :disabled="starting">
                  <option :value="30">30 分钟</option>
                  <option :value="60">60 分钟</option>
                </select>
              </div>
            </div>

            <div class="mt-3 d-flex flex-wrap align-items-center gap-2">
              <button class="btn btn-primary" :disabled="starting || !canStart" @click="startSession">
                <span v-if="starting" class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
                {{ starting ? '正在验证出口并加载…' : session ? '更换代币并重建会话' : '启动动态 IP 浏览会话' }}
              </button>
              <button v-if="session" class="btn btn-outline-danger" :disabled="closing" @click="closeSession">
                {{ closing ? '正在关闭…' : '关闭会话' }}
              </button>
              <button class="btn btn-outline-secondary" :disabled="!generatedUrl" @click="copyGeneratedUrl">
                复制目标链接
              </button>
              <span class="text-muted small font-monospace text-break">{{ generatedUrl }}</span>
            </div>

            <div v-if="message" class="alert mt-3 mb-0 py-2" :class="messageClass" role="alert">
              {{ message }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="session" class="col-12">
        <div class="card shadow-sm">
          <div class="card-header bg-white d-flex flex-wrap align-items-center justify-content-between gap-2">
            <div class="min-w-0">
              <div class="fw-semibold text-truncate">{{ session.title || 'DexScreener' }}</div>
              <div class="small text-muted font-monospace text-truncate">{{ session.currentUrl }}</div>
            </div>
            <div class="d-flex flex-wrap gap-2 align-items-center">
              <span class="badge" :class="session.responseStatus && session.responseStatus < 400 ? 'text-bg-success' : 'text-bg-warning'">
                HTTP {{ session.responseStatus ?? '—' }}
              </span>
              <span class="badge text-bg-light">{{ expiresText }}</span>
            </div>
          </div>

          <div class="card-body p-2 p-md-3">
            <div class="browser-toolbar d-flex flex-wrap align-items-center gap-2 mb-2">
              <button class="btn btn-sm btn-outline-secondary" :disabled="actionBusy" @click="sendAction({ type: 'back' })">← 返回</button>
              <button class="btn btn-sm btn-outline-secondary" :disabled="actionBusy" @click="sendAction({ type: 'reload' })">↻ 刷新</button>
              <button class="btn btn-sm btn-outline-secondary" :disabled="actionBusy" @click="sendAction({ type: 'scroll', deltaY: -620 })">向上滚动</button>
              <button class="btn btn-sm btn-outline-secondary" :disabled="actionBusy" @click="sendAction({ type: 'scroll', deltaY: 620 })">向下滚动</button>
              <div class="input-group input-group-sm browser-text-input">
                <input
                  v-model="keyboardText"
                  class="form-control"
                  maxlength="500"
                  placeholder="先点远程输入框，再在这里输入"
                  :disabled="actionBusy"
                  @keyup.enter="typeText"
                />
                <button class="btn btn-outline-primary" :disabled="actionBusy || !keyboardText" @click="typeText">输入</button>
              </div>
              <button class="btn btn-sm btn-outline-secondary" :disabled="actionBusy" @click="sendAction({ type: 'key', key: 'Enter' })">回车</button>
              <button class="btn btn-sm btn-outline-secondary" :disabled="actionBusy" @click="sendAction({ type: 'key', key: 'Escape' })">Esc</button>
            </div>

            <div
              class="remote-screen position-relative"
              :class="{ 'is-busy': screenshotLoading || actionBusy }"
              @wheel.prevent="handleWheel"
            >
              <img
                v-if="screenshotUrl"
                :src="screenshotUrl"
                class="remote-image"
                alt="DexScreener 服务端浏览器画面"
                draggable="false"
                @click="handleScreenClick"
              />
              <div v-else class="screen-placeholder d-flex align-items-center justify-content-center">
                <div class="text-center text-light">
                  <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
                  正在获取远程画面…
                </div>
              </div>
              <div v-if="screenshotLoading || actionBusy" class="screen-status badge text-bg-dark">
                {{ actionBusy ? '正在执行操作' : '正在刷新画面' }}
              </div>
            </div>

            <div class="small text-muted mt-2">
              点击画面会在服务器浏览器的对应坐标点击；鼠标滚轮和上方按钮也会发送到该浏览会话。此画面不会把 IPFoxy 凭据发送到前端。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
import {
  closeDexScreenerSession,
  createDexScreenerSession,
  getDexScreenerChains,
  getDexScreenerScreenshot,
  performDexScreenerAction,
  type DexScreenerAction,
  type DexScreenerChain,
  type DexScreenerSession
} from '../../services/dexScreenerApi';

const FALLBACK_CHAINS: DexScreenerChain[] = [
  { slug: 'bsc', label: 'BNB Chain' },
  { slug: 'robinhood', label: 'Robinhood' }
];

const chains = ref<DexScreenerChain[]>(FALLBACK_CHAINS);
const form = reactive({
  chain: 'bsc',
  tokenAddress: '',
  countryCode: 'US',
  ttlMinutes: 30 as 30 | 60
});
const session = ref<DexScreenerSession | null>(null);
const screenshotUrl = ref('');
const screenshotLoading = ref(false);
const starting = ref(false);
const closing = ref(false);
const actionBusy = ref(false);
const keyboardText = ref('');
const message = ref('');
const messageType = ref<'success' | 'danger' | 'warning' | 'info'>('info');
let screenshotTimer: number | undefined;
let wheelTimer: number | undefined;
let screenshotInFlight = false;

const generatedUrl = computed(() => {
  const chain = form.chain.trim().toLowerCase();
  const address = form.tokenAddress.trim();
  return chain && address ? `https://dexscreener.com/${chain}/${encodeURIComponent(address)}` : '';
});

const canStart = computed(() => {
  const country = form.countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return false;
  return /^0x[a-fA-F0-9]{40}$/.test(form.tokenAddress.trim());
});

const messageClass = computed(() => `alert-${messageType.value}`);
const expiresText = computed(() => {
  if (!session.value) return '';
  return `到期 ${new Date(session.value.expiresAt).toLocaleString()}`;
});

function setMessage(text: string, type: typeof messageType.value = 'info') {
  message.value = text;
  messageType.value = type;
}

function replaceScreenshotUrl(nextUrl: string) {
  if (screenshotUrl.value) URL.revokeObjectURL(screenshotUrl.value);
  screenshotUrl.value = nextUrl;
}

function stopScreenshotPolling() {
  if (screenshotTimer !== undefined) window.clearInterval(screenshotTimer);
  screenshotTimer = undefined;
}

function startScreenshotPolling() {
  stopScreenshotPolling();
  if (!session.value) return;
  screenshotTimer = window.setInterval(() => void refreshScreenshot(false), 1800);
}

async function refreshScreenshot(showErrors = true) {
  if (!session.value || screenshotInFlight) return;
  screenshotInFlight = true;
  screenshotLoading.value = true;
  const currentSessionId = session.value.sessionId;
  try {
    const blob = await getDexScreenerScreenshot(currentSessionId);
    if (session.value?.sessionId !== currentSessionId) return;
    replaceScreenshotUrl(URL.createObjectURL(blob));
  } catch (error: any) {
    if ([404, 410].includes(error?.status)) {
      session.value = null;
      stopScreenshotPolling();
      replaceScreenshotUrl('');
      setMessage('服务端浏览会话已经过期，请重新创建。', 'warning');
    } else if (showErrors) {
      setMessage(error?.message || '获取远程画面失败', 'danger');
    }
  } finally {
    screenshotLoading.value = false;
    screenshotInFlight = false;
  }
}

async function startSession() {
  if (!canStart.value || starting.value) return;
  starting.value = true;
  setMessage('正在验证服务器直连出口和 IPFoxy 动态出口，然后启动隔离浏览器…', 'info');
  try {
    const created = await createDexScreenerSession({
      chain: form.chain,
      tokenAddress: form.tokenAddress.trim(),
      countryCode: form.countryCode.trim().toUpperCase(),
      ttlMinutes: form.ttlMinutes
    });
    session.value = created;
    setMessage(
      created.egressVerified
        ? `出口验证通过：服务器 ${created.serverIp || '未知'} → 动态 IP ${created.proxyIp}`
        : '会话已创建，但出口差异未得到确认。',
      created.egressVerified ? 'success' : 'warning'
    );
    await refreshScreenshot();
    startScreenshotPolling();
  } catch (error: any) {
    setMessage(error?.message || '创建 DexScreener 会话失败', 'danger');
  } finally {
    starting.value = false;
  }
}

async function closeSession() {
  if (!session.value || closing.value) return;
  closing.value = true;
  const sessionId = session.value.sessionId;
  try {
    await closeDexScreenerSession(sessionId);
    setMessage('DexScreener 服务端浏览会话已关闭。', 'success');
  } catch (error: any) {
    setMessage(error?.message || '关闭会话失败', 'danger');
  } finally {
    session.value = null;
    stopScreenshotPolling();
    replaceScreenshotUrl('');
    closing.value = false;
  }
}

async function sendAction(action: DexScreenerAction) {
  if (!session.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    session.value = await performDexScreenerAction(session.value.sessionId, action);
    await refreshScreenshot();
  } catch (error: any) {
    setMessage(error?.message || '远程浏览器操作失败', 'danger');
  } finally {
    actionBusy.value = false;
  }
}

function handleScreenClick(event: MouseEvent) {
  const image = event.currentTarget as HTMLImageElement;
  if (!session.value || !image.naturalWidth || !image.naturalHeight) return;
  const rect = image.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * session.value.viewport.width;
  const y = ((event.clientY - rect.top) / rect.height) * session.value.viewport.height;
  void sendAction({ type: 'click', x: Math.round(x), y: Math.round(y) });
}

function handleWheel(event: WheelEvent) {
  if (wheelTimer !== undefined) window.clearTimeout(wheelTimer);
  const deltaY = Math.max(-1200, Math.min(1200, event.deltaY * 2));
  const screen = event.currentTarget as HTMLElement;
  const rect = screen.getBoundingClientRect();
  const x = session.value
    ? ((event.clientX - rect.left) / rect.width) * session.value.viewport.width
    : undefined;
  const y = session.value
    ? ((event.clientY - rect.top) / rect.height) * session.value.viewport.height
    : undefined;
  wheelTimer = window.setTimeout(() => void sendAction({
    type: 'scroll',
    deltaY,
    x: x === undefined ? undefined : Math.round(x),
    y: y === undefined ? undefined : Math.round(y)
  }), 120);
}

async function typeText() {
  const text = keyboardText.value;
  if (!text) return;
  keyboardText.value = '';
  await sendAction({ type: 'type', text });
}

async function copyGeneratedUrl() {
  if (!generatedUrl.value) return;
  try {
    await navigator.clipboard.writeText(generatedUrl.value);
    setMessage('目标链接已复制；请注意，本机直接打开不会经过 IPFoxy。', 'info');
  } catch {
    setMessage('浏览器不允许自动复制，请手动复制上方链接。', 'warning');
  }
}

onMounted(async () => {
  try {
    const remoteChains = await getDexScreenerChains();
    if (remoteChains.length) chains.value = remoteChains;
  } catch (error: any) {
    setMessage(error?.message || '读取公链列表失败，已使用内置列表。', 'warning');
  }
});

onActivated(() => {
  if (session.value) {
    void refreshScreenshot(false);
    startScreenshotPolling();
  }
});
onDeactivated(stopScreenshotPolling);
onBeforeUnmount(() => {
  stopScreenshotPolling();
  if (wheelTimer !== undefined) window.clearTimeout(wheelTimer);
  replaceScreenshotUrl('');
});
</script>

<style scoped>
.font-monospace {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.min-w-0 {
  min-width: 0;
}

.browser-text-input {
  width: min(390px, 100%);
}

.remote-screen {
  width: 100%;
  min-height: 320px;
  aspect-ratio: 1365 / 768;
  overflow: hidden;
  background: #090c11;
  border: 1px solid #29313d;
  border-radius: 0.5rem;
  user-select: none;
}

.remote-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: crosshair;
}

.screen-placeholder {
  width: 100%;
  height: 100%;
  min-height: 320px;
}

.screen-status {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  opacity: 0.88;
}

.remote-screen.is-busy .remote-image {
  opacity: 0.86;
}
</style>
