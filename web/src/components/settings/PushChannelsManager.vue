<script setup lang="ts">
import type { DailyReportConfig, OfflineChannelConfig, OfflineConfig, PushChannelChange, PushTargetConfig, RealtimePushConfig } from '@/stores/setting'
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NSwitch } from 'naive-ui/es/switch'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import {
  getPushChannelDocUrl,
  getPushChannelLabel,
  isPushChannelConfigured,
  normalizeChannelEntry,
  PUSH_CHANNEL_OPTIONS,
  validateDingTalkWebhook,
} from '@/stores/setting'
import { useToastStore } from '@/stores/toast'

interface ChannelListItem {
  value: string
  label: string
  configured: boolean
  enabled: boolean
}

const props = defineProps<{
  config: OfflineConfig
  supportsChannels: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: 'saveChannel', change: PushChannelChange, onDone: (ok: boolean) => void): void
  (e: 'saveDailyReport', daily: DailyReportConfig, onDone: (ok: boolean) => void): void
  (e: 'savePushTargets', targets: PushTargetConfig[], onDone: (ok: boolean) => void): void
  (e: 'saveRealtimePush', config: RealtimePushConfig, onDone: (ok: boolean) => void): void
}>()

const toast = useToastStore()

const listOpen = ref(false)
const searchQuery = ref('')

const editingChannel = ref<string | null>(null)
const draftEndpoint = ref('')
const draftToken = ref('')
const draftSecret = ref('')
const draftEnabled = ref(true)
const channelTesting = ref(false)
const channelActionError = ref('')

const channelMap = computed(() => {
  const map = new Map<string, OfflineChannelConfig>()
  for (const item of props.config.channels)
    map.set(item.channel, item)
  return map
})

/** 用户自己绑定的 QQ 机器人：独立于全局渠道展示和管理，管理员不能改用户的密钥。 */
const userBoundChannels = computed<OfflineChannelConfig[]>(() =>
  userOptions.value
    .filter(user => user.id !== 'admin' && user.pushBinding?.endpoint)
    .map(user => ({
      channel: 'qqbot',
      ownerId: user.id,
      displayLabel: `QQ 官方机器人 · ${user.label}`,
      endpoint: String(user.pushBinding!.endpoint),
      token: String(user.pushBinding!.appId || ''),
      secret: '',
      enabled: user.pushBinding!.enabled,
    })),
)

function channelDisplayName(item: OfflineChannelConfig): string {
  return item.displayLabel || getPushChannelLabel(item.channel)
}

const configuredChannels = computed(() => [
  ...props.config.channels.filter(item => isPushChannelConfigured(item)),
  ...userBoundChannels.value,
])

const activeChannels = computed(() =>
  configuredChannels.value.filter(item => item.enabled),
)

const summaryBadge = computed(() => {
  if (activeChannels.value.length > 0)
    return { text: `已启用 ${activeChannels.value.length} 个`, tone: 'active' as const }
  if (configuredChannels.value.length > 0)
    return { text: `已配置 ${configuredChannels.value.length} 个（未启用）`, tone: 'idle' as const }
  return { text: '未配置', tone: 'empty' as const }
})

const sortedChannelItems = computed<ChannelListItem[]>(() => {
  const kw = searchQuery.value.trim().toLowerCase()
  const list = PUSH_CHANNEL_OPTIONS
    .filter(opt => !kw || opt.label.toLowerCase().includes(kw) || opt.value.toLowerCase().includes(kw))
    .map((opt) => {
      const saved = channelMap.value.get(opt.value) || null
      const configured = saved ? isPushChannelConfigured(saved) : false
      return {
        value: opt.value,
        label: opt.label,
        configured,
        enabled: configured && Boolean(saved?.enabled),
      }
    })

  return list.sort((a, b) => {
    const rank = (x: ChannelListItem) => (x.enabled ? 0 : x.configured ? 1 : 2)
    return rank(a) - rank(b)
  })
})

const editingLabel = computed(() => editingChannel.value ? getPushChannelLabel(editingChannel.value) : '')
const editingDocUrl = computed(() => editingChannel.value ? getPushChannelDocUrl(editingChannel.value) : '')
const editingExisting = computed(() => editingChannel.value ? channelMap.value.get(editingChannel.value) || null : null)
const editingWasConfigured = computed(() => isPushChannelConfigured(editingExisting.value || undefined))

