<script setup lang="ts">
import { NCard, NModal } from 'naive-ui'
import { NSwitch } from 'naive-ui/es/switch'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)

const endpoint = ref('')
const appId = ref('')
const appSecret = ref('')
const bindingEnabled = ref(true)

const dailyEnabled = ref(true)
const dailyHour = ref(9)
const dailyMinute = ref(0)
const dailyMax = ref(8)

const realtimeEnabled = ref(true)
const realtimeWindow = ref(20)
const realtimeInterval = ref(60)
const realtimeLimit = ref(120)
const realtimeMarkdown = ref(true)
const preview = ref('')

const qrOpen = ref(false)
const qrLoading = ref(false)
const qrState = ref<{ phase: string, qrUrl?: string, qrImage?: string, error?: string }>({ phase: 'idle' })
let qrTimer: ReturnType<typeof setInterval> | null = null

function stopQrPolling() {
  if (qrTimer) {
    clearInterval(qrTimer)
    qrTimer = null
  }
}

onMounted(async () => {
  await Promise.all([loadBinding(), loadSettings()])
  loading.value = false
})

onBeforeUnmount(() => {
  stopQrPolling()
  if (qrOpen.value)
    void api.post('/api/settings/qqbot/qr/cancel').catch(() => {})
})

async function loadBinding() {
  try {
    const { data } = await api.get('/api/user/push-binding')
    const binding = data?.data
    if (binding) {
      endpoint.value = binding.endpoint || ''
      appId.value = binding.appId || ''
      bindingEnabled.value = binding.enabled !== false
    }
  }
  catch { /* 未绑定 */ }
}

async function loadSettings() {
  try {
    const { data } = await api.get('/api/user/push-settings')
    const settings = data?.data
    if (!settings)
      return
    const daily = settings.dailyReport || {}
    const realtime = settings.realtimePush || {}
    dailyEnabled.value = daily.enabled !== false
    dailyHour.value = daily.hour ?? 9
    dailyMinute.value = daily.minute ?? 0
    dailyMax.value = daily.maxAccounts ?? 8
    realtimeEnabled.value = realtime.enabled !== false
    realtimeWindow.value = realtime.windowSec ?? 20
    realtimeInterval.value = realtime.minIntervalSec ?? 60
    realtimeLimit.value = realtime.dailyLimit ?? 120
    realtimeMarkdown.value = realtime.markdown !== false
  }
  catch { /* 使用默认值 */ }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || 0))

function settingsPayload() {
  return {
    dailyReport: {
      enabled: dailyEnabled.value,
      hour: clamp(dailyHour.value, 0, 23),
      minute: clamp(dailyMinute.value, 0, 59),
      maxAccounts: clamp(dailyMax.value, 1, 30),
    },
    realtimePush: {
      enabled: realtimeEnabled.value,
      windowSec: clamp(realtimeWindow.value, 5, 600),
      minIntervalSec: clamp(realtimeInterval.value, 10, 3600),
      dailyLimit: clamp(realtimeLimit.value, 1, 1000),
      markdown: realtimeMarkdown.value,
    },
  }
}

async function saveSettings() {
  saving.value = true
  try {
    const { data } = await api.post('/api/user/push-settings', settingsPayload())
    if (data?.ok)
      toast.success('我的推送设置已保存')
    else
      toast.error(getApiErrorMessage(data, '保存失败'))
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    saving.value = false
  }
}

async function saveBinding() {
  if (!endpoint.value.trim()) {
    toast.error('请填写推送目标，或先扫码获取')
    return
  }
  saving.value = true
  try {
    const { data } = await api.post('/api/user/push-binding', {
      endpoint: endpoint.value.trim(),
      appId: appId.value.trim(),
      appSecret: appSecret.value,
      enabled: bindingEnabled.value,
    })
    if (data?.ok) {
      toast.success('推送账号已保存')
      appSecret.value = ''
      qrOpen.value = false
    }
    else {
      toast.error(getApiErrorMessage(data, '保存失败'))
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    saving.value = false
  }
}

async function testPush(kind: 'daily' | 'realtime') {
  testing.value = true
  try {
    const path = kind === 'daily' ? '/api/settings/report/test' : '/api/settings/realtime-push/test'
    const { data } = await api.post(path, {})
    if (data?.ok) {
      preview.value = data.preview?.markdown || data.preview?.content || ''
      toast.success(data.message || '测试卡片已发送')
    }
    else {
      toast.error(getApiErrorMessage(data, '测试发送失败'))
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '测试发送失败'))
  }
  finally {
    testing.value = false
  }
}

