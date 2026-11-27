<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NRadio, NRadioGroup } from 'naive-ui/es/radio'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import api, { getApiErrorMessage, getApiRetryAfterMs } from '@/api'
import QqCapturePanel from '@/components/QqCapturePanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { runWxLoginStatusPoll } from '@/utils/wx-login-poll'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<'code' | 'wx_qr' | 'qq_qr' | 'qq_capture'>('code')
const loginSettingsLoaded = ref(false)
const loginSettings = ref({
  wechatQrLogin: true,
  qqQrLogin: false,
  napCatEndpoint: '',
  napCatSignature: '',
  qqCaptureEnabled: false,
  qqCaptureApiUrl: '',
})
let loginSettingsRequestVersion = 0
const wxTaskId = ref('')
const wxStatus = ref('')
const wxError = ref('')
const wxLoading = ref(false)
const wxQrUrl = ref('')
let wxPollTimer: ReturnType<typeof setTimeout> | undefined
let wxQrObjectUrl = ''
let wxFlowVersion = 0
let wxPollController: AbortController | undefined
let wxPollInFlight: Promise<void> | undefined
let wxPollKey = ''
let wxPendingCode = ''
const qqTaskId = ref('')
const qqStatus = ref('')
const qqError = ref('')
const qqLoading = ref(false)
const qqQrUrl = ref('')
const qqQrUnavailable = ref(false)
/**
 * 二维码取码冷却。
 * NapCat 取码要走 WebUI → QQ 内核，内核未就绪时一次失败要等 10s（QRCode Get Error），
 * 期间重复点「刷新二维码」只会把工作流锁占死，后面全变 WORKFLOW_BUSY。
 * 这里统一冷却：失败后按钮显示剩余秒数，倒计时结束前不发请求。
 */
const QQ_COOLDOWN_SECONDS = 10
const qqCooldownLeft = ref(0)
// 手动「初始化扫码」进行中：按钮显示 loading，避免连点打出多次重置。
const qqInitLoading = ref(false)
// 手动初始化触发重启后，倒计时结束自动再取一次码，省得用户再点一下。
let qqAutoRefreshAfterInit = false
let qqCooldownTimer: ReturnType<typeof setInterval> | undefined
function stopQqCooldown() {
  if (qqCooldownTimer) {
    clearInterval(qqCooldownTimer)
    qqCooldownTimer = undefined
  }
  qqCooldownLeft.value = 0
}
function startQqCooldown(seconds = QQ_COOLDOWN_SECONDS) {
  qqCooldownLeft.value = Math.max(1, Math.ceil(seconds))
  if (qqCooldownTimer)
    return
  qqCooldownTimer = setInterval(() => {
    qqCooldownLeft.value = Math.max(0, qqCooldownLeft.value - 1)
    if (qqCooldownLeft.value <= 0) {
      stopQqCooldown()
      if (qqAutoRefreshAfterInit) {
        qqAutoRefreshAfterInit = false
        void startQqLogin()
      }
    }
  }, 1000)
}
let qqPollTimer: ReturnType<typeof setTimeout> | undefined
let qqFlowVersion = 0
let qqPollController: AbortController | undefined
let qqPollInFlight: Promise<void> | undefined
let qqPollKey = ''
let qqPendingCode = ''
let qrNameSubmitTimer: ReturnType<typeof setTimeout> | undefined

const wechatQrLoginEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.wechatQrLogin)
const qqQrLoginEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.qqQrLogin)
const qqCaptureEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.qqCaptureEnabled)

// 表单数据
const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

// 添加账号
async function addAccount(data: any, isRelogin = false) {
  const name = String(data?.name || '').trim()
  if (!isRelogin && !name) {
    errorMessage.value = '请输入账号备注'
    return false
  }

  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', { ...data, name })
    if (res.data.ok) {
      emit('saved')
      close()
      return true
    }
    else {
      errorMessage.value = `保存失败: ${getApiErrorMessage(res.data, '请求失败')}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${getApiErrorMessage(e, '请求失败')}`
  }
  finally {
    loading.value = false
  }

  return false
}

