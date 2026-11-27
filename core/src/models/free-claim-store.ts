export {};
/**
 * 免费领卡密：配置 + 领取记录 + 防刷。
 *
 * 存储位置：<app>/data/free-claim.json（配置）、<app>/data/free-claims.json（领取记录）、
 *          <app>/data/free-claim-secret.json（签名密钥，只生成一次）
 *
 * 防刷分三层：
 *   1. 服务端签名 Cookie（fc_fp）+ 浏览器本地 fp，两者合成身份，清 localStorage 或换 IP 都甩不掉 cookie；
 *   2. 同 IP / 同身份双重冷却，外加每日总量上限；
 *   3. PoW 挑战（FNV-1a 前 N 位 0），一次性、5 分钟过期，抬高批量脚本的成本。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const cardkeyStore = require('./cardkey-store');

const CONFIG_FILE: string = getDataFile('free-claim.json');
const CLAIMS_FILE: string = getDataFile('free-claims.json');
const SECRET_FILE: string = getDataFile('free-claim-secret.json');

const COOKIE_NAME = 'fc_fp';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CLAIM_RECORDS = 5000;
// 领取后到注册前这段时间把卡密标记为“已预留”，避免同一张卡被多人领到；过期自动释放。
const RESERVE_TTL_MS = 24 * 60 * 60 * 1000;

interface FreeClaimConfig {
    enabled: boolean;
    days: number;
    maxUses: number;
    cooldownHours: number;
    dailyLimit: number;
    powDifficulty: number;
    note: string;
    updatedAt: number;
}

interface ClaimRecord {
    ip: string;
    identity: string;
    at: number;
    code: string;
    days: number;
}

interface ClaimsData {
    claims: ClaimRecord[];
}

interface Challenge {
    id: string;
    text: string;
    difficulty: number;
    expiresAt: number;
}

const DEFAULT_CONFIG: FreeClaimConfig = {
    enabled: true,
    days: 1,
    maxUses: 1,
    cooldownHours: 24,
    dailyLimit: 50,
    powDifficulty: 3,
    note: '免费领取',
    updatedAt: 0,
};

let configCache: FreeClaimConfig | null = null;
let claimsCache: ClaimsData | null = null;
let secretCache: string | null = null;
const challenges = new Map<string, Challenge>();

function atomicWrite(filePath: string, data: any): void {
    ensureDataDir();
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function getSecret(): string {
    if (secretCache) return secretCache;
    let raw: any = null;
    try {
        if (fs.existsSync(SECRET_FILE)) raw = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    } catch {
        raw = null;
    }
    if (raw && typeof raw.secret === 'string' && raw.secret.length >= 32) {
        secretCache = raw.secret;
    } else {
        secretCache = crypto.randomBytes(32).toString('hex');
        atomicWrite(SECRET_FILE, { secret: secretCache });
    }
    return secretCache;
}

function sign(value: string): string {
    return crypto.createHmac('sha256', getSecret()).update(value).digest('hex');
}

/** 生成签名 Cookie 值：<fpid>.<hmac>，浏览器无法伪造或篡改。 */
function newFingerprintCookie(): { value: string; fpid: string } {
    const fpid = crypto.randomBytes(16).toString('hex');
    return { value: `${fpid}.${sign(fpid)}`, fpid };
}

function verifyFingerprintCookie(value: any): string {
    const text = String(value || '');
    const split = text.lastIndexOf('.');
    if (split <= 0) return '';
    const fpid = text.slice(0, split);
    const mac = text.slice(split + 1);
    const expected = sign(fpid);
    if (mac.length !== expected.length) return '';
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return '';
    return fpid;
}

function cookieName(): string {
    return COOKIE_NAME;
}

function cookieMaxAge(): number {
    return COOKIE_MAX_AGE;
}

function normalizeConfig(raw: any): FreeClaimConfig {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: source.enabled !== false,
        days: clampInt(source.days, 1, 3650, DEFAULT_CONFIG.days),
        maxUses: clampInt(source.maxUses, 1, 100, DEFAULT_CONFIG.maxUses),
        cooldownHours: clampInt(source.cooldownHours, 0, 24 * 30, DEFAULT_CONFIG.cooldownHours),
        dailyLimit: clampInt(source.dailyLimit, 0, 100000, DEFAULT_CONFIG.dailyLimit),
        powDifficulty: clampInt(source.powDifficulty, 0, 5, DEFAULT_CONFIG.powDifficulty),
        note: String(source.note || DEFAULT_CONFIG.note).slice(0, 120),
        updatedAt: Number(source.updatedAt) || 0,
    };
}

