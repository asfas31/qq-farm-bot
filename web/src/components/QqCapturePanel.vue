<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'

export interface QqCapturePayload {
  name?: string
  code: string
  platform?: 'qq'
  loginType?: 'qq_capture'
  gid?: string
  qq?: string
  friendGids?: number[]
}

const emit = defineEmits<{ captured: [payload: QqCapturePayload] }>()
const CAPTURE_TIMEOUT_MS = 3 * 60 * 1000
const POLL_INTERVAL_MS = 2000
const LOCAL_CERT_URL = '/api/capture/cert'
const loading = ref(false)
const downloadingCert = ref(false)
const errorMessage = ref('')
const sessionId = ref('')
const statusText = ref('')
const status = ref('')
const proxyHost = ref('')
const proxyPort = ref('')
const certUrl = ref(LOCAL_CERT_URL)
const startedAt = ref(0)
const nowTick = ref(Date.now())
let timer: number | undefined
let tickTimer: number | undefined
let polling = false
let capturedPayload: QqCapturePayload | null = null // code 已到，等好友中

const proxyIp = computed(() => proxyHost.value || '')
const proxyPortDisplay = computed(() => proxyPort.value || '')
const elapsedSeconds = computed(() => startedAt.value ? Math.max(0, Math.floor((nowTick.value - startedAt.value) / 1000)) : 0)
const statusHint = computed(() => {
  const current = status.value.toLowerCase()
  if (current === 'ready')
    return '手机已连接代理，正在等待 QQ 农场登录数据。'
  if (current === 'captured')
    return '已抓到登录 Code，正在添加账号。'
  if (current === 'stopped')
    return '抓包会话已停止。'
  if (proxyIp.value && proxyPortDisplay.value)
    return `请在手机 WiFi 代理中填写 IP ${proxyIp.value}，端口 ${proxyPortDisplay.value}，安装并信任证书后打开 QQ 农场。`
  return '正在创建抓包会话。'
})

function stopTimer() {
  if (timer)
    window.clearInterval(timer)
  timer = undefined
}

function stopTickTimer() {
  if (tickTimer)
    window.clearInterval(tickTimer)
  tickTimer = undefined
}

function startTickTimer() {
  stopTickTimer()
  nowTick.value = Date.now()
  tickTimer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
}

function resetSessionState() {
  stopTimer()
  stopTickTimer()
  polling = false
  capturedPayload = null
  sessionId.value = ''
  status.value = ''
  statusText.value = ''
  proxyHost.value = ''
  proxyPort.value = ''
  certUrl.value = LOCAL_CERT_URL
  startedAt.value = 0
}

function normalizePayload(data: any): QqCapturePayload | null {
  const code = String(data?.code || data?.Code || data?.wx_code || '').trim()
  if (!code)
    return null

  // 从 friends 列表或 friendGids 数组里提取 GID
  const rawGids: number[] = []
  if (Array.isArray(data?.friends)) {
    for (const f of data.friends) {
      const g = Number(f?.gid ?? f?.GID ?? f?.roleGid)
      if (Number.isFinite(g) && g > 0)
        rawGids.push(g)
    }
  }
  if (Array.isArray(data?.friendGids)) {
    for (const g of data.friendGids) {
      const n = Number(g)
      if (Number.isFinite(n) && n > 0)
        rawGids.push(n)
    }
  }
  const friendGids = [...new Set(rawGids)]

  return {
    name: String(data?.name || data?.nick || data?.nickname || '').trim(),
    code,
    platform: 'qq',
    loginType: 'qq_capture',
    gid: data?.gid ? String(data.gid) : undefined,
    qq: data?.qq || data?.uin ? String(data.qq || data.uin) : undefined,
    friendGids: friendGids.length > 0 ? friendGids : undefined,
  }
}

function normalizeStatus(data: any) {
  status.value = String(data?.status || '').trim().toLowerCase()
  // 不用原始英文 status 作为显示文字，用 statusHint 的计算属性替代
  statusText.value = String(data?.statusText || data?.message || '').trim()
  proxyHost.value = String(data?.host || data?.proxyHost || proxyHost.value || '').trim()
  proxyPort.value = String(data?.port || data?.proxyPort || proxyPort.value || '').trim()
  certUrl.value = LOCAL_CERT_URL
}

function isTerminalStatus(value: string) {
  return ['stopped', 'failed', 'error', 'expired', 'timeout', 'cancelled', 'canceled'].includes(value.toLowerCase())
}

function finishWithError(message: string) {
  stopTimer()
  stopTickTimer()
  loading.value = false
  errorMessage.value = message
}

