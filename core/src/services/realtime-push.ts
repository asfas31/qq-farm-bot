export {};
/**
 * 实时操作推送：worker 上报的种植/收获/出售等事件，按归属用户聚合后推送。
 * 聚合窗口 + 最小间隔 + 每日上限三重限频，避免 QQ 主动消息被限流或刷屏。
 */

const { sendToOwnerTargets } = require('./daily-report');
const { readPushChannels } = require('../config/push-channels');
const { sendPushChannels } = require('./push');
const { getSystemDateKey } = require('../utils/utils');
const userStore = require('../models/user-store');

const EVENT_LABELS: Record<string, string> = {
    harvest: '🌾 收获',
    plant: '🌱 播种',
    sell: '💰 出售',
    steal: '🥷 偷菜',
    farming: '🪓 翻地',
    fertilize: '🧪 施肥',
    helpFarming: '🤝 帮忙',
    taskClaim: '🎁 领任务',
    upgrade: '⬆️ 升级',
    levelUp: '⭐ 升级',
    weed: '🌿 除草',
    bug: '🐛 除虫',
    'ranch:harvest': '🐄 牧场收获',
    'ranch:produce': '🥛 牧场生产',
    'ranch:steal': '🥷 牧场偷取',
    'ranch:helpFarming': '🤝 牧场帮忙',
};

const EVENT_ALIASES: Record<string, string> = {
    // 同一动作在 worker 里有两种事件名，合并到同一图标与文案。
    levelUp: 'upgrade',
};

interface Bucket {
    events: Map<string, number>;
    accounts: Set<string>;
    firstAt: number;
}

