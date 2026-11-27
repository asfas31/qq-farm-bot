import type { NotificationTypes } from '../config/notification-types';
import type { RanchAutomationConfig } from '../config/ranch-automation';
export {};
export type PlantingStrategy =
  | 'preferred'
  | 'level'
  | 'max_exp'
  | 'max_fert_exp'
  | 'max_profit'
  | 'max_fert_profit'
  | 'bag_priority';

export type BagSeedFallbackStrategy = Exclude<PlantingStrategy, 'bag_priority'>;

export type FertilizerMode = 'both' | 'normal' | 'organic' | 'smart' | 'none' | 'normal_ripen' | 'organic_ripen';

export type FertilizerLandType = 'blue-crystal' | 'purple-gold' | 'gold' | 'black' | 'red' | 'normal';

export interface AutomationConfig extends RanchAutomationConfig {
  farm: boolean;
  farm_harvest_tiangong: boolean;
  farm_push: boolean;
  land_upgrade: boolean;
  friend: boolean;
  friend_auto_accept: boolean;
  friend_help_exp_limit: boolean;
  friend_steal: boolean;
  friend_help: boolean;
  friend_bad: boolean;
  friend_help_protect_dog_ignore_exp_limit: boolean;
  task: boolean;
  fertilizer_gift: boolean;
  fertilizer_buy_organic: boolean;
  fertilizer_buy_normal: boolean;
  mystery_shop_auto_buy: boolean;
  mystery_shop_allow_gold: boolean;
  mystery_shop_allow_coupon: boolean;
  mystery_shop_allow_gold_bean: boolean;
  mystery_shop_allow_diamond: boolean;
  mystery_shop_arrival_notify: boolean;
  mystery_shop_purchase_notify: boolean;
  sell: boolean;
  fertilizer: FertilizerMode;
  fertilizer_multi_season: boolean;
  fertilizer_land_types: FertilizerLandType[];
  fertilizer_smart_seconds: number;
  skip_own_weed_bug: boolean;
  show_manual_fertilizer: boolean;
  /** 节令日历：领节令直达奖励 / 领季度奖励 / 自动答题（只答官方标注过答案的题）。 */
  solar_calendar_claim_events: boolean;
  solar_calendar_claim_seasons: boolean;
  solar_calendar_answer_quiz: boolean;
  /** 牧歌初启：四类奖励领取 / 人格测试结算 + 首次分享奖励。 */
  muge_claim_rewards: boolean;
  muge_finish_survey: boolean;
  // 以薯换福：会改状态的自动动作默认关闭，由用户主动开启。
  yishu_claim_seed: boolean;
  yishu_share: boolean;
  yishu_auto_sell: boolean;
  /** 好友把蜜薯卖进本人铺子产生的收购提成到账后自动领取。 */
  yishu_claim_commission: boolean;
  /** 好友铺子当天都收满时，把剩下的卖给自己铺子。 */
  yishu_sell_fallback_own: boolean;
  /** 每次比价扫描的好友数量上限。 */
  yishu_scan_friend_limit: number;
  /** 两次比价之间的最小间隔（分钟）。 */
  yishu_scan_interval_minutes: number;
  /** 背包蜜薯达到该数量才进入比价卖薯。 */
  yishu_sell_min_count: number;
}

export interface IntervalConfig {
  farm: number;
  farmMin: number;
  farmMax: number;
  friendMin: number;
  friendMax: number;
  helpMin: number;
  helpMax: number;
  stealMin: number;
  stealMax: number;
  [key: string]: number;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  continueFarm: boolean;
}

