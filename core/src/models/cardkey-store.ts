export {};
/**
 * 卡密存储。
 *
 * 存储位置：<app>/data/cardkeys.json
 * 一条卡密可以被多人使用（maxUses）、可以设置兑换截止时间；被用完后 status=used。
 * 卡密本身不绑定用户名，谁先兑换谁生效，兑换时把 userId 记进 usedBy 便于对账。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');

const KEYS_FILE: string = getDataFile('cardkeys.json');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 4;
const GROUP_SIZE = 4;

interface UsedByRecord {
    userId: string;
    username: string;
    at: number;
}

interface CardKeyRecord {
    id: string;
    code: string;
    days: number;
    maxUses: number;
    uses: number;
    note: string;
    status: 'active' | 'used' | 'disabled';
    createdAt: number;
    expiresAt: number;
    createdBy: string;
    usedBy: UsedByRecord[];
}

interface CardKeysData {
    nextId: number;
    keys: CardKeyRecord[];
}

let cache: CardKeysData | null = null;

function atomicWrite(data: any): void {
    ensureDataDir();
    const tmp = `${KEYS_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, KEYS_FILE);
}

function normalizeCode(input: any): string {
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCode(raw: string): string {
    const groups: string[] = [];
    for (let i = 0; i < raw.length; i += GROUP_SIZE) groups.push(raw.slice(i, i + GROUP_SIZE));
    return groups.join('-');
}

function generateRawCode(): string {
    let out = '';
    for (let i = 0; i < CODE_GROUPS * GROUP_SIZE; i++) {
        out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    }
    return out;
}

function normalizeKey(raw: any): CardKeyRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const code = normalizeCode(raw.code);
    if (!code) return null;
    const maxUses = Math.max(1, Math.floor(Number(raw.maxUses) || 1));
    const uses = Math.max(0, Math.min(maxUses, Math.floor(Number(raw.uses) || 0)));
    const status = raw.status === 'disabled' ? 'disabled' : (uses >= maxUses ? 'used' : 'active');
    return {
        id: String(raw.id || ''),
        code: formatCode(code),
        days: Math.max(1, Math.floor(Number(raw.days) || 1)),
        maxUses,
        uses,
        note: String(raw.note || ''),
        status,
        createdAt: Number(raw.createdAt) || Date.now(),
        expiresAt: Number(raw.expiresAt) || 0,
        createdBy: String(raw.createdBy || 'admin'),
        usedBy: Array.isArray(raw.usedBy) ? raw.usedBy.filter(Boolean).map((item: any) => ({
            userId: String(item.userId || ''),
            username: String(item.username || ''),
            at: Number(item.at) || 0,
        })) : [],
    };
}

function load(): CardKeysData {
    if (cache) return cache;
    ensureDataDir();
    let raw: any = { keys: [], nextId: 1 };
    try {
        if (fs.existsSync(KEYS_FILE)) raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch {
        raw = { keys: [], nextId: 1 };
    }
    const keys: CardKeyRecord[] = (Array.isArray(raw?.keys) ? raw.keys : [])
        .map(normalizeKey)
        .filter((key: CardKeyRecord | null): key is CardKeyRecord => !!key && !!key.id);
    const maxId = keys.reduce((max: number, key: CardKeyRecord) => Math.max(max, Number.parseInt(key.id, 10) || 0), 0);
    cache = { keys, nextId: Math.max(Number(raw?.nextId) || 1, maxId + 1) };
    return cache;
}

function save(): void {
    if (cache) atomicWrite(cache);
}

function isExpired(key: CardKeyRecord): boolean {
    return key.expiresAt > 0 && key.expiresAt <= Date.now();
}

function publicKey(key: CardKeyRecord) {
    return {
        id: key.id,
        code: key.code,
        days: key.days,
        maxUses: key.maxUses,
        uses: key.uses,
        remaining: Math.max(0, key.maxUses - key.uses),
        note: key.note,
        status: isExpired(key) && key.status === 'active' ? 'expired' : key.status,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        createdBy: key.createdBy,
        usedBy: key.usedBy,
    };
}

function listKeys() {
    return load().keys.slice().sort((a, b) => b.createdAt - a.createdAt).map(publicKey);
}

function createKeys(input: { count?: number; days?: number; maxUses?: number; note?: string; expiresAt?: number; createdBy?: string }) {
    const count = Math.max(1, Math.min(200, Math.floor(Number(input.count) || 1)));
    const days = Math.max(1, Math.min(3650, Math.floor(Number(input.days) || 30)));
    const maxUses = Math.max(1, Math.min(100, Math.floor(Number(input.maxUses) || 1)));
    const note = String(input.note || '').slice(0, 120);
    const expiresAt = Math.max(0, Number(input.expiresAt) || 0);
    const data = load();
    const created: CardKeyRecord[] = [];
    const existing = new Set(data.keys.map(key => normalizeCode(key.code)));
    let guard = 0;
    while (created.length < count && guard < count * 20) {
        guard++;
        const raw = generateRawCode();
        if (existing.has(raw)) continue;
        existing.add(raw);
        const id = String(data.nextId++);
        const record: CardKeyRecord = {
            id,
            code: formatCode(raw),
            days,
            maxUses,
            uses: 0,
            note,
            status: 'active',
            createdAt: Date.now(),
            expiresAt,
            createdBy: String(input.createdBy || 'admin'),
            usedBy: [],
        };
        data.keys.push(record);
        created.push(record);
    }
    save();
    return created.map(publicKey);
}

function findByCode(code: string): CardKeyRecord | null {
    const target = normalizeCode(code);
    if (!target) return null;
    return load().keys.find(key => normalizeCode(key.code) === target) || null;
}

function verify(code: string) {
    const key = findByCode(code);
    if (!key) return { ok: false as const, error: '卡密不存在', code: 'KEY_NOT_FOUND' };
    if (key.status === 'disabled') return { ok: false as const, error: '卡密已被禁用', code: 'KEY_DISABLED' };
    if (key.status === 'used' || key.uses >= key.maxUses) return { ok: false as const, error: '卡密已被使用完', code: 'KEY_USED' };
    if (isExpired(key)) return { ok: false as const, error: '卡密已过期', code: 'KEY_EXPIRED' };
    return { ok: true as const, key };
}

/** 兑换前只校验不扣次数，避免创建用户失败时白白消耗卡密。 */
function check(code: string) {
    return verify(code);
}

