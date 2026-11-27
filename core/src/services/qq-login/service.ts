import type { LoginSettings } from '../../types/config';
export {};

const axios = require('axios').default;
const store = require('../../models/store');

const QQ_MINIAPP_APP_ID = '1112386029';
const REQUEST_TIMEOUT_MS = 120_000;

export type QqLoginTaskStatus
    = 'waiting_scan'
    | 'scanned'
    | 'confirmed'
    | 'cancelled'
    | 'expired'
    | 'failed';

export interface QqLoginTask {
    taskId: string;
    status: QqLoginTaskStatus;
    qrImage: string;
    expiresAt: number;
}

export interface QqMiniappLoginResult {
    code: string;
    nickname?: string;
}

function loginSettings(): LoginSettings {
    const settings = store.getLoginSettings();
    if (!settings?.qqQrLogin)
        throw new Error('QQ扫码登录未开启');
    if (!settings.napCatEndpoint || !settings.napCatSignature)
        throw new Error('请先配置 NapCat 接口地址和接口签名');
    return settings;
}

function apiUrl(endpoint: string, path: string): string {
    return `${endpoint.replace(/\/+$/, '')}${path}`;
}

function napCatErrorMessage(data: any): string {
    const errorCode = String(data?.code || '').trim().toUpperCase();
    switch (errorCode) {
        case 'SIGNATURE_REQUIRED':
            return 'NapCat 接口签名缺失，请检查配置';
        case 'INVALID_SIGNATURE':
            return 'NapCat 接口签名无效，请检查配置';
        case 'WORKFLOW_BUSY':
            return 'NapCat 登录工作流繁忙，请稍后重试';
        case 'LOGIN_REQUIRED':
            return 'QQ 登录尚未确认，请先完成扫码确认';
        case 'LOGOUT_REQUIRED':
            return '上一位 QQ 登录尚未注销，请稍后重试';
        case 'TASK_EXPIRED':
            return 'QQ 登录任务已过期，请重新获取二维码';
        case 'NAPCAT_REINIT':
            return 'QQ 登录内核正在重启，请稍后重试';
        case 'NAPCAT_CORE_NOT_READY':
            return 'QQ 登录内核尚未就绪，请稍后重试';
        case 'NAPCAT_UNREACHABLE':
            return '无法连接 NapCat 接口，请检查地址和服务状态';
        case 'NAPCAT_TIMEOUT':
            return 'NapCat 接口请求超时，请稍后重试';
        default:
            return `NapCat 接口返回失败${errorCode ? `（${errorCode}）` : ''}`;
    }
}

function normalizeTask(raw: any): QqLoginTask {
    const task = (raw?.task && typeof raw.task === 'object') ? raw.task : {};
    const taskId = String(task.id || '').trim();
    const status = String(task.status || '').trim() as QqLoginTaskStatus;
    const qrImage = String(task.qrImage || '').trim();
    const expiresAt = Number(task.expiresAt);
    if (!taskId)
        throw new Error('NapCat 返回的登录任务无效');
    if (!qrImage)
        throw new Error('NapCat 未返回登录二维码');
    return {
        taskId,
        status,
        qrImage,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    };
}

/**
 * 把上游 NapCat/miniapp-auth 的结构化错误透传出来。
 *
 * 上游返回的 code / phase / retryAfterMs 决定前端该显示「冷却多少秒」还是「重新扫码」，
 * 之前一律压成一句「NapCat 接口返回失败」，用户既不知道能不能重试，也不知道要等多久。
 */
function napCatError(code: string, message: string, extra: Record<string, unknown> = {}): Error & { code?: string, retryAfterMs?: number, phase?: string } {
    const error: any = new Error(message);
    error.code = code;
    if (typeof extra.retryAfterMs === 'number' && Number.isFinite(extra.retryAfterMs))
        error.retryAfterMs = extra.retryAfterMs;
    if (typeof extra.phase === 'string')
        error.phase = extra.phase;
    return error;
}