const isDingTalk = computed(() => editingChannel.value === 'dingtalk')
const isWebhook = computed(() => editingChannel.value === 'webhook')
const isMeow = computed(() => editingChannel.value === 'meow')
const isQQBot = computed(() => editingChannel.value === 'qqbot')
const usesEndpoint = computed(() => isWebhook.value || isDingTalk.value || isMeow.value || isQQBot.value)
const usesSecret = computed(() => isDingTalk.value || isQQBot.value)

const endpointLabel = computed(() => isDingTalk.value
  ? 'Webhook 地址'
  : isQQBot.value
    ? '推送目标'
    : isMeow.value ? '接口地址（可选）' : '接口地址')
const endpointPlaceholder = computed(() => isDingTalk.value
  ? '从钉钉群机器人设置页复制完整 Webhook'
  : isQQBot.value
    ? 'c2c:用户OPENID / group:群OPENID / channel:子频道ID'
    : '接收消息的接口地址')
const tokenLabel = computed(() => isMeow.value ? '昵称' : isQQBot.value ? 'AppID' : 'Token')
const tokenPlaceholder = computed(() => isMeow.value ? 'MeoW 注册昵称' : isQQBot.value ? 'QQ 机器人 AppID' : '接收端 token')

const dingTalkInlineError = computed(() => {
  if (!isDingTalk.value || !draftEndpoint.value.trim())
    return ''
  return validateDingTalkWebhook(draftEndpoint.value)
})

const isDraftConfigured = computed(() => {
  if (!editingChannel.value)
    return false
  return isPushChannelConfigured({
    channel: editingChannel.value,
    endpoint: draftEndpoint.value,
    token: draftToken.value,
    secret: draftSecret.value,
  })
})

const canEnableDraft = computed(() => isDraftConfigured.value && !dingTalkInlineError.value)
const effectiveDraftEnabled = computed(() => canEnableDraft.value && draftEnabled.value)
const modalBusy = computed(() => Boolean(props.saving) || channelTesting.value)

/* ---------------- 每日统计推送 ---------------- */
const dailyEnabled = ref(false)
const dailyHour = ref(22)
const dailyMinute = ref(0)
const dailyMaxAccounts = ref(8)
const dailyTesting = ref(false)
const dailyPreview = ref('')

/* ---------------- 实时操作推送 ---------------- */
const realtimeEnabled = ref(true)
const realtimeWindow = ref(20)
const realtimeInterval = ref(60)
const realtimeLimit = ref(120)
const realtimeMarkdown = ref(true)
const realtimeTesting = ref(false)

watch(() => props.config.realtimePush, (cfg) => {
  if (!cfg)
    return
  realtimeEnabled.value = cfg.enabled !== false
  realtimeWindow.value = cfg.windowSec
  realtimeInterval.value = cfg.minIntervalSec
  realtimeLimit.value = cfg.dailyLimit
  realtimeMarkdown.value = cfg.markdown !== false
}, { immediate: true, deep: true })

function currentRealtimeConfig(): RealtimePushConfig {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || 0))
  return {
    enabled: realtimeEnabled.value,
    windowSec: clamp(realtimeWindow.value, 5, 600),
    minIntervalSec: clamp(realtimeInterval.value, 10, 3600),
    dailyLimit: clamp(realtimeLimit.value, 1, 1000),
    markdown: realtimeMarkdown.value,
  }
}

function saveRealtimePush() {
  if (props.saving || realtimeTesting.value)
    return
  emit('saveRealtimePush', currentRealtimeConfig(), (ok) => {
    if (ok)
      toast.success('实时推送设置已保存')
  })
}

async function testRealtimePush() {
  if (realtimeTesting.value)
    return
  realtimeTesting.value = true
  try {
    const { data } = await api.post('/api/settings/realtime-push/test', { ownerId: 'admin' })
    if (data?.ok) {
      dailyPreview.value = data.preview?.markdown || data.preview?.content || ''
      toast.success(data.message || '实时推送测试成功')
    }
    else {
      toast.error(getApiErrorMessage(data, '实时推送测试失败'))
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '实时推送测试失败'))
  }
  finally {
    realtimeTesting.value = false
  }
}

watch(() => props.config.dailyReport, (daily) => {
  if (!daily)
    return
  dailyEnabled.value = daily.enabled === true
  dailyHour.value = daily.hour
  dailyMinute.value = daily.minute
  dailyMaxAccounts.value = daily.maxAccounts || 8
}, { immediate: true, deep: true })

function currentDailyConfig(): DailyReportConfig {
  return {
    enabled: dailyEnabled.value,
    hour: Math.min(23, Math.max(0, Number(dailyHour.value) || 0)),
    minute: Math.min(59, Math.max(0, Number(dailyMinute.value) || 0)),
    maxAccounts: Math.min(30, Math.max(1, Number(dailyMaxAccounts.value) || 8)),
  }
}

