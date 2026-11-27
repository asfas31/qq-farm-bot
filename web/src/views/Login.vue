<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BrandMark from '@/components/ui/BrandMark.vue'
import { useUserStore } from '@/stores/user'

declare const __APP_VERSION__: string

const userStore = useUserStore()
const appVersion = __APP_VERSION__
const gameVersion = ref('')
const wxGameVersion = ref('')
const mode = ref<'login' | 'register'>('login')

const username = ref('')
const password = ref('')
const error = ref('')
const success = ref('')
const loading = ref(false)
const lockoutRemaining = ref(0)
const rateLimitRemaining = ref(0)

const cardKey = ref('')
const regUsername = ref('')
const regPassword = ref('')
const regPassword2 = ref('')
const regError = ref('')
const regSuccess = ref('')
const regLoading = ref(false)

const freeClaimEnabled = ref(false)
const freeClaimDays = ref(1)
const freeClaimCooldown = ref(24)
const claimDifficulty = ref(3)
const freeClaimLoading = ref(false)
const claimMessage = ref('')
const claimFp = ref('')

function getClaimFp(): string {
  if (claimFp.value)
    return claimFp.value
  let fp = ''
  try { fp = localStorage.getItem('fc_fp') || '' } catch { fp = '' }
  if (!fp) {
    const random = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
    fp = random
    try { localStorage.setItem('fc_fp', fp) } catch { /* 隐私模式下忽略 */ }
  }
  claimFp.value = fp
  return fp
}

