export {};
/**
 * 用户账号与会话存储。
 *
 * 存储位置：<app>/data/users.json、<app>/data/sessions.json
 * 角色只有两种：
 *   - admin：内置超级管理员（仍由 admin-store 校验密码），可看全部账号、管理卡密；
 *   - user ：卡密开通的普通用户，只能看自己名下的 QQ 账号。
 *
 * 会话持久化到磁盘，进程重启后已登录用户不会被踢下线；
 * 有效期取「7 天」与「账号到期时间」中更早的那个，到期时间由卡密决定。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { parseQQBotTarget } = require('../config/push-channels');
const security = require('./auth-security');

const USERS_FILE: string = getDataFile('users.json');
const SESSIONS_FILE: string = getDataFile('sessions.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const MAX_FAILED_PER_USER = 10;
const FAILED_LOCK_MS = 15 * 60 * 1000;

interface PushBinding {
    endpoint: string;
    appId: string;
    appSecret: string;
    enabled: boolean;
    boundAt: number;
}

interface UserDefaultStrategy {
    plantingStrategy: string;
    automation: Record<string, any>;
}

interface UserPushSettings {
    dailyReport: { enabled: boolean, hour: number, minute: number, maxAccounts: number };
    realtimePush: { enabled: boolean, windowSec: number, minIntervalSec: number, dailyLimit: number, markdown: boolean };
}

interface UserRecord {
    id: string;
    username: string;
    password: string;
    role: 'user';
    createdAt: number;
    expiresAt: number;
    enabled: boolean;
    cardKeyId?: string;
    note?: string;
    mustChangePassword?: boolean;
    lastLoginAt?: number;
    pushBinding?: PushBinding;
    pushSettings?: UserPushSettings;
    defaultStrategy?: UserDefaultStrategy;
}

interface UsersData {
    nextId: number;
    users: UserRecord[];
}

interface SessionRecord {
    token: string;
    userId: string;
    username: string;
    role: 'admin' | 'user';
    createdAt: number;
    expiresAt: number;
    ip?: string;
}

interface SessionsData {
    sessions: Record<string, SessionRecord>;
}

let usersCache: UsersData | null = null;
let sessionsCache: SessionsData | null = null;
const failedLogins = new Map<string, { count: number; lockedUntil: number }>();

function atomicWrite(filePath: string, data: any): void {
    ensureDataDir();
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

function normalizeUserDefaultStrategy(raw: any): UserDefaultStrategy {
    const src = raw && typeof raw === 'object' ? raw : {};
    const automation = src.automation && typeof src.automation === 'object' && !Array.isArray(src.automation)
        ? src.automation
        : {};
    const result: UserDefaultStrategy = {
        plantingStrategy: String(src.plantingStrategy || 'max_exp').slice(0, 64),
        automation: {},
    };
    for (const [key, value] of Object.entries(automation)) {
        if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') {
            result.automation[String(key).slice(0, 64)] = value;
        }
    }
    if (!result.automation.ranch_strategy) result.automation.ranch_strategy = 'level';
    if (!result.automation.ranch_bag_fallback) result.automation.ranch_bag_fallback = 'level';
    return result;
}

const DEFAULT_USER_PUSH_SETTINGS: UserPushSettings = {
    dailyReport: { enabled: true, hour: 9, minute: 0, maxAccounts: 8 },
    realtimePush: { enabled: true, windowSec: 20, minIntervalSec: 60, dailyLimit: 120, markdown: true },
};

function normalizeUserPushSettings(raw: any): UserPushSettings {
    const src = raw && typeof raw === 'object' ? raw : {};
    const daily = src.dailyReport && typeof src.dailyReport === 'object' ? src.dailyReport : {};
    const realtime = src.realtimePush && typeof src.realtimePush === 'object' ? src.realtimePush : {};
    const clamp = (value: any, fallback: number, min: number, max: number) => {
        const n = Number.parseInt(value, 10);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    return {
        dailyReport: {
            enabled: daily.enabled === undefined ? DEFAULT_USER_PUSH_SETTINGS.dailyReport.enabled : daily.enabled === true,
            hour: clamp(daily.hour, DEFAULT_USER_PUSH_SETTINGS.dailyReport.hour, 0, 23),
            minute: clamp(daily.minute, DEFAULT_USER_PUSH_SETTINGS.dailyReport.minute, 0, 59),
            maxAccounts: clamp(daily.maxAccounts, DEFAULT_USER_PUSH_SETTINGS.dailyReport.maxAccounts, 1, 30),
        },
        realtimePush: {
            enabled: realtime.enabled === undefined ? DEFAULT_USER_PUSH_SETTINGS.realtimePush.enabled : realtime.enabled === true,
            windowSec: clamp(realtime.windowSec, DEFAULT_USER_PUSH_SETTINGS.realtimePush.windowSec, 5, 600),
            minIntervalSec: clamp(realtime.minIntervalSec, DEFAULT_USER_PUSH_SETTINGS.realtimePush.minIntervalSec, 10, 3600),
            dailyLimit: clamp(realtime.dailyLimit, DEFAULT_USER_PUSH_SETTINGS.realtimePush.dailyLimit, 1, 1000),
            markdown: realtime.markdown === undefined ? DEFAULT_USER_PUSH_SETTINGS.realtimePush.markdown : realtime.markdown === true,
        },
    };
}

function normalizePushBinding(raw: any): PushBinding | null {
    if (!raw || typeof raw !== 'object') return null;
    const endpoint = String(raw.endpoint || '').trim();
    if (!parseQQBotTarget(endpoint)) return null;
    return {
        endpoint,
        appId: String(raw.appId || '').trim(),
        appSecret: String(raw.appSecret || '').trim(),
        enabled: raw.enabled !== false,
        boundAt: Number(raw.boundAt) || 0,
    };
}

function normalizeUser(raw: any): UserRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const username = String(raw.username || '').trim();
    if (!username || !raw.password) return null;
    const now = Date.now();
    return {
        id: String(raw.id || ''),
        username,
        password: String(raw.password),
        role: 'user',
        createdAt: Number(raw.createdAt) || now,
        expiresAt: Number(raw.expiresAt) || 0,
        enabled: raw.enabled !== false,
        cardKeyId: raw.cardKeyId ? String(raw.cardKeyId) : undefined,
        note: raw.note ? String(raw.note) : undefined,
        mustChangePassword: raw.mustChangePassword === true || undefined,
        lastLoginAt: Number(raw.lastLoginAt) || undefined,
        pushBinding: normalizePushBinding(raw.pushBinding) || undefined,
        pushSettings: normalizeUserPushSettings(raw.pushSettings),
        defaultStrategy: normalizeUserDefaultStrategy(raw.defaultStrategy),
    };
}

function loadUsers(): UsersData {
    if (usersCache) return usersCache;
    ensureDataDir();
    let raw: any = { users: [], nextId: 1 };
    try {
        if (fs.existsSync(USERS_FILE)) raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
        raw = { users: [], nextId: 1 };
    }
    const users: UserRecord[] = (Array.isArray(raw?.users) ? raw.users : [])
        .map(normalizeUser)
        .filter((user: UserRecord | null): user is UserRecord => !!user && !!user.id);
    const maxId = users.reduce((max: number, user: UserRecord) => Math.max(max, Number.parseInt(user.id, 10) || 0), 0);
    usersCache = { users, nextId: Math.max(Number(raw?.nextId) || 1, maxId + 1) };
    return usersCache;
}

function saveUsers(): void {
    if (!usersCache) return;
    atomicWrite(USERS_FILE, usersCache);
}

function loadSessions(): SessionsData {
    if (sessionsCache) return sessionsCache;
    ensureDataDir();
    let raw: any = { sessions: {} };
    try {
        if (fs.existsSync(SESSIONS_FILE)) raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch {
        raw = { sessions: {} };
    }
    const now = Date.now();
    const sessions: Record<string, SessionRecord> = {};
    const source = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {};
    for (const [token, value] of Object.entries<any>(source)) {
        if (!value || !value.userId) continue;
        if (Number(value.expiresAt) <= now) continue;
        sessions[token] = {
            token,
            userId: String(value.userId),
            username: String(value.username || ''),
            role: value.role === 'admin' ? 'admin' : 'user',
            createdAt: Number(value.createdAt) || now,
            expiresAt: Number(value.expiresAt) || now,
            ip: value.ip ? String(value.ip) : undefined,
        };
    }
    sessionsCache = { sessions };
    return sessionsCache;
}

function saveSessions(): void {
    if (!sessionsCache) return;
    atomicWrite(SESSIONS_FILE, sessionsCache);
}

function publicUser(user: UserRecord) {
    return {
        id: user.id,
        username: user.username,
        role: 'user' as const,
        createdAt: user.createdAt,
        expiresAt: user.expiresAt,
        enabled: user.enabled,
        mustChangePassword: user.mustChangePassword === true,
        pushBinding: user.pushBinding ? {
            endpoint: user.pushBinding.endpoint,
            appId: user.pushBinding.appId,
            enabled: user.pushBinding.enabled,
            boundAt: user.pushBinding.boundAt,
        } : undefined,
    };
}

function findById(id: string): UserRecord | null {
    const data = loadUsers();
    return data.users.find(user => user.id === String(id)) || null;
}

function findByUsername(username: string): UserRecord | null {
    const key = String(username || '').trim().toLowerCase();
    if (!key) return null;
    const data = loadUsers();
    return data.users.find(user => user.username.toLowerCase() === key) || null;
}

function listUsers() {
    return loadUsers().users.map(publicUser);
}

function createUser(input: { username: string; password: string; days: number; cardKeyId?: string; note?: string }) {
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!USERNAME_RE.test(username)) {
        return { ok: false as const, error: '用户名需为 3-32 位字母、数字或下划线' };
    }
    const strength = security.validatePasswordStrength(password);
    if (!strength.valid) {
        return { ok: false as const, error: strength.errors.join('；') };
    }
    if (findByUsername(username)) {
        return { ok: false as const, error: '用户名已被占用' };
    }
    const days = Math.max(1, Math.min(3650, Math.floor(Number(input.days) || 0)));
    if (!days) return { ok: false as const, error: '卡密时长无效' };

    const data = loadUsers();
    const id = String(data.nextId++);
    const now = Date.now();
    const user: UserRecord = {
        id,
        username,
        password: security.hashPassword(password),
        role: 'user',
        createdAt: now,
        expiresAt: now + days * 24 * 60 * 60 * 1000,
        enabled: true,
        cardKeyId: input.cardKeyId,
        note: input.note,
    };
    data.users.push(user);
    saveUsers();
    return { ok: true as const, user: publicUser(user) };
}

function validateUser(username: string, password: string, ip: string = 'unknown') {
    const key = String(username || '').trim().toLowerCase();
    const lock = failedLogins.get(key);
    const now = Date.now();
    if (lock && lock.lockedUntil > now) {
        return {
            ok: false as const,
            error: 'locked',
            errorType: 'locked',
            message: `登录失败次数过多，请 ${Math.ceil((lock.lockedUntil - now) / 60000)} 分钟后重试`,
            remainingMs: lock.lockedUntil - now,
        };
    }
    const user = findByUsername(username);
    if (!user || !security.verifyPassword(String(password || ''), user.password)) {
        const next = lock && lock.lockedUntil <= now ? { count: 1, lockedUntil: 0 } : { count: (lock?.count || 0) + 1, lockedUntil: 0 };
        if (next.count >= MAX_FAILED_PER_USER) next.lockedUntil = now + FAILED_LOCK_MS;
        failedLogins.set(key, next);
        return {
            ok: false as const,
            error: 'invalid_credentials',
            errorType: 'invalid_credentials',
            message: next.lockedUntil
                ? `登录失败次数过多，请 ${FAILED_LOCK_MS / 60000} 分钟后重试`
                : `用户名或密码错误，剩余尝试次数: ${Math.max(0, MAX_FAILED_PER_USER - next.count)}`,
        };
    }
    failedLogins.delete(key);
    if (!user.enabled) {
        return { ok: false as const, error: 'disabled', errorType: 'disabled', message: '账号已被管理员禁用' };
    }
    if (user.expiresAt && user.expiresAt <= now) {
        return { ok: false as const, error: 'expired', errorType: 'expired', message: '卡密已到期，请续费后登录' };
    }
    if (security.needsRehash(user.password)) {
        user.password = security.hashPassword(password);
    }
    user.lastLoginAt = now;
    saveUsers();
    return { ok: true as const, user: publicUser(user) };
}

function extendUser(id: string, days: number) {
    const amount = Math.floor(Number(days) || 0);
    if (amount <= 0 || amount > 3650) return { ok: false as const, error: '续费天数需在 1-3650 之间' };
    const user = findById(id);
    if (!user) return { ok: false as const, error: '用户不存在' };
    const base = Math.max(Date.now(), user.expiresAt || 0);
    user.expiresAt = base + amount * 24 * 60 * 60 * 1000;
    user.enabled = true;
    saveUsers();
    return { ok: true as const, user: publicUser(user) };
}

function setUserEnabled(id: string, enabled: boolean) {
    const user = findById(id);
    if (!user) return { ok: false as const, error: '用户不存在' };
    user.enabled = enabled === true;
    saveUsers();
    if (!user.enabled) revokeUserSessions(user.id);
    return { ok: true as const, user: publicUser(user) };
}

function resetUserPassword(id: string, newPassword?: string) {
    const user = findById(id);
    if (!user) return { ok: false as const, error: '用户不存在' };
    const password = newPassword && String(newPassword).trim()
        ? String(newPassword)
        : crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
    const strength = security.validatePasswordStrength(password);
    if (!strength.valid) return { ok: false as const, error: strength.errors.join('；') };
    user.password = security.hashPassword(password);
    user.mustChangePassword = true;
    saveUsers();
    revokeUserSessions(user.id);
    return { ok: true as const, password };
}

function changeUserPassword(id: string, oldPassword: string, newPassword: string) {
    const user = findById(id);
    if (!user) return { ok: false as const, error: '用户不存在' };
    if (!security.verifyPassword(String(oldPassword || ''), user.password)) {
        return { ok: false as const, error: '当前密码错误' };
    }
    const strength = security.validatePasswordStrength(newPassword);
    if (!strength.valid) return { ok: false as const, error: strength.errors.join('；') };
    user.password = security.hashPassword(newPassword);
    delete user.mustChangePassword;
    saveUsers();
    return { ok: true as const };
}

function deleteUser(id: string) {
    const data = loadUsers();
    const index = data.users.findIndex(user => user.id === String(id));
    if (index < 0) return { ok: false as const, error: '用户不存在' };
    const [removed] = data.users.splice(index, 1);
    saveUsers();
    revokeUserSessions(removed.id);
    return { ok: true as const };
}

function createSession(input: { userId: string; username: string; role: 'admin' | 'user'; ip?: string }): SessionRecord {
    const data = loadSessions();
    const now = Date.now();
    let expiresAt = now + SESSION_TTL_MS;
    if (input.role === 'user') {
        const user = findById(input.userId);
        if (user && user.expiresAt > 0) expiresAt = Math.min(expiresAt, user.expiresAt);
    }
    const token = crypto.randomBytes(24).toString('hex');
    const session: SessionRecord = {
        token,
        userId: input.userId,
        username: input.username,
        role: input.role,
        createdAt: now,
        expiresAt,
        ip: input.ip,
    };
    data.sessions[token] = session;
    saveSessions();
    return session;
}

function getSession(token: string): SessionRecord | null {
    if (!token) return null;
    const data = loadSessions();
    const session = data.sessions[token];
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt <= now) {
        delete data.sessions[token];
        saveSessions();
        return null;
    }
    if (session.role === 'user') {
        const user = findById(session.userId);
        if (!user || !user.enabled) {
            delete data.sessions[token];
            saveSessions();
            return null;
        }
        if (user.expiresAt && user.expiresAt <= now) {
            delete data.sessions[token];
            saveSessions();
            return null;
        }
    }
    return session;
}

function revokeSession(token: string): void {
    const data = loadSessions();
    if (data.sessions[token]) {
        delete data.sessions[token];
        saveSessions();
    }
}

function revokeUserSessions(userId: string): void {
    const data = loadSessions();
    let changed = false;
    for (const [token, session] of Object.entries(data.sessions)) {
        if (session.userId === String(userId)) {
            delete data.sessions[token];
            changed = true;
        }
    }
    if (changed) saveSessions();
}

function revokeRoleSessions(role: 'admin' | 'user'): void {
    const data = loadSessions();
    let changed = false;
    for (const [token, session] of Object.entries(data.sessions)) {
        if (session.role === role) {
            delete data.sessions[token];
            changed = true;
        }
    }
    if (changed) saveSessions();
}

function stats() {
    const now = Date.now();
    const users = loadUsers().users;
    return {
        total: users.length,
        active: users.filter(user => user.enabled && (!user.expiresAt || user.expiresAt > now)).length,
        expired: users.filter(user => !!user.expiresAt && user.expiresAt <= now).length,
        disabled: users.filter(user => !user.enabled).length,
    };
}

function getPushBinding(id: string): PushBinding | null {
    const binding = findById(id)?.pushBinding;
    return binding ? { ...binding } : null;
}

function setPushBinding(id: string, input: any): { ok: boolean, error?: string, data?: PushBinding } {
    const user = findById(id);
    if (!user) return { ok: false, error: '用户不存在' };
    const endpoint = String(input?.endpoint || '').trim();
    if (!parseQQBotTarget(endpoint)) {
        return { ok: false, error: '推送目标格式应为 c2c:OPENID / group:GROUP_OPENID / channel:CHANNEL_ID' };
    }
    const binding: PushBinding = {
        endpoint,
        appId: String(input?.appId || '').trim(),
        appSecret: String(input?.appSecret || '').trim(),
        enabled: input?.enabled !== false,
        boundAt: Date.now(),
    };
    user.pushBinding = binding;
    saveUsers();
    return { ok: true, data: { ...binding } };
}

function getPushSettings(id: string): UserPushSettings {
    return normalizeUserPushSettings(findById(id)?.pushSettings);
}

function setPushSettings(id: string, input: any): { ok: boolean, error?: string, data?: UserPushSettings } {
    const user = findById(id);
    if (!user) return { ok: false, error: '用户不存在' };
    const next = normalizeUserPushSettings({
        dailyReport: { ...getPushSettings(id).dailyReport, ...(input?.dailyReport || {}) },
        realtimePush: { ...getPushSettings(id).realtimePush, ...(input?.realtimePush || {}) },
    });
    user.pushSettings = next;
    saveUsers();
    return { ok: true, data: next };
}

function getDefaultStrategy(id: string): UserDefaultStrategy {
    return normalizeUserDefaultStrategy(findById(id)?.defaultStrategy);
}

function setDefaultStrategy(id: string, input: any): { ok: boolean, error?: string, data?: UserDefaultStrategy } {
    const user = findById(id);
    if (!user) return { ok: false, error: '用户不存在' };
    const next = normalizeUserDefaultStrategy({
        plantingStrategy: input?.plantingStrategy ?? getDefaultStrategy(id).plantingStrategy,
        automation: { ...getDefaultStrategy(id).automation, ...(input?.automation || {}) },
    });
    user.defaultStrategy = next;
    saveUsers();
    return { ok: true, data: next };
}

module.exports = {
    listUsers,
    findById,
    findByUsername,
    createUser,
    validateUser,
    extendUser,
    setUserEnabled,
    resetUserPassword,
    changeUserPassword,
    deleteUser,
    createSession,
    getSession,
    revokeSession,
    revokeUserSessions,
    revokeRoleSessions,
    publicUser,
    getPushBinding,
    setPushBinding,
    getPushSettings,
    setPushSettings,
    getDefaultStrategy,
    setDefaultStrategy,
    stats,
};
