export {};
/**
 * 账号资产快照。账号离线时也能在每日报表里展示最后一次已知的金币/点券/等级，
 * 上传状态由主进程 runtime-engine 的 onStatusSync 驱动，30 秒内相同数据不重复落盘。
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const SNAPSHOT_FILE = getDataFile('asset-snapshot.json');
const WRITE_INTERVAL_MS = 30_000;
let cache: Record<string, any> | null = null;

function load(): Record<string, any> {
    if (cache) return cache;
    try {
        cache = fs.existsSync(SNAPSHOT_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) : {};
    } catch {
        cache = {};
    }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    return cache;
}

function save(): void {
    if (!cache) return;
    const dir = path.dirname(SNAPSHOT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
}

function updateAccountSnapshot(accountId: string, status: any): void {
    const id = String(accountId || '').trim();
    if (!id || !status || typeof status !== 'object') return;
    const info = status.status && typeof status.status === 'object' ? status.status : {};
    const entry = {
        name: String(info.name || status.accountName || '').slice(0, 40),
        level: Number(info.level) || 0,
        gold: Number(info.gold) || 0,
        coupon: Number(info.coupon) || 0,
        exp: Number(info.exp) || 0,
        at: Date.now(),
    };
    // 30 秒内资产无变化就跳过写盘，状态同步频率很高。
    const prev = load()[id];
    if (prev && entry.at - (Number(prev.at) || 0) < WRITE_INTERVAL_MS
        && Number(prev.gold) === entry.gold && Number(prev.coupon) === entry.coupon && Number(prev.exp) === entry.exp) {
        return;
    }
    load()[id] = entry;
    save();
}

function getAccountSnapshot(accountId: string): any | null {
    return load()[String(accountId || '')] || null;
}

module.exports = { updateAccountSnapshot, getAccountSnapshot };
