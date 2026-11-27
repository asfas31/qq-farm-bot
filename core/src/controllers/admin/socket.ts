/**
 * Socket.IO setup and realtime emit functions.
 */
import type { AdminContext } from './context';
export {};

const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');
const SocketIOServer = Server;
const { getRuntimePaths } = require('../../config/runtime-paths');
const { getActiveWebBuildId } = require('./web-version');

const {
    resolveAccId,
    getAccountList,
} = require('./middleware');
const userStore = require('../../models/user-store');

function applySocketSubscription(ctx: AdminContext, socket: any, accountRef: string = ''): void {
    const incoming = String(accountRef || '').trim();
    let resolved = incoming && incoming !== 'all' ? resolveAccId(ctx, incoming) : '';

    // 普通用户只允许订阅自己名下的账号，避免房间串数据。
    const auth = socket.data.auth || null;
    if (resolved && auth && auth.role !== 'admin') {
        const target = getAccountList(ctx).find((account: any) => String(account.id) === resolved);
        if (!target || String(target.ownerId || '') !== auth.userId) resolved = '';
    }

    for (const room of socket.rooms) {
        if (room.startsWith('account:')) socket.leave(room);
    }
    if (resolved) {
        socket.join(`account:${resolved}`);
        socket.data.accountId = resolved;
    } else {
        socket.join('account:all');
        socket.data.accountId = '';
    }
    socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

    try {
        const targetId = socket.data.accountId || '';
        const isAdminSocket = !auth || auth.role === 'admin';
        const ownedIds = new Set<string>(getAccountList(ctx)
            .filter((account: any) => isAdminSocket || String(account.ownerId || '') === auth.userId)
            .map((account: any) => String(account.id)));
        if (targetId && ctx.provider && typeof ctx.provider.getStatus === 'function') {
            const currentStatus = ctx.provider.getStatus(targetId);
            socket.emit('status:update', { accountId: targetId, status: currentStatus });
        }
        if (ctx.provider && typeof ctx.provider.getLogs === 'function') {
            // 冗余缓存：逐块务农日志密集，前端要先聚合再截断，快照给足原始行
            let currentLogs: any[] = ctx.provider.getLogs(targetId, { limit: 500 });
            if (!Array.isArray(currentLogs)) currentLogs = [];
            if (!isAdminSocket) currentLogs = currentLogs.filter((entry: any) => ownedIds.has(String(entry?.accountId || '')));

            socket.emit('logs:snapshot', {
                accountId: targetId || 'all',
                logs: currentLogs,
            });
        }
        if (ctx.provider && typeof ctx.provider.getAccountLogs === 'function') {
            let currentAccountLogs: any[] = ctx.provider.getAccountLogs(100);
            if (!Array.isArray(currentAccountLogs)) currentAccountLogs = [];
            if (!isAdminSocket) currentAccountLogs = currentAccountLogs.filter((entry: any) => ownedIds.has(String(entry?.accountId || '')));

            socket.emit('account-logs:snapshot', {
                logs: currentAccountLogs,
            });
        }
    } catch {
        // ignore snapshot push errors
    }
}

function setupSocketIO(ctx: AdminContext): void {
    ctx.io = new SocketIOServer(ctx.server as any, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    ctx.io.use((socket: any, next: (err?: Error) => void) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        const session = token ? userStore.getSession(token) : null;
        if (!token || (!session && !ctx.tokens.has(token))) {
            return next(new Error('Unauthorized'));
        }
        socket.data.auth = session
            ? { userId: session.userId, role: session.role, username: session.username }
            : { userId: 'admin', role: 'admin', username: 'admin' };
        socket.data.adminToken = token;
        return next();
    });

    let lastNotifiedBuildId = getActiveWebBuildId();
    let webWatchTimer: ReturnType<typeof setTimeout> | null = null;
    let webWatcher: any = null;

    const notifyIfWebChanged = () => {
        const nextBuildId = getActiveWebBuildId();
        if (nextBuildId && nextBuildId !== lastNotifiedBuildId) {
            lastNotifiedBuildId = nextBuildId;
            ctx.io?.emit('panel:version', { webBuildId: nextBuildId, ts: Date.now() });
        }
    };

    try {
        const pointerFile = getRuntimePaths().webRootPointerFile;
        const pointerDir = path.dirname(pointerFile);
        const pointerName = path.basename(pointerFile);
        if (fs.existsSync(pointerDir)) {
            webWatcher = fs.watch(pointerDir, (_eventType: string, filename: string | Buffer | null) => {
                if (filename && String(filename) !== pointerName) return;
                if (webWatchTimer) clearTimeout(webWatchTimer);
                webWatchTimer = setTimeout(notifyIfWebChanged, 150);
                webWatchTimer.unref?.();
            });
            webWatcher.unref?.();
            webWatcher.on?.('error', () => {
                // ignore watcher errors on ephemeral filesystems
            });
        }
    } catch {
        // ignore fs.watch unsupported environments
    }

    ctx.server?.once('close', () => {
        if (webWatchTimer) {
            clearTimeout(webWatchTimer);
            webWatchTimer = null;
        }
        try {
            webWatcher?.close?.();
        } catch {
            // ignore close error
        }
        webWatcher = null;
    });

    ctx.io.on('connection', (socket: any) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(ctx, socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now(), webBuildId: getActiveWebBuildId() });

        socket.on('subscribe', (payload: any) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(ctx, socket, body.accountId || '');
        });
    });
}

function emitRealtimeStatus(ctx: AdminContext, accountId: string, status: any): void {
    if (!ctx.io) return;
    const id = String(accountId || '').trim();
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('log:new', payload);
}

function emitRealtimeAccountLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('account-log:new', payload);
}

module.exports = {
    setupSocketIO,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
