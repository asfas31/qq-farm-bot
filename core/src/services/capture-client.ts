export {};
/**
 * QQ 自动抓包服务客户端：面板只跟本服务的 /api/capture 通信，
 * 由服务端转发到 qq-capture 网关，避免把网关地址暴露给浏览器。
 */

interface CaptureClientOptions {
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

interface CaptureRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
}

export function normalizeCaptureSession(payload: any = {}): any {
    const session = payload?.session && typeof payload.session === 'object' ? payload.session : payload;
    return {
        ...payload,
        ...session,
        sessionId: String(session?.id || payload?.sessionId || payload?.id || ''),
        statusText: payload?.statusText || payload?.message || session?.status,
        certUrl: payload?.certUrl,
    };
}

class CaptureClient {
    private baseUrl: string;
    private fetchImpl: typeof fetch;
    private timeoutMs: number;

    constructor(options: CaptureClientOptions = {}) {
        this.baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/, '');
        this.fetchImpl = options.fetch || globalThis.fetch;
        this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000) || 30000);
    }

    private assertConfigured(): void {
        if (!this.baseUrl) throw Object.assign(new Error('QQ 抓包服务地址未配置'), { status: 503 });
    }

    async request(path: string, options: CaptureRequestOptions = {}): Promise<any> {
        this.assertConfigured();
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: options.method || 'GET',
            headers: { 'content-type': 'application/json', ...(options.headers || {}) },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok === false) {
            throw Object.assign(
                new Error(payload?.error || payload?.message || `QQ 抓包服务请求失败: ${response.status}`),
                { status: response.status },
            );
        }
        return payload?.data !== undefined ? payload.data : payload;
    }

    async requestBinary(path: string, options: CaptureRequestOptions = {}): Promise<{ buffer: Buffer, contentType: string }> {
        this.assertConfigured();
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: options.method || 'GET',
            headers: options.headers || {},
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
            const payload = await response.json?.().catch(() => null);
            throw Object.assign(
                new Error(payload?.error || payload?.message || `QQ 抓包服务请求失败: ${response.status}`),
                { status: response.status },
            );
        }
        const contentType = response.headers?.get ? response.headers.get('content-type') || '' : '';
        return {
            buffer: Buffer.from(await response.arrayBuffer()),
            contentType: contentType || 'application/x-x509-ca-cert',
        };
    }

    async startSession(input: Record<string, unknown> = {}): Promise<any> {
        return normalizeCaptureSession(await this.request('/api/session/start', {
            method: 'POST',
            body: { platform: 'qq', ...input },
        }));
    }

    async pollSession(sessionId: string): Promise<any> {
        return normalizeCaptureSession(await this.request(`/api/session/${encodeURIComponent(String(sessionId))}`));
    }

    async cancelSession(sessionId: string): Promise<any> {
        return normalizeCaptureSession(await this.request(`/api/session/${encodeURIComponent(String(sessionId))}/stop`, { method: 'POST' }));
    }

    async getCert(): Promise<{ buffer: Buffer, contentType: string }> {
        return this.requestBinary('/api/cert');
    }
}

export { CaptureClient };