function loadConfig(): FreeClaimConfig {
    if (configCache) return configCache;
    let raw: any = null;
    try {
        if (fs.existsSync(CONFIG_FILE)) raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        raw = null;
    }
    configCache = raw === null ? { ...DEFAULT_CONFIG } : normalizeConfig(raw);
    if (raw === null) atomicWrite(CONFIG_FILE, configCache);
    return configCache;
}

function loadClaims(): ClaimsData {
    if (claimsCache) return claimsCache;
    let raw: any = { claims: [] };
    try {
        if (fs.existsSync(CLAIMS_FILE)) raw = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
    } catch {
        raw = { claims: [] };
    }
    const claims: ClaimRecord[] = (Array.isArray(raw?.claims) ? raw.claims : [])
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => ({
            ip: String(item.ip || 'unknown'),
            identity: String(item.identity || ''),
            at: Number(item.at) || 0,
            code: String(item.code || ''),
            days: Number(item.days) || 0,
        }));
    claimsCache = { claims };
    return claimsCache;
}

function saveClaims(): void {
    if (claimsCache) atomicWrite(CLAIMS_FILE, claimsCache);
}

function publicConfig() {
    const config = loadConfig();
    return {
        enabled: config.enabled,
        days: config.days,
        maxUses: config.maxUses,
        cooldownHours: config.cooldownHours,
        dailyLimit: config.dailyLimit,
        powDifficulty: config.powDifficulty,
    };
}

function getConfig() {
    return { ...loadConfig() };
}

function setConfig(patch: any) {
    const current = loadConfig();
    const next = normalizeConfig({ ...current, ...(patch || {}) });
    next.updatedAt = Date.now();
    configCache = next;
    atomicWrite(CONFIG_FILE, next);
    return { ...next };
}