function handleCaptureData(data: any) {
  normalizeStatus(data)
  const payload = normalizePayload(data)
  if (payload) {
    status.value = 'captured'

    // 合并最新好友数据到 capturedPayload
    if (!capturedPayload) {
      capturedPayload = payload
      statusText.value = '已抓到 Code，正在等待好友数据...'
    }
    else {
      // 更新好友列表（取最新的更多数量）
      const newGids = payload.friendGids ?? []
      const oldGids = capturedPayload.friendGids ?? []
      if (newGids.length > oldGids.length)
        capturedPayload = payload
    }

    // 必须拿到好友 GID 后才创建账号，和旧项目一致。
    // 只拿到 code 时继续轮询，避免手机连接仍占用 code 导致 bot 登录 400。
    const hasFriends = (capturedPayload.friendGids?.length ?? 0) > 0
    if (hasFriends) {
      stopTimer()
      stopTickTimer()
      loading.value = false
      statusText.value = `已抓到 Code，导入 ${capturedPayload.friendGids!.length} 位好友`
      emit('captured', capturedPayload)
      capturedPayload = null
    }
    return true
  }
  if (status.value && isTerminalStatus(status.value)) {
    finishWithError(statusText.value || '抓包会话已结束，请重新开始')
    return true
  }
  return false
}

async function poll() {
  if (!sessionId.value || polling)
    return
  if (startedAt.value && Date.now() - startedAt.value > CAPTURE_TIMEOUT_MS) {
    await cancelCapture('等待抓包结果超时，请检查手机证书和 WiFi 代理设置后重新开始')
    return
  }
  polling = true
  try {
    const response = await api.get(`/api/capture/sessions/${encodeURIComponent(sessionId.value)}`)
    const data = response.data?.data || response.data
    handleCaptureData(data)
  }
  catch (error: any) {
    finishWithError(error?.response?.data?.error || error?.message || '抓包状态查询失败')
  }
  finally {
    polling = false
  }
}

async function startCapture() {
  if (loading.value)
    return
  resetSessionState()
  loading.value = true
  errorMessage.value = ''
  statusText.value = '正在创建抓包会话'
  startedAt.value = Date.now()
  startTickTimer()
  try {
    const response = await api.post('/api/capture/sessions', {})
    const data = response.data?.data || response.data
    sessionId.value = String(data?.sessionId || data?.id || data?.uuid || '')
    if (handleCaptureData(data))
      return
    if (!sessionId.value)
      throw new Error('抓包服务未返回会话 ID')
    if (!statusText.value)
      statusText.value = '请按抓包服务提示在手机 QQ 中完成登录'
    loading.value = false
    timer = window.setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    void poll()
  }
  catch (error: any) {
    finishWithError(error?.response?.data?.error || error?.message || '创建抓包会话失败')
  }
}

async function downloadCert() {
  downloadingCert.value = true
  errorMessage.value = ''
  try {
    const response = await api.get(certUrl.value || LOCAL_CERT_URL, { responseType: 'blob' })
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = 'qq-capture-ca.crt'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }
  catch (error: any) {
    errorMessage.value = error?.response?.data?.error || error?.message || '下载 CA 证书失败'
  }
  finally {
    downloadingCert.value = false
  }
}

async function cancelCapture(message = '') {
  const id = sessionId.value
  stopTimer()
  stopTickTimer()
  sessionId.value = ''
  loading.value = false
  polling = false
  if (message)
    errorMessage.value = message
  else statusText.value = ''
  if (id)
    await api.delete(`/api/capture/sessions/${encodeURIComponent(id)}`).catch(() => {})
}

onBeforeUnmount(() => {
  void cancelCapture()
})
</script>

