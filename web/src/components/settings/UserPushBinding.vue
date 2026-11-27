<script setup lang="ts">
import { NCard, NModal } from 'naive-ui'
import { NSwitch } from 'naive-ui/es/switch'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()
const endpoint = ref('')
const appId = ref('')
const appSecret = ref('')
const enabled = ref(true)
const saving = ref(false)
const testing = ref(false)
const loaded = ref(false)

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
  try {
    const { data } = await api.get('/api/user/push-binding')
    const binding = data?.data
    if (binding) {
      endpoint.value = binding.endpoint || ''
      appId.value = binding.appId || ''
      appSecret.value = ''
      enabled.value = binding.enabled !== false
    }
  }
  catch {
    // 未配置时保持空表单
  }
  finally {
    loaded.value = true
  }
})

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
      appId.value = String(state.credentials.appId || '')
      appSecret.value = String(state.credentials.appSecret || '')
      if (state.credentials.userOpenid)
        endpoint.value = `c2c:${state.credentials.userOpenid}`
      stopQrPolling()
      qrOpen.value = false
      toast.success('扫码成功，已填入密钥和你的 OpenID；点「保存绑定」生效')
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
      enabled: enabled.value,
    })
    if (data?.ok) {
      toast.success('推送绑定已保存，你只会收到自己账号的通知')
      appSecret.value = ''
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

async function testBinding() {
  testing.value = true
  try {
    const { data } = await api.post('/api/settings/realtime-push/test', {})
    if (data?.ok) toast.success(data.message || '测试卡片已发送')
    else toast.error(getApiErrorMessage(data, '测试发送失败'))
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '测试发送失败'))
  }
  finally {
    testing.value = false
  }
}
</script>

<template>
  <section class="farm-card rounded-lg p-4">
    <div class="mb-4 flex items-start gap-3">
      <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400">
        <span class="i-carbon-notification text-xl" />
      </div>
      <div>
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">我的推送绑定</h4>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          绑定你自己的 QQ 机器人后，日报和实时操作只会发给你，不会发给管理员或其他用户。
        </p>
      </div>
    </div>

    <div v-if="!loaded" class="py-4 text-center text-sm text-gray-500">加载中...</div>
    <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BaseInput v-model="appId" type="text" label="我的 AppID" placeholder="扫码获取，或手填自己的机器人 AppID" />
      <BaseInput v-model="appSecret" type="password" label="我的 AppSecret" placeholder="不修改可留空" />
      <BaseInput v-model="endpoint" type="text" label="推送目标" placeholder="c2c:你的OPENID" class="sm:col-span-2" />
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <BaseButton variant="secondary" size="sm" :loading="qrLoading" @click="startQrBind">扫码绑定我的机器人</BaseButton>
      <BaseButton variant="primary" size="sm" :loading="saving" @click="saveBinding">保存绑定</BaseButton>
      <BaseButton variant="outline" size="sm" :loading="testing" @click="testBinding">发送测试卡片</BaseButton>
      <NSwitch :value="enabled" size="small" aria-label="启用我的推送" @update:value="val => { enabled = Boolean(val) }" />
      <span class="text-xs text-gray-400">{{ enabled ? '推送已启用' : '推送已关闭（保存后生效）' }}</span>
    </div>

    <NModal v-model:show="qrOpen" :close-on-esc="!qrLoading" :mask-closable="!qrLoading">
      <NCard
        class="push-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="扫码绑定我的 QQ 机器人"
        title="扫码绑定我的 QQ 机器人"
        :bordered="false"
        size="medium"
        :closable="!qrLoading"
        @close="closeQrBind"
      >
        <div class="grid gap-3 text-center">
          <img v-if="qrState.qrImage" :src="qrState.qrImage" alt="QQ 机器人绑定二维码" class="mx-auto w-60" />
          <p class="text-xs text-[var(--ui-muted)]">手机 QQ 扫码后自动填入你的 AppID、AppSecret 和 OpenID。</p>
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
  </section>
</template>
