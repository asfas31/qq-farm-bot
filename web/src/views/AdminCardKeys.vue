<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'

interface CardKeyItem {
  id: string
  code: string
  days: number
  maxUses: number
  uses: number
  remaining: number
  note: string
  status: 'active' | 'used' | 'disabled' | 'expired'
  createdAt: number
  expiresAt: number
  usedBy: { userId: string, username: string, at: number }[]
}

interface UserItem {
  id: string
  username: string
  role: 'user'
  createdAt: number
  expiresAt: number
  enabled: boolean
  accountCount: number
  cardKeyId?: string
  note?: string
  lastLoginAt?: number
}

const toast = useToastStore()

const overview = ref({ cardkeys: { total: 0, active: 0, used: 0, disabled: 0, expired: 0, registers: 0 }, users: { total: 0, active: 0, expired: 0, disabled: 0 }, freeClaim: { total: 0, today: 0, lastClaimAt: 0, poolAvailable: 0 } })
const keys = ref<CardKeyItem[]>([])
const users = ref<UserItem[]>([])
const loadingKeys = ref(false)
const loadingUsers = ref(false)

const genDays = ref(30)
const genCount = ref(5)
const genMaxUses = ref(1)
const genNote = ref('')
const generating = ref(false)
const generated = ref<CardKeyItem[]>([])

const keyword = ref('')
const statusFilter = ref('')
const listExpanded = ref(false)
const copiedAll = ref(false)

const newUsername = ref('')
const newPassword = ref('')
const newDays = ref(30)
const creatingUser = ref(false)
const revealedPassword = ref('')

const freeClaim = ref({ enabled: true, days: 1, maxUses: 1, cooldownHours: 24, dailyLimit: 50, powDifficulty: 3, note: '免费领取', updatedAt: 0 })
const freeClaimSaving = ref(false)
const claimRecords = ref<{ ip: string, at: number, code: string, days: number, identity?: string }[]>([])
const showClaimRecords = ref(false)

const statusText: Record<string, string> = {
  active: '可用',
  used: '已用完',
  disabled: '已禁用',
  expired: '已过期',
}

const filteredKeys = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return keys.value.filter((key) => {
    if (statusFilter.value && key.status !== statusFilter.value)
      return false
    if (!kw)
      return true
    return key.code.toLowerCase().includes(kw)
      || String(key.note || '').toLowerCase().includes(kw)
      || key.usedBy.some(item => item.username.toLowerCase().includes(kw))
  })
})

/* ---------------- 批量选择 ---------------- */
const selectedIds = ref<Set<string>>(new Set())
const bulkBusy = ref(false)
const bulkNote = ref('')

const selectedKeys = computed(() => keys.value.filter(key => selectedIds.value.has(key.id)))

const selectedStats = computed(() => {
  let active = 0
  let disabled = 0
  let dead = 0
  let daysTotal = 0
  for (const key of selectedKeys.value) {
    if (key.status === 'active')
      active++
    else if (key.status === 'disabled')
      disabled++
    else
      dead++
    daysTotal += Number(key.days) || 0
  }
  return { active, disabled, dead, daysTotal }
})

const allFilteredSelected = computed(() =>
  filteredKeys.value.length > 0 && filteredKeys.value.every(key => selectedIds.value.has(key.id)),
)
const someFilteredSelected = computed(() =>
  !allFilteredSelected.value && filteredKeys.value.some(key => selectedIds.value.has(key.id)),
)

function isSelected(id: string) {
  return selectedIds.value.has(id)
}

function syncSelection(next: Set<string>) {
  selectedIds.value = next
}

function toggleSelect(key: CardKeyItem) {
  const next = new Set(selectedIds.value)
  if (next.has(key.id))
    next.delete(key.id)
  else
    next.add(key.id)
  syncSelection(next)
}

function toggleSelectAllFiltered() {
  const next = new Set(selectedIds.value)
  if (allFilteredSelected.value) {
    for (const key of filteredKeys.value) next.delete(key.id)
  }
  else {
    for (const key of filteredKeys.value) next.add(key.id)
  }
  syncSelection(next)
}

function invertSelection() {
  const next = new Set(selectedIds.value)
  for (const key of filteredKeys.value) {
    if (next.has(key.id))
      next.delete(key.id)
    else
      next.add(key.id)
  }
  syncSelection(next)
}

function clearSelection() {
  syncSelection(new Set())
}

function pruneSelection(available: CardKeyItem[]) {
  const exist = new Set(available.map(key => key.id))
  const next = new Set([...selectedIds.value].filter(id => exist.has(id)))
  if (next.size !== selectedIds.value.size)
    syncSelection(next)
}