async function pollQrState() {
  try {
    const { data } = await api.get('/api/settings/qqbot/qr/state')
    const state = data?.data || {}
    qrState.value = state
    if (state.phase === 'success' && state.credentials) {
      appId.value = String(state.credentials.appId || '')
      appSecret.value = String(state.credentials.appSecret || '')
      if (state.credentials.userOpenid)
        endpoint.value = `c2c:${state.credentials.userOpenid}`
      stopQrPolling()
      qrOpen.value = false
      toast.success('扫码成功，点「保存配置」生效')
    }
    else if (state.phase === 'failed') {
      stopQrPolling()
      toast.error(state.error || '扫码失败')
    }
  }
  catch (e: any) {
    stopQrPolling()
    toast.error(getApiErrorMessage(e, '扫码状态查询失败'))
  }
}

async function startQrBind() {
  qrLoading.value = true
  qrState.value = { phase: 'starting' }
  qrOpen.value = true
  try {
    const { data } = await api.post('/api/settings/qqbot/qr/start')
    qrState.value = data?.data || { phase: 'waiting' }
    stopQrPolling()
    qrTimer = setInterval(() => { void pollQrState() }, 1500)
  }
  catch (e: any) {
    qrOpen.value = false
    toast.error(getApiErrorMessage(e, '启动扫码失败'))
  }
  finally {
    qrLoading.value = false
  }
}

function closeQrBind() {
  stopQrPolling()
  qrOpen.value = false
  void api.post('/api/settings/qqbot/qr/cancel').catch(() => {})
}
</script>