export interface AccountConfig {
  automation: AutomationConfig;
  plantingStrategy: PlantingStrategy;
  preferredSeedId: number;
  intervals: IntervalConfig;
  friendQuietHours: QuietHoursConfig;
  knownFriendGids: number[];
  knownFriendGidSyncCooldownSec: number;
  friendsListCacheTtlSec: number;
  friendBlacklist: number[];
  ranchFriendBlacklist: number[];
  plantBlacklist: number[];
  stealDelaySeconds: number;
  plantOrderRandom: boolean;
  plantDelaySeconds: number;
  fertilizerBuyOrganicCount: number;
  fertilizerBuyOrganicThresholdHours: number;
  fertilizerBuyNormalCount: number;
  fertilizerBuyNormalThresholdHours: number;
  fertilizerBuyCheckIntervalMinutes: number;
  /** 每天检查邮箱奖励的时间（0-23 点，默认 10 点）；到点后每天只触发一次。 */
  emailClaimHour: number;
  bagSeedPriority: number[];
  /** 是否为明确排在前面的多格背包种子保留尚未连成布局的空地。 */
  bagSeedMultiLandReservationEnabled: boolean;
  /** seedId -> 允许种植的土地类型。缺 key 视为不限制。 */
  bagSeedLandTypes: Record<string, FertilizerLandType[]>;
  bagSeedFallbackStrategy: BagSeedFallbackStrategy;
  autoAcceptFriendMinLevel: number;
  autoAcceptRequireOwnLevel: boolean;
  autoAcceptHarvestStealEnabled: boolean;
  autoAcceptHarvestStealHarvest: number;
  autoAcceptHarvestStealSteal: number;
  /** 当前账号独立设备信息；新建账号时随机生成，可由用户自定义。 */
  deviceInfo?: DeviceInfo;
}

export interface OfflineReminderChannel {
  channel: string;
  enabled: boolean;
  endpoint: string;
  token: string;
  secret: string;
}

export interface PushTarget {
  id: string;
  label: string;
  /** 'admin' 表示管理员；其余为 user-store 的用户 id。 */
  ownerId: string;
  endpoint: string;
  enabled: boolean;
}

export interface RealtimePushConfig {
  enabled: boolean;
  /** 事件聚合窗口，避免每次操作都发消息被 QQ 限频。 */
  windowSec: number;
  /** 同一归属用户两次推送的最小间隔。 */
  minIntervalSec: number;
  /** 每个归属用户每日最多推送条数。 */
  dailyLimit: number;
  /** 是否用 QQ Markdown 卡片发送。 */
  markdown: boolean;
}

export interface DailyReportConfig {
  enabled: boolean;
  /** 24 小时制，服务器本地时区（面板 service 已设 TZ=Asia/Shanghai）。 */
  hour: number;
  minute: number;
  /** 明细里最多展示多少个账号，防止推送内容超过渠道字数上限。 */
  maxAccounts: number;
}

export interface OfflineReminder {
  notificationTypes: NotificationTypes;
  channels: OfflineReminderChannel[];
  channel: string;
  endpoint: string;
  token: string;
  secret: string;
  title: string;
  msg: string;
  offlineDeleteSec: number;
  dailyReport: DailyReportConfig;
  realtimePush: RealtimePushConfig;
  pushTargets: PushTarget[];
}

export interface UIConfig {
  theme: 'light' | 'dark';
}

export interface LoginSettings {
  wechatQrLogin: boolean;
  qqQrLogin: boolean;
  napCatEndpoint: string;
  napCatSignature: string;
}

export interface DeviceInfo {
  os: string;
  clientVersion: string;
  sysSoftware: string;
  network: string;
  memory: string;
  deviceId: string;
  userAgent: string;
}

export interface SystemConfig {
  serverUrl: string;
  clientVersion: string;
  clientVersionUpdatedAt?: number;
  wxClientVersion: string;
  wxClientVersionUpdatedAt?: number;
  platform: string;
  os: string;
  timeZone: string;
  deviceInfo: DeviceInfo;
}

export interface GlobalConfig {
  accountConfigs: Record<string, AccountConfig>;
  defaultAccountConfig: AccountConfig;
  ui: UIConfig;
  loginSettings: LoginSettings;
  offlineReminder: OfflineReminder;
  systemConfig: SystemConfig | null;
}
