import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { cancelLoginTask, createLoginTask, getMiniappCode, QQ_MINIAPP_APP_ID, queryLoginStatus, reinitializeLoginCore } from '../../services/qq-login/service';
export {};

const { createAuthRequired } = require('./middleware');

function publicTask(task: any) {
    return {
        task_id: task.taskId,
        status: task.status,
        qr_image: task.qrImage,
        expires_at: task.expiresAt,
    };
}

function sendError(res: Response, error: any, fallback: string): void {
    const payload: Record<string, unknown> = {
        ok: false,
        error: String(error?.message || '').trim() || fallback,
    };
    // 把可重试信息透传给前端：前端据此显示「N 秒后可重试」而不是一句干巴巴的失败。
    if (error?.code)
        payload.errorCode = String(error.code);
    if (typeof error?.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs))
        payload.retryAfterMs = Math.max(0, Math.round(error.retryAfterMs));
    if (typeof error?.phase === 'string')
        payload.phase = error.phase;
    res.json(payload);
}

function mountQqLoginRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/qq-login', createAuthRequired(ctx));

    app.post('/api/qq-login/tasks', async (_req: Request, res: Response) => {
        try {
            const task = await createLoginTask();
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录任务创建失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/status', async (req: Request, res: Response) => {
        try {
            const task = await queryLoginStatus(String(req.params.taskId || ''));
            res.json({ ok: true, data: publicTask(task) });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录状态查询失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/code', async (req: Request, res: Response) => {
        try {
            const result = await getMiniappCode(String(req.params.taskId || ''));
            res.json({ ok: true, data: { code: result.code, nickname: result.nickname || '', app_id: QQ_MINIAPP_APP_ID } });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 小程序授权 Code 获取失败');
        }
    });

    app.post('/api/qq-login/tasks/:taskId/cancel', async (req: Request, res: Response) => {
        try {
            await cancelLoginTask(String(req.params.taskId || ''));
            res.json({ ok: true });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 登录任务取消失败');
        }
    });

    // 手动初始化扫码能力：清掉卡死的任务/工作流/凭证，内核没救才重启 NapCat。
    app.post('/api/qq-login/reinit', async (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: await reinitializeLoginCore() });
        }
        catch (error: any) {
            sendError(res, error, 'QQ 扫码内核初始化失败');
        }
    });
}

module.exports = { mountQqLoginRoutes };
