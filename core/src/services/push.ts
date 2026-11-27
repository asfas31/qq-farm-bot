import type { OfflineReminderChannel } from '../types/config';
import { isPushChannelConfigured, parseQQBotTarget, PUSHOO_CHANNELS } from '../config/push-channels';
/**
 * 推送接口封装（基于 pushoo）
 */

const crypto = require('node:crypto');
const axios = require('axios').default;
const pushoo = require('pushoo').default;

const DINGTALK_WEBHOOK_PREFIX = 'https://oapi.dingtalk.com/robot/send?access_token=';
const MEOW_DEFAULT_BASE_URL = 'https://api.chuckfang.com';
const QQ_BOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_BOT_API_BASE = 'https://api.sgroup.qq.com';
const QQ_BOT_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
// access_token 两小时有效，按 AppID 缓存并在到期前 60 秒刷新，避免每次通知都取 token。
const qqBotTokenCache = new Map<string, { token: string, expiresAt: number }>();

function assertRequiredText(name: string, value: any): string {
    const text: string = String(value || '').trim();
    if (!text) {
        throw new Error(`${name} 不能为空`);
    }
    return text;
}

function createDingTalkSign(secretInput: any, timestampInput: any): string {
    const secret = assertRequiredText('钉钉加签密钥', secretInput);
    const timestamp = Math.trunc(Number(timestampInput));
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('钉钉加签时间戳无效');
    }
    return crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`, 'utf8')
        .digest('base64');
}

function buildDingTalkWebhook(endpointInput: any, tokenInput: any, secretInput: any = '', timestampInput: any = Date.now()): string {
    const endpoint = String(endpointInput || '').trim();
    const token = String(tokenInput || '').trim();
    const credential = assertRequiredText('钉钉 Webhook 地址', endpoint || token);
    const rawUrl = /^https?:\/\//i.test(credential)
        ? credential
        : `${DINGTALK_WEBHOOK_PREFIX}${encodeURIComponent(credential)}`;

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('钉钉 Webhook 地址格式无效');
    }
    const isOfficialWebhook = url.protocol === 'https:'
        && url.hostname.toLowerCase() === 'oapi.dingtalk.com'
        && url.pathname === '/robot/send'
        && !!url.searchParams.get('access_token');
    if (!isOfficialWebhook) {
        throw new Error('钉钉 Webhook 地址格式无效');
    }

    const secret = String(secretInput || '').trim();
    if (secret) {
        const timestamp = Math.trunc(Number(timestampInput));
        const sign = createDingTalkSign(secret, timestamp);
        url.searchParams.set('timestamp', String(timestamp));
        url.searchParams.set('sign', sign);
    }
    return url.toString();
}

async function sendDingTalkMessage(payload: any): Promise<any> {
    const url = buildDingTalkWebhook(payload.endpoint, payload.token, payload.secret);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const response = await axios.post(url, {
        msgtype: 'text',
        text: {
            content: `${title}\n${content}`,
        },
    });
    return response.data;
}

/**
 * 发送 MeoW 推送（鸿蒙 MeoW 消息推送 API）
 * @param payload
 * @param payload.token 必填 用户昵称（作为路径参数）
 * @param payload.endpoint 可选 自定义接口地址（默认 https://api.chuckfang.com）
 * @param payload.title 必填 推送标题
 * @param payload.content 必填 推送内容
 * @returns MeoW 推送结果
 */
async function sendMeowMessage(payload: any): Promise<any> {
    const nickname = assertRequiredText('MeoW 昵称', payload.token);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const baseUrl = String(payload.endpoint || MEOW_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('MeoW 接口地址格式无效');
    }
    const url = `${baseUrl}/${encodeURIComponent(nickname)}`;
    const response = await axios.post(url, {
        title,
        msg: content,
    });
    const data: any = (response && response.data && typeof response.data === 'object') ? response.data : {};
    const status: number = Number(data.status);
    if (Number.isFinite(status) && status !== 200) {
        // MeoW 业务状态码非 200 视为失败，转为 error 结构便于统一结果判断
        return {
            status,
            error: {
                message: String(data.msg || data.message || 'MeoW 推送失败'),
            },
        };
    }
    return data;
}

async function getQQBotAccessToken(appId: string, appSecret: string): Promise<string> {
    const cached = qqBotTokenCache.get(appId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    let data: any = null;
    try {
        const response = await axios.post(QQ_BOT_TOKEN_URL, {
            appId,
            clientSecret: appSecret,
        }, { timeout: 15000 });
        data = response.data;
    } catch (error: any) {
        data = error?.response?.data;
    }
    const token = String(data?.access_token || '').trim();
    if (!token) {
        const reason = String(data?.message || data?.errmsg || data?.error || '接口未返回 access_token');
        throw new Error(`QQ 机器人获取 Token 失败：${reason}`.slice(0, 300));
    }
    const expiresIn = Math.max(60, Number(data?.expires_in) || 7200);
    qqBotTokenCache.set(appId, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
}

/**
 * QQ 官方机器人推送。endpoint 配置为 c2c:OPENID / group:GROUP_OPENID / channel:CHANNEL_ID，
 * 沙箱环境在前面加 sandbox@。token 字段放 AppID，secret 字段放 AppSecret。
 * 主动消息不带 msg_id，受官方主动消息配额限制；msg_seq 每次随机以保证唯一。
 */
async function sendQQBotMessage(payload: any): Promise<any> {
    const target = parseQQBotTarget(payload.endpoint);
    if (!target) {
        throw new Error('QQ 机器人推送目标格式无效，应为 c2c:OPENID / group:GROUP_OPENID / channel:CHANNEL_ID');
    }
    const appId = assertRequiredText('QQ 机器人 AppID', payload.token);
    const appSecret = assertRequiredText('QQ 机器人 AppSecret', payload.secret);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);
    const text = `${title}\n${content}`.slice(0, 1800);
    const markdownText = String(payload.markdown || '').trim().slice(0, 4000);
    const useMarkdown = Boolean(markdownText) && target.type !== 'channel';
    const textBody: any = target.type === 'channel'
        ? { content: text }
        : { content: text, msg_type: 0, msg_seq: crypto.randomInt(1, 1_000_000) };
    const markdownBody: any = {
        msg_type: 2,
        markdown: { content: markdownText },
        msg_seq: crypto.randomInt(1, 1_000_000),
    };
    const base = target.sandbox ? QQ_BOT_SANDBOX_API_BASE : QQ_BOT_API_BASE;
    const path = target.type === 'c2c'
        ? `/v2/users/${encodeURIComponent(target.target)}/messages`
        : target.type === 'group'
            ? `/v2/groups/${encodeURIComponent(target.target)}/messages`
            : `/channels/${encodeURIComponent(target.target)}/messages`;
    const accessToken = await getQQBotAccessToken(appId, appSecret);
    const requestOptions = {
        headers: {
            Authorization: `QQBot ${accessToken}`,
            'X-Union-Appid': appId,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    };
    const post = (body: any) => axios.post(`${base}${path}`, body, requestOptions)
        .then((response: any) => response.data);

    const isMarkdownRejected = (code: number) => code === 40034127 || code === 40034011 || code === 40034024
        || code === 22006 || code === 304004 || code === 40034008;
    try {
        const data: any = useMarkdown ? await post(markdownBody) : await post(textBody);
        const code = Number(data?.code);
        // Markdown 权限/格式问题自动降级为纯文本，保证通知不丢。
        if (useMarkdown && isMarkdownRejected(code)) {
            return await post(textBody);
        }
        return data;
    } catch (error: any) {
        const data = error?.response?.data;
        // QQ 接口业务错误也走 200；非 2xx 且是 Markdown 权限问题时同样降级重试。
        if (data && typeof data === 'object') {
            if (useMarkdown && isMarkdownRejected(Number(data.code))) {
                return await post(textBody);
            }
            return data;
        }
        throw error;
    }
}

/**
 * 发送推送
 * @param payload
 * @param payload.channel 必填 推送渠道（pushoo 平台名，如 webhook）
 * @param payload.endpoint Webhook 接口地址（webhook、dingtalk 渠道使用）
 * @param payload.token 除 webhook、dingtalk 外的渠道必填；兼容旧版钉钉 access token
 * @param payload.secret 钉钉机器人加签密钥（可选）
 * @param payload.title 必填 推送标题
 * @param payload.content 必填 推送内容
 * @returns 推送结果
 */
async function sendPushooMessage(payload: any = {}): Promise<{ ok: boolean; code: string; msg: string; raw: any }> {
    const channel: string = assertRequiredText('channel', payload.channel);
    const endpoint: string = String(payload.endpoint || '').trim();
    const rawToken: string = String(payload.token || '').trim();
    const secret: string = String(payload.secret || '').trim();
    const token: string = channel === 'webhook' || channel === 'dingtalk'
        ? rawToken
        : channel === 'qqbot'
            ? assertRequiredText('QQ 机器人 AppID', rawToken)
            : assertRequiredText('token', rawToken);
    const title: string = assertRequiredText('title', payload.title);
    const content: string = assertRequiredText('content', payload.content);
    const markdown = String(payload.markdown || '').trim();

    const options: any = {};
    if (channel === 'webhook') {
        const url: string = assertRequiredText('endpoint', endpoint);
        options.webhook = { url, method: 'POST' };
    }

    const request: any = { title, content };
    if (token) request.token = token;
    if (channel === 'webhook') request.options = options;

    const result: any = channel === 'dingtalk'
        ? await sendDingTalkMessage({ endpoint, token, secret, title, content })
        : channel === 'meow'
            ? await sendMeowMessage({ endpoint, token, title, content })
            : channel === 'qqbot'
                ? await sendQQBotMessage({ endpoint, token, secret, title, content, markdown })
                : await pushoo(channel, request);

    const raw: any = (result && typeof result === 'object') ? result : { data: result };
    const hasError = Boolean(raw.error) || raw.ok === false || raw.success === false || raw.status === 'failed';
    const code = String(raw.code ?? raw.errcode ?? raw.retcode ?? raw.error_code ?? (hasError ? 'error' : 'ok'));
    const accepted = code === 'ok' || code === '0'
        || (code === '200' && ['pushplus', 'pushplushxtrip', 'bark'].includes(channel))
        || (channel === 'wxpusher' && code === '1000');
    const ok = !hasError && accepted;
    const message = String(raw.msg || raw.errmsg || raw.message || raw.description || raw.error?.message
        || (ok ? 'ok' : `推送失败（${code}）`));

    return {
        ok,
        code,
        msg: message,
        raw,
    };
}

function pushChannelError(entry: OfflineReminderChannel, required: boolean): string {
    if (!PUSHOO_CHANNELS.has(entry.channel)) return '不支持的推送渠道';
    if (entry.channel === 'qqbot') {
        if (entry.endpoint && !parseQQBotTarget(entry.endpoint)) {
            return 'QQ 机器人目标格式应为 c2c:OPENID / group:GROUP_OPENID / channel:CHANNEL_ID';
        }
        if (required) {
            if (!entry.token) return 'QQ 机器人需要填写 AppID';
            if (!entry.secret) return 'QQ 机器人需要填写 AppSecret';
            if (!parseQQBotTarget(entry.endpoint)) return 'QQ 机器人需要填写推送目标';
        }
    }
    if (required && !isPushChannelConfigured(entry)) {
        if (entry.channel === 'webhook') return 'Webhook 渠道需要填写接口地址';
        if (entry.channel === 'dingtalk') return '钉钉渠道需要填写 Webhook 地址';
        return '当前推送渠道需要填写 Token';
    }
    if (entry.channel === 'dingtalk' && entry.endpoint) {
        try {
            if (!/^https:\/\//i.test(entry.endpoint)) return '钉钉 Webhook 地址格式无效';
            buildDingTalkWebhook(entry.endpoint, '');
        } catch (error: any) {
            return error.message;
        }
    }
    return '';
}

async function sendPushChannels(
    channels: OfflineReminderChannel[], message: { title: string; content: string; markdown?: string }, send = sendPushooMessage,
) {
    return Promise.all(channels.map(async ({ channel, endpoint, token, secret }) => {
        try {
            const result = await send({ channel, endpoint, token, secret, ...message });
            return { ...result, channel };
        } catch (error) {
            return { channel, ok: false, msg: error instanceof Error ? error.message : String(error) };
        }
    }));
}

module.exports = {
    pushChannelError,
    sendPushChannels,
    buildDingTalkWebhook,
    createDingTalkSign,
    sendMeowMessage,
    getQQBotAccessToken,
    sendQQBotMessage,
    sendPushooMessage,
};
