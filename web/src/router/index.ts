import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { useAppUpdateStore } from '@/stores/app-update'
import { allMenuRoutes } from './menu'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

type TokenCheckResult = 'valid' | 'unauthorized' | 'unavailable'

const adminToken = useStorage('admin_token', '')
const userInfoRef = useStorage<any>('user_info', null)
let validatedToken = ''
let validatingPromise: Promise<TokenCheckResult> | null = null

function currentRole(): string {
  const info = userInfoRef.value
  if (!info || typeof info !== 'object')
    return ''
  return String(info.role || '')
}

async function ensureTokenValid(): Promise<TokenCheckResult> {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return 'unauthorized'

  if (validatedToken && validatedToken === token)
    return 'valid'

  if (validatingPromise)
    return validatingPromise

  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res): TokenCheckResult => {
    const ok = !!(res.data && res.data.ok)
    if (ok) {
      validatedToken = token
      useAppUpdateStore().notifyBackendReachable()
      const payload = res.data.data || {}
      const existing = userInfoRef.value && typeof userInfoRef.value === 'object' ? userInfoRef.value : {}
      userInfoRef.value = {
        ...existing,
        username: payload.username || existing.username || '',
        role: payload.role === 'admin' ? 'admin' : 'user',
        expiresAt: Number(payload.expiresAt || 0),
      }
      return 'valid'
    }
    return 'unauthorized'
  }).catch((err: any): TokenCheckResult => {
    const status = Number(err?.response?.status || 0)
    if (status === 401 || status === 403)
      return 'unauthorized'
    useAppUpdateStore().notifyBackendUnavailable()
    return 'unavailable'
  }).finally(() => {
    validatingPromise = null
  })

  return validatingPromise
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: [
        ...allMenuRoutes.map(route => ({
          path: route.path,
          name: route.name,
          component: route.component,
          meta: route.meta,
        })),
        {
          path: 'admin/cardkeys',
          name: 'admin-cardkeys',
          component: () => import('@/views/AdminCardKeys.vue'),
          meta: { adminOnly: true },
        },
      ],
    },
    {
      path: '/mystery-shop',
      name: 'mystery-shop',
      redirect: to => ({ name: 'game-mall', query: { ...to.query, tab: 'mystery' }, hash: to.hash }),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
  ],
})

router.beforeEach(async (to, _from) => {
  NProgress.start()

  if (to.name === 'login') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const result = await ensureTokenValid()
    if (result === 'valid')
      return { name: 'dashboard' }
    if (result === 'unauthorized') {
      adminToken.value = ''
      validatedToken = ''
    }
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    return { name: 'login' }
  }

  const result = await ensureTokenValid()
  if (result === 'unauthorized') {
    adminToken.value = ''
    validatedToken = ''
    return { name: 'login' }
  }

  if (to.meta.adminOnly && currentRole() !== 'admin')
    return { name: 'dashboard' }

  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