function clockText(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 发送一条实时动态。优先走归属用户的 QQ 机器人目标；管理员没有 QQ 目标时，
 * 回退到已启用的非 QQ 渠道（webhook / 企业微信 / Telegram 等），避免开了实时推送却收不到。
 */
async function deliverRealtimeMessage(options: {
    store: any;
    ownerId: string;
    message: { title: string; content: string; markdown?: string };
    sendPushooMessage: (payload: any) => Promise<any>;
    log?: (tag: string, msg: string) => void;
}): Promise<any[]> {
    const results = await sendToOwnerTargets({
        store: options.store,
        ownerId: options.ownerId,
        message: options.message,
        sendPushooMessage: options.sendPushooMessage,
        log: options.log,
    });
    if (!results.length && String(options.ownerId || 'admin') === 'admin') {
        const cfg = options.store.getOfflineReminder ? options.store.getOfflineReminder() : {};
        const channels = readPushChannels(cfg || {}).filter((entry: any) => entry.enabled && entry.channel !== 'qqbot');
        if (channels.length) {
            results.push(...await sendPushChannels(channels, options.message, options.sendPushooMessage));
        }
    }
    return results;
}

function createRealtimePushService(options: {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log?: (tag: string, msg: string) => void;
}) {
    const buckets = new Map<string, Bucket>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const counters = new Map<string, { date: string, count: number, lastAt: number }>();

    function config(owner = 'admin'): any {
        if (owner && owner !== 'admin' && userStore.getPushSettings) {
            try {
                // 用户被删除或配置损坏时回退到管理员配置，避免整个事件循环抛异常。
                const settings = userStore.getPushSettings(owner);
                if (settings?.realtimePush) return settings.realtimePush;
            } catch {
                // ignore and fall through
            }
        }
        const cfg = options.store.getOfflineReminder ? options.store.getOfflineReminder() : {};
        return cfg.realtimePush || { enabled: false, windowSec: 20, minIntervalSec: 60, dailyLimit: 120, markdown: true };
    }

    function findAccount(accountId: string): any {
        const accounts = (options.store.getAccounts ? options.store.getAccounts() : {})?.accounts || [];
        return accounts.find((account: any) => String(account.id) === accountId) || null;
    }

    function ownerOf(accountId: string): string {
        return String(findAccount(accountId)?.ownerId || 'admin');
    }

    function scheduleFlush(owner: string, delayMs: number): void {
        if (timers.has(owner)) return;
        const timer = setTimeout(() => {
            timers.delete(owner);
            void flush(owner);
        }, Math.max(1000, delayMs));
        if (timer.unref) timer.unref();
        timers.set(owner, timer);
    }

    function buildMessage(owner: string, bucket: Bucket, seq: number, dailyLimit: number, markdown: boolean) {
        const names = [...bucket.accounts]
            .map(id => String(findAccount(id)?.name || id))
            .slice(0, 3)
            .join('、');
        const more = bucket.accounts.size > 3 ? ` 等 ${bucket.accounts.size} 个账号` : '';
        const summary = (() => {
            // upgrade / levelUp 是同一个动作的两种事件名，按展示文案合并，避免一条卡片里出现两个「升级」。
            const totals = new Map<string, number>();
            for (const [key, count] of bucket.events) {
                const canonical = EVENT_ALIASES[key] || key;
                const label = EVENT_LABELS[canonical] || canonical;
                totals.set(label, (totals.get(label) || 0) + count);
            }
            return [...totals.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([label, count]) => `${label} ${count}`)
                .join('　');
        })();
        const time = clockText();
        const title = '🌱 农场实时动态';
        const content = [
            title,
            `${names}${more} · ${time}`,
            '',
            `本次操作：${summary}`,
            `今日第 ${seq}/${dailyLimit} 条`,
        ].join('\n');
        const md = [
            '## 🌱 农场实时动态',
            `**${names}${more}** · ${time}`,
            '',
            '> ' + summary.replace(/\u3000/g, ' ｜ '),
            '',
            `*今日第 ${seq}/${dailyLimit} 条 · ${owner === 'admin' ? '管理员' : owner}*`,
        ].join('\n');
        return { title, content, markdown: markdown ? md : '' };
    }

    function recordEvent(event: any): void {
        const accountId = String(event?.accountId || '');
        const count = Number(event?.count) || 0;
        const type = String(event?.type || '');
        const scene = event?.scene === 'ranch' ? 'ranch' : 'farm';
        const key = scene === 'ranch' ? `ranch:${type}` : type;
        if (!accountId || count <= 0 || !EVENT_LABELS[key]) return;

        const owner = ownerOf(accountId);
        const cfg = config(owner);
        if (!cfg.enabled) return;
        const date = getSystemDateKey();
        let counter = counters.get(owner) || { date, count: 0, lastAt: 0 };
        if (counter.date !== date) {
            counter.date = date;
            counter.count = 0;
            counter.lastAt = 0;
        }
        if (counter.count >= cfg.dailyLimit) return;
        counters.set(owner, counter);

        let bucket = buckets.get(owner);
        if (!bucket) {
            bucket = { events: new Map(), accounts: new Set(), firstAt: Date.now() };
            buckets.set(owner, bucket);
        }
        bucket.events.set(key, (bucket.events.get(key) || 0) + count);
        bucket.accounts.add(accountId);
        scheduleFlush(owner, cfg.windowSec * 1000);
    }

    async function flush(owner: string): Promise<void> {
        const bucket = buckets.get(owner);
        if (!bucket) return;
        const cfg = config(owner);
        if (!cfg.enabled) {
            buckets.delete(owner);
            return;
        }
        const gap = Date.now() - (counters.get(owner)?.lastAt || 0);
        const minGap = cfg.minIntervalSec * 1000;
        if (gap < minGap) {
            // 冷却期内不丢事件，等剩余时间到了再合并发送。
            scheduleFlush(owner, minGap - gap);
            return;
        }
        buckets.delete(owner);
        const counter = counters.get(owner) || { date: getSystemDateKey(), count: 0, lastAt: 0 };
        if (counter.count >= cfg.dailyLimit) return;
        counter.count += 1;
        counter.lastAt = Date.now();
        counters.set(owner, counter);
        const message = buildMessage(owner, bucket, counter.count, cfg.dailyLimit, cfg.markdown !== false);
        try {
            const results = await deliverRealtimeMessage({
                store: options.store,
                ownerId: owner,
                message,
                sendPushooMessage: options.sendPushooMessage,
                log: options.log,
            });
            for (const result of results) {
                if (options.log) {
                    options.log(result.ok ? '系统' : '错误', `实时${result.ok ? '推送成功' : `推送失败: ${result.msg}`}（${result.label || owner}）`);
                }
            }
        } catch (error: any) {
            if (options.log) options.log('错误', `实时推送异常: ${error?.message || String(error)}`);
        }
    }

    function stop(): void {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        buckets.clear();
        counters.clear();
    }

    return { recordEvent, flush, stop };
}

module.exports = { createRealtimePushService, deliverRealtimeMessage, EVENT_LABELS };
