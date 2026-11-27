import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 用户系统 / 卡密系统路由。
 *
 * 公开：POST /api/register              卡密 + 用户名 + 密码 开通账号
 *       GET  /api/free-claim/config     免费领取开关与时长
 *       POST /api/free-claim            按 IP 冷却领取一张免费卡密
 * 登录用户：POST /api/cardkeys/redeem    续费（再兑一张卡密）
 * 管理员：/api/admin/cardkeys*          卡密生成、禁用、删除
 *         /api/admin/users*             用户续期、禁用、重置密码、删除
 *         /api/admin/free-claim*        免费领取开关、时长、冷却、记录
 */

const store = require('../../models/store');
const userStore = require('../../models/user-store');
const cardkeyStore = require('../../models/cardkey-store');
const freeClaimStore = require('../../models/free-claim-store');
const adminStore = require('../../models/admin-store');
const security = require('../../models/auth-security');

const {
    getClientIp,
    createAdminRequired,
    getAuth,
    handleApiError,
} = require('./middleware');

function accountCountByOwner(): Record<string, number> {
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    const counts: Record<string, number> = {};
    for (const account of (data.accounts || [])) {
        const owner = String(account.ownerId || '');
        if (!owner) continue;
        counts[owner] = (counts[owner] || 0) + 1;
    }
    return counts;
}

function readCookie(req: Request, name: string): string {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        if (part.slice(0, index).trim() === name) {
            try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return part.slice(index + 1).trim(); }
        }
    }
    return '';
}

function ensureFingerprintCookie(req: Request, res: Response): string {
    const name = freeClaimStore.cookieName();
    const existing = readCookie(req, name);
    if (freeClaimStore.verifyFingerprintCookie(existing)) return existing;
    const fresh = freeClaimStore.newFingerprintCookie();
    res.cookie(name, fresh.value, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: freeClaimStore.cookieMaxAge(),
        path: '/',
    });
    return fresh.value;
}