/** 与前端同一算法：FNV-1a 32 位，输出 8 位十六进制。 */
function fnv1a(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function createChallenge() {
    const config = loadConfig();
    const id = crypto.randomBytes(12).toString('hex');
    const text = crypto.randomBytes(12).toString('hex');
    const challenge: Challenge = {
        id,
        text,
        difficulty: config.powDifficulty,
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    challenges.set(id, challenge);
    // 清理过期挑战，避免长时间运行后堆积。
    if (challenges.size > 500) {
        const now = Date.now();
        for (const [key, item] of challenges) {
            if (item.expiresAt <= now) challenges.delete(key);
        }
    }
    return { id, challenge: text, difficulty: challenge.difficulty };
}

function verifyChallenge(challenge: any, nonce: any): boolean {
    const id = String(challenge?.id || '');
    const text = String(challenge?.text || '');
    const item = challenges.get(id);
    if (!item || item.text !== text) return false;
    challenges.delete(id); // 一次性，重放直接失败
    if (item.expiresAt <= Date.now()) return false;
    if (!Number.isFinite(Number(nonce))) return false;
    const prefix = '0'.repeat(item.difficulty);
    return fnv1a(`${text}:${Math.floor(Number(nonce))}`).startsWith(prefix);
}

function identityOf(fpid: string, clientFp: string): string {
    return crypto.createHash('sha256').update(`${fpid}|${String(clientFp || '').slice(0, 128)}`).digest('hex');
}

/** 24 小时内已发出但还没被注册占用的卡密，不能再发给第二个人。 */
function reservedCodes(): Set<string> {
    const cutoff = Date.now() - RESERVE_TTL_MS;
    return new Set(loadClaims().claims
        .filter(item => item.at >= cutoff && item.code)
        .map(item => item.code));
}

function noteKeyOf(): string {
    return String(loadConfig().note || '免费领取').toLowerCase();
}

function freePool(): any[] {
    const noteKey = noteKeyOf();
    const reserved = reservedCodes();
    return cardkeyStore.listKeys().filter((candidate: any) =>
        candidate.status === 'active'
        && Number(candidate.remaining) > 0
        && !reserved.has(candidate.code)
        && (!noteKey || String(candidate.note || '').toLowerCase().includes(noteKey)));
}

/** 领取前查询：是否开放、还要等多久。不暴露任何卡密内容。 */
function claimStatus(ip: string, identity: string) {
    const config = loadConfig();
    const now = Date.now();
    const key = String(ip || 'unknown');
    const records = loadClaims().claims;
    const lastByIdentity = records
        .filter(item => !!identity && item.identity === identity)
        .reduce((max: number, item: ClaimRecord) => Math.max(max, item.at), 0);
    const lastByIp = records
        .filter(item => item.ip === key)
        .reduce((max: number, item: ClaimRecord) => Math.max(max, item.at), 0);
    const last = Math.max(lastByIdentity, lastByIp);
    const waitMs = last && config.cooldownHours > 0
        ? Math.max(0, last + config.cooldownHours * 60 * 60 * 1000 - now)
        : 0;
    return {
        enabled: config.enabled,
        days: config.days,
        cooldownHours: config.cooldownHours,
        canClaim: config.enabled && waitMs <= 0,
        waitMs,
        lastClaimAt: last || 0,
    };
}

function claim(ip: string, clientFp: string, cookieValue: any, challenge: any, nonce: any) {
    const fpid = verifyFingerprintCookie(cookieValue);
    if (!fpid) {
        return { ok: false as const, error: '验证标识已失效，请刷新页面重试', code: 'NEED_FP' };
    }

    const config = loadConfig();
    if (!config.enabled) return { ok: false as const, error: '免费领取暂未开放' };

    if (config.powDifficulty > 0 && !verifyChallenge(challenge, nonce)) {
        return { ok: false as const, error: '验证未完成，请重试', code: 'POW_FAILED' };
    }

    const identity = identityOf(fpid, clientFp);
    const status = claimStatus(ip, identity);
    if (status.waitMs > 0) {
        const hours = Math.ceil(status.waitMs / 3600000);
        return { ok: false as const, error: `领取过于频繁，请 ${hours} 小时后再领`, code: 'CLAIM_COOLDOWN', waitMs: status.waitMs };
    }

    if (config.dailyLimit > 0) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayCount = loadClaims().claims.filter(item => item.at >= startOfDay.getTime()).length;
        if (todayCount >= config.dailyLimit) {
            return { ok: false as const, error: '今日免费领取名额已用完', code: 'DAILY_LIMIT' };
        }
    }

    // 只发放管理员预先生成、备注属于免费卡池的卡密，不再现场生成。
    // 注意：这里不 consume！卡密在用户点「注册」时才由 /api/register 扣次数，
    // 否则用户第一次注册必然报「卡密已被使用完」。用领取记录做 24 小时预留防重复发放。
    const pool = freePool();
    const key: any = pool.length ? pool[0] : null;
    if (!key) {
        return { ok: false as const, error: '免费卡池为空，请联系管理员补充卡密', code: 'POOL_EMPTY' };
    }

    const data = loadClaims();
    data.claims.push({
        ip: String(ip || 'unknown'),
        identity,
        at: Date.now(),
        code: key.code,
        days: key.days,
    });
    if (data.claims.length > MAX_CLAIM_RECORDS) {
        data.claims.splice(0, data.claims.length - MAX_CLAIM_RECORDS);
    }
    saveClaims();
    return { ok: true as const, key };
}

function poolAvailable(): number {
    return freePool().length;
}

function stats() {
    const claims = loadClaims().claims;
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return {
        total: claims.length,
        today: claims.filter(item => item.at >= startOfDay.getTime()).length,
        lastClaimAt: claims.reduce((max: number, item) => Math.max(max, item.at), 0),
        poolAvailable: poolAvailable(),
    };
}

function listClaims(limit: number = 50) {
    return loadClaims().claims.slice().sort((a, b) => b.at - a.at).slice(0, limit)
        .map(item => ({ ...item, identity: item.identity ? item.identity.slice(0, 12) : '' }));
}

module.exports = {
    cookieName,
    cookieMaxAge,
    newFingerprintCookie,
    verifyFingerprintCookie,
    publicConfig,
    getConfig,
    setConfig,
    createChallenge,
    claimStatus,
    claim,
    stats,
    poolAvailable,
    listClaims,
};