/** 与服务端一致的 FNV-1a 32 位，避免依赖需要 HTTPS 的 crypto.subtle。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function solvePow(challenge: string, difficulty: number): number {
  const prefix = '0'.repeat(Math.max(0, difficulty))
  if (!prefix)
    return 0
  for (let nonce = 0; nonce < 500000; nonce++) {
    if (fnv1a(`${challenge}:${nonce}`).startsWith(prefix))
      return nonce
  }
  return -1
}

const usernameValid = computed(() => {
  const name = username.value
  if (!name)
    return { valid: false, message: '' }
  if (name.length < 3)
    return { valid: false, message: '用户名至少3位' }
  if (name.length > 32)
    return { valid: false, message: '用户名最多32位' }
  if (!/^\w+$/.test(name))
    return { valid: false, message: '只能包含字母、数字、下划线' }
  return { valid: true, message: '' }
})

const regUsernameValid = computed(() => {
  const name = regUsername.value
  if (!name)
    return { valid: false, message: '' }
  if (name.length < 3)
    return { valid: false, message: '用户名至少3位' }
  if (name.length > 32)
    return { valid: false, message: '用户名最多32位' }
  if (!/^\w+$/.test(name))
    return { valid: false, message: '只能包含字母、数字、下划线' }
  return { valid: true, message: '' }
})

function switchMode(next: 'login' | 'register') {
  mode.value = next
  error.value = ''
  success.value = ''
  regError.value = ''
  regSuccess.value = ''
  claimMessage.value = ''
}

function validateForm(): boolean {
  if (!username.value) {
    error.value = '请输入用户名'
    return false
  }
  if (!usernameValid.value.valid) {
    error.value = usernameValid.value.message
    return false
  }
  if (!password.value) {
    error.value = '请输入密码'
    return false
  }
  return true
}

async function handleSubmit() {
  if (!validateForm())
    return

  loading.value = true
  error.value = ''
  success.value = ''

  try {
    const result = await userStore.login(username.value, password.value)
    if (result.ok) {
      if (result.data?.mustChangePassword)
        success.value = '登录成功，请修改默认密码'
      setTimeout(() => {
        window.location.href = '/'
      }, 400)
    }
    else if (result.errorType === 'rate_limit') {
      error.value = result.error || '请求过于频繁，请稍后重试'
      if (result.remainingMs)
        rateLimitRemaining.value = Math.ceil(result.remainingMs / 1000)
    }
    else if (result.errorType === 'locked') {
      error.value = result.error || '账户已被锁定'
      if (result.remainingMs)
        lockoutRemaining.value = Math.ceil(result.remainingMs / 1000 / 60)
    }
    else {
      error.value = result.error || '登录失败'
    }
  }
  catch (e: any) {
    const data = e.response?.data
    if (data?.errorType === 'rate_limit') {
      error.value = getApiErrorMessage(data, '请求过于频繁')
      if (data.remainingMs)
        rateLimitRemaining.value = Math.ceil(data.remainingMs / 1000)
    }
    else if (data?.errorType === 'locked') {
      error.value = getApiErrorMessage(data, '账户已被锁定')
      if (data.remainingMs)
        lockoutRemaining.value = Math.ceil(data.remainingMs / 1000 / 60)
    }
    else {
      error.value = getApiErrorMessage(e, '操作异常')
    }
  }
  finally {
    loading.value = false
  }
}

function validateRegister(): boolean {
  if (!cardKey.value.trim()) {
    regError.value = '请输入卡密'
    return false
  }
  if (!regUsernameValid.value.valid) {
    regError.value = regUsernameValid.value.message || '请输入用户名'
    return false
  }
  if (regPassword.value.length < 6) {
    regError.value = '密码长度至少 6 位'
    return false
  }
  if (!/[A-Za-z]/.test(regPassword.value) || !/\d/.test(regPassword.value)) {
    regError.value = '密码需同时包含字母和数字'
    return false
  }
  if (regPassword.value !== regPassword2.value) {
    regError.value = '两次输入的密码不一致'
    return false
  }
  return true
}

async function handleRegister() {
  if (!validateRegister())
    return
  regLoading.value = true
  regError.value = ''
  regSuccess.value = ''
  try {
    const result = await userStore.register(cardKey.value.trim(), regUsername.value.trim(), regPassword.value)
    if (result.ok) {
      regSuccess.value = '开通成功，正在进入面板...'
      setTimeout(() => {
        window.location.href = '/'
      }, 500)
    }
    else {
      regError.value = result.error || '开通失败'
    }
  }
  finally {
    regLoading.value = false
  }
}

async function loadFreeClaimConfig() {
  try {
    getClaimFp()
    const res = await api.get('/api/free-claim/config', { skipErrorToast: true } as any)
    if (res.data?.ok) {
      freeClaimEnabled.value = !!res.data.data.enabled
      freeClaimDays.value = Number(res.data.data.days) || 1
      freeClaimCooldown.value = Number(res.data.data.cooldownHours) || 24
      claimDifficulty.value = Number(res.data.data.powDifficulty) || 0
    }
  }
  catch {
    freeClaimEnabled.value = false
  }
}

async function claimFreeKey(retry = true) {
  freeClaimLoading.value = true
  claimMessage.value = ''
  try {
    const fp = getClaimFp()
    const challengeRes = await api.get('/api/free-claim/challenge', {
      params: { fp },
      skipErrorToast: true,
    } as any)
    const challenge = challengeRes.data?.data
    if (!challengeRes.data?.ok || !challenge?.challenge) {
      claimMessage.value = challengeRes.data?.error || '获取验证失败，请重试'
      return
    }
    const nonce = solvePow(String(challenge.challenge), Number(challenge.difficulty) || 0)
    if (nonce < 0) {
      claimMessage.value = '验证计算失败，请重试'
      return
    }
    const res = await api.post('/api/free-claim', {
      fp,
      challenge: { id: challenge.id, text: challenge.challenge },
      nonce,
    }, { skipErrorToast: true } as any)
    if (res.data?.ok) {
      cardKey.value = res.data.data.code
      claimMessage.value = `已领取 ${res.data.data.days} 天卡密，已填入输入框，直接填写用户名密码即可开通`
      regError.value = ''
    }
    else if (res.data?.errorType === 'NEED_FP' && retry) {
      // 首次访问 Cookie 由响应 Set-Cookie 写入，带新 Cookie 重试一次。
      await claimFreeKey(false)
    }
    else {
      claimMessage.value = res.data?.error || '领取失败，请稍后重试'
    }
  }
  catch (e: any) {
    claimMessage.value = getApiErrorMessage(e.response?.data || e, '领取失败，请稍后重试')
  }
  finally {
    freeClaimLoading.value = false
  }
}

async function fetchGameVersion() {
  try {
    const res = await api.get('/api/game-version')
    if (res.data.ok)
      gameVersion.value = res.data.clientVersion
    wxGameVersion.value = res.data.wxClientVersion || ''
  }
  catch (e) {
    console.error('获取游戏版本失败:', e)
  }
}

onMounted(() => {
  fetchGameVersion()
  loadFreeClaimConfig()
})
</script>

<template>
  <main class="login-container">
    <section class="login-card">
      <header class="logo-area">
        <BrandMark class="logo-icon" :size="58" />
        <div>
          <span class="logo-kicker">QQ FARM</span>
          <h1 class="logo-title">
            QQ农场智能助手
          </h1>
          <p class="logo-subtitle">
            {{ mode === 'login' ? '账号登录' : '卡密开通新账号' }}
          </p>
        </div>
      </header>

      <div class="mode-switch" role="tablist">
        <button
          type="button"
          class="mode-tab"
          :class="{ active: mode === 'login' }"
          role="tab"
          :aria-selected="mode === 'login'"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="mode-tab"
          :class="{ active: mode === 'register' }"
          role="tab"
          :aria-selected="mode === 'register'"
          @click="switchMode('register')"
        >
          卡密开通
        </button>
      </div>

      <form v-if="mode === 'login'" class="form-area" @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label" for="username">
            <span class="i-carbon-user" />
            用户名
          </label>
          <BaseInput
            id="username"
            v-model="username"
            type="text"
            placeholder="请输入用户名"
            autocomplete="username"
            required
          />
          <p v-if="username && !usernameValid.valid" class="form-hint error">
            {{ usernameValid.message }}
          </p>
        </div>

        <div class="form-group">
          <label class="form-label" for="password">
            <span class="i-carbon-locked" />
            密码
          </label>
          <BaseInput
            id="password"
            v-model="password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            required
          />
        </div>

        <div v-if="error" class="message error-message" role="alert">
          <span class="i-carbon-warning-alt" />
          <div>
            {{ error }}
            <span v-if="lockoutRemaining > 0">（{{ lockoutRemaining }} 分钟后解锁）</span>
            <span v-if="rateLimitRemaining > 0">（{{ rateLimitRemaining }} 秒后可重试）</span>
          </div>
        </div>
        <div v-if="success" class="message success-message" role="status">
          <span class="i-carbon-checkmark-filled" />
          {{ success }}
        </div>

        <BaseButton type="submit" variant="primary" block :loading="loading" class="submit-btn">
          <span v-if="!loading" class="inline-flex items-center gap-2">
            <span class="i-carbon-login" />
            登录
          </span>
        </BaseButton>

        <p class="mode-hint">
          还没有账号？<button type="button" class="link-btn" @click="switchMode('register')">用卡密开通</button>
        </p>
      </form>

      <form v-else class="form-area" @submit.prevent="handleRegister">
        <div class="form-group">
          <label class="form-label" for="cardKey">
            <span class="i-carbon-key" />
            卡密
          </label>
          <BaseInput
            id="cardKey"
            v-model="cardKey"
            type="text"
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autocomplete="off"
            required
          />
          <div v-if="freeClaimEnabled" class="claim-row">
            <button
              type="button"
              class="claim-btn"
              :disabled="freeClaimLoading"
              @click="() => claimFreeKey()"
            >
              <span class="i-carbon-gift" />
              {{ freeClaimLoading ? '领取中...' : '免费领取卡密' }}
            </button>
            <span class="claim-hint">免费 {{ freeClaimDays }} 天 · {{ freeClaimCooldown }} 小时可领一次</span>
          </div>
          <p v-if="claimMessage" class="form-hint" :class="claimMessage.startsWith('已领取') ? 'success-text' : 'error'">
            {{ claimMessage }}
          </p>
        </div>

        <div class="form-group">
          <label class="form-label" for="regUsername">
            <span class="i-carbon-user" />
            用户名
          </label>
          <BaseInput
            id="regUsername"
            v-model="regUsername"
            type="text"
            placeholder="3-32 位字母、数字或下划线"
            autocomplete="username"
            required
          />
          <p v-if="regUsername && !regUsernameValid.valid" class="form-hint error">
            {{ regUsernameValid.message }}
          </p>
        </div>

        <div class="form-group">
          <label class="form-label" for="regPassword">
            <span class="i-carbon-locked" />
            密码
          </label>
          <BaseInput
            id="regPassword"
            v-model="regPassword"
            type="password"
            placeholder="至少 6 位，包含字母和数字"
            autocomplete="new-password"
            required
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="regPassword2">
            <span class="i-carbon-checkmark-outline" />
            确认密码
          </label>
          <BaseInput
            id="regPassword2"
            v-model="regPassword2"
            type="password"
            placeholder="再次输入密码"
            autocomplete="new-password"
            required
          />
        </div>

        <div v-if="regError" class="message error-message" role="alert">
          <span class="i-carbon-warning-alt" />
          <div>{{ regError }}</div>
        </div>
        <div v-if="regSuccess" class="message success-message" role="status">
          <span class="i-carbon-checkmark-filled" />
          {{ regSuccess }}
        </div>

        <BaseButton type="submit" variant="primary" block :loading="regLoading" class="submit-btn">
          <span v-if="!regLoading" class="inline-flex items-center gap-2">
            <span class="i-carbon-key" />
            开通账号
          </span>
        </BaseButton>

        <p class="mode-hint">
          有效期由卡密天数决定，已有账号？<button type="button" class="link-btn" @click="switchMode('login')">直接登录</button>
        </p>
      </form>

      <footer class="card-footer">
        <div class="footer-info">
          <span>Web v{{ appVersion }}</span>
          <span v-if="gameVersion">QQ {{ gameVersion }}</span>
          <span v-if="wxGameVersion">微信 {{ wxGameVersion }}</span>
        </div>
        <a href="https://github.com/asfas31/qq-farm-bot" target="_blank" rel="noopener noreferrer" class="github-link" aria-label="GitHub">
          <span class="i-carbon-logo-github" />
        </a>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.login-container {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 100dvh;
  place-items: center;
  overflow: hidden;
  padding: 28px 18px;
  color: var(--ui-ink);
  background-color: var(--ui-bg);
  background-image:
    linear-gradient(rgba(67, 141, 99, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(67, 141, 99, 0.045) 1px, transparent 1px);
  background-size: 42px 42px;
}

.login-container::before {
  position: absolute;
  inset: 8% 7%;
  border: 1px solid rgba(67, 141, 99, 0.08);
  border-radius: 36px;
  background: color-mix(in srgb, var(--ui-surface-strong) 22%, transparent);
  content: '';
}

.login-card {
  position: relative;
  z-index: 1;
  width: min(430px, 100%);
  padding: 30px;
  border: 1px solid var(--ui-border);
  border-radius: 18px;
  background: color-mix(in srgb, var(--ui-bg) 82%, transparent);
  box-shadow:
    0 28px 76px rgba(55, 75, 61, 0.16),
    inset 0 1px 0 var(--glass-highlight);
  -webkit-backdrop-filter: blur(24px) saturate(135%);
  backdrop-filter: blur(24px) saturate(135%);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--ui-border);
}

.logo-icon {
  flex: none;
  filter: drop-shadow(0 8px 18px rgba(45, 122, 83, 0.24));
}

.logo-kicker {
  color: var(--ui-primary);
  font-size: 10px;
  font-weight: var(--fw-700);
}

.logo-title {
  margin: 2px 0 0;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}

.logo-subtitle {
  margin: 5px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 18px;
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-surface-strong) 55%, transparent);
}

.mode-tab {
  height: 34px;
  border: none;
  border-radius: 8px;
  color: var(--ui-muted);
  font-size: 13px;
  font-weight: var(--fw-600);
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.mode-tab:hover {
  color: var(--ui-ink);
}

.mode-tab.active {
  color: #fff;
  background: var(--ui-primary);
  box-shadow: 0 4px 12px rgba(67, 141, 99, 0.24);
}

.form-area {
  display: flex;
  flex-direction: column;
  gap: 17px;
  padding-top: 20px;
}

.form-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}

.form-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.form-label > span {
  color: var(--ui-primary);
}

.login-card :deep(.base-input) {
  height: 42px;
  border-color: var(--ui-border);
  border-radius: 10px;
  color: var(--ui-ink);
  background: color-mix(in srgb, var(--ui-surface-strong) 70%, transparent);
}

.login-card :deep(.base-input:focus) {
  border-color: rgba(67, 141, 99, 0.55);
  box-shadow: 0 0 0 3px rgba(67, 141, 99, 0.1);
}

.claim-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.claim-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid rgba(67, 141, 99, 0.4);
  border-radius: 8px;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
  background: var(--ui-primary-soft);
  cursor: pointer;
}

.claim-btn:hover:not(:disabled) {
  border-color: var(--ui-primary);
}

.claim-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.claim-hint {
  color: var(--ui-subtle);
  font-size: 11px;
}

.success-text {
  color: var(--ui-primary);
}

.form-hint {
  margin: 0;
  color: var(--ui-danger);
  font-size: 11px;
}

.message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.error-message {
  border-color: rgba(201, 95, 102, 0.18);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}

.success-message {
  border-color: rgba(67, 141, 99, 0.18);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.submit-btn {
  margin-top: 2px;
}

.mode-hint {
  margin: 0;
  color: var(--ui-muted);
  font-size: 12px;
  text-align: center;
}

.link-btn {
  padding: 0;
  border: none;
  color: var(--ui-primary);
  font-size: 12px;
  font-weight: var(--fw-600);
  background: none;
  cursor: pointer;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 22px;
  padding-top: 17px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-subtle);
  font-size: 10px;
}

.footer-info {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.github-link {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: var(--ui-muted);
  text-decoration: none;
}

.github-link:hover {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

@media (max-width: 480px) {
  .login-container {
    align-items: center;
    padding: 16px 12px;
  }

  .login-container::before {
    inset: 4%;
    border-radius: 24px;
  }

  .login-card {
    padding: 24px 20px;
    border-radius: 16px;
  }

  .logo-icon {
    width: 52px;
    height: 52px;
  }

  .logo-title {
    font-size: 19px;
  }
}
</style>