function saveDailyReport() {
  if (props.saving || dailyTesting.value)
    return
  emit('saveDailyReport', currentDailyConfig(), (ok) => {
    if (ok)
      toast.success('每日统计推送设置已保存')
  })
}

async function testDailyReport() {
  if (dailyTesting.value)
    return
  dailyTesting.value = true
  try {
    const { data } = await api.post('/api/settings/report/test', currentDailyConfig())
    if (data?.ok) {
      dailyPreview.value = data.preview?.content || ''
      toast.success(data.message || '测试报表已发送')
    }
    else {
      toast.error(getApiErrorMessage(data, '测试报表发送失败'))
      if (data?.preview?.content)
        dailyPreview.value = data.preview.content
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '测试报表发送失败'))
  }
  finally {
    dailyTesting.value = false
  }
}

/* ---------------- QQ 机器人扫码绑定 ---------------- */
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

onBeforeUnmount(() => {
  stopQrPolling()
  if (qrOpen.value)
    void api.post('/api/settings/qqbot/qr/cancel').catch(() => {})
})

async function pollQrState() {
  try {
    const { data } = await api.get('/api/settings/qqbot/qr/state')
    const state = data?.data || {}
    qrState.value = state
    if (state.phase === 'success' && state.credentials) {
      draftToken.value = String(state.credentials.appId || '')
      draftSecret.value = String(state.credentials.appSecret || '')
      if (state.credentials.userOpenid)
        draftEndpoint.value = `c2c:${state.credentials.userOpenid}`
      stopQrPolling()
      qrOpen.value = false
      toast.success('扫码成功，密钥已填入；点击「保存配置」生效')
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

/* ---------------- 按归属分组的推送账号 ---------------- */
const targetsDraft = ref<PushTargetConfig[]>([])
const userOptions = ref<{ id: string, label: string, pushBinding?: { endpoint: string, appId: string, enabled: boolean } }[]>([{ id: 'admin', label: '管理员' }])
const targetTesting = ref('')

watch(() => props.config.pushTargets, (targets) => {
  if (!targets)
    return
  targetsDraft.value = targets.map(item => ({ ...item }))
}, { immediate: true, deep: true })

async function loadUserOptions() {
  try {
    const { data } = await api.get('/api/admin/users')
    const users = Array.isArray(data?.data) ? data.data : []
    userOptions.value = [
      { id: 'admin', label: '管理员' },
      ...users.map((u: any) => ({
        id: String(u.id),
        label: String(u.username),
        pushBinding: u.pushBinding ? {
          endpoint: String(u.pushBinding.endpoint || ''),
          appId: String(u.pushBinding.appId || ''),
          enabled: u.pushBinding.enabled !== false,
        } : undefined,
      })),
    ]
  }
  catch {
    // 非管理员拿不到用户列表，保留管理员项即可
  }
}
void loadUserOptions()

function addPushTarget() {
  targetsDraft.value.push({
    id: `t-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    label: '',
    ownerId: 'admin',
    endpoint: '',
    enabled: true,
  })
}

function savePushTargets() {
  if (props.saving)
    return
  emit('savePushTargets', targetsDraft.value.map(item => ({ ...item })), (ok) => {
    if (ok)
      toast.success('推送账号已保存')
  })
}

async function testPushTarget(target: PushTargetConfig) {
  if (targetTesting.value)
    return
  targetTesting.value = target.id
  try {
    const { data } = await api.post('/api/settings/report/test', {
      ownerId: target.ownerId,
      maxAccounts: currentDailyConfig().maxAccounts,
    })
    if (data?.ok) {
      dailyPreview.value = data.preview?.content || ''
      toast.success(`${target.label || target.ownerId} 测试报表已发送`)
    }
    else {
      toast.error(getApiErrorMessage(data, '测试报表发送失败'))
      if (data?.preview?.content)
        dailyPreview.value = data.preview.content
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '测试报表发送失败'))
  }
  finally {
    targetTesting.value = ''
  }
}

function openListModal() {
  searchQuery.value = ''
  listOpen.value = true
}

function openChannelEditor(channelValue: string, hint?: string) {
  const existing = channelMap.value.get(channelValue)
  editingChannel.value = channelValue
  draftEndpoint.value = existing?.endpoint || ''
  draftToken.value = existing?.token || ''
  draftSecret.value = existing?.secret || ''
  draftEnabled.value = existing && isPushChannelConfigured(existing) ? existing.enabled : true
  channelActionError.value = ''
  if (hint)
    toast.info(hint)
}

function openDocs(url: string) {
  if (url)
    window.open(url, '_blank', 'noopener,noreferrer')
}

function handleToggle(channel: string, enabled: boolean) {
  emit('saveChannel', { channel, enabled }, (ok) => {
    if (ok)
      toast.success(`${enabled ? '已启用' : '已停用'} ${getPushChannelLabel(channel)}`)
  })
}

function handleDisabledSwitchTap(item: ChannelListItem) {
  if (item.configured || props.saving)
    return
  openChannelEditor(item.value, '请先完成配置后再启用')
}

function handleDraftEnabledChange(value?: boolean) {
  if (!canEnableDraft.value) {
    toast.warning('请先填写有效的推送配置后再启用')
    return
  }
  draftEnabled.value = Boolean(value)
}

async function handleTestChannel() {
  if (!editingChannel.value || channelTesting.value)
    return
  channelActionError.value = ''
  if (!isDraftConfigured.value) {
    channelActionError.value = isQQBot.value
      ? '请填写 QQ 机器人 AppID、AppSecret 和推送目标（c2c/group/channel）'
      : isDingTalk.value
        ? '请填写钉钉机器人 Webhook 地址'
        : isWebhook.value
          ? '请填写 Webhook 接口地址'
          : isMeow.value
            ? '请填写 MeoW 昵称'
            : '请填写接收端 Token'
    return
  }
  if (isDingTalk.value) {
    const err = validateDingTalkWebhook(draftEndpoint.value)
    if (err) {
      channelActionError.value = err
      return
    }
  }

  channelTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', {
      channel: editingChannel.value,
      endpoint: draftEndpoint.value.trim(),
      token: isDingTalk.value ? '' : draftToken.value.trim(),
      secret: usesSecret.value ? draftSecret.value.trim() : '',
      title: props.config.title || '账号下线提醒',
      msg: props.config.msg || '账号下线',
    })
    if (data?.ok) {
      toast.success(`${editingLabel.value} 测试消息发送成功`)
    }
    else {
      channelActionError.value = `测试失败: ${getApiErrorMessage(data, '未知错误')}`
    }
  }
  catch (e: any) {
    channelActionError.value = `测试失败: ${getApiErrorMessage(e, '请求失败')}`
  }
  finally {
    channelTesting.value = false
  }
}

function handleSaveChannel() {
  if (!editingChannel.value || modalBusy.value)
    return
  channelActionError.value = ''

  if (!isDraftConfigured.value) {
    channelActionError.value = isQQBot.value
      ? '请填写 QQ 机器人 AppID、AppSecret 和推送目标；如需移除该渠道，请点击左下角“清空配置”'
      : isDingTalk.value
        ? '请填写钉钉机器人 Webhook 地址；如需移除该渠道，请点击左下角“清空配置”'
        : isWebhook.value
          ? '请填写接口地址；如需移除该渠道，请点击左下角“清空配置”'
          : isMeow.value
            ? '请填写昵称；如需移除该渠道，请点击左下角“清空配置”'
            : '请填写 Token；如需移除该渠道，请点击左下角“清空配置”'
    return
  }

  if (isDingTalk.value) {
    const err = validateDingTalkWebhook(draftEndpoint.value)
    if (err) {
      channelActionError.value = err
      return
    }
  }

  const normalized = normalizeChannelEntry({
    channel: editingChannel.value,
    enabled: effectiveDraftEnabled.value,
    endpoint: usesEndpoint.value ? draftEndpoint.value.trim() : '',
    token: isDingTalk.value ? '' : draftToken.value.trim(),
    secret: usesSecret.value ? draftSecret.value.trim() : '',
  })
  if (!normalized) {
    channelActionError.value = '推送渠道配置无效'
    return
  }

  emit('saveChannel', normalized, (ok) => {
    if (ok) {
      editingChannel.value = null
      toast.success('推送渠道配置已保存')
    }
  })
}

function handleClearChannel() {
  if (!editingChannel.value || modalBusy.value)
    return
  const target = editingChannel.value
  const label = editingLabel.value
  emit('saveChannel', { channel: target, enabled: false, token: '', endpoint: '', secret: '' }, (ok) => {
    if (ok) {
      editingChannel.value = null
      toast.info(`已清空 ${label} 配置`)
    }
  })
}
</script>

<template>
  <div class="push-section">
    <div class="push-section__head">
      <div class="flex flex-wrap items-center gap-2">
        <span class="push-section__title">推送渠道</span>
        <span
          class="push-channel-badge"
          :class="`push-channel-badge--${summaryBadge.tone}`"
        >
          {{ summaryBadge.text }}
        </span>
      </div>
      <BaseButton variant="secondary" size="sm" @click="openListModal">
        管理推送渠道
      </BaseButton>
    </div>

    <div v-if="configuredChannels.length > 0" class="push-channel-summary-list">
      <div
        v-for="item in configuredChannels"
        :key="`${item.channel}:${item.ownerId || 'global'}`"
        class="push-channel-row"
      >
        <button
          type="button"
          class="push-channel-row__main"
          @click="item.ownerId ? toast.info('该用户的推送由用户自己在「账号管理」里管理') : openChannelEditor(item.channel)"
        >
          <span class="push-channel-row__name">{{ channelDisplayName(item) }}</span>
          <span
            class="push-channel-row__state"
            :class="item.enabled ? 'push-channel-row__state--on' : 'push-channel-row__state--off'"
          >
            {{ item.enabled ? '已启用' : '已配置 · 未启用' }}
          </span>
          <span v-if="item.ownerId" class="push-channel-row__state push-channel-row__state--empty">用户独立</span>
        </button>
        <div class="flex shrink-0 items-center gap-2">
          <button
            v-if="!item.ownerId"
            type="button"
            class="push-channel-edit-btn"
            @click="openChannelEditor(item.channel)"
          >
            配置
          </button>
          <NSwitch
            v-if="supportsChannels && !item.ownerId"
            :aria-label="`启用 ${channelDisplayName(item)}`"
            :value="item.enabled"
            :disabled="saving"
            size="small"
            @update:value="val => handleToggle(item.channel, val)"
          />
        </div>
      </div>
    </div>

    <button
      v-else
      type="button"
      class="push-channel-empty"
      @click="openListModal"
    >
      暂未配置推送渠道，点击查看全部渠道并配置
    </button>
  </div>

    <div class="daily-report-section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm text-[var(--ui-ink)] font-medium">📊 每日统计推送</div>
          <div class="text-xs text-[var(--ui-muted)]">
            每天固定时间向已启用的推送渠道发送一次账号资产与今日操作汇总，每天只发一次。
          </div>
        </div>
        <NSwitch
          aria-label="启用每日统计推送"
          :value="dailyEnabled"
          :disabled="saving"
          size="small"
          @update:value="val => { dailyEnabled = Boolean(val) }"
        />
      </div>

      <div class="daily-report-fields">
        <label class="daily-report-field">
          <span>发送时间</span>
          <span class="flex items-center gap-1">
            <BaseInput v-model.number="dailyHour" type="number" min="0" max="23" :disabled="saving" />
            <span>时</span>
            <BaseInput v-model.number="dailyMinute" type="number" min="0" max="59" :disabled="saving" />
            <span>分</span>
          </span>
        </label>
        <label class="daily-report-field">
          <span>最多展示账号数</span>
          <BaseInput v-model.number="dailyMaxAccounts" type="number" min="1" max="30" :disabled="saving" />
        </label>
        <div class="flex items-end gap-2">
          <BaseButton variant="secondary" size="sm" :loading="dailyTesting" :disabled="saving" @click="testDailyReport">
            发送测试报表
          </BaseButton>
          <BaseButton variant="primary" size="sm" :loading="saving" :disabled="dailyTesting" @click="saveDailyReport">
            保存设置
          </BaseButton>
        </div>
      </div>

      <div class="realtime-push-box">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="text-sm text-[var(--ui-ink)] font-medium">⚡ 实时操作推送</div>
            <div class="text-xs text-[var(--ui-muted)]">
              种植、收获、出售、偷菜等操作实时汇总后推送给对应账号所有者。
            </div>
          </div>
          <NSwitch
            aria-label="启用实时操作推送"
            :value="realtimeEnabled"
            :disabled="saving"
            size="small"
            @update:value="val => { realtimeEnabled = Boolean(val) }"
          />
        </div>
        <div class="realtime-fields">
          <label class="daily-report-field">
            <span>聚合窗口（秒）</span>
            <BaseInput v-model.number="realtimeWindow" type="number" min="5" max="600" :disabled="saving" />
          </label>
          <label class="daily-report-field">
            <span>最小间隔（秒）</span>
            <BaseInput v-model.number="realtimeInterval" type="number" min="10" max="3600" :disabled="saving" />
          </label>
          <label class="daily-report-field">
            <span>每日上限（条/人）</span>
            <BaseInput v-model.number="realtimeLimit" type="number" min="1" max="1000" :disabled="saving" />
          </label>
          <label class="realtime-markdown">
            <NSwitch :value="realtimeMarkdown" size="small" :disabled="saving" @update:value="val => { realtimeMarkdown = Boolean(val) }" />
            <span>QQ Markdown 卡片</span>
          </label>
          <div class="flex items-end gap-2">
            <BaseButton variant="secondary" size="sm" :loading="realtimeTesting" :disabled="saving" @click="testRealtimePush">
              发送测试卡片
            </BaseButton>
            <BaseButton variant="primary" size="sm" :loading="saving" :disabled="realtimeTesting" @click="saveRealtimePush">
              保存实时设置
            </BaseButton>
          </div>
        </div>
      </div>

      <pre v-if="dailyPreview" class="daily-report-preview">{{ dailyPreview }}</pre>

      <div class="push-targets">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="text-sm text-[var(--ui-ink)] font-medium">推送账号（按归属分别推送）</div>
            <div class="text-xs text-[var(--ui-muted)]">
              每个用户只收到自己名下账号的报表；管理员只收到管理员名下账号的报表。
            </div>
          </div>
          <div class="flex items-center gap-2">
            <BaseButton variant="secondary" size="sm" :disabled="saving" @click="addPushTarget">添加账号</BaseButton>
            <BaseButton variant="primary" size="sm" :loading="saving" @click="savePushTargets">保存推送账号</BaseButton>
          </div>
        </div>

        <div v-for="(target, index) in targetsDraft" :key="target.id" class="push-target-row">
          <BaseInput v-model="target.label" type="text" placeholder="备注名称" class="push-target-label" :disabled="saving" />
          <select v-model="target.ownerId" class="push-target-select" :disabled="saving">
            <option v-for="user in userOptions" :key="user.id" :value="user.id">{{ user.label }}</option>
          </select>
          <BaseInput v-model="target.endpoint" type="text" placeholder="c2c:OPENID" class="push-target-endpoint" :disabled="saving" />
          <NSwitch :value="target.enabled" size="small" :disabled="saving" @update:value="val => { target.enabled = Boolean(val) }" />
          <button type="button" class="push-target-test" :disabled="targetTesting !== ''" @click="testPushTarget(target)">
            {{ targetTesting === target.id ? '发送中' : '测试' }}
          </button>
          <button type="button" class="push-target-remove" :disabled="saving" @click="targetsDraft.splice(index, 1)">删除</button>
        </div>

        <p v-if="!targetsDraft.length" class="text-xs text-[var(--ui-muted)]">
          还没有推送账号，点「添加账号」绑定用户与 QQ 机器人 OpenID。
        </p>
      </div>
    </div>

  <!-- 一级弹窗：列出全部推送渠道 -->
  <NModal v-model:show="listOpen" :close-on-esc="!saving">
    <NCard
      class="push-modal-card"
      role="dialog"
      aria-modal="true"
      aria-label="推送渠道"
      title="推送渠道"
      :bordered="false"
      size="medium"
      closable
      @close="listOpen = false"
    >
      <div class="grid gap-3">
        <p v-if="!supportsChannels" class="text-xs text-[var(--ui-muted)] leading-relaxed">
          当前服务端只支持一个渠道，保存新渠道会替换原渠道。
        </p>

        <BaseInput
          v-model="searchQuery"
          aria-label="搜索推送渠道"
          placeholder="搜索推送渠道"
          clearable
        />

        <div class="push-modal-list">
          <div
            v-for="item in sortedChannelItems"
            :key="item.value"
            class="push-channel-row"
          >
            <button
              type="button"
              class="push-channel-row__main"
              @click="openChannelEditor(item.value)"
            >
              <span class="push-channel-row__name">{{ item.label }}</span>
              <span
                class="push-channel-row__state"
                :class="item.enabled
                  ? 'push-channel-row__state--on'
                  : item.configured
                    ? 'push-channel-row__state--off'
                    : 'push-channel-row__state--empty'"
              >
                {{ item.enabled ? '已启用' : item.configured ? '已配置 · 未启用' : '未配置' }}
              </span>
            </button>

            <div class="flex shrink-0 items-center gap-2">
              <div
                v-if="supportsChannels"
                class="inline-flex items-center"
                @click="!item.configured && handleDisabledSwitchTap(item)"
              >
                <NSwitch
                  :value="item.enabled"
                  :disabled="!item.configured || saving"
                  :aria-label="`启用 ${item.label}`"
                  size="small"
                  @update:value="val => handleToggle(item.value, val)"
                />
              </div>
            </div>
          </div>

          <p
            v-if="sortedChannelItems.length === 0"
            class="py-6 text-center text-xs text-[var(--ui-muted)]"
          >
            没有匹配的推送渠道
          </p>
        </div>
      </div>
    </NCard>
  </NModal>

  <!-- 二级弹窗：单个渠道详细设置 + 单独测试 + 启用开关 -->
  <NModal
    :show="editingChannel !== null"
    :mask-closable="!modalBusy"
    :close-on-esc="!modalBusy"
    @update:show="show => { if (!show && !modalBusy) editingChannel = null }"
  >
    <NCard
      class="push-modal-card push-modal-card--detail"
      role="dialog"
      aria-modal="true"
      :aria-label="`配置 ${editingLabel}`"
      :title="editingLabel ? `配置 · ${editingLabel}` : '配置推送渠道'"
      :bordered="false"
      size="medium"
      :closable="!modalBusy"
      @close="editingChannel = null"
    >
      <template v-if="editingDocUrl" #header-extra>
        <button
          type="button"
          class="mr-2 inline-flex items-center gap-1 text-xs text-[var(--ui-primary)] hover:underline"
          @click="openDocs(editingDocUrl)"
        >
          官方文档
          <span class="i-carbon-launch" aria-hidden="true" />
        </button>
      </template>

      <div class="grid gap-4">
        <BaseInput
          v-if="usesEndpoint"
          id="push-channel-endpoint"
          v-model="draftEndpoint"
          :label="endpointLabel"
          :placeholder="endpointPlaceholder"
          :disabled="modalBusy"
        />

        <BaseInput
          v-if="!isDingTalk"
          id="push-channel-token"
          v-model="draftToken"
          :type="isMeow || isQQBot ? 'text' : 'password'"
          :label="tokenLabel"
          :placeholder="tokenPlaceholder"
          :disabled="modalBusy"
        />

        <template v-if="isDingTalk">
          <BaseInput
            id="push-channel-secret"
            v-model="draftSecret"
            label="加签密钥（可选）"
            type="password"
            placeholder="仅在机器人开启加签时填写 SEC..."
            :disabled="modalBusy"
          />
          <p class="text-xs text-[var(--ui-muted)] leading-relaxed">
            复制群机器人的完整 Webhook 地址；仅开启“加签”时需要填写密钥。
          </p>
        </template>

        <template v-if="isQQBot">
          <BaseInput
            id="push-channel-secret"
            v-model="draftSecret"
            label="AppSecret"
            type="password"
            placeholder="QQ 机器人 AppSecret"
            :disabled="modalBusy"
          />
          <div class="flex flex-wrap items-center gap-2">
            <BaseButton variant="secondary" size="sm" :loading="qrLoading" :disabled="modalBusy" @click="startQrBind">
              扫码获取密钥
            </BaseButton>
            <span class="text-xs text-[var(--ui-muted)]">手机 QQ 扫码后自动填入 AppID / AppSecret / 你的 OpenID</span>
          </div>
          <p class="text-xs text-[var(--ui-muted)] leading-relaxed">
            推送目标：c2c:用户OPENID（单聊）、group:群OPENID（群聊）、channel:子频道ID（频道）。沙箱环境在目标前加 sandbox@。主动消息受 QQ 官方配额限制。
          </p>
        </template>

        <p v-if="dingTalkInlineError" class="text-xs text-red-600 dark:text-red-400">
          {{ dingTalkInlineError }}
        </p>

        <div v-if="supportsChannels" class="push-modal-toggle flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm text-[var(--ui-ink)] font-medium">
              启用此渠道
            </div>
            <div class="text-xs text-[var(--ui-muted)]">
              {{ canEnableDraft ? '开启后将在触发所选通知类型时向该渠道发送消息' : '需先填写有效配置后才允许启用' }}
            </div>
          </div>
          <NSwitch
            size="small"
            :aria-label="`启用 ${editingLabel}`"
            :value="effectiveDraftEnabled"
            :disabled="!canEnableDraft || modalBusy"
            @update:value="handleDraftEnabledChange"
          />
        </div>

        <p v-if="channelActionError" role="alert" class="text-xs text-red-600 dark:text-red-400">
          {{ channelActionError }}
        </p>
      </div>

      <template #footer>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <BaseButton
              v-if="editingWasConfigured"
              variant="secondary"
              size="sm"
              :disabled="modalBusy"
              @click="handleClearChannel"
            >
              清空配置
            </BaseButton>
          </div>
          <div class="flex items-center gap-2">
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="channelTesting"
              :disabled="!canEnableDraft || saving"
              @click="handleTestChannel"
            >
              测试通知
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="saving"
              :disabled="channelTesting"
              @click="handleSaveChannel"
            >
              保存配置
            </BaseButton>
          </div>
        </div>
      </template>
    </NCard>
  </NModal>
  <!-- QQ 机器人扫码绑定弹窗 -->
  <NModal v-model:show="qrOpen" :close-on-esc="!qrLoading" :mask-closable="!qrLoading">
    <NCard
      class="push-modal-card"
      role="dialog"
      aria-modal="true"
      aria-label="扫码绑定 QQ 机器人"
      title="扫码绑定 QQ 机器人"
      :bordered="false"
      size="medium"
      :closable="!qrLoading"
      @close="closeQrBind"
    >
      <div class="grid gap-3 text-center">
        <img v-if="qrState.qrImage" :src="qrState.qrImage" alt="QQ 机器人绑定二维码" class="mx-auto w-60" />
        <p class="text-xs text-[var(--ui-muted)]">用手机 QQ 扫描二维码，绑定成功后自动填入密钥。</p>
        <a v-if="qrState.qrUrl" :href="qrState.qrUrl" target="_blank" rel="noopener noreferrer" class="text-xs text-[var(--ui-primary)] hover:underline">
          在浏览器打开二维码链接
        </a>
        <p v-if="qrState.error" class="text-xs text-red-600 dark:text-red-400">{{ qrState.error }}</p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <BaseButton variant="secondary" size="sm" @click="closeQrBind">取消</BaseButton>
          <BaseButton variant="primary" size="sm" :loading="qrLoading" @click="startQrBind">刷新二维码</BaseButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.push-section {
  display: grid;
  gap: 12px;
  padding-top: 18px;
  border-top: 1px solid var(--ui-border);
}

.push-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.push-section__title {
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
  line-height: 20px;
}

.push-targets {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}

.push-target-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.push-target-label,
.push-target-endpoint {
  width: 180px;
}

.push-target-select {
  height: 34px;
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  color: var(--ui-ink);
  font-size: 12px;
  background: var(--ui-surface);
}

.push-target-test,
.push-target-remove {
  padding: 4px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  color: var(--ui-ink);
  font-size: 11px;
  background: transparent;
  cursor: pointer;
}

.push-target-test:hover,
.push-target-remove:hover {
  color: var(--ui-primary);
  border-color: var(--ui-primary);
}

.realtime-push-box {
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface);
}

.realtime-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.realtime-markdown {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ui-muted);
  font-size: 12px;
}

.daily-report-section {
  display: grid;
  gap: 12px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-surface-strong) 38%, transparent);
}

.daily-report-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.daily-report-field {
  display: grid;
  gap: 5px;
  color: var(--ui-muted);
  font-size: 12px;
}

.daily-report-field :deep(input) {
  width: 68px;
}

.daily-report-preview {
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

.push-modal-toggle {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 58%, transparent);
}

.push-channel-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

.push-channel-badge--active {
  background: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  color: var(--ui-primary);
}

.push-channel-badge--idle {
  background: color-mix(in srgb, #d97706 14%, transparent);
  color: #b45309;
}

.push-channel-badge--empty {
  background: color-mix(in srgb, var(--ui-surface-strong) 75%, transparent);
  color: var(--ui-muted);
}

.push-channel-summary-list {
  display: grid;
  gap: 8px;
}

.push-channel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-control);
  background: color-mix(in srgb, var(--ui-surface-strong) 54%, transparent);
}

.push-channel-row__main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  background: transparent;
}

.push-channel-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: 500;
}

.push-channel-row__state {
  flex-shrink: 0;
  font-size: 12px;
}

.push-channel-row__state--on {
  color: var(--ui-primary);
}

.push-channel-row__state--off {
  color: #d97706;
}

.push-channel-row__state--empty {
  color: var(--ui-subtle);
}

.push-channel-edit-btn {
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--ui-muted);
  font-size: 12px;
}

.push-channel-edit-btn:hover {
  color: var(--ui-primary);
}

.push-channel-empty {
  width: 100%;
  padding: 14px 12px;
  border: 1px dashed var(--ui-border);
  border-radius: var(--ui-radius-control);
  color: var(--ui-muted);
  font-size: 12px;
  text-align: center;
  background: color-mix(in srgb, var(--ui-surface-strong) 36%, transparent);
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.push-channel-empty:hover {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
}

.push-modal-card {
  width: min(500px, calc(100vw - 32px));
}

.push-modal-card--detail {
  width: min(460px, calc(100vw - 32px));
}

.push-modal-list {
  display: grid;
  gap: 8px;
  max-height: min(56vh, 440px);
  overflow-y: auto;
  padding-right: 2px;
}
</style>