function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([`\uFEFF${text}`], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function csvCell(value: unknown) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`
}

async function copySelected() {
  if (!selectedKeys.value.length)
    return
  const ok = await copyText(selectedKeys.value.map(key => key.code).join('\n'))
  if (ok)
    toast.success(`已复制 ${selectedKeys.value.length} 张卡密`)
  else
    toast.error('复制失败，请手动选择')
}

function exportSelected() {
  const list = selectedKeys.value
  if (!list.length)
    return
  const header = ['卡密', '天数', '可用次数', '已用次数', '状态', '备注', '兑换用户', '创建时间']
  const rows = list.map((key) => {
    const status = key.status === 'expired' ? '已过期' : (statusText[key.status] || key.status)
    return [
      key.code,
      `${key.days}`,
      `${key.maxUses}`,
      `${key.uses}`,
      status,
      key.note || '',
      key.usedBy.map(item => item.username).join('、'),
      formatTime(key.createdAt),
    ]
  })
  const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const name = `cardkeys-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.csv`
  downloadText(name, csv, 'text/csv;charset=utf-8')
  toast.success(`已导出 ${list.length} 张卡密`)
}

async function batchAction(action: 'enable' | 'disable' | 'delete') {
  const ids = [...selectedIds.value]
  if (!ids.length)
    return
  if (action === 'delete') {
    const usedCount = selectedKeys.value.filter(key => key.uses > 0).length
    const tip = usedCount
      ? `删除选中的 ${ids.length} 张卡密？其中 ${usedCount} 张已有兑换记录，删除后无法再查对账。`
      : `删除选中的 ${ids.length} 张卡密？此操作不可撤销。`
    if (!window.confirm(tip))
      return
  }
  bulkBusy.value = true
  try {
    const res = await api.post('/api/admin/cardkeys/batch', { action, ids })
    if (res.data.ok) {
      const data = res.data.data || {}
      const parts: string[] = []
      if (action === 'delete')
        parts.push(`已删除 ${data.affected || 0} 张`)
      else
        parts.push(`${action === 'enable' ? '已启用' : '已禁用'} ${data.affected || 0} 张`)
      if (data.unchanged)
        parts.push(`${data.unchanged} 张状态未变`)
      if (Array.isArray(data.skipped) && data.skipped.length)
        parts.push(`${data.skipped.length} 张跳过（已用完或已过期）`)
      if (Array.isArray(data.missing) && data.missing.length)
        parts.push(`${data.missing.length} 张不存在`)
      toast.success(parts.join('，'))
      clearSelection()
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '批量操作失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '批量操作失败'))
  }
  finally {
    bulkBusy.value = false
  }
}

async function applyBulkNote() {
  const ids = [...selectedIds.value]
  if (!ids.length)
    return
  if (!window.confirm(`把 ${ids.length} 张卡密的备注统一改为「${bulkNote.value || '空'}」？`))
    return
  bulkBusy.value = true
  try {
    const res = await api.post('/api/admin/cardkeys/batch', { action: 'note', ids, note: bulkNote.value })
    if (res.data.ok) {
      toast.success(`已更新 ${res.data.data?.affected || 0} 张卡密的备注`)
      await loadKeys()
    }
    else {
      toast.error(res.data.error || '修改备注失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '修改备注失败'))
  }
  finally {
    bulkBusy.value = false
  }
}

function formatTime(value: number) {
  if (!value)
    return '永久'
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function daysLeft(value: number) {
  if (!value)
    return '永久'
  const diff = value - Date.now()
  if (diff <= 0)
    return '已到期'
  return `${Math.ceil(diff / 86400000)} 天`
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  }
}

async function loadOverview() {
  try {
    const res = await api.get('/api/admin/overview')
    if (res.data.ok)
      overview.value = res.data.data
  }
  catch {}
}

async function loadKeys() {
  loadingKeys.value = true
  try {
    const res = await api.get('/api/admin/cardkeys')
    if (res.data.ok) {
      keys.value = res.data.data
      pruneSelection(keys.value)
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '加载卡密失败'))
  }
  finally {
    loadingKeys.value = false
  }
}

async function loadUsers() {
  loadingUsers.value = true
  try {
    const res = await api.get('/api/admin/users')
    if (res.data.ok)
      users.value = res.data.data
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '加载用户失败'))
  }
  finally {
    loadingUsers.value = false
  }
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadKeys(), loadUsers(), loadFreeClaim()])
}

async function loadFreeClaim() {
  try {
    const res = await api.get('/api/admin/free-claim/config')
    if (res.data.ok)
      freeClaim.value = { ...freeClaim.value, ...res.data.data }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '加载免费领取配置失败'))
  }
}

async function saveFreeClaim() {
  freeClaimSaving.value = true
  try {
    const res = await api.post('/api/admin/free-claim/config', {
      enabled: freeClaim.value.enabled,
      days: Number(freeClaim.value.days) || 1,
      maxUses: Number(freeClaim.value.maxUses) || 1,
      cooldownHours: Number(freeClaim.value.cooldownHours) || 0,
      dailyLimit: Number(freeClaim.value.dailyLimit) || 0,
      powDifficulty: Number(freeClaim.value.powDifficulty) || 0,
      note: freeClaim.value.note,
    })
    if (res.data.ok) {
      freeClaim.value = { ...freeClaim.value, ...res.data.data }
      toast.success(freeClaim.value.enabled ? '免费领取已开启' : '免费领取已关闭')
      await loadOverview()
    }
    else {
      toast.error(res.data.error || '保存失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存失败'))
  }
  finally {
    freeClaimSaving.value = false
  }
}

async function generateFreePool() {
  generating.value = true
  try {
    const res = await api.post('/api/admin/cardkeys', {
      count: 20,
      days: Number(freeClaim.value.days) || 1,
      maxUses: Number(freeClaim.value.maxUses) || 1,
      note: freeClaim.value.note || '免费领取',
    })
    if (res.data.ok) {
      toast.success(`已补充 ${res.data.data.length} 张免费卡池卡密`)
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '补充失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '补充失败'))
  }
  finally {
    generating.value = false
  }
}

async function toggleClaimRecords() {
  if (showClaimRecords.value) {
    showClaimRecords.value = false
    return
  }
  try {
    const res = await api.get('/api/admin/free-claim/claims?limit=50')
    if (res.data.ok)
      claimRecords.value = res.data.data
    showClaimRecords.value = true
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '加载领取记录失败'))
  }
}

async function generateKeys() {
  generating.value = true
  try {
    const res = await api.post('/api/admin/cardkeys', {
      count: Number(genCount.value) || 1,
      days: Number(genDays.value) || 30,
      maxUses: Number(genMaxUses.value) || 1,
      note: genNote.value,
    })
    if (res.data.ok) {
      generated.value = res.data.data
      toast.success(`已生成 ${generated.value.length} 张卡密`)
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '生成失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '生成失败'))
  }
  finally {
    generating.value = false
  }
}

async function copyGenerated() {
  const text = generated.value.map(key => `${key.code}  ${key.days}天`)
  const ok = await copyText(text.join('\n'))
  if (ok) {
    copiedAll.value = true
    toast.success('已复制全部卡密')
    setTimeout(() => { copiedAll.value = false }, 1500)
  }
}

/* ---------------- 卡密详情抽屉 ---------------- */
const detailId = ref('')
const detailNote = ref('')
const detailBusy = ref(false)

const detailKey = computed(() => keys.value.find(key => key.id === detailId.value) || null)
const detailOpen = computed(() => Boolean(detailKey.value))
const detailUsagePercent = computed(() => {
  const key = detailKey.value
  if (!key || !key.maxUses)
    return 0
  return Math.min(100, Math.round((key.uses / key.maxUses) * 100))
})

function openDetail(key: CardKeyItem) {
  detailId.value = key.id
  detailNote.value = key.note || ''
}

const detailIndex = computed(() => filteredKeys.value.findIndex(key => key.id === detailId.value))

// 在当前筛选结果里前后翻页，方便连续核对同批卡密。
function stepDetail(delta: number) {
  const list = filteredKeys.value
  if (list.length < 2 || detailIndex.value < 0)
    return
  const next = list[(detailIndex.value + delta + list.length) % list.length]
  if (next)
    openDetail(next)
}

function closeDetail() {
  detailId.value = ''
  detailNote.value = ''
}

function toggleDetailStatus() {
  const key = detailKey.value
  if (key)
    void toggleKey(key)
}

function removeDetailKey() {
  const key = detailKey.value
  if (key)
    void removeKey(key)
}

async function copyDetailCode() {
  const key = detailKey.value
  if (!key)
    return
  const ok = await copyText(key.code)
  if (ok)
    toast.success('已复制卡密')
  else
    toast.error('复制失败，请手动选择')
}

async function copyDetailUsers() {
  const key = detailKey.value
  if (!key || !key.usedBy.length)
    return
  const ok = await copyText(key.usedBy.map(item => item.username).join('\n'))
  if (ok)
    toast.success(`已复制 ${key.usedBy.length} 个兑换用户`)
  else
    toast.error('复制失败，请手动选择')
}

async function saveDetailNote() {
  const key = detailKey.value
  if (!key)
    return
  detailBusy.value = true
  try {
    const res = await api.post('/api/admin/cardkeys/batch', { action: 'note', ids: [key.id], note: detailNote.value })
    if (res.data.ok) {
      toast.success('备注已保存')
      await loadKeys()
    }
    else {
      toast.error(res.data.error || '保存备注失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '保存备注失败'))
  }
  finally {
    detailBusy.value = false
  }
}

// 抽屉打开时锁定背景滚动，并支持 Esc 关闭。
watch(detailOpen, (open) => {
  if (typeof document === 'undefined')
    return
  document.body.style.overflow = open ? 'hidden' : ''
})

// 卡密被删除或刷新后不存在时，自动收起抽屉，避免展示空数据。
watch(detailKey, (key) => {
  if (!key && detailId.value)
    detailId.value = ''
})

function handleDetailKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && detailId.value && !detailBusy.value)
    closeDetail()
}

async function toggleKey(key: CardKeyItem) {
  const next = key.status === 'disabled' ? 'active' : 'disabled'
  try {
    const res = await api.post(`/api/admin/cardkeys/${key.id}/status`, { status: next })
    if (res.data.ok) {
      await loadKeys()
      await loadOverview()
    }
    else {
      toast.error(res.data.error || '操作失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '操作失败'))
  }
}

async function removeKey(key: CardKeyItem) {
  if (!window.confirm(`删除卡密 ${key.code}？此操作不可撤销。`))
    return
  try {
    const res = await api.delete(`/api/admin/cardkeys/${key.id}`)
    if (res.data.ok) {
      if (detailId.value === key.id)
        closeDetail()
      toast.success('已删除')
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '删除失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '删除失败'))
  }
}

async function extendUser(user: UserItem, days: number) {
  try {
    const res = await api.post(`/api/admin/users/${user.id}/extend`, { days })
    if (res.data.ok) {
      toast.success(`${user.username} 已续期 ${days} 天`)
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '续期失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '续期失败'))
  }
}

async function toggleUser(user: UserItem) {
  try {
    const res = await api.post(`/api/admin/users/${user.id}/status`, { enabled: !user.enabled })
    if (res.data.ok) {
      toast.success(user.enabled ? '已禁用' : '已启用')
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '操作失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '操作失败'))
  }
}

async function resetPassword(user: UserItem) {
  if (!window.confirm(`重置 ${user.username} 的密码？旧密码将立即失效。`))
    return
  try {
    const res = await api.post(`/api/admin/users/${user.id}/reset-password`, {})
    if (res.data.ok) {
      revealedPassword.value = `${user.username} 的新密码：${res.data.data.password}`
      await copyText(res.data.data.password)
      toast.success('已重置并复制新密码')
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '重置失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '重置失败'))
  }
}

async function removeUser(user: UserItem) {
  if (!window.confirm(`删除用户 ${user.username}？其名下 ${user.accountCount} 个账号会保留，但不再归属该用户。`))
    return
  try {
    const res = await api.delete(`/api/admin/users/${user.id}`)
    if (res.data.ok) {
      toast.success('已删除用户')
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '删除失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '删除失败'))
  }
}

async function createUser() {
  if (!newUsername.value.trim()) {
    toast.error('请输入用户名')
    return
  }
  if (newPassword.value.length < 6) {
    toast.error('密码至少 6 位，且包含字母和数字')
    return
  }
  creatingUser.value = true
  try {
    const res = await api.post('/api/admin/users', {
      username: newUsername.value.trim(),
      password: newPassword.value,
      days: Number(newDays.value) || 30,
    })
    if (res.data.ok) {
      toast.success('用户已创建')
      newUsername.value = ''
      newPassword.value = ''
      await refreshAll()
    }
    else {
      toast.error(res.data.error || '创建失败')
    }
  }
  catch (e: any) {
    toast.error(getApiErrorMessage(e, '创建失败'))
  }
  finally {
    creatingUser.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleDetailKeydown)
  void refreshAll()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleDetailKeydown)
  if (typeof document !== 'undefined')
    document.body.style.overflow = ''
})
</script>

<template>
  <div class="admin-page">
    <header class="admin-header">
      <div>
        <h1 class="admin-title">
          <span class="i-carbon-key" />
          卡密与用户管理
        </h1>
        <p class="admin-subtitle">
          生成卡密分发给用户；用户凭卡密自助开通账号，按卡密天数计时。
        </p>
      </div>
      <BaseButton variant="outline" size="sm" @click="refreshAll">
        <span class="inline-flex items-center gap-1.5"><span class="i-carbon-renew" />刷新</span>
      </BaseButton>
    </header>

    <section class="stat-grid">
      <article class="stat-card">
        <span class="stat-label">卡密总数</span>
        <strong class="stat-value">{{ overview.cardkeys.total }}</strong>
        <span class="stat-foot">可用 {{ overview.cardkeys.active }} · 已用 {{ overview.cardkeys.used }}</span>
      </article>
      <article class="stat-card">
        <span class="stat-label">注册次数</span>
        <strong class="stat-value">{{ overview.cardkeys.registers }}</strong>
        <span class="stat-foot">来自卡密兑换</span>
      </article>
      <article class="stat-card">
        <span class="stat-label">用户总数</span>
        <strong class="stat-value">{{ overview.users.total }}</strong>
        <span class="stat-foot">有效 {{ overview.users.active }} · 过期 {{ overview.users.expired }}</span>
      </article>
      <article class="stat-card">
        <span class="stat-label">已禁用</span>
        <strong class="stat-value">{{ overview.users.disabled }}</strong>
        <span class="stat-foot">卡密禁用 {{ overview.cardkeys.disabled }}</span>
      </article>
      <article class="stat-card">
        <span class="stat-label">免费领取</span>
        <strong class="stat-value">{{ overview.freeClaim.today }}</strong>
        <span class="stat-foot">今日 · 累计 {{ overview.freeClaim.total }}</span>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">
          <span class="i-carbon-add-alt" />
          生成卡密
        </h2>
      </div>
      <div class="gen-grid">
        <label class="field">
          <span class="field-label">时长（天）</span>
          <BaseInput v-model.number="genDays" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">数量</span>
          <BaseInput v-model.number="genCount" type="number" min="1" max="200" />
        </label>
        <label class="field">
          <span class="field-label">每张可用次数</span>
          <BaseInput v-model.number="genMaxUses" type="number" min="1" max="100" />
        </label>
        <label class="field field-wide">
          <span class="field-label">备注（渠道、批次）</span>
          <BaseInput v-model="genNote" type="text" placeholder="例如：QQ群 9 月批次" />
        </label>
        <div class="field field-action">
          <BaseButton variant="primary" :loading="generating" @click="generateKeys">
            生成
          </BaseButton>
        </div>
      </div>

      <div v-if="generated.length" class="generated-box">
        <div class="generated-head">
          <span>本次生成 {{ generated.length }} 张（{{ generated[0]?.days ?? '-' }} 天 / 可用 {{ generated[0]?.maxUses ?? '-' }} 次）</span>
          <BaseButton size="sm" variant="outline" @click="copyGenerated">
            {{ copiedAll ? '已复制' : '复制全部' }}
          </BaseButton>
        </div>
        <pre class="generated-list">{{ generated.map(k => k.code).join('\n') }}</pre>
      </div>

      <div v-if="revealedPassword" class="generated-box password-box">
        <span>{{ revealedPassword }}</span>
        <button class="link-btn" type="button" @click="revealedPassword = ''">
          关闭
        </button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">
          <span class="i-carbon-gift" />
          免费领卡密
        </h2>
        <div class="panel-tools">
          <BaseButton variant="primary" size="sm" :loading="generating" @click="generateFreePool">
            补充 20 张免费卡池
          </BaseButton>
          <BaseButton variant="outline" size="sm" @click="toggleClaimRecords">
            {{ showClaimRecords ? '收起记录' : '领取记录' }}
          </BaseButton>
        </div>
      </div>

      <div class="gen-grid">
        <label class="field field-wide">
          <span class="field-label">开关</span>
          <BaseSwitch v-model="freeClaim.enabled" :label="freeClaim.enabled ? '注册页显示免费领取按钮' : '已关闭'" />
        </label>
        <label class="field">
          <span class="field-label">每张天数</span>
          <BaseInput v-model.number="freeClaim.days" type="number" min="1" max="3650" />
        </label>
        <label class="field">
          <span class="field-label">可用次数</span>
          <BaseInput v-model.number="freeClaim.maxUses" type="number" min="1" max="100" />
        </label>
        <label class="field">
          <span class="field-label">同 IP 冷却（小时）</span>
          <BaseInput v-model.number="freeClaim.cooldownHours" type="number" min="0" max="720" />
        </label>
        <label class="field">
          <span class="field-label">每日上限（0=不限）</span>
          <BaseInput v-model.number="freeClaim.dailyLimit" type="number" min="0" max="100000" />
        </label>
        <label class="field">
          <span class="field-label">验证难度（0-5）</span>
          <BaseInput v-model.number="freeClaim.powDifficulty" type="number" min="0" max="5" />
        </label>
        <label class="field field-wide">
          <span class="field-label">备注</span>
          <BaseInput v-model="freeClaim.note" type="text" placeholder="免费领取" />
        </label>
        <div class="field field-action">
          <BaseButton variant="primary" :loading="freeClaimSaving" @click="saveFreeClaim">
            保存
          </BaseButton>
        </div>
      </div>

      <p class="free-claim-tip">
        领取从管理员生成的免费卡池里发放（备注含「{{ freeClaim.note || '免费领取' }}」），不再现场生成；当前可用 {{ overview.freeClaim.poolAvailable }} 张，今日领取 {{ overview.freeClaim.today }} 次，累计 {{ overview.freeClaim.total }} 次。
      </p>

      <div v-if="showClaimRecords" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>标识</th>
              <th>时间</th>
              <th>卡密</th>
              <th>天数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in claimRecords" :key="index">
              <td class="muted-cell">
                {{ item.ip }}
              </td>
              <td class="muted-cell">
                {{ item.identity || '-' }}
              </td>
              <td class="muted-cell">
                {{ formatTime(item.at) }}
              </td>
              <td class="code-cell">
                {{ item.code }}
              </td>
              <td>{{ item.days }} 天</td>
            </tr>
            <tr v-if="!claimRecords.length">
              <td colspan="5" class="empty-cell">
                暂无领取记录
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">
          <span class="i-carbon-ticket" />
          卡密列表
          <span class="count-badge">{{ filteredKeys.length }}</span>
        </h2>
        <div class="panel-tools">
          <template v-if="listExpanded">
            <select v-model="statusFilter" class="select">
              <option value="">
                全部状态
              </option>
              <option value="active">
                可用
              </option>
              <option value="used">
                已用完
              </option>
              <option value="disabled">
                已禁用
              </option>
              <option value="expired">
                已过期
              </option>
            </select>
            <BaseInput v-model="keyword" type="text" placeholder="搜卡密 / 备注 / 用户" class="search-input" />
          </template>
          <BaseButton size="sm" variant="outline" @click="listExpanded = !listExpanded">
            {{ listExpanded ? '收起列表' : '展开列表' }}
          </BaseButton>
        </div>
      </div>

      <template v-if="listExpanded">
        <div v-if="selectedIds.size" class="bulk-bar">
          <div class="bulk-info">
            <strong>已选 {{ selectedIds.size }} 张</strong>
            <span class="bulk-sub">
              可用 {{ selectedStats.active }} · 已禁用 {{ selectedStats.disabled }} · 已用完/过期 {{ selectedStats.dead }} · 合计 {{ selectedStats.daysTotal }} 天
            </span>
          </div>
          <div class="bulk-actions">
            <button class="bulk-btn" type="button" :disabled="bulkBusy" @click="batchAction('enable')">
              批量启用
            </button>
            <button class="bulk-btn" type="button" :disabled="bulkBusy" @click="batchAction('disable')">
              批量禁用
            </button>
            <span class="bulk-note-group">
              <input v-model="bulkNote" class="bulk-note-input" type="text" maxlength="120" placeholder="统一备注，留空则清空">
              <button class="bulk-btn" type="button" :disabled="bulkBusy" @click="applyBulkNote">应用备注</button>
            </span>
            <button class="bulk-btn" type="button" @click="copySelected">
              复制卡密
            </button>
            <button class="bulk-btn" type="button" @click="exportSelected">
              导出 CSV
            </button>
            <button class="bulk-btn" type="button" @click="invertSelection">
              反选
            </button>
            <button class="bulk-btn danger" type="button" :disabled="bulkBusy" @click="batchAction('delete')">
              批量删除
            </button>
            <button class="bulk-btn ghost" type="button" @click="clearSelection">
              取消选择
            </button>
          </div>
        </div>

        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="col-select">
                  <button
                    class="sel-box"
                    :class="{ 'is-on': allFilteredSelected, 'is-part': someFilteredSelected }"
                    type="button"
                    :title="allFilteredSelected ? '取消全选（当前筛选结果）' : '全选当前筛选结果'"
                    @click="toggleSelectAllFiltered"
                  >
                    {{ allFilteredSelected ? '✓' : (someFilteredSelected ? '–' : '') }}
                  </button>
                </th>
                <th>卡密</th>
                <th>时长</th>
                <th>用量</th>
                <th>状态</th>
                <th>备注</th>
                <th>兑换用户</th>
                <th>创建时间</th>
                <th class="col-actions">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="key in filteredKeys" :key="key.id" :class="{ 'is-selected': isSelected(key.id) }">
                <td class="col-select">
                  <button
                    class="sel-box"
                    :class="{ 'is-on': isSelected(key.id) }"
                    type="button"
                    :title="isSelected(key.id) ? '取消选择' : '选择'"
                    @click="toggleSelect(key)"
                  >
                    {{ isSelected(key.id) ? '✓' : '' }}
                  </button>
                </td>
                <td>
                  <button class="code-cell" type="button" title="点击复制" @click="copyText(key.code).then(ok => ok && toast.success('已复制'))">
                    {{ key.code }}
                    <span class="i-carbon-copy" />
                  </button>
                </td>
                <td>{{ key.days }} 天</td>
                <td>{{ key.uses }} / {{ key.maxUses }}</td>
                <td><span class="status-pill" :class="`is-${key.status}`">{{ statusText[key.status] || key.status }}</span></td>
                <td class="muted-cell">
                  {{ key.note || '-' }}
                </td>
                <td class="muted-cell">
                  {{ key.usedBy.length ? key.usedBy.map(u => u.username).join('、') : '-' }}
                </td>
                <td class="muted-cell">
                  {{ formatTime(key.createdAt) }}
                </td>
                <td class="col-actions">
                  <button class="row-btn" type="button" @click="openDetail(key)">
                    详情
                  </button>
                  <button class="row-btn" type="button" @click="toggleKey(key)">
                    {{ key.status === 'disabled' ? '启用' : '禁用' }}
                  </button>
                  <button class="row-btn danger" type="button" @click="removeKey(key)">
                    删除
                  </button>
                </td>
              </tr>
              <tr v-if="!filteredKeys.length">
                <td colspan="9" class="empty-cell">
                  {{ loadingKeys ? '加载中...' : '暂无卡密' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">
          <span class="i-carbon-user-multiple" />
          用户列表
          <span class="count-badge">{{ users.length }}</span>
        </h2>
      </div>

      <div class="create-user">
        <BaseInput v-model="newUsername" type="text" placeholder="用户名" class="create-input" />
        <BaseInput v-model="newPassword" type="password" placeholder="初始密码（字母+数字，≥6位）" class="create-input" />
        <BaseInput v-model.number="newDays" type="number" min="1" max="3650" class="create-days" />
        <BaseButton variant="outline" :loading="creatingUser" @click="createUser">
          直接建号
        </BaseButton>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>到期</th>
              <th>剩余</th>
              <th>账号数</th>
              <th>状态</th>
              <th>最近登录</th>
              <th class="col-actions">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td class="strong-cell">
                {{ user.username }}
              </td>
              <td>普通用户</td>
              <td class="muted-cell">
                {{ formatTime(user.expiresAt) }}
              </td>
              <td>{{ daysLeft(user.expiresAt) }}</td>
              <td>{{ user.accountCount }}</td>
              <td>
                <span class="status-pill" :class="user.enabled ? 'is-active' : 'is-disabled'">
                  {{ user.enabled ? '正常' : '已禁用' }}
                </span>
              </td>
              <td class="muted-cell">
                {{ user.lastLoginAt ? formatTime(user.lastLoginAt) : '-' }}
              </td>
              <td class="col-actions">
                <button class="row-btn" type="button" @click="extendUser(user, 30)">
                  +30天
                </button>
                <button class="row-btn" type="button" @click="extendUser(user, 90)">
                  +90天
                </button>
                <button class="row-btn" type="button" @click="resetPassword(user)">
                  重置密码
                </button>
                <button class="row-btn" type="button" @click="toggleUser(user)">
                  {{ user.enabled ? '禁用' : '启用' }}
                </button>
                <button class="row-btn danger" type="button" @click="removeUser(user)">
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!users.length">
              <td colspan="8" class="empty-cell">
                {{ loadingUsers ? '加载中...' : '暂无用户，先在左侧生成卡密' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Teleport to="body">
      <Transition name="ck-drawer">
        <div v-if="detailKey" class="ck-drawer-root">
          <div class="ck-drawer-mask" @click="closeDetail" />
          <aside class="ck-drawer" role="dialog" aria-modal="true" aria-label="卡密详情">
            <header class="ck-drawer-head">
              <div class="ck-drawer-head-main">
                <span class="ck-drawer-kicker">卡密详情</span>
                <strong class="ck-drawer-code">{{ detailKey.code }}</strong>
              </div>
              <div class="ck-drawer-nav">
                <button
                  class="ck-drawer-icon-btn"
                  type="button"
                  aria-label="上一条"
                  :disabled="filteredKeys.length < 2"
                  @click="stepDetail(-1)"
                >
                  ‹
                </button>
                <button
                  class="ck-drawer-icon-btn"
                  type="button"
                  aria-label="下一条"
                  :disabled="filteredKeys.length < 2"
                  @click="stepDetail(1)"
                >
                  ›
                </button>
                <button class="ck-drawer-close" type="button" aria-label="关闭" @click="closeDetail">
                  ✕
                </button>
              </div>
            </header>

            <div class="ck-drawer-body">
              <div class="ck-drawer-badges">
                <span class="status-pill" :class="`is-${detailKey.status}`">{{ statusText[detailKey.status] || detailKey.status }}</span>
                <span class="ck-badge">{{ detailKey.days }} 天</span>
                <span class="ck-badge">用量 {{ detailKey.uses }} / {{ detailKey.maxUses }}</span>
              </div>

              <div class="ck-usage">
                <div class="ck-usage-track">
                  <span class="ck-usage-fill" :class="{ 'is-full': detailUsagePercent >= 100 }" :style="{ width: `${detailUsagePercent}%` }" />
                </div>
                <span class="ck-usage-text">剩余可用 {{ detailKey.remaining }} 次</span>
              </div>

              <dl class="ck-meta">
                <div class="ck-meta-item">
                  <dt>创建时间</dt>
                  <dd>{{ formatTime(detailKey.createdAt) }}</dd>
                </div>
                <div class="ck-meta-item">
                  <dt>到期时间</dt>
                  <dd>{{ formatTime(detailKey.expiresAt) }}</dd>
                </div>
                <div class="ck-meta-item">
                  <dt>剩余时长</dt>
                  <dd>{{ daysLeft(detailKey.expiresAt) }}</dd>
                </div>
                <div class="ck-meta-item">
                  <dt>兑换人数</dt>
                  <dd>{{ detailKey.usedBy.length }} 人</dd>
                </div>
              </dl>

              <section class="ck-section">
                <h3 class="ck-section-title">
                  备注
                </h3>
                <textarea
                  v-model="detailNote"
                  class="ck-note"
                  rows="3"
                  maxlength="120"
                  placeholder="例如：QQ群 9 月批次"
                />
                <div class="ck-note-foot">
                  <span>{{ detailNote.length }}/120</span>
                  <BaseButton size="sm" variant="outline" :loading="detailBusy" @click="saveDetailNote">
                    保存备注
                  </BaseButton>
                </div>
              </section>

              <section class="ck-section">
                <h3 class="ck-section-title">
                  兑换记录
                  <span class="count-badge">{{ detailKey.usedBy.length }}</span>
                </h3>
                <ul v-if="detailKey.usedBy.length" class="ck-users">
                  <li v-for="item in detailKey.usedBy" :key="`${item.userId}-${item.at}`" class="ck-user">
                    <span class="ck-user-name">{{ item.username }}</span>
                    <span class="ck-user-time">{{ formatTime(item.at) }}</span>
                  </li>
                </ul>
                <p v-else class="ck-empty">
                  暂无兑换记录
                </p>
              </section>
            </div>

            <footer class="ck-drawer-foot">
              <BaseButton size="sm" variant="outline" @click="copyDetailCode">
                复制卡密
              </BaseButton>
              <BaseButton v-if="detailKey.usedBy.length" size="sm" variant="outline" @click="copyDetailUsers">
                复制用户
              </BaseButton>
              <BaseButton size="sm" variant="secondary" @click="toggleDetailStatus">
                {{ detailKey.status === 'disabled' ? '启用' : '禁用' }}
              </BaseButton>
              <BaseButton size="sm" variant="danger" @click="removeDetailKey">
                删除
              </BaseButton>
            </footer>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-page {
  display: flex;
  max-width: 1280px;
  flex-direction: column;
  gap: 18px;
  margin: 0 auto;
  padding: 22px 20px 48px;
}

.admin-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.admin-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700);
}

.admin-title > span {
  color: var(--ui-primary);
}

.admin-subtitle {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font-size: 13px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
}

.stat-label {
  color: var(--ui-muted);
  font-size: 12px;
}

.stat-value {
  color: var(--ui-ink);
  font-size: 26px;
  line-height: 1.15;
}

.stat-foot {
  color: var(--ui-subtle);
  font-size: 11px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--ui-border);
  border-radius: 14px;
  background: var(--ui-surface);
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-700);
}

.panel-title > span:first-child {
  color: var(--ui-primary);
}

.count-badge {
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-600);
  background: var(--ui-primary-soft);
}

.panel-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.select {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-ink);
  font-size: 12px;
  background: var(--ui-surface);
}

.search-input {
  width: 220px;
}

.gen-grid {
  display: grid;
  grid-template-columns: 130px 110px 150px minmax(180px, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  color: var(--ui-muted);
  font-size: 12px;
}

.free-claim-tip {
  margin: 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 1.5;
}

.field-action {
  justify-content: flex-end;
}

.generated-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px dashed rgba(67, 141, 99, 0.4);
  border-radius: 10px;
  background: var(--ui-primary-soft);
}

.generated-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--ui-ink);
  font-size: 12px;
}

.generated-list {
  max-height: 220px;
  margin: 0;
  overflow: auto;
  color: var(--ui-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.password-box {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  color: var(--ui-ink);
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.link-btn {
  padding: 0;
  border: none;
  color: var(--ui-primary);
  font-size: 12px;
  background: none;
  cursor: pointer;
}

.bulk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(67, 141, 99, 0.35);
  border-radius: 10px;
  background: var(--ui-primary-soft);
}

.bulk-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--ui-ink);
  font-size: 13px;
}

.bulk-sub {
  color: var(--ui-muted);
  font-size: 11px;
}

.bulk-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.bulk-btn {
  padding: 4px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  color: var(--ui-ink);
  font-size: 12px;
  background: var(--ui-surface);
  cursor: pointer;
}

.bulk-btn:hover:not(:disabled) {
  border-color: rgba(67, 141, 99, 0.5);
  color: var(--ui-primary);
}

.bulk-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.bulk-btn.danger:hover:not(:disabled) {
  border-color: rgba(201, 95, 102, 0.55);
  color: #c95f66;
}

.bulk-btn.ghost {
  border-color: transparent;
  color: var(--ui-muted);
  background: transparent;
}

.bulk-note-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.bulk-note-input {
  width: 170px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  color: var(--ui-ink);
  font-size: 12px;
  background: var(--ui-surface);
}

.col-select {
  width: 40px;
  text-align: center;
}

.sel-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  color: #fff;
  font-size: 12px;
  line-height: 1;
  background: var(--ui-surface);
  cursor: pointer;
}

.sel-box:hover {
  border-color: rgba(67, 141, 99, 0.55);
}

.sel-box.is-on,
.sel-box.is-part {
  border-color: var(--ui-primary);
  background: var(--ui-primary);
}

.sel-box.is-part {
  background: color-mix(in srgb, var(--ui-primary) 60%, #fff);
}

.data-table tbody tr.is-selected {
  background: color-mix(in srgb, var(--ui-primary-soft) 70%, transparent);
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}

.data-table th {
  padding: 9px 12px;
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-600);
  text-align: left;
  background: color-mix(in srgb, var(--ui-surface-strong) 45%, transparent);
}

.data-table td {
  padding: 9px 12px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-ink);
  vertical-align: middle;
}

.data-table tbody tr:hover {
  background: color-mix(in srgb, var(--ui-primary-soft) 45%, transparent);
}

.code-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  color: var(--ui-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--ui-surface);
  cursor: pointer;
}

.code-cell:hover {
  border-color: rgba(67, 141, 99, 0.45);
  color: var(--ui-primary);
}

.muted-cell {
  color: var(--ui-muted);
}

.strong-cell {
  font-weight: var(--fw-600);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: var(--fw-600);
}

.status-pill.is-active {
  color: #217a46;
  background: rgba(67, 141, 99, 0.13);
}

.status-pill.is-used,
.status-pill.is-expired {
  color: #8a6a1f;
  background: rgba(196, 158, 57, 0.16);
}

.status-pill.is-disabled {
  color: #a14147;
  background: rgba(201, 95, 102, 0.14);
}

.col-actions {
  text-align: right;
}

.row-btn {
  padding: 3px 8px;
  margin-left: 4px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  color: var(--ui-ink);
  font-size: 11px;
  background: transparent;
  cursor: pointer;
}

.row-btn:hover {
  border-color: rgba(67, 141, 99, 0.5);
  color: var(--ui-primary);
}

.row-btn.danger:hover {
  border-color: rgba(201, 95, 102, 0.55);
  color: #c95f66;
}

.empty-cell {
  padding: 26px 12px;
  color: var(--ui-muted);
  text-align: center;
}

.create-user {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.create-input {
  width: 220px;
}

.create-days {
  width: 100px;
}

/* ---------------- 卡密详情抽屉 ---------------- */
.ck-drawer-root {
  position: fixed;
  z-index: 2400;
  inset: 0;
  display: flex;
  justify-content: flex-end;
}

.ck-drawer-mask {
  position: absolute;
  inset: 0;
  background: rgba(16, 24, 20, 0.38);
  backdrop-filter: blur(1px);
}

.ck-drawer {
  position: relative;
  display: flex;
  width: min(420px, 100vw);
  height: 100%;
  flex-direction: column;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-surface);
  box-shadow: -18px 0 42px rgba(16, 24, 20, 0.16);
}

.ck-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--ui-border);
}

.ck-drawer-head-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.ck-drawer-kicker {
  color: var(--ui-muted);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.ck-drawer-code {
  overflow-wrap: anywhere;
  color: var(--ui-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 15px;
  line-height: 1.35;
}

.ck-drawer-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-muted);
  font-size: 13px;
  background: var(--ui-surface);
  cursor: pointer;
}

.ck-drawer-close:hover {
  border-color: rgba(67, 141, 99, 0.5);
  color: var(--ui-primary);
}

.ck-drawer-nav {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

.ck-drawer-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-ink);
  font-size: 15px;
  line-height: 1;
  background: var(--ui-surface);
  cursor: pointer;
}

.ck-drawer-icon-btn:hover:not(:disabled) {
  border-color: rgba(67, 141, 99, 0.5);
  color: var(--ui-primary);
}

.ck-drawer-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ck-drawer-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  padding: 16px 18px 20px;
  overflow-y: auto;
}

.ck-drawer-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ck-badge {
  padding: 1px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: var(--fw-600);
}

.ck-usage {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ck-usage-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-primary-soft);
}

.ck-usage-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--ui-primary);
  transition: width 0.25s ease;
}

.ck-usage-fill.is-full {
  background: #c95f66;
}

.ck-usage-text {
  color: var(--ui-muted);
  font-size: 11px;
}

.ck-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
  margin: 0;
}

.ck-meta-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ck-meta-item dt {
  color: var(--ui-muted);
  font-size: 11px;
}

.ck-meta-item dd {
  margin: 0;
  color: var(--ui-ink);
  font-size: 12px;
}

.ck-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--ui-border);
}

.ck-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: var(--fw-600);
}

.ck-note {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-ink);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  background: var(--ui-surface);
  resize: vertical;
}

.ck-note:focus {
  border-color: rgba(67, 141, 99, 0.55);
  outline: none;
}

.ck-note-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--ui-subtle);
  font-size: 11px;
}

.ck-users {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ck-user {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-surface-strong) 40%, transparent);
}

.ck-user-name {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ck-user-time {
  flex: none;
  color: var(--ui-muted);
  font-size: 11px;
}

.ck-empty {
  margin: 0;
  padding: 14px 0;
  color: var(--ui-muted);
  font-size: 12px;
  text-align: center;
}

.ck-drawer-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 18px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--ui-border);
  background: var(--ui-surface);
}

/* 抽屉进出场：遮罩淡入，面板从右侧滑入 */
.ck-drawer-enter-active,
.ck-drawer-leave-active {
  transition: opacity 0.22s ease;
}

.ck-drawer-enter-active .ck-drawer,
.ck-drawer-leave-active .ck-drawer {
  transition: transform 0.26s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.ck-drawer-enter-from,
.ck-drawer-leave-to {
  opacity: 0;
}

.ck-drawer-enter-from .ck-drawer,
.ck-drawer-leave-to .ck-drawer {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .ck-drawer-enter-active,
  .ck-drawer-leave-active,
  .ck-drawer-enter-active .ck-drawer,
  .ck-drawer-leave-active .ck-drawer {
    transition: none;
  }
}

@media (max-width: 900px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .gen-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field-wide {
    grid-column: span 2;
  }

  .admin-page {
    padding: 16px 12px 40px;
  }
}

@media (max-width: 560px) {
  .ck-drawer {
    width: 100vw;
  }

  .ck-drawer-body {
    padding: 14px 14px 18px;
  }

  .ck-meta {
    grid-template-columns: 1fr;
  }

  .ck-drawer-foot > * {
    flex: 1 1 auto;
  }

  .stat-grid {
    grid-template-columns: 1fr;
  }

  .gen-grid {
    grid-template-columns: 1fr;
  }

  .field-wide {
    grid-column: auto;
  }

  .search-input,
  .create-input {
    width: 100%;
  }

  .bulk-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .bulk-note-group {
    width: 100%;
  }

  .bulk-note-input {
    flex: 1;
    width: auto;
  }
}
</style>