// QQ 自动抓包拿到 Code 后直接建号，好友 GID 顺带落库。
async function handleCaptureImported(payload: any) {
  const code = String(payload?.code || '').trim()
  if (!code) {
    errorMessage.value = '抓包结果里没有登录 Code，请重新开始'
    return
  }
  await addAccount({
    name: form.name.trim() || String(payload?.name || '').trim() || 'QQ 抓包账号',
    code,
    platform: 'qq',
    loginType: 'qq_capture',
    knownFriendGids: Array.isArray(payload?.friendGids) ? payload.friendGids : undefined,
  }, !!props.editData)
}

function clearQrNameSubmitTimer() {
  if (qrNameSubmitTimer) {
    clearTimeout(qrNameSubmitTimer)
    qrNameSubmitTimer = undefined
  }
}

async function addQrAccount(platform: 'wx' | 'qq', code: string, nickname: string) {
  const name = form.name.trim() || nickname
  if (platform === 'wx')
    wxPendingCode = code
  else
    qqPendingCode = code

  if (!name) {
    if (platform === 'wx') {
      wxStatus.value = '登录授权已完成，等待填写账号备注'
      wxError.value = '未获取到微信昵称，请填写账号备注'
    }
    else {
      qqStatus.value = '登录授权已完成，等待填写账号备注'
      qqError.value = '未获取到 QQ 昵称，请填写账号备注'
    }
    return
  }

  form.name = name
  await submitPendingQrAccount(platform)
}

async function submitPendingQrAccount(platform: 'wx' | 'qq') {
  const name = form.name.trim() || props.editData?.name || ''
  const code = platform === 'wx' ? wxPendingCode : qqPendingCode
  if (!name || !code || !props.show || activeLoginTab.value !== `${platform}_qr`)
    return

  if (platform === 'wx') {
    wxPendingCode = ''
    wxError.value = ''
    wxStatus.value = props.editData ? '正在重新登录...' : '正在添加账号...'
  }
  else {
    qqPendingCode = ''
    qqError.value = ''
    qqStatus.value = props.editData ? '正在重新登录...' : '正在添加账号...'
  }

  const payload: any = { name, code, platform, loginType: 'manual' }
  const saved = await addAccount(payload, !!props.editData)
  if (!saved && props.show && activeLoginTab.value === `${platform}_qr`) {
    if (platform === 'wx')
      wxPendingCode = code
    else
      qqPendingCode = code
  }
}

async function loadLoginSettings() {
  const requestVersion = ++loginSettingsRequestVersion
  loginSettingsLoaded.value = false
  try {
    const response = await api.get('/api/settings/login-config', { skipErrorToast: true } as any)
    if (requestVersion !== loginSettingsRequestVersion)
      return
    const data = response.data?.data
    loginSettings.value = {
      wechatQrLogin: typeof data?.wechatQrLogin === 'boolean' ? data.wechatQrLogin : true,
      qqQrLogin: typeof data?.qqQrLogin === 'boolean' ? data.qqQrLogin : false,
      napCatEndpoint: typeof data?.napCatEndpoint === 'string' ? data.napCatEndpoint : '',
      napCatSignature: typeof data?.napCatSignature === 'string' ? data.napCatSignature : '',
      qqCaptureEnabled: data?.qqCaptureEnabled === true,
      qqCaptureApiUrl: typeof data?.qqCaptureApiUrl === 'string' ? data.qqCaptureApiUrl : '',
    }
  }
  catch {
    if (requestVersion !== loginSettingsRequestVersion)
      return
    // Keep the existing login entries available when an older server has no endpoint yet.
    loginSettings.value = {
      wechatQrLogin: true,
      qqQrLogin: false,
      napCatEndpoint: '',
      napCatSignature: '',
      qqCaptureEnabled: false,
      qqCaptureApiUrl: '',
    }
  }
  finally {
    if (requestVersion === loginSettingsRequestVersion) {
      loginSettingsLoaded.value = true
      if (activeLoginTab.value === 'wx_qr' && !loginSettings.value.wechatQrLogin)
        activeLoginTab.value = 'code'
      if (activeLoginTab.value === 'qq_qr' && !loginSettings.value.qqQrLogin)
        activeLoginTab.value = 'code'
      if (activeLoginTab.value === 'qq_qr' && loginSettings.value.qqQrLogin && !qqTaskId.value)
        void startQqLogin()
    }
  }
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!props.editData && !form.name.trim()) {
    errorMessage.value = '请输入账号备注'
    return
  }
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }
  form.name = form.name.trim()

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  const payload: any = {
    name: form.name,
    code,
    platform: props.editData ? (props.editData.platform || 'qq') : form.platform,
    loginType: 'manual',
  }

  await addAccount(payload, !!props.editData)
}