<template>
  <div class="capture-panel">
    <p v-if="errorMessage" class="capture-error">
      {{ errorMessage }}
    </p>

    <div class="capture-guide">
      <div class="capture-step">
        <span class="step-index">1</span>
        <span>下载并安装 CA 证书，手机里开启完全信任。</span>
      </div>
      <div class="capture-step">
        <span class="step-index">2</span>
        <span>按页面显示的地址设置手机 WiFi HTTP 代理。</span>
      </div>
      <div class="capture-step">
        <span class="step-index">3</span>
        <span>打开手机 QQ 农场，等待状态变为已抓到 Code。</span>
      </div>
    </div>

    <div
      v-if="statusText || proxyIp || proxyPortDisplay"
      class="capture-status-card"
      :class="{
        'capture-status-card--waiting': status === 'waiting',
        'capture-status-card--ready': status === 'ready',
        'capture-status-card--captured': status === 'captured',
        'capture-status-card--stopped': status === 'stopped' || isTerminalStatus(status),
      }"
    >
      <!-- 连接状态徽章 -->
      <div
        class="capture-conn-badge"
        :class="{ 'capture-conn-badge--waiting': status === 'waiting' || status === 'ready' || status === 'captured' }"
      >
        <template v-if="status === 'ready' || status === 'captured'">
          <span class="conn-dot conn-dot--online" />
          <span class="conn-label conn-label--online">{{ status === 'captured' ? '已抓到数据' : '手机已连接' }}</span>
        </template>
        <template v-else-if="status === 'waiting'">
          <span class="conn-dot conn-dot--waiting" />
          <span class="conn-label conn-label--waiting">等待手机连接...</span>
        </template>
        <template v-else-if="isTerminalStatus(status)">
          <span class="conn-dot conn-dot--stopped" />
          <span class="conn-label conn-label--stopped">已停止</span>
        </template>
      </div>

      <div v-if="status !== 'waiting' && status !== 'ready' && status !== 'captured' && statusText" class="capture-status-title">
        {{ statusText }}
      </div>
      <div class="capture-status-hint">
        {{ statusHint }}
      </div>

      <div v-if="proxyIp" class="capture-detail-row">
        <span>IP</span>
        <strong>{{ proxyIp }}</strong>
      </div>
      <div v-if="proxyPortDisplay" class="capture-detail-row">
        <span>端口</span>
        <strong>{{ proxyPortDisplay }}</strong>
      </div>
      <div v-if="startedAt && sessionId" class="capture-detail-row">
        <span>已等待</span>
        <strong>{{ elapsedSeconds }} 秒</strong>
      </div>
    </div>

    <div class="capture-actions">
      <BaseButton v-if="!sessionId" variant="primary" :loading="loading" @click="startCapture">
        开始 QQ 抓包
      </BaseButton>
      <BaseButton variant="outline" :loading="downloadingCert" @click="downloadCert">
        下载证书
      </BaseButton>
      <BaseButton v-if="sessionId" variant="outline" @click="cancelCapture()">
        取消
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.capture-panel {
  display: grid;
  justify-items: stretch;
  gap: 0.75rem;
  width: 100%;
}
.capture-error {
  width: 100%;
  margin: 0;
  color: #dc2626;
  font-size: 0.875rem;
  text-align: center;
}
.capture-guide {
  display: grid;
  gap: 0.5rem;
}
.capture-step {
  display: grid;
  grid-template-columns: 1.5rem 1fr;
  align-items: center;
  gap: 0.5rem;
  color: var(--theme-text-secondary, #64748b);
  font-size: 0.8125rem;
}
.step-index {
  display: inline-grid;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--theme-primary, #2563eb) 14%, transparent);
  color: var(--theme-primary, #2563eb);
  font-weight: 700;
  font-size: 0.75rem;
}

/* ── 状态卡片基础 ── */
.capture-status-card {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--theme-text, #0f172a) 12%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-bg, #fff) 94%, var(--theme-text, #0f172a));
  transition:
    border-color 0.25s,
    background 0.25s;
}

/* waiting — 橙色：代理已就绪，手机未连接 */
.capture-status-card--waiting {
  border-color: rgba(234, 179, 8, 0.45);
  background: color-mix(in srgb, #fef9c3 70%, var(--theme-bg, #fff));
  text-align: center;
}

/* ready — 绿色：手机已连上代理 */
.capture-status-card--ready {
  border-color: rgba(34, 197, 94, 0.5);
  background: color-mix(in srgb, #dcfce7 65%, var(--theme-bg, #fff));
  text-align: center;
}

/* captured — 深绿：已拿到数据 */
.capture-status-card--captured {
  border-color: rgba(22, 163, 74, 0.6);
  background: color-mix(in srgb, #bbf7d0 60%, var(--theme-bg, #fff));
}

/* stopped/error */
.capture-status-card--stopped {
  border-color: rgba(100, 116, 139, 0.3);
  background: color-mix(in srgb, #f1f5f9 80%, var(--theme-bg, #fff));
}

/* ── 连接状态徽章 ── */
.capture-conn-badge {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
/* waiting 时居中放大 */
.capture-conn-badge--waiting {
  justify-content: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
}
.capture-conn-badge--waiting .conn-dot {
  width: 0.75rem;
  height: 0.75rem;
}
.capture-conn-badge--waiting .conn-label {
  font-size: 1rem;
  font-weight: 700;
}
.conn-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
}
.conn-dot--waiting {
  background: #eab308;
  animation: pulse-waiting 1.4s ease-in-out infinite;
}
.conn-dot--online {
  background: #22c55e;
}
.conn-dot--stopped {
  background: #94a3b8;
}

@keyframes pulse-waiting {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.75);
  }
}

.conn-label {
  font-size: 0.75rem;
  font-weight: 600;
}
.conn-label--waiting {
  color: #92400e;
}
.conn-label--online {
  color: #166534;
}
.conn-label--stopped {
  color: #475569;
}

/* ── 文字 ── */
.capture-status-title {
  color: var(--theme-text, #0f172a);
  font-size: 0.9rem;
  font-weight: 700;
}
.capture-status-hint {
  color: var(--theme-text-secondary, #64748b);
  font-size: 0.8125rem;
  line-height: 1.5;
}
.capture-detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--theme-text-secondary, #64748b);
  font-size: 0.8125rem;
}
.capture-detail-row strong {
  color: var(--theme-text, #0f172a);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.capture-actions {
  display: flex;
  justify-content: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  width: 100%;
}
.capture-actions :deep(.base-button) {
  min-width: 9rem;
}
</style>
