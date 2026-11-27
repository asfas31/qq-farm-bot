export {};
/**
 * QQ 机器人扫码绑定。复用腾讯官方 @tencent-connect/qqbot-connector 的扫码状态机：
 * 手机 QQ 扫描二维码后直接拿到 AppID / AppSecret / 扫码者 OpenID。
 *
 * 每个用户（管理员 key=admin，普通用户 key=用户 id）有独立的扫码会话，
 * 避免多人同时绑定时互相覆盖二维码。
 *
 * connector 的 CJS 构建缺少扩展名，Node 直接 require 会报 MODULE_NOT_FOUND，
 * 这里用原生动态 import 加载 ESM 构建；new Function 避免 TS 把 import() 降级成 require()。
 */

const QRCode = require('qrcode');

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

interface QrCredentials {
    appId: string;
    appSecret: string;
    userOpenid?: string;
}

interface BindState {
    phase: 'idle' | 'waiting' | 'success' | 'failed';
    qrUrl?: string;
    qrImage?: string;
    issuedAt?: number;
    credentials?: QrCredentials;
    error?: string;
}

interface Session {
    state: BindState;
    stopFn: (() => void) | null;
    generation: number;
}

const sessions = new Map<string, Session>();

function sessionOf(key: string): Session {
    const id = String(key || 'admin');
    let session = sessions.get(id);
    if (!session) {
        session = { state: { phase: 'idle' }, stopFn: null, generation: 0 };
        sessions.set(id, session);
    }
    return session;
}

function snapshot(key = 'admin'): BindState {
    const session = sessionOf(key);
    return { ...session.state, credentials: session.state.credentials ? { ...session.state.credentials } : undefined };
}

function cancel(key = 'admin'): void {
    const session = sessionOf(key);
    session.generation++;
    if (session.stopFn) {
        try { session.stopFn(); } catch { /* ignore */ }
        session.stopFn = null;
    }
    session.state = { phase: 'idle' };
}

async function start(key = 'admin'): Promise<BindState> {
    cancel(key);
    const session = sessionOf(key);
    const myGeneration = session.generation;
    const connector = await dynamicImport('@tencent-connect/qqbot-connector');
    if (typeof connector.startQrConnect !== 'function') {
        session.state = { phase: 'failed', error: '扫码组件未正确加载' };
        return snapshot(key);
    }
    session.state = { phase: 'waiting', issuedAt: Date.now() };
    session.stopFn = connector.startQrConnect({
        onQrDisplayed: (url: string) => {
            if (myGeneration !== session.generation) return;
            const qrUrl = String(url || '');
            void QRCode.toDataURL(qrUrl, { width: 260, margin: 1 }).then((image: string) => {
                if (myGeneration !== session.generation || session.state.phase !== 'waiting') return;
                session.state = { ...session.state, qrUrl, qrImage: image, issuedAt: Date.now() };
            }).catch(() => {
                if (myGeneration !== session.generation || session.state.phase !== 'waiting') return;
                session.state = { ...session.state, qrUrl, issuedAt: Date.now() };
            });
        },
        onSuccess: (credentials: any[]) => {
            if (myGeneration !== session.generation) return;
            const cred = Array.isArray(credentials) ? credentials[0] : null;
            if (!cred || !cred.appId || !cred.appSecret) {
                session.state = { phase: 'failed', error: '扫码未返回有效凭据' };
                session.stopFn = null;
                return;
            }
            session.state = {
                phase: 'success',
                credentials: {
                    appId: String(cred.appId),
                    appSecret: String(cred.appSecret),
                    userOpenid: cred.userOpenid ? String(cred.userOpenid) : undefined,
                },
            };
            session.stopFn = null;
        },
        onFailure: (error: Error) => {
            if (myGeneration !== session.generation) return;
            session.state = { phase: 'failed', error: error?.message || String(error) };
            session.stopFn = null;
        },
    }, {
        displayQrCodeToConsole: false,
        source: 'qq-farm-bot',
    });
    return snapshot(key);
}

module.exports = { start, cancel, snapshot };
