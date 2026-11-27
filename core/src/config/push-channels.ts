import type { OfflineReminder, OfflineReminderChannel } from '../types/config';

export const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher', 'meow', 'qqbot',
]);

/**
 * QQ 官方机器人目标格式：<type>:<id>，type 支持 c2c / group / channel。
 * 需要沙箱环境时在前面加 sandbox@，例如 sandbox@group:GROUP_OPENID。
 */
export const QQ_BOT_TARGET_PATTERN = /^(?:sandbox@)?(c2c|group|channel):([A-Za-z0-9_\-+=/.]{6,128})$/;

export function parseQQBotTarget(input: unknown): { type: 'c2c' | 'group' | 'channel'; target: string; sandbox: boolean } | null {
    const text = String(input ?? '').trim();
    const matched = QQ_BOT_TARGET_PATTERN.exec(text);
    if (!matched) return null;
    return {
        type: matched[1] as 'c2c' | 'group' | 'channel',
        target: matched[2],
        sandbox: text.startsWith('sandbox@'),
    };
}

export function normalizePushChannel(input: Partial<OfflineReminderChannel>): OfflineReminderChannel {
    const channel = String(input.channel ?? '').trim().toLowerCase();
    let endpoint = String(input.endpoint ?? '').trim();
    let token = String(input.token ?? '').trim();
    const secret = String(input.secret ?? '').trim();
    if (channel === 'dingtalk' && token) {
        endpoint ||= /^https?:\/\//i.test(token) ? token : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`;
        token = '';
    }
    return { channel, endpoint, token, secret, enabled: input.enabled === true };
}

export function isPushChannelConfigured(entry: OfflineReminderChannel): boolean {
    if (entry.channel === 'qqbot') {
        return Boolean(parseQQBotTarget(entry.endpoint) && entry.token && entry.secret);
    }
    return Boolean(entry.channel === 'webhook' || entry.channel === 'dingtalk' ? entry.endpoint : entry.token);
}

export function readPushChannels(config: Partial<OfflineReminder>): OfflineReminderChannel[] {
    // 早期配置把渠道名存放在 endpoint，钉钉则可能只保存了 access token。
    const oldName = String(config.endpoint ?? '').trim().toLowerCase();
    const namedEndpoint = !config.channel && PUSHOO_CHANNELS.has(oldName);
    const entries = Array.isArray(config.channels) ? config.channels : [{
        ...config, channel: config.channel || (namedEndpoint ? oldName : 'webhook'),
        endpoint: namedEndpoint ? '' : config.endpoint, enabled: true,
    }];
    const channels = new Map<string, OfflineReminderChannel>();
    for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = normalizePushChannel(raw);
        if (!PUSHOO_CHANNELS.has(entry.channel) || !(entry.endpoint || entry.token || entry.secret)) continue;
        entry.enabled &&= isPushChannelConfigured(entry);
        channels.set(entry.channel, entry);
    }
    return [...channels.values()];
}

export function singlePushChannel(saved: OfflineReminder, update: Partial<OfflineReminderChannel>): OfflineReminderChannel {
    const channel = String(update.channel ?? saved.channel).trim().toLowerCase();
    const existing = saved.channels.find(entry => entry.channel === channel);
    return normalizePushChannel({ ...existing, ...update, channel, enabled: update.enabled ?? true });
}