function stopWxPolling() {
  if (wxPollTimer) {
    clearTimeout(wxPollTimer)
    wxPollTimer = undefined
  }
  wxPollController?.abort()
  wxPollController = undefined
}

function resetWxLogin() {
  const oldTaskId = wxTaskId.value
  wxFlowVersion += 1
  stopWxPolling()
  if (oldTaskId) {
    void api.delete(`/api/wx-login/tasks/${oldTaskId}`, { skipErrorToast: true } as any).catch(() => undefined)
  }
  if (wxQrObjectUrl) {
    URL.revokeObjectURL(wxQrObjectUrl)
    wxQrObjectUrl = ''
  }
  wxTaskId.value = ''
  wxStatus.value = ''
  wxError.value = ''
  wxQrUrl.value = ''
  wxLoading.value = false
  wxPendingCode = ''
  clearQrNameSubmitTimer()
}

function isWxFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === wxFlowVersion && taskId === wxTaskId.value
}

async function getWxCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const codeResult = await api.post(`/api/wx-login/tasks/${taskId}/code`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const code = String(codeResult.data?.data?.code || '').trim()
  const nickname = String(codeResult.data?.data?.nickname || '').trim()
  if (!code)
    throw new Error('未获取到登录 Code')

  await addQrAccount('wx', code, nickname)
}

async function confirmWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  wxStatus.value = '正在建立登录会话...'
  await api.post(`/api/wx-login/tasks/${taskId}/confirm`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  await getWxCodeAndAdd(taskId, flowVersion)
}

async function pollWxLoginRequest(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const controller = new AbortController()
  wxPollController = controller
  try {
    const response = await runWxLoginStatusPoll(() => api.get(`/api/wx-login/tasks/${taskId}/status`, {
      timeout: 40000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any))
    if (!isWxFlowActive(taskId, flowVersion))
      return
    const status = response.data?.data?.status
    if (status === 'waiting') {
      wxStatus.value = '等待微信扫码'
    }
    else if (status === 'scanned') {
      wxStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'authorized') {
      stopWxPolling()
      await confirmWxLogin(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      wxError.value = '二维码已失效，请重新获取'
      return
    }
    wxPollTimer = setTimeout(() => void pollWxLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isWxFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    wxError.value = getApiErrorMessage(error, '登录状态检查失败')
  }
  finally {
    if (wxPollController === controller)
      wxPollController = undefined
  }
}

async function pollWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const previous = wxPollInFlight
  const previousKey = wxPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isWxFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }

  const current = pollWxLoginRequest(taskId, flowVersion)
  wxPollInFlight = current
  wxPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (wxPollInFlight === current) {
      wxPollInFlight = undefined
      wxPollKey = ''
    }
  }
}

