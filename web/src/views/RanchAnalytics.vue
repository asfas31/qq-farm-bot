<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

interface RanchAnimalRow {
  animalId: number
  name: string
  kind: string
  requiredLevel: number
  cycleSec: number
  firstHarvestSec: number
  expPerHour: number
  goldPerHour: number
  cubCost: number
  grassCostPerCycle: number
  netPerCycle: number
  netGoldPerHour: number
  paybackHours: number
  pricePerCycle: number
}

const accountStore = useAccountStore()
const settingStore = useSettingStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)
const { settings, loadedAccountId } = storeToRefs(settingStore)
const { status } = storeToRefs(statusStore)

const loading = ref(false)
const list = ref<RanchAnimalRow[]>([])
const sortKey = ref<'gold' | 'exp'>('gold')
const kindFilter = ref('all')
const levelLimit = ref(0)
const keyword = ref('')

const strategyLabelMap: Record<string, string> = {
  level: '按已解锁等级',
  max_exp: '最大经验/时',
  max_gold: '最大净金币/时',
  preferred: '指定动物',
  bag_priority: '优先背包幼崽',
}

const effectiveStrategy = computed(() => {
  const auto = settings.value?.automation
  if (!auto)
    return 'level'
  if (auto.ranch_strategy === 'bag_priority')
    return auto.ranch_bag_fallback || 'level'
  return auto.ranch_strategy || 'level'
})

const currentStrategyLabel = computed(() => strategyLabelMap[effectiveStrategy.value] || effectiveStrategy.value)

const statusLevel = computed(() => Number(status.value?.status?.level) || 0)
watch(statusLevel, (level) => {
  if (level > 0 && levelLimit.value === 0)
    levelLimit.value = level
}, { immediate: true })

const availableRows = computed(() => list.value.filter((row) => {
  if (levelLimit.value > 0 && Number(row.requiredLevel) > levelLimit.value)
    return false
  return true
}))

const filteredRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return availableRows.value.filter((row) => {
    if (kindFilter.value !== 'all' && row.kind !== kindFilter.value)
      return false
    if (!kw)
      return true
    return row.name.toLowerCase().includes(kw) || String(row.animalId).includes(kw)
  }).sort((a, b) => {
    const key = sortKey.value === 'exp' ? 'expPerHour' : 'netGoldPerHour'
    return Number(b[key]) - Number(a[key]) || a.cycleSec - b.cycleSec || a.requiredLevel - b.requiredLevel
  })
})

function metricOf(strategy: string): 'expPerHour' | 'netGoldPerHour' | 'requiredLevel' | null {
  if (strategy === 'max_exp')
    return 'expPerHour'
  if (strategy === 'max_gold')
    return 'netGoldPerHour'
  if (strategy === 'level')
    return 'requiredLevel'
  return null
}

const bestForCurrent = computed(() => {
  const metric = metricOf(effectiveStrategy.value)
  if (!metric)
    return null
  return [...availableRows.value].sort((a, b) => {
    const diff = Number(b[metric]) - Number(a[metric])
    return diff || a.cycleSec - b.cycleSec || Number(b.goldPerHour) - Number(a.goldPerHour)
  })[0] || null
})

const summaryCards = computed(() => {
  const top = (metric: 'expPerHour' | 'netGoldPerHour' | 'requiredLevel') =>
    [...availableRows.value].sort((a, b) => Number(b[metric]) - Number(a[metric]) || a.cycleSec - b.cycleSec)[0] || null
  return [
    { key: 'exp', label: '经验/时最高', value: top('expPerHour')?.expPerHour || 0, unit: 'EXP', name: top('expPerHour')?.name || '-', color: 'purple' },
    { key: 'gold', label: '净金币/时最高', value: top('netGoldPerHour')?.netGoldPerHour || 0, unit: '金币', name: top('netGoldPerHour')?.name || '-', color: 'amber' },
    { key: 'level', label: '解锁等级最高', value: top('requiredLevel')?.requiredLevel || 0, unit: 'Lv', name: top('requiredLevel')?.name || '-', color: 'rose' },
  ]
})

