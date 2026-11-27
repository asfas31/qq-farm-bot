export {};
/**
 * 每日统计推送：按配置时间汇总全部账号的资产与今日操作，格式化后推送到已启用的渠道。
 * 数据来自 provider.getStatus()（其中 operations 会回读当日 stats 文件），不额外占用 worker。
 */

const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');
const { getSystemDateKey, getSystemClockMinutes } = require('../utils/utils');
const { readPushChannels, parseQQBotTarget } = require('../config/push-channels');
const { sendPushChannels } = require('./push');
const statsService = require('./stats');
const assetSnapshot = require('./asset-snapshot');
const userStore = require('../models/user-store');

const MARKER_FILE = getDataFile('daily-report-last.json');

const OP_LABELS: Array<[string, string]> = [
    ['harvest', '收获'],
    ['plant', '播种'],
    ['steal', '偷菜'],
    ['farming', '翻地'],
    ['fertilize', '施肥'],
    ['helpFarming', '帮助'],
    ['taskClaim', '领任务'],
    ['sell', '出售'],
    ['upgrade', '升级'],
    ['weed', '除草'],
    ['bug', '除虫'],
];
const RANCH_LABELS: Array<[string, string]> = [
    ['harvest', '牧场收获'],
    ['produce', '牧场生产'],
    ['steal', '牧场偷取'],
    ['helpFarming', '牧场帮忙'],
];