async function startWxLogin() {
  if (!wechatQrLoginEnabled.value) {
    activeLoginTab.value = 'code'
    return
  }
  resetWxLogin()
  const flowVersion = wxFlowVersion
  wxLoading.value = true
  try {
    const response = await api.post('/api/wx-login/tasks', { app_id: 'wx5306c5978fdb76e4' })
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (flowVersion !== wxFlowVersion) {
      void api.delete(`/api/wx-login/tasks/${taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    wxTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, { responseType: 'blob' })
    if (!isWxFlowActive(taskId, flowVersion))
      return
    wxQrObjectUrl = URL.createObjectURL(qrResponse.data)
    wxQrUrl.value = wxQrObjectUrl
    wxStatus.value = '等待微信扫码'
    void pollWxLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion !== wxFlowVersion)
      return
    wxError.value = getApiErrorMessage(error, '二维码获取失败')
  }
  finally {
    if (flowVersion === wxFlowVersion)
      wxLoading.value = false
  }
}

function stopQqPolling() {
  if (qqPollTimer) {
    clearTimeout(qqPollTimer)
    qqPollTimer = undefined
  }
  qqPollController?.abort()
  qqPollController = undefined
}

function resetQqLogin() {
  const taskId = qqTaskId.value
  qqFlowVersion += 1
  stopQqPolling()
  if (taskId)
    void cancelQqLoginTask(taskId)
  qqTaskId.value = ''
  qqStatus.value = ''
  qqError.value = ''
  qqQrUrl.value = ''
  qqQrUnavailable.value = false
  qqLoading.value = false
  qqPendingCode = ''
  qqAutoRefreshAfterInit = false
  clearQrNameSubmitTimer()
}

function isQqFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === qqFlowVersion && taskId === qqTaskId.value
}

function ensureQqApiOk(response: any, fallback: string) {
  const payload = response?.data
  if (payload?.ok === false) {
    // 把后端的错误码 / 剩余等待时间挂到 Error 上，否则 getApiRetryAfterMs 拿不到值，
    // 冷却只能退化成固定秒数（WORKFLOW_BUSY 的精确剩余时间就丢了）。
    const error: any = new Error(getApiErrorMessage(payload, fallback))
    if (payload.errorCode)
      error.code = String(payload.errorCode)
    if (Number.isFinite(Number(payload.retryAfterMs)))
      error.retryAfterMs = Number(payload.retryAfterMs)
    if (typeof payload.phase === 'string')
      error.phase = payload.phase
    throw error
  }
  return payload
}

async function getQqCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return
  qqLoading.value = true
  qqStatus.value = '正在获取小程序授权 Code...'
  try {
    const response = await api.post(`/api/qq-login/tasks/${taskId}/code`, undefined, { timeout: 120000 } as any)
    if (!isQqFlowActive(taskId, flowVersion))
      return
    const payload = ensureQqApiOk(response, '获取小程序授权 Code 失败')
    const code = String(payload?.data?.code || '').trim()
    const nickname = String(payload?.data?.nickname || '').trim()
    if (!code)
      throw new Error('未获取到登录 Code')
    await addQrAccount('qq', code, nickname)
  }
  catch (error: any) {
    if (isQqFlowActive(taskId, flowVersion))
      qqError.value = getApiErrorMessage(error, '获取小程序授权 Code 失败')
  }
  finally {
    if (isQqFlowActive(taskId, flowVersion))
      qqLoading.value = false
  }
}

async function cancelQqLoginTask(taskId: string) {
  if (!taskId)
    return
  try {
    const response = await api.post(`/api/qq-login/tasks/${taskId}/cancel`, undefined, {
      timeout: 120000,
      skipErrorToast: true,
    } as any)
    ensureQqApiOk(response, 'QQ 登录任务取消失败')
  }
  catch {}
}

async function pollQqLoginRequest(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return

  const controller = new AbortController()
  qqPollController = controller
  try {
    const response = await api.post(`/api/qq-login/tasks/${taskId}/status`, undefined, {
      timeout: 120000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any)
    if (!isQqFlowActive(taskId, flowVersion))
      return

    const payload = ensureQqApiOk(response, 'QQ 登录状态检查失败')
    const task = payload?.data
    if (!task)
      throw new Error('QQ 登录状态返回无效')
    const status = String(task?.status || '').trim()
    const qrImage = String(task?.qr_image || '').trim()
    if (qrImage)
      qqQrUrl.value = qrImage

    if (status === 'waiting_scan') {
      qqStatus.value = '等待 QQ 扫码'
    }
    else if (status === 'scanned') {
      qqStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'confirmed') {
      stopQqPolling()
      await getQqCodeAndAdd(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      qqError.value = '二维码已失效，请重新获取'
      return
    }
    if (!status) {
      qqError.value = 'QQ 登录状态异常，请重新获取二维码'
      return
    }
    qqPollTimer = setTimeout(() => void pollQqLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isQqFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    qqError.value = getApiErrorMessage(error, 'QQ 登录状态检查失败')
    // 状态查询也被 NapCat 工作流挡住时，同样按后端给的剩余时间进冷却。
    const retryMs = getApiRetryAfterMs(error)
    if (retryMs > 0)
      startQqCooldown(Math.ceil(retryMs / 1000))
  }
  finally {
    if (qqPollController === controller)
      qqPollController = undefined
  }
}

async function pollQqLogin(taskId: string, flowVersion: number) {
  if (!isQqFlowActive(taskId, flowVersion))
    return

  const previous = qqPollInFlight
  const previousKey = qqPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isQqFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }

  const current = pollQqLoginRequest(taskId, flowVersion)
  qqPollInFlight = current
  qqPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (qqPollInFlight === current) {
      qqPollInFlight = undefined
      qqPollKey = ''
    }
  }
}

async function startQqLogin() {
  if (!qqQrLoginEnabled.value) {
    activeLoginTab.value = 'code'
    return
  }
  // 冷却期内不发请求：NapCat 内核未就绪时每次取码都要等满 10s，
  // 连点会把工作流锁占死（后续全变 WORKFLOW_BUSY），这里直接拦下并显示剩余秒数。
  if (qqCooldownLeft.value > 0) {
    qqError.value = `请等待 ${qqCooldownLeft.value} 秒后再获取二维码`
    return
  }
  resetQqLogin()
  qqQrUnavailable.value = false
  const flowVersion = qqFlowVersion
  qqLoading.value = true
  try {
    // 后端 createLoginTask 走 NapCat，自身超时 120s：NapCat 冷启动/QQ 未就绪时可能要好几秒到几十秒。
    // 这里不能沿用全局 10s，否则前端先掐断、后端其实已经建好任务，表现为「有概率二维码获取失败」。
    const response = await api.post('/api/qq-login/tasks', undefined, { timeout: 120000 } as any)
    const payload = ensureQqApiOk(response, 'QQ 登录二维码获取失败')
    const task = payload?.data
    const taskId = String(task?.task_id || '')
    const qrImage = String(task?.qr_image || '')
    if (!taskId || !qrImage)
      throw new Error('未创建 QQ 登录任务')
    if (flowVersion !== qqFlowVersion)
      return
    qqTaskId.value = taskId
    qqQrUrl.value = qrImage
    qqStatus.value = '等待 QQ 扫码'
    qqError.value = ''
    void pollQqLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion === qqFlowVersion) {
      qqError.value = getApiErrorMessage(error, 'QQ 登录二维码获取失败')
      // 优先用后端给的 retryAfterMs（WORKFLOW_BUSY 会带精确剩余时间），没有则用默认冷却。
      const retryMs = getApiRetryAfterMs(error)
      const errorCode = String(((error as any)?.response?.data?.errorCode) || (error as any)?.code || '').toUpperCase()
      // NapCat 没装或连不上时，任何错误码都不要再进自动重试；
      // 否则倒计时一到就再次失败，页面会堆满「取码失败 / 冷却中 / 请等待 N 秒」。
      const napcatFailure = errorCode.startsWith('NAPCAT_') || /NapCat/i.test(qqError.value)
      if (napcatFailure) {
        qqAutoRefreshAfterInit = false
        stopQqCooldown()
        qqQrUnavailable.value = true
        qqStatus.value = qqCaptureEnabled.value
          ? 'QQ 扫码内核不可用，请改用「QQ抓包」登录'
          : 'QQ 扫码内核不可用，请检查 NapCat 是否已安装'
      }
      else {
        startQqCooldown(retryMs > 0 ? Math.ceil(retryMs / 1000) : QQ_COOLDOWN_SECONDS)
        qqStatus.value = '取码失败'
      }
    }
  }
  finally {
    if (flowVersion === qqFlowVersion)
      qqLoading.value = false
  }
}

/**
 * 手动初始化扫码能力。
 *
 * 扫几轮之后 NapCat 内核会卡死（QRCode Get Error / 工作流锁释放不掉），以前只能上服务器
 * 重启服务。现在把这件事做成按钮：上游先清任务/工作流/凭证并重刷二维码（秒级），
 * 内核确实坏了才重启 NapCat（异步，约 20s），这里按返回结果决定是立刻取码还是等倒计时。
 */
async function initQqLoginCore() {
  if (qqInitLoading.value)
    return
  qqInitLoading.value = true
  qqError.value = ''
  qqStatus.value = '正在初始化扫码内核…'
  try {
    const response = await api.post('/api/qq-login/reinit', undefined, { timeout: 60000 } as any)
    const payload = ensureQqApiOk(response, '初始化扫码内核失败')
    const data = payload?.data || {}
    if (data.restarting === true) {
      const seconds = Math.max(10, Math.ceil(Number(data.retryAfterMs || 20000) / 1000))
      qqStatus.value = String(data.message || `扫码内核正在重启，${seconds} 秒后自动重试`)
      // 后端是异步重启，倒计时结束后自动取码；超时没起来也只是再显示一次失败 + 冷却。
      qqAutoRefreshAfterInit = true
      startQqCooldown(seconds)
    }
    else {
      // 内核能响应：要么已就绪，要么只是宿主 QQ 掉登录（waiting_qrcode）。
      // 后者不需要重启，直接把宿主登录二维码取出来展示，扫一下就恢复。
      qqStatus.value = data.coreReady === true
        ? '扫码内核已就绪，正在获取二维码…'
        : '扫码内核未登录，正在获取登录二维码…'
      qqAutoRefreshAfterInit = false
      stopQqCooldown()
      void startQqLogin()
    }
  }
  catch (error: any) {
    const retryMs = getApiRetryAfterMs(error)
    qqError.value = getApiErrorMessage(error, '初始化扫码内核失败')
    startQqCooldown(retryMs > 0 ? Math.ceil(retryMs / 1000) : QQ_COOLDOWN_SECONDS)
    qqStatus.value = '初始化失败'
  }
  finally {
    qqInitLoading.value = false
  }
}

function close() {
  qqAutoRefreshAfterInit = false
  resetWxLogin()
  resetQqLogin()
  stopQqCooldown()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    activeLoginTab.value = 'code'
    resetWxLogin()
    void loadLoginSettings()
    if (props.editData) {
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
    }
    else {
      form.name = ''
      form.code = ''
      form.platform = 'qq'
    }
  }
})

watch(activeLoginTab, (tab) => {
  if (tab === 'wx_qr' && wechatQrLoginEnabled.value && !wxTaskId.value)
    void startWxLogin()
  else if (tab === 'wx_qr' && !wechatQrLoginEnabled.value)
    activeLoginTab.value = 'code'
  else if (tab === 'qq_qr' && qqQrLoginEnabled.value && !qqTaskId.value)
    void startQqLogin()
  else if (tab === 'qq_qr' && !qqQrLoginEnabled.value)
    activeLoginTab.value = 'code'
  else if (tab === 'qq_capture' && !qqCaptureEnabled.value)
    activeLoginTab.value = 'code'
  if (tab !== 'wx_qr')
    resetWxLogin()
  if (tab !== 'qq_qr')
    resetQqLogin()
})

watch(() => form.name, (name) => {
  clearQrNameSubmitTimer()
  if (!name.trim())
    return
  const platform = activeLoginTab.value === 'wx_qr'
    ? 'wx'
    : activeLoginTab.value === 'qq_qr' ? 'qq' : undefined
  if (!platform || !(platform === 'wx' ? wxPendingCode : qqPendingCode))
    return
  qrNameSubmitTimer = setTimeout(() => void submitPendingQrAccount(platform), 800)
})

onBeforeUnmount(() => {
  resetWxLogin()
  resetQqLogin()
  stopQqCooldown()
})
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading && !wxLoading && !qqLoading"
    :close-on-esc="!loading && !wxLoading && !qqLoading"
    @update:show="value => !value && close()"
  >
    <NCard
      class="account-modal-card"
      :title="editData ? '编辑账号' : '添加账号'"
      :bordered="false"
      :closable="!loading && !wxLoading && !qqLoading"
      @close="close"
    >
      <div class="account-modal-content dialog-scroll overflow-y-auto">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <NTabs v-if="loginSettingsLoaded" v-model:value="activeLoginTab" class="login-tabs mb-4" type="line">
          <NTab name="code">
            Code
          </NTab>
          <NTab v-if="wechatQrLoginEnabled" name="wx_qr">
            微信扫码
          </NTab>
          <NTab v-if="qqQrLoginEnabled" name="qq_qr">
            QQ扫码
          </NTab>
          <NTab v-if="qqCaptureEnabled" name="qq_capture">
            QQ抓包
          </NTab>
        </NTabs>

        <div v-if="activeLoginTab === 'code'" class="space-y-4">
          <BaseInput
            v-if="!editData"
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
            class="farm-input"
          />

          <NRadioGroup v-if="!editData" v-model:value="form.platform" name="account-platform">
            <div class="flex gap-5">
              <NRadio value="qq">
                QQ 小程序
              </NRadio>
              <NRadio value="wx">
                微信小程序
              </NRadio>
            </div>
          </NRadioGroup>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'wx_qr'" class="space-y-4" role="tabpanel" aria-label="微信扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            placeholder="留空时使用微信昵称"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="wxQrUrl" class="bg-white p-2">
              <img :src="wxQrUrl" alt="微信登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ wxLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxStatus }}
            </p>
            <p v-if="wxError" class="text-sm text-red-500">
              {{ wxError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="startWxLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'qq_qr'" class="space-y-4" role="tabpanel" aria-label="QQ扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            placeholder="留空时使用 QQ 昵称"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="qqQrUrl" class="bg-white p-2">
              <img :src="qqQrUrl" alt="QQ登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex flex-col items-center justify-center gap-1 text-sm opacity-60">
              <span class="i-carbon-qr-code text-3xl" />
              <span>{{ qqLoading ? '正在获取二维码...' : (qqQrUnavailable ? 'QQ 扫码不可用' : '二维码不可用') }}</span>
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ qqStatus }}
            </p>
            <p v-if="qqCooldownLeft > 0" class="text-sm text-amber-600">
              <span class="i-carbon-time mr-1 inline-block align-middle" />
              冷却中，{{ qqCooldownLeft }} 秒后可重新获取二维码
            </p>
            <p v-if="qqError" class="text-sm text-red-500">
              {{ qqError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton v-if="qqQrUnavailable && qqCaptureEnabled" variant="primary" @click="activeLoginTab = 'qq_capture'">
              改用 QQ抓包
            </BaseButton>
            <BaseButton v-if="!qqQrUnavailable" variant="outline" :loading="qqInitLoading" :disabled="qqInitLoading || qqLoading" @click="initQqLoginCore">
              {{ qqInitLoading ? '初始化中…' : '初始化扫码' }}
            </BaseButton>
            <BaseButton v-if="!qqQrUnavailable" variant="outline" :loading="qqLoading" :disabled="qqCooldownLeft > 0 || qqInitLoading" @click="startQqLogin">
              {{ qqCooldownLeft > 0 ? `刷新二维码 (${qqCooldownLeft}s)` : '刷新二维码' }}
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'qq_capture'" class="space-y-4" role="tabpanel" aria-label="QQ自动抓包登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            placeholder="留空时使用抓包到的昵称"
            class="farm-input"
          />
          <QqCapturePanel @captured="handleCaptureImported" />
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.account-modal-card {
  width: min(448px, calc(100vw - 32px));
}

.account-modal-content {
  max-height: calc(90vh - 100px);
}

/* 四个登录页签挤在 448px 弹窗里，缩短标签并收紧内边距，避免横向溢出。 */
.login-tabs :deep(.n-tabs-tab) {
  padding: 0 8px;
}

.login-tabs :deep(.n-tabs-tab__label) {
  font-size: 12px;
}
</style>
