import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export type UserRole = 'admin' | 'user'

export interface UserInfo {
  id?: string
  username: string
  role: UserRole
  avatar?: string
  mustChangePassword?: boolean
  expiresAt?: number
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: string
  remainingMs?: number
  data?: {
    token: string
    role: UserRole
    user: { username: string, id?: string }
    expiresAt?: number
    mustChangePassword?: boolean
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<UserInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')
  const role = computed<UserRole>(() => userInfo.value?.role || 'user')
  const isAdmin = computed(() => role.value === 'admin')
  const expiresAt = computed(() => Number(userInfo.value?.expiresAt || 0))
  const expiresText = computed(() => {
    const value = expiresAt.value
    if (!value)
      return role.value === 'admin' ? '永久' : '未设置'
    const date = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  })

  function applyAuth(data: any) {
    token.value = String(data.token || '')
    userInfo.value = {
      id: data.user?.id,
      username: data.user?.username || '',
      role: data.role === 'admin' ? 'admin' : 'user',
      mustChangePassword: data.mustChangePassword === true,
      expiresAt: Number(data.expiresAt || data.user?.expiresAt || 0),
    }
  }

  async function login(usernameInput: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username: usernameInput, password })
      if (res.data.ok) {
        applyAuth(res.data.data)
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function register(cardKey: string, usernameInput: string, password: string) {
    try {
      const res = await api.post('/api/register', { cardKey, username: usernameInput, password })
      if (res.data.ok) {
        applyAuth(res.data.data)
      }
      return { ok: !!res.data.ok, error: res.data.error as string | undefined, data: res.data.data }
    }
    catch (error: any) {
      const data = error.response?.data
      return { ok: false, error: getApiErrorMessage(data || error, '开通失败') }
    }
  }

  async function redeem(cardKey: string) {
    try {
      const res = await api.post('/api/cardkeys/redeem', { cardKey })
      if (res.data.ok && res.data.data?.user) {
        userInfo.value = {
          ...(userInfo.value || { username: '', role: 'user' }),
          expiresAt: Number(res.data.data.user.expiresAt || 0),
        }
      }
      return { ok: !!res.data.ok, error: res.data.error as string | undefined, data: res.data.data }
    }
    catch (error: any) {
      const data = error.response?.data
      return { ok: false, error: getApiErrorMessage(data || error, '续费失败') }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok) {
        userInfo.value = {
          ...res.data.data,
          role: res.data.data.role === 'admin' ? 'admin' : 'user',
          expiresAt: Number(res.data.data.expiresAt || 0),
        }
      }
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    if (res.data?.ok && res.data?.token)
      token.value = String(res.data.token)
    return res.data
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    role,
    isAdmin,
    expiresAt,
    expiresText,
    applyAuth,
    login,
    register,
    redeem,
    logout,
    fetchUserInfo,
    changePassword,
  }
})