<template>
  <div class="user-push-panel">
    <div v-if="loading" class="py-4 text-center text-sm text-gray-500">加载中...</div>
    <template v-else>
      <section class="farm-card rounded-lg p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="text-sm text-[var(--ui-ink)] font-medium">QQ 官方机器人</div>
            <div class="text-xs text-[var(--ui-muted)]">
              {{ endpoint ? (bindingEnabled ? '已启用' : '已配置 · 未启用') : '未配置' }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-[var(--ui-muted)]">{{ endpoint || '未绑定' }}</span>
            <BaseButton variant="secondary" size="sm" @click="qrOpen = true">配置</BaseButton>
            <NSwitch :value="bindingEnabled" size="small" aria-label="启用我的 QQ 机器人" @update:value="val => { bindingEnabled = Boolean(val); void saveBinding() }" />
          </div>
        </div>
      </section>

      <section class="farm-card rounded-lg p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="text-sm text-[var(--ui-ink)] font-medium">📊 每日统计推送</div>
            <div class="text-xs text-[var(--ui-muted)]">每天固定时间推送自己账号的资产与今日操作，每天只发一次。</div>
          </div>
          <NSwitch :value="dailyEnabled" size="small" aria-label="启用每日统计推送" @update:value="val => { dailyEnabled = Boolean(val) }" />
        </div>
        <div class="user-push-fields">
          <label class="user-push-field">
            <span>发送时间</span>
            <span class="flex items-center gap-1">
              <BaseInput v-model.number="dailyHour" type="number" min="0" max="23" />
              <span>时</span>
              <BaseInput v-model.number="dailyMinute" type="number" min="0" max="59" />
              <span>分</span>
            </span>
          </label>
          <label class="user-push-field">
            <span>最多展示账号数</span>
            <BaseInput v-model.number="dailyMax" type="number" min="1" max="30" />
          </label>
          <div class="flex items-end gap-2">
            <BaseButton variant="secondary" size="sm" :loading="testing" @click="testPush('daily')">发送测试报表</BaseButton>
            <BaseButton variant="primary" size="sm" :loading="saving" @click="saveSettings">保存设置</BaseButton>
          </div>
        </div>
      </section>

      <section class="farm-card rounded-lg p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="text-sm text-[var(--ui-ink)] font-medium">⚡ 实时操作推送</div>
            <div class="text-xs text-[var(--ui-muted)]">种植、收获、出售、偷菜等操作实时汇总后推送给你。</div>
          </div>
          <NSwitch :value="realtimeEnabled" size="small" aria-label="启用实时操作推送" @update:value="val => { realtimeEnabled = Boolean(val) }" />
        </div>
        <div class="user-push-fields">
          <label class="user-push-field"><span>聚合窗口（秒）</span><BaseInput v-model.number="realtimeWindow" type="number" min="5" max="600" /></label>
          <label class="user-push-field"><span>最小间隔（秒）</span><BaseInput v-model.number="realtimeInterval" type="number" min="10" max="3600" /></label>
          <label class="user-push-field"><span>每日上限（条）</span><BaseInput v-model.number="realtimeLimit" type="number" min="1" max="1000" /></label>
          <label class="flex items-center gap-2 text-xs text-[var(--ui-muted)]">
            <NSwitch :value="realtimeMarkdown" size="small" aria-label="QQ Markdown 卡片" @update:value="val => { realtimeMarkdown = Boolean(val) }" />
            QQ Markdown 卡片
          </label>
          <div class="flex items-end gap-2">
            <BaseButton variant="secondary" size="sm" :loading="testing" @click="testPush('realtime')">发送测试卡片</BaseButton>
            <BaseButton variant="primary" size="sm" :loading="saving" @click="saveSettings">保存实时设置</BaseButton>
          </div>
        </div>
      </section>

      <section class="farm-card rounded-lg p-4">
        <div class="text-sm text-[var(--ui-ink)] font-medium">推送账号</div>
        <p class="text-xs text-[var(--ui-muted)]">只推送给你自己，不会和其他用户共用配置。</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="text-xs text-[var(--ui-ink)]">{{ endpoint || '尚未绑定' }}</span>
          <BaseButton variant="outline" size="sm" @click="qrOpen = true">扫码绑定</BaseButton>
        </div>
      </section>

      <pre v-if="preview" class="user-push-preview">{{ preview }}</pre>
    </template>

    <NModal v-model:show="qrOpen" :close-on-esc="!qrLoading" :mask-closable="!qrLoading">
      <NCard class="push-modal-card" role="dialog" aria-modal="true" aria-label="配置我的 QQ 机器人" title="配置我的 QQ 机器人" :bordered="false" size="medium" :closable="!qrLoading" @close="closeQrBind">
        <div class="grid gap-3">
          <BaseInput v-model="appId" type="text" label="AppID" placeholder="扫码获取或手填" />
          <BaseInput v-model="appSecret" type="password" label="AppSecret" placeholder="不修改可留空" />
          <BaseInput v-model="endpoint" type="text" label="推送目标" placeholder="c2c:你的OPENID" />
          <div class="flex flex-wrap items-center gap-2">
            <BaseButton variant="secondary" size="sm" :loading="qrLoading" @click="startQrBind">扫码获取密钥</BaseButton>
            <span class="text-xs text-[var(--ui-muted)]">扫码会自动填入上三项</span>
          </div>
          <img v-if="qrState.qrImage" :src="qrState.qrImage" alt="QQ 机器人绑定二维码" class="mx-auto w-60" />
          <a v-if="qrState.qrUrl" :href="qrState.qrUrl" target="_blank" rel="noopener noreferrer" class="text-center text-xs text-[var(--ui-primary)] hover:underline">在浏览器打开二维码链接</a>
          <p v-if="qrState.error" class="text-xs text-red-600 dark:text-red-400">{{ qrState.error }}</p>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <BaseButton variant="secondary" size="sm" @click="closeQrBind">取消</BaseButton>
            <BaseButton variant="primary" size="sm" :loading="saving" @click="saveBinding">保存配置</BaseButton>
          </div>
        </template>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.user-push-panel {
  display: grid;
  gap: 12px;
}

.user-push-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-top: 12px;
}

.user-push-field {
  display: grid;
  gap: 5px;
  color: var(--ui-muted);
  font-size: 12px;
}

.user-push-field :deep(input) {
  width: 72px;
}

.user-push-preview {
  max-height: 320px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  background: var(--ui-surface);
}
</style>