function consume(code: string, user: { id: string; username: string }) {
    const data = load();
    const key = findByCode(code);
    if (!key) return { ok: false as const, error: '卡密不存在', code: 'KEY_NOT_FOUND' };
    if (key.status === 'disabled') return { ok: false as const, error: '卡密已被禁用', code: 'KEY_DISABLED' };
    if (key.uses >= key.maxUses) return { ok: false as const, error: '卡密已被使用完', code: 'KEY_USED' };
    if (isExpired(key)) return { ok: false as const, error: '卡密已过期', code: 'KEY_EXPIRED' };
    key.uses += 1;
    if (key.uses >= key.maxUses) key.status = 'used';
    key.usedBy.push({ userId: user.id, username: user.username, at: Date.now() });
    save();
    return { ok: true as const, key: publicKey(key) };
}

function setStatus(id: string, status: 'active' | 'disabled') {
    const key = load().keys.find(item => item.id === String(id));
    if (!key) return { ok: false as const, error: '卡密不存在' };
    if (status === 'active') {
        if (key.uses >= key.maxUses) return { ok: false as const, error: '已用完的卡密不能重新启用' };
        key.status = 'active';
    } else {
        key.status = 'disabled';
    }
    save();
    return { ok: true as const, key: publicKey(key) };
}

function deleteKey(id: string) {
    const data = load();
    const index = data.keys.findIndex(key => key.id === String(id));
    if (index < 0) return { ok: false as const, error: '卡密不存在' };
    data.keys.splice(index, 1);
    save();
    return { ok: true as const };
}

/**
 * 批量改状态。只对「还能用」的卡密生效：已用完 / 已过期 / 不存在的统一计入 skipped，
 * 避免出现「禁用了一张已用完的卡」这种看不出区别的状态。
 */
function setStatusMany(ids: string[], status: 'active' | 'disabled') {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(item => String(item)));
    const data = load();
    let affected = 0;
    let unchanged = 0;
    const skipped: { id: string; code: string; reason: string }[] = [];
    const missing: string[] = [];
    for (const id of wanted) {
        const key = data.keys.find(item => item.id === id);
        if (!key) {
            missing.push(id);
            continue;
        }
        if (key.uses >= key.maxUses) {
            skipped.push({ id, code: formatCode(normalizeCode(key.code)), reason: '已用完' });
            continue;
        }
        if (isExpired(key) && status === 'active') {
            skipped.push({ id, code: formatCode(normalizeCode(key.code)), reason: '已过期' });
            continue;
        }
        if (key.status === status) {
            unchanged++;
            continue;
        }
        key.status = status;
        affected++;
    }
    if (affected > 0) save();
    return { ok: true as const, affected, unchanged, skipped, missing };
}

/** 批量删除。返回真正删掉的 id，缺失的 id 单独回传，前端据此提示。 */
function deleteKeys(ids: string[]) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(item => String(item)));
    const data = load();
    const removed: string[] = [];
    data.keys = data.keys.filter((key) => {
        if (!wanted.has(key.id)) return true;
        removed.push(key.id);
        return false;
    });
    if (removed.length > 0) save();
    return { ok: true as const, affected: removed.length, removed, missing: [...wanted].filter(id => !removed.includes(id)) };
}

/** 批量改备注，传空字符串等于清空备注。 */
function setNoteMany(ids: string[], note: string) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(item => String(item)));
    const text = String(note == null ? '' : note).slice(0, 120);
    const data = load();
    let affected = 0;
    for (const key of data.keys) {
        if (!wanted.has(key.id)) continue;
        if (key.note === text) continue;
        key.note = text;
        affected++;
    }
    if (affected > 0) save();
    return { ok: true as const, affected };
}

function stats() {
    const keys = load().keys;
    const now = Date.now();
    return {
        total: keys.length,
        active: keys.filter(key => key.status === 'active' && !isExpired(key)).length,
        used: keys.filter(key => key.status === 'used').length,
        disabled: keys.filter(key => key.status === 'disabled').length,
        expired: keys.filter(key => isExpired(key) && key.status === 'active').length,
        registers: keys.reduce((sum, key) => sum + key.uses, 0),
        now,
    };
}

module.exports = {
    createKeys,
    listKeys,
    check,
    consume,
    setStatus,
    setStatusMany,
    deleteKeys,
    setNoteMany,
    deleteKey,
    stats,
};
