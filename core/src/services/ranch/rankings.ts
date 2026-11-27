export {};
/**
 * 牧场动物收益排行。
 *
 * 与农场 getPlantRankings 对齐，但牧场的幼崽本身有购买成本、成熟前有空档期，
 * 所以「最大金币/时」按净收益算：
 *   净收益/周期 = 产物与副产物售价 - 幼崽成本 - 周期内的牧草成本
 *   净金币/时  = 净收益/周期 / 生产周期 * 3600
 * 经验按 produce_exp + harvest_exp 每周期计算。
 *
 * 供 auto.ranch_strategy = max_exp / max_gold 自动选动物时使用。
 */

import animals from '../../gameConfig/ranch/MCAnimalConfig.json';
import ranchItems from '../../gameConfig/ranch/MCItemInfo.json';
import shopGoods from '../../gameConfig/Goods.json';

const itemMap = new Map<number, any>(ranchItems.map((row: any) => [Number(row.id), row]));

function shopIndexByCub(): Map<number, { level: number; cost: number }> {
    const map = new Map<number, { level: number; cost: number }>();
    for (const goods of shopGoods as any[]) {
        const cubId = Number(goods?.item_id) || 0;
        if (!cubId) continue;
        const match = String(goods?.conds || '').match(/:(\d+)\s*$/);
        const level = match ? Number(match[1]) : 0;
        const cost = Number(goods?.price_id) === 1007 ? Math.max(0, Number(goods?.price_count) || 0) : 0;
        const current = map.get(cubId);
        // 同一幼崽可能有折扣条目，取等级上限最高、价格最低的一条作为稳定基准。
        if (!current || level > current.level || (level === current.level && cost < current.cost)) {
            map.set(cubId, { level, cost });
        }
    }
    return map;
}
const SHOP_INDEX = shopIndexByCub();

const GRASS_ITEM_ID = 7001;
const GRASS_PRICE = (() => {
    for (const goods of shopGoods as any[]) {
        if (Number(goods?.item_id) === GRASS_ITEM_ID && Number(goods?.price_id) === 1007) {
            return Math.max(0, Number(goods?.price_count) || 0);
        }
    }
    return 0;
})();

function sellPrice(itemId: any): number {
    const item = itemMap.get(Number(itemId));
    const sells = item && typeof item.sells === 'string' ? item.sells : '';
    let total = 0;
    for (const part of sells.split(';')) {
        const [currency, amount] = part.split(':');
        // 1007 是牧场产物结算货币；其他货币（活动兑换）不折算进收益。
        if (Number(currency) === 1007) total += Math.max(0, Number(amount) || 0);
    }
    return total;
}

function perHour(value: number, seconds: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(seconds) || seconds <= 0) return 0;
    return Number.parseFloat(((value / seconds) * 3600).toFixed(2));
}

function round2(value: number): number {
    return Number.isFinite(value) ? Number.parseFloat(value.toFixed(2)) : 0;
}

export interface RanchAnimalRanking {
    animalId: number;
    name: string;
    kind: string;
    requiredLevel: number;
    cycleSec: number;
    firstHarvestSec: number;
    expPerHour: number;
    goldPerHour: number;
    cubCost: number;
    grassCostPerCycle: number;
    netPerCycle: number;
    netGoldPerHour: number;
    paybackHours: number;
    pricePerCycle: number;
}

export interface RanchRankingStat {
    score: number;
    cycleSec: number;
    requiredLevel: number;
}

/** requiredLevelMap 由商店 goods 的 conds 解析，没传时用 Goods.json 的配置。 */
function buildRankings(requiredLevelMap?: Map<number, number>): RanchAnimalRanking[] {
    const results: RanchAnimalRanking[] = [];
    for (const animal of animals as any[]) {
        if (!animal || animal.enable_flag !== true) continue;
        const cycleSec = Math.max(0, Number(animal.product_round_sec) || 0);
        // 8 秒的测试动物不参与收益排行，否则会霸占「最大金币/时」。
        if (cycleSec < 60) continue;

        const product = animal.product_item || {};
        const byproduct = animal.byproduct_item || {};
        const income = Math.max(0, Number(product.count) || 0) * sellPrice(product.id)
            + Math.max(0, Number(byproduct.count) || 0) * sellPrice(byproduct.id);
        const exp = Math.max(0, Number(animal.produce_exp) || 0) + Math.max(0, Number(animal.harvest_exp) || 0);
        const animalId = Number(animal.id) || 0;
        if (!animalId) continue;

        const cubId = Number(animal.cub_item_id) || animalId;
        const shop = SHOP_INDEX.get(cubId) || SHOP_INDEX.get(animalId);
        const cubCost = shop?.cost || 0;
        const grassSec = Math.max(0, Number(animal.grass_sec_per_item) || 0);
        const grassCostPerCycle = GRASS_PRICE > 0 && grassSec > 0
            ? Math.ceil(cycleSec / grassSec) * GRASS_PRICE
            : 0;
        const netPerCycle = income - cubCost - grassCostPerCycle;
        const firstHarvestSec = Math.max(0, Number(animal.infant_sec) || 0)
            + Math.max(0, Number(animal.grow_sec) || 0)
            + Math.max(0, Number(animal.mature_sec) || 0);
        const paybackSec = netPerCycle > 0
            ? firstHarvestSec + (cubCost / netPerCycle) * cycleSec
            : 0;

        results.push({
            animalId,
            name: String(animal.name || ''),
            kind: String(animal.husbandry_type || ''),
            requiredLevel: requiredLevelMap?.get(animalId) ?? shop?.level ?? 0,
            cycleSec,
            firstHarvestSec,
            expPerHour: perHour(exp, cycleSec),
            goldPerHour: perHour(income, cycleSec),
            cubCost,
            grassCostPerCycle,
            netPerCycle: round2(netPerCycle),
            netGoldPerHour: perHour(netPerCycle, cycleSec),
            paybackHours: round2(paybackSec / 3600),
            pricePerCycle: income,
        });
    }
    return results;
}

/** 给自动选动物用：分数 + 周期，周期短的优先，避免同分时选到慢周期动物。 */
function getRankingStats(sortBy: 'exp' | 'gold', requiredLevelMap?: Map<number, number>): Map<number, RanchRankingStat> {
    const map = new Map<number, RanchRankingStat>();
    for (const row of buildRankings(requiredLevelMap)) {
        map.set(row.animalId, {
            score: sortBy === 'exp' ? row.expPerHour : row.netGoldPerHour,
            cycleSec: row.cycleSec,
            requiredLevel: row.requiredLevel,
        });
    }
    return map;
}

function getRankingMap(sortBy: 'exp' | 'gold', requiredLevelMap?: Map<number, number>): Map<number, number> {
    const stats = getRankingStats(sortBy, requiredLevelMap);
    const map = new Map<number, number>();
    for (const [id, stat] of stats) map.set(id, stat.score);
    return map;
}

function getRanchAnimalRankings(sortBy: string = 'gold', requiredLevelMap?: Map<number, number>): RanchAnimalRanking[] {
    const results = buildRankings(requiredLevelMap);
    if (sortBy === 'exp') {
        results.sort((a, b) => b.expPerHour - a.expPerHour || a.cycleSec - b.cycleSec || a.requiredLevel - b.requiredLevel);
    } else {
        results.sort((a, b) => b.netGoldPerHour - a.netGoldPerHour || a.cycleSec - b.cycleSec || a.requiredLevel - b.requiredLevel);
    }
    return results;
}

module.exports = {
    getRanchAnimalRankings,
    getRankingStats,
    getRankingMap,
};