function formatNumber(value: any): string {
  const number = Number(value) || 0
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function formatCycle(seconds: number): string {
  const value = Number(seconds) || 0
  if (value < 60)
    return `${value}秒`
  if (value < 3600)
    return `${Math.round(value / 60)}分`
  const hours = Math.floor(value / 3600)
  const mins = Math.round((value % 3600) / 60)
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`
}

function colorClass(color: string, type: 'bg' | 'text'): string {
  const map: Record<string, Record<string, string>> = {
    purple: { bg: 'bg-purple-50 dark:bg-purple-900/20', text: 'text-purple-600 dark:text-purple-400' },
    amber: { bg: 'bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-600 dark:text-amber-400' },
    rose: { bg: 'bg-rose-50 dark:bg-rose-900/20', text: 'text-rose-600 dark:text-rose-400' },
  }
  return map[color]?.[type] || ''
}

async function loadAnalytics() {
  loading.value = true
  try {
    const { data } = await api.get('/api/ranch/animal-rankings', {
      params: { sortBy: sortKey.value },
    })
    if (data?.ok && Array.isArray(data.data))
      list.value = data.data
    else
      list.value = []
  }
  catch (error: any) {
    toast.error(getApiErrorMessage(error, '牧场分析加载失败'))
    list.value = []
  }
  finally {
    loading.value = false
  }
}

watch(currentAccountId, () => {
  if (loadedAccountId.value === currentAccountId.value)
    void loadAnalytics()
})

onMounted(loadAnalytics)
</script>

<template>
  <div class="page-stack flex flex-col gap-4">
    <EmptyState
      v-if="!currentAccountId"
      title="请先选择账号"
      description="在左侧选择账号后查看牧场动物收益分析"
      icon="i-carbon-user-avatar"
    />
    <template v-else>
      <div class="farm-card rounded-2xl p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 class="text-xl text-gray-900 font-bold dark:text-gray-100">
              牧场分析
            </h1>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              动物收益按产物与副产物计价，窝和棚分别排名；当前策略：{{ currentStrategyLabel }}
            </p>
          </div>
          <BaseButton variant="outline" size="sm" :loading="loading" @click="loadAnalytics">
            <span class="inline-flex items-center gap-1.5"><span class="i-carbon-renew" />刷新</span>
          </BaseButton>
        </div>

        <div v-if="bestForCurrent" class="mt-4 rounded-xl border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
          <p class="text-xs text-green-700 dark:text-green-400">
            按当前策略「{{ currentStrategyLabel }}」，可养动物中最优：
          </p>
          <p class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ bestForCurrent.name }} · {{ bestForCurrent.kind }} · 净 {{ formatNumber(bestForCurrent.netGoldPerHour) }} 金币/时 · {{ formatNumber(bestForCurrent.expPerHour) }} 经验/时 · 约 {{ formatNumber(bestForCurrent.paybackHours) }} 小时回本
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <section v-for="card in summaryCards" :key="card.key" class="farm-card rounded-2xl p-4">
          <div class="flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg" :class="colorClass(card.color, 'bg')">
              <span class="i-carbon-chart-line text-xl" :class="colorClass(card.color, 'text')" />
            </div>
            <div class="min-w-0">
              <p class="text-xs text-gray-500 dark:text-gray-400">{{ card.label }}</p>
              <p class="text-lg text-gray-900 font-bold dark:text-gray-100">
                {{ formatNumber(card.value) }} <span class="text-xs font-normal">{{ card.unit }}</span>
              </p>
              <p class="truncate text-xs text-gray-500 dark:text-gray-400">{{ card.name }}</p>
            </div>
          </div>
        </section>
      </div>

      <section class="farm-card rounded-2xl p-4">
        <div class="mb-4 flex flex-wrap items-end gap-3">
          <BaseSelect v-model="sortKey" label="排序" :options="[
            { label: '净金币/时', value: 'gold' },
            { label: '经验/时', value: 'exp' },
          ]" class="w-36" />
          <BaseSelect v-model="kindFilter" label="窝棚" :options="[
            { label: '全部', value: 'all' },
            { label: '窝', value: '窝' },
            { label: '棚', value: '棚' },
          ]" class="w-28" />
          <BaseInput v-model.number="levelLimit" type="number" min="0" max="200" label="等级上限（0=不限）" class="w-44" />
          <BaseInput v-model="keyword" type="text" label="搜索动物" placeholder="名称或 ID" class="w-48" />
        </div>

        <div class="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-700">
          <table class="w-full min-w-[720px] text-left text-xs">
            <thead class="bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th class="px-3 py-2 font-semibold">#</th>
                <th class="px-3 py-2 font-semibold">动物</th>
                <th class="px-3 py-2 font-semibold">窝棚</th>
                <th class="px-3 py-2 font-semibold">解锁等级</th>
                <th class="px-3 py-2 font-semibold">生产周期</th>
                <th class="px-3 py-2 font-semibold">成熟时间</th>
                <th class="px-3 py-2 font-semibold">经验/时</th>
                <th class="px-3 py-2 font-semibold">毛金币/时</th>
                <th class="px-3 py-2 font-semibold">净金币/时</th>
                <th class="px-3 py-2 font-semibold">单次净收益</th>
                <th class="px-3 py-2 font-semibold">幼崽成本</th>
                <th class="px-3 py-2 font-semibold">回本</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
              <tr
                v-for="(row, index) in filteredRows"
                :key="row.animalId"
                class="hover:bg-gray-50 dark:hover:bg-gray-800/60"
                :class="bestForCurrent && row.animalId === bestForCurrent.animalId ? 'bg-green-50/60 dark:bg-green-900/10' : ''"
              >
                <td class="px-3 py-2 text-gray-400">{{ index + 1 }}</td>
                <td class="px-3 py-2 text-gray-900 font-medium dark:text-gray-100">
                  {{ row.name }}
                  <span v-if="bestForCurrent && row.animalId === bestForCurrent.animalId" class="ml-1 text-green-600 dark:text-green-400">当前最优</span>
                </td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ row.kind }}</td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ row.requiredLevel || '-' }}</td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ formatCycle(row.cycleSec) }}</td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ formatCycle(row.firstHarvestSec) }}</td>
                <td class="px-3 py-2 text-gray-900 dark:text-gray-100">{{ formatNumber(row.expPerHour) }}</td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ formatNumber(row.goldPerHour) }}</td>
                <td class="px-3 py-2 text-gray-900 font-medium dark:text-gray-100">{{ formatNumber(row.netGoldPerHour) }}</td>
                <td class="px-3 py-2 text-gray-900 dark:text-gray-100">{{ formatNumber(row.netPerCycle) }}</td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ formatNumber(row.cubCost) }}</td>
                <td class="px-3 py-2 text-gray-500 dark:text-gray-400">{{ formatNumber(row.paybackHours) }}时</td>
              </tr>
              <tr v-if="!filteredRows.length">
                <td colspan="11" class="px-3 py-8 text-center text-gray-400">
                  {{ loading ? '加载中...' : '没有符合条件的动物' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-gray-400">
          共 {{ filteredRows.length }} 条，按{{ sortKey === 'exp' ? '经验' : '净金币' }}/时从高到低；净收益已扣除幼崽成本与牧草成本，同分优先短周期。
        </p>
      </section>
    </template>
  </div>
</template>