function num(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function fmt(value: any): string {
    return Math.round(num(value)).toLocaleString('zh-CN');
}

function signed(value: any): string {
    const n = num(value);
    if (n === 0) return '±0';
    return `${n > 0 ? '+' : '-'}${fmt(Math.abs(n))}`;
}

function loadMarkers(): Record<string, { date: string, at: number }> {
    try {
        if (!fs.existsSync(MARKER_FILE)) return {};
        const raw = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
        // 兼容旧格式 {date, at}：视为管理员的记录
        if (raw && typeof raw === 'object' && typeof raw.date === 'string') {
            return { admin: { date: raw.date, at: Number(raw.at) || 0 } };
        }
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

function markSent(owner: string, date: string): void {
    const markers = loadMarkers();
    markers[String(owner || 'admin')] = { date, at: Date.now() };
    const dir = require('node:path').dirname(MARKER_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${MARKER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(markers, null, 2), 'utf8');
    fs.renameSync(tmp, MARKER_FILE);
}

function collectAccounts(provider: any, store: any, maxAccounts: number, ownerId?: string): any[] {
    const allAccounts = (store.getAccounts ? store.getAccounts() : {})?.accounts || [];
    // 按归属分组：管理员 'admin'、普通用户 user id；未指定 ownerId 才汇总全部。
    const accounts = ownerId === undefined
        ? allAccounts
        : allAccounts.filter((account: any) => String(account.ownerId || 'admin') === String(ownerId || 'admin'));
    const dateKey = getSystemDateKey();
    return accounts.map((account: any, index: number) => {
        const id = String(account.id || '');
        const status = (provider && typeof provider.getStatus === 'function')
            ? provider.getStatus(id)
            : null;
        const info = status?.status || {};
        const operations = status?.operations || {};
        const ranchOperations = status?.ranchOperations || {};
        const persisted = statsService.loadPersistedStats ? statsService.loadPersistedStats(id) : null;
        const snapshot = assetSnapshot.getAccountSnapshot(id);
        const isToday = persisted?.date === dateKey;
        const connected = Boolean(status?.connection?.connected);
        const baseGold = isToday ? num(persisted?.initialState?.gold) : num(info.gold);
        const gold = connected ? num(info.gold) : (snapshot ? num(snapshot.gold) : (isToday ? num(persisted?.initialState?.gold) : 0));
        const goldDelta = connected ? gold - baseGold : 0;
        return {
            id,
            index: index + 1,
            name: String(status?.accountName || account.name || account.remark || snapshot?.name || `账号 ${id}`).slice(0, 24),
            level: connected ? num(info.level) : num(snapshot?.level),
            gold,
            goldDelta,
            coupon: connected ? num(info.coupon) : num(snapshot?.coupon),
            exp: connected ? num(info.exp) : num(snapshot?.exp),
            connected,
            operations,
            ranchOperations,
        };
    }).slice(0, maxAccounts);
}

function opSummary(operations: any, labels: Array<[string, string]>): string {
    const parts = labels
        .map(([key, label]) => ({ label, value: num(operations?.[key]) }))
        .filter(item => item.value > 0)
        .map(item => `${item.label}${fmt(item.value)}`);
    return parts.length ? parts.join(' · ') : '无记录';
}

function formatReport(rows: any[], accountsTotal: number, dateKey: string): { title: string, content: string, markdown: string } {
    const online = rows.filter(row => row.connected).length;
    const totalGold = rows.reduce((sum, row) => sum + row.gold, 0);
    const totalCoupon = rows.reduce((sum, row) => sum + row.coupon, 0);
    const totalGoldDelta = rows.reduce((sum, row) => sum + row.goldDelta, 0);
    const totalOps: Record<string, number> = {};
    const totalRanch: Record<string, number> = {};
    for (const row of rows) {
        for (const [key] of OP_LABELS) totalOps[key] = (totalOps[key] || 0) + num(row.operations?.[key]);
        for (const [key] of RANCH_LABELS) totalRanch[key] = (totalRanch[key] || 0) + num(row.ranchOperations?.[key]);
    }
    const lines: string[] = [
        `📊 农场日报 · ${dateKey}`,
        '',
        '━━━━━━━━━━ 今日总览 ━━━━━━━━━━',
        `👥 账号 ${accountsTotal} 个｜在线 ${online} 个`,
        `💰 金币 ${fmt(totalGold)}　今日 ${signed(totalGoldDelta)}`,
        `🎫 点券 ${fmt(totalCoupon)}`,
        `🌾 ${opSummary(totalOps, OP_LABELS)}`,
        `🐄 ${opSummary(totalRanch, RANCH_LABELS)}`,
    ];
    const md: string[] = [
        `## 📊 农场日报`,
        `**${dateKey} · 服务器时区**`,
        '',
        `> 👥 账号 **${accountsTotal}** 个 ｜ 在线 **${online}** 个`,
        `> 💰 金币 **${fmt(totalGold)}**`,
        `> 📈 今日金币 **${signed(totalGoldDelta)}**`,
        `> 🎫 点券 **${fmt(totalCoupon)}**`,
        '',
        `**🌾 今日操作**`,
        opSummary(totalOps, OP_LABELS),
        '',
        `**🐄 牧场**`,
        opSummary(totalRanch, RANCH_LABELS),
    ];
    if (rows.length) {
        lines.push('', '━━━━━━━━━━ 账号明细 ━━━━━━━━━━');
        md.push('', '**账号明细**');
        rows.forEach((row) => {
            lines.push(`${row.index}. ${row.connected ? '🟢' : '💤'} ${row.name}  Lv.${fmt(row.level)}`);
            lines.push(`   💰 ${fmt(row.gold)} (${signed(row.goldDelta)})　🎫 ${fmt(row.coupon)}`);
            lines.push(`   🌾 ${opSummary(row.operations, OP_LABELS)}`);
            md.push(`${row.index}. ${row.connected ? '🟢' : '💤'} **${row.name}** · Lv.${fmt(row.level)}`);
            md.push(`   💰 ${fmt(row.gold)}（${signed(row.goldDelta)}）｜🎫 ${fmt(row.coupon)}`);
            md.push(`   🌾 ${opSummary(row.operations, OP_LABELS)}`);
            const ranch = opSummary(row.ranchOperations, RANCH_LABELS);
            if (ranch !== '无记录') {
                lines.push(`   🐄 ${ranch}`);
                md.push(`   🐄 ${ranch}`);
            }
        });
    }
    if (accountsTotal > rows.length) {
        lines.push(`… 其余 ${accountsTotal - rows.length} 个账号未展示`);
        md.push(`*其余 ${accountsTotal - rows.length} 个账号未展示*`);
    }
    const clock = getSystemClockMinutes();
    const clockText = `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
    lines.push('', `生成时间 ${dateKey} ${clockText}（服务器时区）`);
    md.push('', '---', `*生成时间 ${dateKey} ${clockText}*`);
    return { title: `📊 农场日报 · ${dateKey}`, content: lines.join('\n'), markdown: md.join('\n') };
}

/** 生成报表；QQ 机器人正文上限 1800 字，超限时逐步减少明细账号。 */
function buildDailyReport(provider: any, store: any, maxAccountsInput?: number, ownerId?: string): { title: string, content: string, markdown: string } {
    const cfg = store.getOfflineReminder ? store.getOfflineReminder() : {};
    const rawMax = num(maxAccountsInput ?? (ownerId && ownerId !== 'admin'
        ? userStore.getPushSettings(ownerId).dailyReport.maxAccounts
        : cfg?.dailyReport?.maxAccounts ?? 8));
    const maxAccounts = Math.min(30, Math.max(1, Math.round(rawMax) || 8));
    const accounts = collectAccounts(provider, store, 10000, ownerId);
    let limit = maxAccounts;
    let built = formatReport(collectAccounts(provider, store, limit, ownerId), accounts.length, getSystemDateKey());
    while (built.content.length > 1700 && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        built = formatReport(collectAccounts(provider, store, limit, ownerId), accounts.length, getSystemDateKey());
    }
    return built;
}

/**
 * 把一条消息发给某个归属用户的全部 QQ 机器人推送账号。
 * 日报和实时事件推送共用这一套目标解析逻辑，确保两边归属规则一致。
 */
async function sendToOwnerTargets(options: {
    store: any;
    ownerId: string;
    message: { title: string, content: string, markdown?: string };
    sendPushooMessage: (payload: any) => Promise<any>;
    log?: (tag: string, msg: string) => void;
}): Promise<any[]> {
    const cfg = options.store.getOfflineReminder ? options.store.getOfflineReminder() : {};
    const channels = readPushChannels(cfg || {}).filter((entry: any) => entry.enabled);
    const qq = channels.find((entry: any) => entry.channel === 'qqbot');
    if (!qq) return [];
    const owner = String(options.ownerId || 'admin');
    // 普通用户自己绑定的 QQ 机器人优先：密钥和目标都独立，不再走管理员的渠道。
    const binding = owner !== 'admin' ? userStore.getPushBinding(owner) : null;
    if (binding && binding.enabled && parseQQBotTarget(binding.endpoint)) {
        const entry = {
            ...qq,
            endpoint: binding.endpoint,
            token: binding.appId || qq.token,
            secret: binding.appSecret || qq.secret,
        };
        const sent = await sendPushChannels([entry], options.message, options.sendPushooMessage);
        return sent.map((result: any) => ({ ...result, label: '我的推送', ownerId: owner }));
    }
    let targets: any[] = (Array.isArray(cfg.pushTargets) ? cfg.pushTargets : [])
        .filter((entry: any) => entry.enabled
            && parseQQBotTarget(entry.endpoint)
            && String(entry.ownerId || 'admin') === owner);
    if (!targets.length && owner === 'admin' && parseQQBotTarget(qq.endpoint)) {
        // 兼容尚未配置推送账号列表的老配置
        targets = [{ id: 'legacy', label: '管理员', ownerId: 'admin', endpoint: qq.endpoint, enabled: true }];
    }
    const results: any[] = [];
    for (const target of targets) {
        const entry = { ...qq, endpoint: target.endpoint };
        const sent = await sendPushChannels([entry], options.message, options.sendPushooMessage);
        for (const result of sent) {
            results.push({ ...result, label: target.label || owner, ownerId: owner });
        }
    }
    return results;
}

/**
 * 发送一次报表。force=true 用于面板手动测试，不受定时开关限制；
 * 定时触发由调用方写发送标记，避免同一天重复推送。
 */
async function sendDailyReport(options: {
    provider: any;
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log?: (tag: string, msg: string) => void;
    maxAccounts?: number;
    /** 只给某个归属用户的推送账号发送（面板单点测试用）；不传则群发给所有推送账号。 */
    ownerId?: string;
}, force = false): Promise<any[]> {
    const cfg = options.store.getOfflineReminder ? options.store.getOfflineReminder() : {};
    // 定时触发时每个归属用户各自有开关；面板手动测试 force=true 不受开关限制。
    if (!force && options.ownerId === undefined && cfg?.dailyReport?.enabled !== true) return [];
    const channels = readPushChannels(cfg || {}).filter((entry: any) => entry.enabled);
    if (!channels.length) {
        if (options.log) options.log('错误', '每日报表未找到已启用的推送渠道');
        return [];
    }
    const results: any[] = [];
    const qqChannel = channels.find((entry: any) => entry.channel === 'qqbot');

    // 非 QQ 渠道（webhook / 企业微信 / Telegram 等）只发管理员全量汇总，不受归属拆分影响。
    const otherChannels = channels.filter((entry: any) => entry.channel !== 'qqbot');
    if (otherChannels.length && options.ownerId === undefined) {
        const report = buildDailyReport(options.provider, options.store, options.maxAccounts);
        results.push(...await sendPushChannels(otherChannels, report, options.sendPushooMessage));
    }

    if (qqChannel) {
        const owners = options.ownerId !== undefined
            ? [String(options.ownerId || 'admin')]
            : Array.from(new Set([
                ...((Array.isArray(cfg.pushTargets) ? cfg.pushTargets : []).map((entry: any) => String(entry.ownerId || 'admin'))),
                'admin',
            ]));
        for (const owner of owners) {
            const accountCount = collectAccounts(options.provider, options.store, 10000, owner).length;
            if (!accountCount) {
                if (options.log) options.log('系统', `每日报表跳过 ${owner}：名下没有账号`);
                continue;
            }
            const report = buildDailyReport(options.provider, options.store, options.maxAccounts, owner);
            results.push(...await sendToOwnerTargets({
                store: options.store,
                ownerId: owner,
                message: report,
                sendPushooMessage: options.sendPushooMessage,
                log: options.log,
            }));
        }
    }

    for (const result of results) {
        if (options.log) {
            const who = result.label ? `（${result.label}）` : '';
            options.log(result.ok ? '系统' : '错误', `每日报表${result.ok ? '发送成功' : `发送失败: ${result.msg}`}${who}`);
        }
    }
    return results;
}

/** 每分钟检查一次是否到达设定时刻；跨重启用 marker 文件去重。 */
function createDailyReportScheduler(options: {
    provider: any;
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log?: (tag: string, msg: string) => void;
}) {
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    async function check(): Promise<void> {
        if (inFlight) return;
        const cfg = options.store.getOfflineReminder ? options.store.getOfflineReminder() : {};
        const minutes = getSystemClockMinutes();
        const dateKey = getSystemDateKey();
        const markers = loadMarkers();
        const owners = [
            'admin',
            ...(userStore.listUsers ? userStore.listUsers().map((user: any) => String(user.id)) : []),
        ];
        const due: string[] = [];
        for (const owner of owners) {
            const daily = owner === 'admin'
                ? cfg?.dailyReport
                : userStore.getPushSettings(owner).dailyReport;
            if (!daily || daily.enabled !== true) continue;
            const target = num(daily.hour) * 60 + num(daily.minute);
            if (minutes < target || minutes >= target + 2) continue;
            if (markers[owner]?.date === dateKey) continue;
            due.push(owner);
        }
        if (!due.length) return;
        inFlight = true;
        try {
            for (const owner of due) {
                // 先写标记再发送：失败也等到下一天，避免每分钟重试轰炸渠道。
                markSent(owner, dateKey);
                await sendDailyReport({ ...options, ownerId: owner }, false);
            }
        } catch (error: any) {
            if (options.log) options.log('错误', `每日报表生成异常: ${error?.message || String(error)}`);
        } finally {
            inFlight = false;
        }
    }

    function start(): void {
        if (timer) return;
        void check();
        timer = setInterval(() => { void check(); }, 30_000);
        if (timer.unref) timer.unref();
    }

    function stop(): void {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { start, stop, check, build: () => buildDailyReport(options.provider, options.store) };
}

module.exports = {
    buildDailyReport,
    sendDailyReport,
    sendToOwnerTargets,
    createDailyReportScheduler,
    formatReport,
};
