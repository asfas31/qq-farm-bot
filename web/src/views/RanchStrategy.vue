<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import AutomationSettingsForm from '@/components/settings/AutomationSettingsForm.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useSettingStore } from '@/stores/setting'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

// 牧场的自动化开关与养殖策略独立成页，避免和农场账号设置混在一起。
const fertilizerLandTypeOptions = [
  { label: '蓝晶土地', value: 'blue-crystal' },
  { label: '紫金土地', value: 'purple-gold' },
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '智能施肥', value: 'smart' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '不施肥', value: 'none' },
]

const accountStore = useAccountStore()
const settingStore = useSettingStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)
const { currentAccountConnected } = storeToRefs(useStatusStore())
const { settings, loading: settingsLoading, loadedAccountId } = storeToRefs(settingStore)

const model = ref<any>({})
const ranchAnimalOptions = ref<Array<{ value: number, label: string, kind: string }>>([])
const animalOptionsLoading = ref(false)
const animalOptionsError = ref('')
const ranchRankings = ref<Array<{ animalId: number, name: string, kind: string, expPerHour: number, netGoldPerHour: number, cycleSec: number }>>([])
const rankingLoaded = ref(false)
const saving = ref(false)
const error = ref('')

const ready = computed(() => !!currentAccountId.value && loadedAccountId.value === currentAccountId.value)
const needsAnimalOptions = computed(() => {
  const auto = model.value.automation
  return auto?.ranch_strategy === 'preferred' || (auto?.ranch_strategy === 'bag_priority' && auto.ranch_bag_fallback === 'preferred')
})
const waitingForAnimalOptions = computed(() => needsAnimalOptions.value && !ranchAnimalOptions.value.length)

const activeSmartStrategy = computed(() => {
  const auto = model.value.automation
  if (!auto) return ''
  if (auto.ranch_strategy === 'max_exp' || auto.ranch_strategy === 'max_gold')
    return auto.ranch_strategy
  if (auto.ranch_strategy === 'bag_priority' && (auto.ranch_bag_fallback === 'max_exp' || auto.ranch_bag_fallback === 'max_gold'))
    return auto.ranch_bag_fallback
  return ''
})
const rankingKey = computed<'expPerHour' | 'netGoldPerHour'>(() => activeSmartStrategy.value === 'max_exp' ? 'expPerHour' : 'netGoldPerHour')
const rankingLabel = computed(() => activeSmartStrategy.value === 'max_exp' ? '经验/时' : '净金币/时')
const topByKind = (kind: string) => [...ranchRankings.value]
  .filter(row => row.kind === kind)
  .sort((a, b) => Number(b[rankingKey.value]) - Number(a[rankingKey.value]) || a.cycleSec - b.cycleSec)
  .slice(0, 3)

/** 只把牧场相关开关交给后端，避免整份账号配置被覆盖。 */
function ranchAutomationOnly(automation: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(automation || {}).filter(([key]) => key.startsWith('ranch_')))
}

function syncFromStore() {
  if (!settings.value) {
    model.value = {}
    return
  }
  const next = JSON.parse(JSON.stringify(settings.value))
  next.automation = { ...next.automation }
  model.value = next
}

function showError(cause: unknown, fallback: string) {
  error.value = getApiErrorMessage(cause, fallback)
}

async function load() {
  error.value = ''
  const accountId = currentAccountId.value
  if (!accountId)
    return
  try {
    const loaded = await settingStore.fetchSettings(accountId)
    if (accountId !== currentAccountId.value)
      return
    if (!loaded)
      throw new Error('牧场策略读取失败')
    syncFromStore()
  }
  catch (cause) {
    showError(cause, '牧场策略读取失败')
  }
}

watch(currentAccountId, (accountId) => {
  model.value = {}
  void load()
  void loadRankings()
  if (accountId && !ranchAnimalOptions.value.length)
    void loadAnimalOptions()
}, { immediate: true })

watch(settings, () => {
  if (ready.value && !saving.value)
    syncFromStore()
})

async function loadRankings() {
  if (rankingLoaded.value)
    return
  try {
    const { data } = await api.get('/api/ranch/animal-rankings', { skipErrorToast: true } as any)
    if (data?.ok && Array.isArray(data.data))
      ranchRankings.value = data.data
    rankingLoaded.value = true
  }
  catch {
    rankingLoaded.value = false
  }
}