function mountUserRoutes(app: Application, ctx: AdminContext): void {
    const adminRequired = createAdminRequired();

    // ---------- 公开：免费领卡密 ----------
    app.get('/api/free-claim/config', (req: Request, res: Response) => {
        ensureFingerprintCookie(req, res);
        res.json({ ok: true, data: freeClaimStore.publicConfig() });
    });

    app.get('/api/free-claim/challenge', (req: Request, res: Response) => {
        ensureFingerprintCookie(req, res);
        res.json({ ok: true, data: freeClaimStore.createChallenge() });
    });

    app.post('/api/free-claim', (req: Request, res: Response) => {
        const ip = getClientIp(req);
        // 领取请求不自动补发 Cookie：没有有效签名标识就明确要求刷新重试。
        const cookieValue = readCookie(req, freeClaimStore.cookieName());
        const limit = security.checkRateLimit(ip);
        if (!limit.allowed) {
            return res.status(429).json({ ok: false, error: limit.message, errorType: 'rate_limit', remainingMs: limit.remainingMs });
        }
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const result = freeClaimStore.claim(ip, body.fp, cookieValue, body.challenge, body.nonce);
        if (!result.ok) {
            const code = (result as any).code || 'CLAIM_FAILED';
            const statusCode = code === 'NEED_FP' ? 409
                : code === 'DAILY_LIMIT' || code === 'CLAIM_COOLDOWN' || code === 'rate_limit' ? 429
                : code === 'POW_FAILED' ? 400 : 403;
            return res.status(statusCode).json({
                ok: false,
                error: result.error,
                errorType: code,
                waitMs: (result as any).waitMs || 0,
            });
        }
        res.json({ ok: true, data: { code: result.key.code, days: result.key.days } });
    });

    // ---------- 公开：卡密开通 ----------
    app.post('/api/register', (req: Request, res: Response) => {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const ip = getClientIp(req);
        const limit = security.checkRateLimit(ip);
        if (!limit.allowed) {
            return res.status(429).json({ ok: false, error: limit.message, errorType: 'rate_limit', remainingMs: limit.remainingMs });
        }

        const cardKey = String(body.cardKey || body.code || '').trim();
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!cardKey) return res.status(400).json({ ok: false, error: '请输入卡密' });

        if (adminStore.getAdminInfo().username.toLowerCase() === username.toLowerCase()) {
            return res.status(400).json({ ok: false, error: '该用户名不可用' });
        }
        if (userStore.findByUsername(username)) {
            return res.status(400).json({ ok: false, error: '用户名已被占用' });
        }

        // 先验卡密，创建用户成功后再扣次数，避免建号失败白吞卡密。
        const checked = cardkeyStore.check(cardKey);
        if (!checked.ok) {
            return res.status(400).json({ ok: false, error: checked.error, errorType: checked.code });
        }

        const created = userStore.createUser({
            username,
            password,
            days: checked.key.days,
            cardKeyId: checked.key.id,
            note: checked.key.note,
        });
        if (!created.ok) {
            return res.status(400).json({ ok: false, error: created.error });
        }

        const consumed = cardkeyStore.consume(cardKey, { id: created.user.id, username: created.user.username });
        if (!consumed.ok) {
            // 极端并发下卡密刚被抢完：回滚用户，保持数据一致。
            userStore.deleteUser(created.user.id);
            return res.status(409).json({ ok: false, error: consumed.error, errorType: consumed.code });
        }

        const token = userStore.createSession({
            userId: created.user.id,
            username: created.user.username,
            role: 'user',
            ip,
        }).token;
        ctx.tokens.add(token);
        return res.json({
            ok: true,
            data: {
                token,
                role: 'user',
                user: created.user,
                expiresAt: created.user.expiresAt,
                cardKey: consumed.key,
            },
        });
    });

    // ---------- 登录用户：续费 ----------
    app.post('/api/cardkeys/redeem', (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'user') {
            return res.status(403).json({ ok: false, error: '管理员账号无需卡密续费' });
        }
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const cardKey = String(body.cardKey || body.code || '').trim();
        if (!cardKey) return res.status(400).json({ ok: false, error: '请输入卡密' });

        const checked = cardkeyStore.check(cardKey);
        if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error, errorType: checked.code });

        const extended = userStore.extendUser(auth.userId, checked.key.days);
        if (!extended.ok) return res.status(400).json({ ok: false, error: extended.error });

        const consumed = cardkeyStore.consume(cardKey, { id: auth.userId, username: auth.username });
        if (!consumed.ok) {
            return res.status(409).json({ ok: false, error: consumed.error, errorType: consumed.code });
        }
        return res.json({ ok: true, data: { user: extended.user, cardKey: consumed.key } });
    });

    app.get('/api/cardkeys/my', (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (!auth || auth.role !== 'user') return res.json({ ok: true, data: [] });
        const list = cardkeyStore.listKeys()
            .filter((key: any) => key.usedBy.some((item: any) => item.userId === auth.userId));
        return res.json({ ok: true, data: list });
    });

    // ---------- 用户：自己的推送绑定（每个用户独立） ----------
    app.get('/api/user/push-binding', (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        const targetId = auth.role === 'admin'
            ? String(req.query.userId || auth.userId)
            : auth.userId;
        if (auth.role === 'user' && targetId !== auth.userId) {
            return res.status(403).json({ ok: false, error: '只能查看自己的推送绑定' });
        }
        return res.json({ ok: true, data: userStore.getPushBinding(targetId) });
    });

    app.post('/api/user/push-binding', (req: Request, res: Response) => {
        try {
            const auth = getAuth(req);
            if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const targetId = auth.role === 'admin' && body.userId
                ? String(body.userId)
                : auth.userId;
            if (auth.role === 'user' && targetId !== auth.userId) {
                return res.status(403).json({ ok: false, error: '只能修改自己的推送绑定' });
            }
            const result = userStore.setPushBinding(targetId, {
                endpoint: body.endpoint,
                appId: body.appId,
                appSecret: body.appSecret,
                enabled: body.enabled !== false,
            });
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            return res.json({ ok: true, data: result.data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/user/push-settings', (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        const targetId = auth.role === 'admin' ? String(req.query.userId || auth.userId) : auth.userId;
        if (auth.role === 'user' && targetId !== auth.userId) {
            return res.status(403).json({ ok: false, error: '只能查看自己的推送设置' });
        }
        return res.json({ ok: true, data: userStore.getPushSettings(targetId) });
    });

    app.get('/api/user/default-strategy', (req: Request, res: Response) => {
        const auth = getAuth(req);
        if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        const targetId = auth.role === 'admin' ? String(req.query.userId || auth.userId) : auth.userId;
        if (auth.role === 'user' && targetId !== auth.userId) {
            return res.status(403).json({ ok: false, error: '只能查看自己的默认策略' });
        }
        return res.json({ ok: true, data: userStore.getDefaultStrategy(targetId) });
    });

    app.post('/api/user/default-strategy', (req: Request, res: Response) => {
        try {
            const auth = getAuth(req);
            if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const targetId = auth.role === 'admin' && body.userId ? String(body.userId) : auth.userId;
            if (auth.role === 'user' && targetId !== auth.userId) {
                return res.status(403).json({ ok: false, error: '只能修改自己的默认策略' });
            }
            const plantingAllowed = new Set(['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit', 'bag_priority']);
            const ranchAllowed = new Set(['level', 'max_exp', 'max_gold', 'preferred', 'bag_priority']);
            if (body.plantingStrategy !== undefined && !plantingAllowed.has(String(body.plantingStrategy))) {
                return res.status(400).json({ ok: false, error: '农场默认种植策略无效' });
            }
            const auto = (body.automation && typeof body.automation === 'object') ? body.automation : {};
            for (const key of ['ranch_strategy', 'ranch_bag_fallback']) {
                if (auto[key] !== undefined && !ranchAllowed.has(String(auto[key]))) {
                    return res.status(400).json({ ok: false, error: `${key} 无效` });
                }
            }
            const result = userStore.setDefaultStrategy(targetId, body);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            return res.json({ ok: true, data: result.data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/user/push-settings', (req: Request, res: Response) => {
        try {
            const auth = getAuth(req);
            if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const targetId = auth.role === 'admin' && body.userId ? String(body.userId) : auth.userId;
            if (auth.role === 'user' && targetId !== auth.userId) {
                return res.status(403).json({ ok: false, error: '只能修改自己的推送设置' });
            }
            const result = userStore.setPushSettings(targetId, body);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            return res.json({ ok: true, data: result.data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // ---------- 管理员：总览 ----------
    app.get('/api/admin/overview', adminRequired, (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                data: {
                    cardkeys: cardkeyStore.stats(),
                    users: userStore.stats(),
                    freeClaim: freeClaimStore.stats(),
                },
            });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // ---------- 管理员：免费领卡密开关 ----------
    app.get('/api/admin/free-claim/config', adminRequired, (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: freeClaimStore.getConfig() });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/free-claim/config', adminRequired, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const patch: any = {};
            if (body.enabled !== undefined) patch.enabled = body.enabled === true;
            for (const key of ['days', 'maxUses', 'cooldownHours', 'dailyLimit', 'powDifficulty', 'note']) {
                if (body[key] !== undefined) patch[key] = body[key];
            }
            const updated = freeClaimStore.setConfig(patch);
            res.json({ ok: true, data: updated });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/admin/free-claim/claims', adminRequired, (req: Request, res: Response) => {
        try {
            const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit as string) || 50));
            res.json({ ok: true, data: freeClaimStore.listClaims(limit) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // ---------- 管理员：卡密 ----------
    app.get('/api/admin/cardkeys', adminRequired, (req: Request, res: Response) => {
        try {
            const status = String(req.query.status || '').trim();
            const keyword = String(req.query.q || '').trim().toLowerCase();
            let list: any[] = cardkeyStore.listKeys();
            if (status) list = list.filter((key: any) => key.status === status);
            if (keyword) {
                list = list.filter((key: any) =>
                    key.code.toLowerCase().includes(keyword)
                    || String(key.note || '').toLowerCase().includes(keyword));
            }
            res.json({ ok: true, data: list });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/cardkeys', adminRequired, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const created = cardkeyStore.createKeys({
                count: body.count,
                days: body.days,
                maxUses: body.maxUses,
                note: body.note,
                expiresAt: body.expiresAt,
                createdBy: String(getAuth(req)?.username || 'admin'),
            });
            res.json({ ok: true, data: created });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/cardkeys/:id/status', adminRequired, (req: Request, res: Response) => {
        try {
            const status = String(req.body?.status || '');
            if (status !== 'active' && status !== 'disabled') {
                return res.status(400).json({ ok: false, error: 'status 只能是 active 或 disabled' });
            }
            const result = cardkeyStore.setStatus(req.params.id, status);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true, data: result.key });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/admin/cardkeys/:id', adminRequired, (req: Request, res: Response) => {
        try {
            const result = cardkeyStore.deleteKey(req.params.id);
            if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    /**
     * 批量操作。统一走 POST /api/admin/cardkeys/batch，避免 DELETE /:id 与 /batch 路由冲突。
     * body: { action: 'enable'|'disable'|'delete'|'note', ids: string[], note?: string }
     */
    app.post('/api/admin/cardkeys/batch', adminRequired, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const action = String(body.action || '').trim();
            const ids = Array.isArray(body.ids)
                ? body.ids.map((item: any) => String(item || '')).filter(Boolean).slice(0, 5000)
                : [];
            if (!ids.length) {
                return res.status(400).json({ ok: false, error: '请先选择卡密' });
            }
            if (action === 'enable' || action === 'disable') {
                const result = cardkeyStore.setStatusMany(ids, action === 'enable' ? 'active' : 'disabled');
                return res.json({ ok: true, data: result });
            }
            if (action === 'delete') {
                const result = cardkeyStore.deleteKeys(ids);
                return res.json({ ok: true, data: result });
            }
            if (action === 'note') {
                const result = cardkeyStore.setNoteMany(ids, String(body.note ?? ''));
                return res.json({ ok: true, data: result });
            }
            return res.status(400).json({ ok: false, error: '不支持的批量操作' });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // ---------- 管理员：用户 ----------
    app.get('/api/admin/users', adminRequired, (_req: Request, res: Response) => {
        try {
            const counts = accountCountByOwner();
            const users = userStore.listUsers().map((user: any) => ({
                ...user,
                accountCount: counts[user.id] || 0,
            }));
            res.json({ ok: true, data: users });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/users', adminRequired, (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (adminStore.getAdminInfo().username.toLowerCase() === String(body.username || '').toLowerCase()) {
                return res.status(400).json({ ok: false, error: '该用户名不可用' });
            }
            const created = userStore.createUser({
                username: String(body.username || ''),
                password: String(body.password || ''),
                days: Number(body.days) || 30,
                note: String(body.note || ''),
            });
            if (!created.ok) return res.status(400).json({ ok: false, error: created.error });
            res.json({ ok: true, data: created.user });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.get('/api/admin/users/:id/accounts', adminRequired, (req: Request, res: Response) => {
        try {
            const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
            const accounts = (data.accounts || []).filter((account: any) => String(account.ownerId || '') === req.params.id);
            res.json({ ok: true, data: accounts });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/users/:id/extend', adminRequired, (req: Request, res: Response) => {
        try {
            const days = Number(req.body?.days) || 0;
            const result = userStore.extendUser(req.params.id, days);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true, data: result.user });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/users/:id/status', adminRequired, (req: Request, res: Response) => {
        try {
            const enabled = req.body?.enabled === true;
            const result = userStore.setUserEnabled(req.params.id, enabled);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true, data: result.user });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/admin/users/:id/reset-password', adminRequired, (req: Request, res: Response) => {
        try {
            const result = userStore.resetUserPassword(req.params.id, req.body?.password ? String(req.body.password) : '');
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
            res.json({ ok: true, data: { password: result.password } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/admin/users/:id', adminRequired, (req: Request, res: Response) => {
        try {
            const result = userStore.deleteUser(req.params.id);
            if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 把已有账号转给某个用户（迁移老数据用）
    app.post('/api/admin/accounts/:id/owner', adminRequired, (req: Request, res: Response) => {
        try {
            const ownerId = String(req.body?.ownerId || '').trim();
            // admin 是内置归属标识，不是 users.json 里的记录。
            if (ownerId && ownerId !== 'admin' && !userStore.findById(ownerId)) {
                return res.status(404).json({ ok: false, error: '目标用户不存在' });
            }
            const { addOrUpdateAccount } = store;
            const data = addOrUpdateAccount({ id: String(req.params.id), ownerId });
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });
}

module.exports = { mountUserRoutes };