async function requestNapCat(path: string, body: Record<string, unknown>, requireOk = true): Promise<any> {
    const settings = loginSettings();
    let response;
    try {
        response = await axios.post(apiUrl(settings.napCatEndpoint, path), body, {
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: status => status === 200,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Signature': settings.napCatSignature,
            },
        });
    }
    catch (error: any) {
        if (error?.code === 'ECONNABORTED' || error?.message?.includes('timeout')) {
            throw napCatError('NAPCAT_TIMEOUT', 'NapCat 接口请求超时，请稍后重试');
        }
        throw napCatError('NAPCAT_UNREACHABLE', '无法连接 NapCat 接口，请检查地址和服务状态');
    }

    const data = response?.data;
    if (requireOk && (!data || typeof data !== 'object' || data.ok !== true)) {
        const upstreamCode = String(data?.code || '').trim().toUpperCase();
        const retryAfterMs = Number(data?.retryAfterMs);
        // WORKFLOW_BUSY / NAPCAT_REINIT 都带 retryAfterMs：直接用它做冷却秒数。
        if (upstreamCode === 'WORKFLOW_BUSY') {
            throw napCatError('WORKFLOW_BUSY', napCatErrorMessage(data), {
                retryAfterMs,
                phase: data?.phase,
            });
        }
        // 内核卡死并正在重启 NapCat：告诉用户稍等，重启完就能出码。
        if (upstreamCode === 'NAPCAT_REINIT') {
            throw napCatError('NAPCAT_REINIT', retryAfterMs > 0
                ? `QQ 登录内核正在重启，请等待 ${Math.max(1, Math.round(retryAfterMs / 1000))} 秒后重试`
                : 'QQ 登录内核正在重启，请稍后重试', { retryAfterMs });
        }
        // QRCode Get Error 属于 QQ 内核未就绪，可重试但有代价：给固定冷却。
        const rawError = String(data?.error || '');
        if (/qrcode (get|refresh) error/i.test(rawError)) {
            throw napCatError('NAPCAT_CORE_NOT_READY', 'QQ 登录内核尚未就绪，请稍后重试', { retryAfterMs: 10_000 });
        }
        throw napCatError(upstreamCode || 'NAPCAT_API_ERROR', napCatErrorMessage(data), { retryAfterMs });
    }
    return data;
}

async function createLoginTask(): Promise<QqLoginTask> {
    return normalizeTask(await requestNapCat('/api/qq/login/qrcode', {}));
}

async function queryLoginStatus(taskId: string): Promise<QqLoginTask> {
    const id = String(taskId || '').trim();
    if (!id)
        throw new Error('登录任务 ID 不能为空');
    return normalizeTask(await requestNapCat('/api/qq/login/status', {
        taskId: id,
        refresh: false,
    }));
}

async function getMiniappCode(taskId: string): Promise<QqMiniappLoginResult> {
    const id = String(taskId || '').trim();
    if (!id)
        throw new Error('登录任务 ID 不能为空');
    const data = await requestNapCat('/api/qq/miniapp/code', {
        taskId: id,
        appId: QQ_MINIAPP_APP_ID,
    });
    const code = String(data?.code || '').trim();
    if (!code)
        throw new Error('NapCat 未返回小程序授权 Code');
    const nickname = typeof data?.nickname === 'string' ? data.nickname.trim() : '';
    return nickname ? { code, nickname } : { code };
}

async function cancelLoginTask(taskId: string): Promise<void> {
    const id = String(taskId || '').trim();
    if (!id)
        throw new Error('登录任务 ID 不能为空');
    await requestNapCat('/api/qq/logout', {
        taskId: id,
    }, false);
}

export interface QqReinitResult {
    mode: string;
    coreReady: boolean;
    isLogin: boolean;
    restarting: boolean;
    retryAfterMs?: number;
    message: string;
}

/**
 * 手动初始化扫码内核。上游先做轻量重置（清孤儿任务/工作流/凭证并重刷二维码），
 * 内核确实没救时才重启 NapCat；重启是异步的，这里会拿到「正在重启」+ 建议冷却时间。
 */
async function reinitializeLoginCore(): Promise<QqReinitResult> {
    const data = await requestNapCat('/api/qq/reinit', {}, false);
    if (!data || typeof data !== 'object')
        throw napCatError('NAPCAT_API_ERROR', 'NapCat 未返回初始化结果');
    const retryAfterMs = Number(data.retryAfterMs);
    return {
        mode: String(data.mode || ''),
        coreReady: data.coreReady === true,
        isLogin: data.isLogin === true,
        restarting: data.restarting === true,
        retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, Math.round(retryAfterMs)) : undefined,
        message: typeof data.message === 'string' ? data.message : '',
    };
}

export {
    cancelLoginTask,
    createLoginTask,
    getMiniappCode,
    QQ_MINIAPP_APP_ID,
    queryLoginStatus,
    reinitializeLoginCore,
};