async function loadAnimalOptions() {
  if (animalOptionsLoading.value)
    return
  animalOptionsLoading.value = true
  animalOptionsError.value = ''
  try {
    const { data } = await api.get('/api/ranch/automation-options', { skipErrorToast: true } as any)
    if (!data?.ok || !Array.isArray(data.data) || !data.data.length)
      throw new Error(getApiErrorMessage(data, '牧场动物选项读取失败'))
    ranchAnimalOptions.value = data.data
  }
  catch (cause) {
    animalOptionsError.value = getApiErrorMessage(cause, '牧场动物选项读取失败')
  }
  finally {
    animalOptionsLoading.value = false
  }
}

async function save() {
  const accountId = currentAccountId.value
  if (!accountId || saving.value || !ready.value || waitingForAnimalOptions.value)
    return
  saving.value = true
  error.value = ''
  try {
    const result = await settingStore.saveSettings(accountId, { automation: ranchAutomationOnly(model.value.automation) })
    if (accountId !== currentAccountId.value)
      return
    if (!result.ok)
      throw new Error(result.error || '保存失败')
    syncFromStore()
    toast.success('牧场策略已保存')
  }
  catch (cause) {
    showError(cause, '牧场策略保存失败')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page-stack flex flex-col gap-4">
    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后配置牧场自动化与养殖策略" icon="i-carbon-user-avatar" />
    <template v-else>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400" role="alert">
        {{ error }}
      </p>
      <p v-if="settingsLoading" class="py-8 text-center text-sm text-gray-500 dark:text-gray-400" role="status">
        <span class="i-carbon-circle-dash mx-auto mb-2 inline-block animate-spin text-2xl" />
        加载中...
      </p>
      <BaseButton v-else-if="!ready" variant="secondary" size="sm" @click="load">
        重新读取策略
      </BaseButton>
      <template v-else>
        <AutomationSettingsForm
          v-model="model"
          in-ranch
          panel="strategy"
          hide-save
          :ranch-animal-options="ranchAnimalOptions"
          :ranch-animal-options-loading="animalOptionsLoading"
          :ranch-animal-options-error="animalOptionsError"
          :account-id="currentAccountId"
          :connected="currentAccountConnected"
          :saving="saving"
          :fertilizer-land-type-options="fertilizerLandTypeOptions"
          :fertilizer-options="fertilizerOptions"
          @save="save"
          @reload-animals="loadAnimalOptions"
        />

        <section v-if="activeSmartStrategy" class="farm-card rounded-2xl p-4">
          <div class="mb-3 flex items-start gap-3">
            <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400">
              <span class="i-carbon-chart-line text-xl" />
            </div>
            <div>
              <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
                智能选择预估
              </h4>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                按{{ rankingLabel }}排序，补栏时优先选当前可买且排名最高的动物（窝与棚分别计算）。
              </p>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div v-for="kind in ['窝', '棚']" :key="kind" class="rounded-lg border border-gray-100 p-3 dark:border-gray-700">
              <p class="mb-2 text-sm font-bold">{{ kind }} · 前 3 名</p>
              <ol class="space-y-1 text-xs text-gray-600 dark:text-gray-300">
                <li v-for="(row, index) in topByKind(kind)" :key="row.animalId">
                  {{ index + 1 }}. {{ row.name }} · {{ Number(row[rankingKey]).toLocaleString('zh-CN') }} {{ rankingLabel }}
                </li>
                <li v-if="!topByKind(kind).length">暂无排行数据</li>
              </ol>
            </div>
          </div>
        </section>

        <AutomationSettingsForm
          v-model="model"
          in-ranch
          panel="automation"
          hide-save
          :saving="saving"
          :fertilizer-land-type-options="fertilizerLandTypeOptions"
          :fertilizer-options="fertilizerOptions"
          @save="save"
        />
        <div class="flex justify-end">
          <BaseButton variant="primary" size="sm" :loading="saving" :disabled="waitingForAnimalOptions" @click="save">
            保存牧场策略
          </BaseButton>
        </div>
      </template>
    </template>
  </div>
</template>
