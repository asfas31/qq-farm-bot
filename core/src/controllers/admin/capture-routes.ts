import type { Application, Request, Response, Router } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * QQ 自动抓包登录：面板通过本路由创建/轮询/取消抓包会话，
 * 服务端再转发到 qq-capture 网关。网关地址是服务端配置，不下发给普通用户。
 */

const express = require('express');
const store = require('../../models/store');
const { CaptureClient } = require('../../services/capture-client');
const { createAuthRequired } = require('./middleware');

interface CaptureRouterOptions {
    ttlMs?: number;
    now?: () => number;
    isEnabled?: () => boolean;
    getClient?: () => any;
}

function createCaptureRouter(options: CaptureRouterOptions = {}): Router {
    const router = express.Router();
    const sessions = new Map<string, { id: string, createdAt: number }>();
    const ttlMs = Math.max(60_000, Number(options.ttlMs || process.env.QQ_CAPTURE_SESSION_TTL_MS) || 1_800_000);
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
    const getClient = typeof options.getClient === 'function' ? options.getClient : () => null;

    function clientOrThrow(): any {
        if (!isEnabled()) {
            throw Object.assign(new Error('QQ 自动抓包登录未启用'), { status: 403 });
        }
        const client = getClient();
        if (!client) {
            throw Object.assign(new Error('QQ 抓包服务地址未配置'), { status: 503 });
        }
        return client;
    }

    function handleError(res: Response, error: any): void {
        const status = Number(error?.status) || 500;
        res.status(status >= 400 && status < 600 ? status : 500).json({
            ok: false,
            error: error?.message || 'QQ 抓包请求失败',
        });
    }

    function cleanup(): void {
        const current = now();
        for (const [id, session] of sessions) {
            if (current - session.createdAt > ttlMs) sessions.delete(id);
        }
    }

    router.get('/config', (_req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, data: { enabled: isEnabled(), configured: Boolean(getClient()), ttlMs } });
    });

    router.get('/cert', async (_req: Request, res: Response) => {
        try {
            const cert = await clientOrThrow().getCert();
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', cert.contentType || 'application/x-x509-ca-cert');
            res.setHeader('Content-Disposition', 'attachment; filename="qq-capture-ca.crt"');
            res.send(cert.buffer);
        } catch (err: any) {
            handleError(res, err);
        }
    });

    router.post('/sessions', async (req: Request, res: Response) => {
        cleanup();
        try {
            const data = await clientOrThrow().startSession(req.body || {});
            const id = String(data?.sessionId || data?.id || data?.uuid || '');
            if (id) sessions.set(id, { id, createdAt: now() });
            res.json({ ok: true, data });
        } catch (err: any) {
            handleError(res, err);
        }
    });

    router.get('/sessions/:id', async (req: Request, res: Response) => {
        cleanup();
        try {
            const id = String(req.params.id || '');
            if (!sessions.has(id)) {
                throw Object.assign(new Error('QQ 抓包会话已过期，请重新开始抓包'), { status: 410 });
            }
            const data = await clientOrThrow().pollSession(id);
            res.json({ ok: true, data });
        } catch (err: any) {
            handleError(res, err);
        }
    });

    router.delete('/sessions/:id', async (req: Request, res: Response) => {
        try {
            const client = getClient();
            if (client) await client.cancelSession(req.params.id);
            sessions.delete(String(req.params.id));
            res.json({ ok: true, data: { cancelled: true } });
        } catch (err: any) {
            handleError(res, err);
        }
    });

    (router as any).clearSessions = async (): Promise<void> => {
        sessions.clear();
    };

    return router;
}

function mountCaptureRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);
    let client: any = null;
    let clientKey = '';

    const getClient = () => {
        const settings = store.getLoginSettings ? store.getLoginSettings() : {};
        const baseUrl = String(settings?.qqCaptureApiUrl || process.env.QQ_CAPTURE_API_URL || '').trim().replace(/\/+$/, '');
        if (!baseUrl) return null;
        if (!client || clientKey !== baseUrl) {
            client = new CaptureClient({ baseUrl });
            clientKey = baseUrl;
        }
        return client;
    };

    const captureRouter = createCaptureRouter({
        getClient,
        isEnabled: () => {
            const settings = store.getLoginSettings ? store.getLoginSettings() : {};
            return settings?.qqCaptureEnabled === true;
        },
    });

    app.use('/api/capture', authRequired, captureRouter);
}

module.exports = { createCaptureRouter, mountCaptureRoutes, CaptureClient };
