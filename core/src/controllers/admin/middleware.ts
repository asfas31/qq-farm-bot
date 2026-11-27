import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthInfo {
    userId: string;
    username: string;
    role: 'admin' | 'user';
    expiresAt: number;
}

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    auth?: AuthInfo;
}

function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first) return first;
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        if (!token) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        const session = userStore.getSession(token);
        if (session) {
            req.auth = {
                userId: session.userId,
                username: session.username,
                role: session.role,
                expiresAt: session.expiresAt,
            };
            req.adminToken = token;
            if (!ctx.tokens.has(token)) ctx.tokens.add(token);
            next();
            return;
        }
        // 兼容旧版内存 token（本进程内签发的管理员 token）
        if (ctx.tokens.has(token)) {
            req.auth = { userId: 'admin', username: 'admin', role: 'admin', expiresAt: 0 };
            req.adminToken = token;
            next();
            return;
        }
        res.status(401).json({ ok: false, error: 'Unauthorized' });
    };
}

/** 仅超级管理员可访问的路由守卫。 */
function createAdminRequired() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        if (!req.auth || req.auth.role !== 'admin') {
            res.status(403).json({ ok: false, error: '需要超级管理员权限', errorType: 'forbidden' });
            return;
        }
        next();
    };
}

function getAuth(req: Request): AuthInfo | null {
    return (req as AuthenticatedRequest).auth || null;
}

function isAdmin(req: Request): boolean {
    const auth = getAuth(req);
    return !!auth && auth.role === 'admin';
}

function ownsAccount(account: any, auth: AuthInfo | null): boolean {
    if (!account) return false;
    if (!auth) return false;
    if (auth.role === 'admin') return true;
    return String(account.ownerId || '') === auth.userId;
}

function scopedAccounts(ctx: AdminContext, req?: Request): any[] {
    const list = getAccountList(ctx);
    if (!req) return list;
    const auth = getAuth(req);
    if (!auth || auth.role === 'admin') return list;
    return list.filter(account => ownsAccount(account, auth));
}


function getAccountList(ctx: AdminContext): any[] {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) return data.accounts;
        }
    } catch {
        // Fall back to persistent storage.
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function getAccountIds(ctx: AdminContext, req?: Request): string[] {
    return scopedAccounts(ctx, req).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s+.*?)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    return message.match(/\bcode=\d+\b\s*(.*)$/)?.[1]?.trim() || '';
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider) return resolvedByProvider;
    }
    return resolveAccountId(getAccountList(ctx), input) || input;
}

function getAccId(ctx: AdminContext, req: Request): string {
    const id = resolveAccId(ctx, req.headers['x-account-id']);
    if (!id) return '';
    const auth = getAuth(req);
    if (!auth || auth.role === 'admin') return id;
    const account = getAccountList(ctx).find((item: any) => String(item.id) === id);
    return ownsAccount(account, auth) ? id : '';
}

/** 接口内显式传入账号引用时用它做归属校验（管理员放行）。 */
function canAccessAccount(ctx: AdminContext, req: Request, rawRef: any): boolean {
    const auth = getAuth(req);
    if (!auth) return false;
    if (auth.role === 'admin') return true;
    const ref = resolveAccId(ctx, rawRef);
    if (!ref) return false;
    const account = getAccountList(ctx).find((item: any) => String(item.id) === ref);
    return ownsAccount(account, auth);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
    };
}

module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    createAdminRequired,
    getAuth,
    isAdmin,
    ownsAccount,
    scopedAccounts,
    canAccessAccount,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
