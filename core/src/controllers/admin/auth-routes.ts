import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const adminStore = require('../../models/admin-store');
const userStore = require('../../models/user-store');
const { getActiveWebBuildId } = require('./web-version');

const {
    getClientIp,
    issueToken,
    createAuthRequired,
    getAccId,
    getAuth,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);

    // 统一登录入口：先匹配内置管理员用户名，其余走普通用户校验。
    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        const clientIp = getClientIp(req);
        const adminInfo = adminStore.getAdminInfo();
        const isAdminLogin = String(username) === adminInfo.username;

        if (isAdminLogin) {
            const result = adminStore.validateAdmin(String(username), String(password), clientIp);
            if (result?.error) {
                const statusCode = result.error === 'rate_limit' ? 429 : result.error === 'locked' ? 423 : 401;
                adminLogger.warn('登录失败', { username, error: result.error, ip: clientIp });
                return res.status(statusCode).json({
                    ok: false,
                    error: result.message,
                    errorType: result.error,
                    remainingMs: result.remainingMs,
                });
            }

            const session = userStore.createSession({
                userId: 'admin',
                username: result.username,
                role: 'admin',
                ip: clientIp,
            });
            const token = session.token;
            ctx.tokens.add(token);
            adminLogger.info('超级管理员登录成功', { username: result.username, ip: clientIp });
            return res.json({
                ok: true,
                data: {
                    token,
                    role: 'admin',
                    user: { username: result.username },
                    mustChangePassword: result.mustChangePassword === true,
                },
            });
        }

        const result = userStore.validateUser(String(username), String(password), clientIp);
        if (!result.ok) {
            adminLogger.warn('用户登录失败', { username, error: result.error, ip: clientIp });
            return res.status(401).json({
                ok: false,
                error: result.message,
                errorType: result.errorType,
                remainingMs: result.remainingMs,
            });
        }
        const token = userStore.createSession({
            userId: result.user.id,
            username: result.user.username,
            role: 'user',
            ip: clientIp,
        }).token;
        ctx.tokens.add(token);
        adminLogger.info('用户登录成功', { username: result.user.username, ip: clientIp });
        return res.json({
            ok: true,
            data: {
                token,
                role: 'user',
                user: result.user,
                expiresAt: result.user.expiresAt,
                mustChangePassword: result.user.mustChangePassword === true,
            },
        });
    });

    app.post('/api/user/change-password', authRequired, (req: Request, res: Response) => {
        const { oldPassword, newPassword } = req.body || {};
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }
        const auth = getAuth(req);
        if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

        if (auth.role === 'admin') {
            const result = adminStore.changePassword(String(oldPassword), String(newPassword));
            if (result.ok) {
                userStore.revokeRoleSessions('admin');
                ctx.tokens.clear();
                ctx.io?.disconnectSockets(true);
            }
            return res.json(result);
        }

        const result = userStore.changeUserPassword(auth.userId, String(oldPassword), String(newPassword));
        if (!result.ok) return res.json(result);
        // 改密后作废该用户全部旧 token，签发新 token 返回给前端替换。
        userStore.revokeUserSessions(auth.userId);
        // PersistentTokenSet 不支持遍历，只有内存 Set 才需要按 user-store 清理失效 token
        if (ctx.tokens instanceof Set) {
            for (const token of Array.from(ctx.tokens as Set<string>)) {
                if (!userStore.getSession(token)) ctx.tokens.delete(token);
            }
        }
        const token = userStore.createSession({
            userId: auth.userId,
            username: auth.username,
            role: 'user',
            ip: getClientIp(req),
        }).token;
        ctx.tokens.add(token);
        return res.json({ ok: true, message: '密码修改成功', token });
    });

    app.use('/api', (req: Request, res: Response, next: any) => {
        if (req.path === '/login' || req.path === '/register' || req.path === '/game-version'
            || req.path === '/free-claim' || req.path === '/free-claim/config'
            || req.path === '/free-claim/challenge') return next();
        return authRequired(req, res, next);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version, webBuildId: getActiveWebBuildId() } });
    });

    app.get('/api/game-version', async (_req: Request, res: Response) => {
        const { clientVersion, wxClientVersion } = getRuntimeConfig();
        const { getServiceSummary } = require('../../session/ipc');
        res.json({ ok: true, clientVersion, wxClientVersion, botVersion: version, serviceSummary: await getServiceSummary() });
    });

    app.get('/api/auth/validate', (req: Request, res: Response) => {
        const auth = getAuth(req);
        let expiresAt = auth?.expiresAt || 0;
        // 会话有效期最长 7 天，这里向前端展示账号真实到期时间。
        if (auth && auth.role === 'user') {
            const user = userStore.findById(auth.userId);
            if (user) expiresAt = Number(user.expiresAt) || 0;
        }
        res.json({
            ok: true,
            data: {
                valid: !!auth,
                role: auth?.role || '',
                username: auth?.username || '',
                expiresAt,
            },
        });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken;
        if (token) {
            userStore.revokeSession(String(token));
            ctx.tokens.delete(token);
        }
        if (ctx.io && token) {
            for (const socket of ctx.io.sockets.sockets.values()) {
                if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
            }
        }
        res.json({ ok: true });
    });

    app.get('/api/user/me', (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        if (auth.role === 'admin') {
            return res.json({ ok: true, data: { ...adminStore.getAdminInfo(), expiresAt: 0 } });
        }
        const user = userStore.findById(auth.userId);
        if (!user) return res.status(401).json({ ok: false, error: '用户不存在' });
        return res.json({ ok: true, data: userStore.publicUser(user) });
    });
}

module.exports = { mountAuthRoutes };
