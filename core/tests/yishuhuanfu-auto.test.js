const assert = require('node:assert/strict');
const test = require('node:test');

const { createYishuAutomation, isYishuAutomationEnabled } = require('../dist/services/yishuhuanfu-auto');

// 以薯换福自动任务的纯逻辑测试：所有网关调用都用桩替换，只验证「什么时候发、发给谁、发几次」。
const NOW_SEC = 1795573881;

function makeSnapshot(overrides = {}) {
    const base = {
        active: true,
        daily: { seedClaimed: false, shared: false, sharedToday: false },
        sweetPotatoBalance: '0',
        shop: { priceKnown: true, price: '111', bonus: '33', estimatedPrice: '144' },
        commission: { pending: '0', claimable: false, flag: '0' },
    };
    return {
        ...base,
        ...overrides,
        daily: { ...base.daily, ...(overrides.daily || {}) },
        shop: { ...base.shop, ...(overrides.shop || {}) },
        commission: { ...base.commission, ...(overrides.commission || {}) },
    };
}

function makeShop(overrides = {}) {
    return {
        gid: '1',
        name: '甲',
        own: false,
        totalPrice: '165',
        price: '99',
        bonus: '66',
        quota: '0',
        quotaCap: '8000',
        quotaUsed: '8000',
        ...overrides,
    };
}

function createHarness(options = {}) {
    const calls = [];
    const logs = [];
    let snapshot = options.snapshot || makeSnapshot();
    const shops = options.shops || [];
    const automation = createYishuAutomation({
        getActivity: async (...args) => {
            calls.push(['getActivity', args[0]]);
            return snapshot;
        },
        claimSeed: async (args) => {
            calls.push(['claimSeed', args]);
            return { count: '28' };
        },
        shareShop: async (args) => {
            calls.push(['shareShop', args]);
            return { count: '3', shareReported: true };
        },
        claimCommission: async (args) => {
            calls.push(['claimCommission', args]);
            return { amount: '86', balance: '32156' };
        },
        scanFriends: async (args) => {
            calls.push(['scanFriends', args]);
            return { shops };
        },
        sell: async (friendGid, count, args) => {
            calls.push(['sell', friendGid, count, args]);
            if (options.sell) return options.sell(friendGid, count);
            return { count, price: '165', income: String(Number(count) * 165) };
        },
        getServerTimeSec: () => NOW_SEC,
        log: (module, message, meta) => logs.push({ module, message, meta }),
    });
    return {
        automation,
        calls,
        logs,
        sells: () => calls.filter(entry => entry[0] === 'sell'),
        setSnapshot: next => { snapshot = next; },
    };
}

const ALL_ON = {
    yishu_claim_seed: true,
    yishu_share: true,
    yishu_claim_commission: true,
    yishu_auto_sell: true,
    yishu_sell_fallback_own: true,
    yishu_scan_friend_limit: 20,
    yishu_scan_interval_minutes: 30,
    yishu_sell_min_count: 1,
};

test('yishu automation is enabled by any single switch', () => {
    assert.equal(isYishuAutomationEnabled({}), false);
    assert.equal(isYishuAutomationEnabled({ yishu_share: true }), true);
    assert.equal(isYishuAutomationEnabled({ yishu_claim_commission: true }), true);
    assert.equal(isYishuAutomationEnabled({ muge_claim_rewards: true }), false);
});

test('daily seed and share claims run once, then skip on the server flags', async () => {
    const harness = createHarness({ snapshot: makeSnapshot({ sweetPotatoBalance: '0' }) });
    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.calls.filter(entry => entry[0] !== 'getActivity').map(entry => entry[0]), [
        'claimSeed',
        'shareShop',
    ]);
    // 自动任务不需要整份活动中心快照（那是 7 个活动的读），必须显式关掉。
    assert.deepEqual(harness.calls.find(entry => entry[0] === 'claimSeed')[1], { withSnapshot: false });

    const second = createHarness({
        snapshot: makeSnapshot({ daily: { seedClaimed: true, shared: true } }),
    });
    await second.automation.runYishuAutomation(ALL_ON);
    assert.deepEqual(second.calls.filter(entry => entry[0] !== 'getActivity').map(entry => entry[0]), []);
    // 每天只记一条跳过，不刷日志。
    assert.ok(second.logs.some(entry => entry.message.includes('今日红薯种子已经领过')));
});

test('commission is claimed only when the server says it is claimable', async () => {
    const pending = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '0', commission: { pending: '86', claimable: true } }),
    });
    await pending.automation.runYishuAutomation({ yishu_claim_commission: true, yishu_auto_sell: false });
    assert.deepEqual(pending.calls.filter(entry => entry[0] === 'claimCommission')[0][1], { withSnapshot: false });

    const empty = createHarness({ snapshot: makeSnapshot({ sweetPotatoBalance: '0' }) });
    await empty.automation.runYishuAutomation({ yishu_claim_commission: true, yishu_auto_sell: false });
    assert.equal(empty.calls.filter(entry => entry[0] === 'claimCommission').length, 0);
});

test('auto sell walks shops by price and switches to the next when one is full', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '500' }),
        shops: [
            makeShop({ gid: '1001', name: '最高价', totalPrice: '165', quota: '300' }),
            makeShop({ gid: '1002', name: '第二高', totalPrice: '150', quota: '0' }),
            makeShop({ gid: '1003', name: '第三高', totalPrice: '144', quota: '500' }),
            makeShop({ gid: 'own', name: '我的铺子', own: true, totalPrice: '111', quota: '10000' }),
        ],
        sell: (friendGid, count) => {
            if (friendGid === '1001') {
                // 服务端说这家已经收满：必须换下一家，而不是整轮失败。
                const error = new Error('1001 的铺子今日只剩 0 个接收额度');
                error.code = 'YSHF_SHOP_QUOTA_INSUFFICIENT';
                throw error;
            }
            return { count, price: '144', income: String(Number(count) * 144) };
        },
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.sells().map(entry => [entry[1], entry[2]]), [
        ['1001', '300'],
        ['1003', '500'],
    ]);
    // 第三高那家把 500 个全吃了，自己的铺子不该再被写一次。
    assert.equal(harness.calls.filter(entry => entry[0] === 'sell').length, 2);
});

test('auto sell skips a shop whose can_sell is false without calling it', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '400' }),
        shops: [
            // 最高价但当前不收（can_sell=false），且额度还剩很多——
            // 只看 quota 就会白打一次 cmd 93 再失败。
            makeShop({ gid: '2001', name: '关门铺', totalPrice: '300', quota: '5000', canSell: false }),
            makeShop({ gid: '2002', name: '次高', totalPrice: '160', quota: '400', canSell: true }),
        ],
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.sells().map(entry => [entry[1], entry[2]]), [['2002', '400']]);
});

test('leftover sweet potatoes fall back to the own shop when every friend is full', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '500' }),
        shops: [
            makeShop({ gid: '1001', quota: '0' }),
            makeShop({ gid: 'own', name: '我的铺子', own: true, totalPrice: '111', quota: '10000' }),
        ],
        sell: (friendGid, count) => ({ count, price: '111', income: String(Number(count) * 111) }),
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    // null 表示「不传 friendGid」，服务端按自己的铺子结算。
    assert.deepEqual(harness.sells().map(entry => [entry[1], entry[2]]), [[null, '500']]);
});

test('closing the own-shop fallback keeps leftovers unsold', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '500' }),
        shops: [
            makeShop({ gid: '1001', quota: '0' }),
            makeShop({ gid: 'own', name: '我的铺子', own: true, totalPrice: '111', quota: '10000' }),
        ],
    });

    await harness.automation.runYishuAutomation({ ...ALL_ON, yishu_sell_fallback_own: false });

    assert.equal(harness.sells().length, 0);
    assert.ok(harness.logs.some(entry => entry.message.includes('没卖出去') || entry.message.includes('没有可卖')));
});

test('a round never switches more than three shops', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '1000' }),
        shops: [
            makeShop({ gid: '1001', totalPrice: '165', quota: '100' }),
            makeShop({ gid: '1002', totalPrice: '160', quota: '100' }),
            makeShop({ gid: '1003', totalPrice: '155', quota: '100' }),
            makeShop({ gid: '1004', totalPrice: '150', quota: '100' }),
            makeShop({ gid: '1005', totalPrice: '145', quota: '100' }),
        ],
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.sells().map(entry => entry[1]), ['1001', '1002', '1003']);
    assert.ok(harness.logs.some(entry => entry.message.includes('还有 700 个蜜薯没卖出去')));
});

test('sweet potatoes below the sell threshold are left alone', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '12' }),
        shops: [makeShop({ gid: '1001', quota: '500' })],
    });

    await harness.automation.runYishuAutomation({ ...ALL_ON, yishu_sell_min_count: 20 });

    assert.equal(harness.sells().length, 0);
    assert.equal(harness.calls.filter(entry => entry[0] === 'scanFriends').length, 0);
    assert.ok(harness.logs.some(entry => entry.message.includes('未达到自动卖出阈值 20')));
});

test('friend price scan is throttled by the configured interval', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: '10' }),
        shops: [makeShop({ gid: '1001', quota: '1000' })],
    });

    await harness.automation.runYishuAutomation(ALL_ON);
    harness.setSnapshot(makeSnapshot({ sweetPotatoBalance: '10' }));
    await harness.automation.runYishuAutomation(ALL_ON);

    // 第二轮在 30 分钟窗口内，直接复用上一轮的排序结果。
    assert.equal(harness.calls.filter(entry => entry[0] === 'scanFriends').length, 1);
    // 比价只传好友数上限，force 由自动任务自己控制。
    assert.deepEqual(harness.calls.find(entry => entry[0] === 'scanFriends')[1], { limit: 20, force: true });
});

test('an inactive activity window stops the whole round', async () => {
    const harness = createHarness({ snapshot: makeSnapshot({ active: false, sweetPotatoBalance: '500' }) });
    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.calls.map(entry => entry[0]), ['getActivity']);
    assert.ok(harness.logs.some(entry => entry.message.includes('不在开放窗口')));
});

/**
 * 定时器接线：桩掉 store 与 scheduler，只断言「什么时候注册、什么时候清」。
 * 线上踩过的坑是「掉线瞬间被 clear 后再也不重建」，所以这里必须锁住这两条。
 */
function timerHarness(automation, aliveKeys = []) {
    const storePath = require.resolve('../dist/models/store');
    require.cache[storePath] = {
        id: storePath,
        filename: storePath,
        loaded: true,
        exports: { getAutomation: () => automation },
    };
    const cleared = [];
    const timeouts = [];
    const intervals = [];
    const alive = new Set(aliveKeys);
    return {
        cleared,
        timeouts,
        intervals,
        scheduler: {
            clear: (key) => { cleared.push(key); alive.delete(key); },
            has: (key) => alive.has(key),
            setTimeoutTask: (key, ms) => { timeouts.push({ key, ms }); },
            setIntervalTask: (key, ms, fn, options) => { intervals.push({ key, ms, options }); alive.add(key); },
        },
    };
}

test('定时器注册首跑与十分钟周期，且不再叠加错相位', () => {
    const { startYishuTimer, YISHU_CHECK_INTERVAL_MS, YISHU_INITIAL_DELAY_MS } = require('../dist/services/yishuhuanfu-auto');
    const h = timerHarness({ ...ALL_ON });
    startYishuTimer(h.scheduler, () => true);

    assert.equal(h.timeouts.length, 1);
    assert.equal(h.timeouts[0].key, 'yishu_initial');
    assert.equal(h.timeouts[0].ms, YISHU_INITIAL_DELAY_MS);
    assert.equal(h.intervals.length, 1);
    assert.equal(h.intervals[0].key, 'yishu_interval');
    assert.equal(h.intervals[0].ms, YISHU_CHECK_INTERVAL_MS);
    // 错相位会把首跑推到 phase + interval（14 分钟），配置一变就重建，首跑永远等不到。
    assert.equal(h.intervals[0].options, undefined);
});

test('未登录时不碰已有定时器，重复挂表不重建', () => {
    const { startYishuTimer } = require('../dist/services/yishuhuanfu-auto');

    const offline = timerHarness({ ...ALL_ON }, ['yishu_interval']);
    startYishuTimer(offline.scheduler, () => false);
    assert.deepEqual(offline.cleared, [], '未登录时不能清掉已有定时器');
    assert.equal(offline.timeouts.length, 0);
    assert.equal(offline.intervals.length, 0);

    const ready = timerHarness({ ...ALL_ON });
    startYishuTimer(ready.scheduler, () => true);
    const clearedAfterFirst = ready.cleared.length;
    startYishuTimer(ready.scheduler, () => true);
    assert.equal(ready.cleared.length, clearedAfterFirst, '第二次挂表不该再清一次');
    assert.equal(ready.timeouts.length, 1);
    assert.equal(ready.intervals.length, 1);
});

test('开关全关时只清不挂', () => {
    const { startYishuTimer } = require('../dist/services/yishuhuanfu-auto');
    const h = timerHarness({ yishu_claim_seed: false, yishu_share: false, yishu_auto_sell: false, yishu_claim_commission: false }, ['yishu_initial', 'yishu_interval']);
    startYishuTimer(h.scheduler, () => true);
    assert.deepEqual(h.cleared, ['yishu_initial', 'yishu_interval']);
    assert.equal(h.timeouts.length, 0);
    assert.equal(h.intervals.length, 0);
});

test('自动任务读快照时要求更硬的余额读取参数', async () => {
    const harness = createHarness({ snapshot: makeSnapshot({ sweetPotatoBalance: '5' }), shops: [] });
    await harness.automation.runYishuAutomation(ALL_ON);

    const read = harness.calls.find(entry => entry[0] === 'getActivity');
    assert.equal(read[1].freshBalances, true);
    // 轮询间隔 10 分钟 = 界面 stale 窗口，只试一次几乎必然读到未知值。
    assert.equal(read[1].balanceRetries, 2);
    assert.equal(read[1].balanceStaleMaxMs, 60 * 60 * 1000);
});

test('按线上真实快照结构读取蜜薯数量（sweetPotato.balance）', async () => {
    // 线上快照没有顶层 sweetPotatoBalance，只有 sweetPotato.balance。
    // 这里故意只给对象字段，锁住「字段名写错导致永远跳过卖薯」这个回归。
    const snapshot = makeSnapshot();
    delete snapshot.sweetPotatoBalance;
    snapshot.sweetPotato = { id: '1032', balance: '500', count: '500' };
    snapshot.luckCoin = { id: '1033', balance: '117', count: '117' };

    const harness = createHarness({
        snapshot,
        shops: [makeShop({ gid: '1001', name: '112', totalPrice: '273', quota: '8000' })],
        sell: (friendGid, count) => ({ count, price: '273', income: String(Number(count) * 273) }),
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.sells().map(entry => [entry[1], entry[2]]), [['1001', '500']]);
    const summary = harness.logs.find(entry => entry.message.includes('本轮开始'));
    assert.equal(summary.meta.sweetPotato, '500');
    assert.equal(summary.meta.luckCoin, '117');
});

test('自己的铺子价格再高也排在好友之后', async () => {
    // 贪心顺序是「好友都卖不进去才卖自己」。若按 totalPrice 统一排序，
    // 自家铺子出价更高时会被排到最前，等于把货直接留在自己手里。
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotato: { balance: '500' } }),
        shops: [
            makeShop({ gid: 'own', name: '我的铺子', own: true, totalPrice: '300', quota: '10000' }),
            makeShop({ gid: '1001', name: '好友', totalPrice: '200', quota: '10000' }),
        ],
        sell: (friendGid, count) => ({ count, price: friendGid === 'own' ? '300' : '200', income: String(Number(count) * 200) }),
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    assert.deepEqual(harness.sells().map(entry => entry[1]), ['1001']);
});

test('领完种子会重新读一次快照，避免卖薯被「价格未知」跳过', async () => {
    // 领种子之前服务端还没生成当日行情（priceKnown=false）。领完必须再读一次，
    // 否则同一轮里的卖薯会拿着旧快照直接跳过，背包里的蜜薯要白等 10 分钟。
    const calls = [];
    const logs = [];
    let reads = 0;
    const { createYishuAutomation: create } = require('../dist/services/yishuhuanfu-auto');
    const automation = create({
        getActivity: async () => {
            reads += 1;
            // 第一次：还没领种子、没有行情；第二次：行情已生成。
            return reads === 1
                ? makeSnapshot({ shop: { priceKnown: false }, sweetPotato: { balance: '500' } })
                : makeSnapshot({ shop: { priceKnown: true, price: '111', estimatedPrice: '144' }, sweetPotato: { balance: '500' }, daily: { seedClaimed: true, shared: true } });
        },
        claimSeed: async () => { calls.push('claimSeed'); return { count: '7' }; },
        shareShop: async () => ({ count: '0', shareReported: true }),
        claimCommission: async () => ({ amount: '0' }),
        scanFriends: async () => { calls.push('scanFriends'); return { shops: [makeShop({ gid: '1001', quota: '10000' })] }; },
        sell: async (friendGid, count) => { calls.push(['sell', friendGid, count]); return { count, price: '144', income: String(Number(count) * 144) }; },
        getServerTimeSec: () => NOW_SEC,
        log: (module, message, meta) => logs.push({ module, message, meta }),
    });

    await automation.runYishuAutomation({ ...ALL_ON, yishu_share: false, yishu_claim_commission: false });

    assert.equal(reads, 2, '领种子后必须刷新快照');
    assert.deepEqual(calls, ['claimSeed', 'scanFriends', ['sell', '1001', '500']]);
    assert.ok(logs.some(entry => entry.message.includes('领取红薯种子 7 个')));
});

test('没读到蜜薯数量时把后端原因写进跳过日志', async () => {
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotatoBalance: null, balanceError: 'itempb.ItemService.Bag timeout' }),
        shops: [],
    });
    await harness.automation.runYishuAutomation(ALL_ON);

    assert.ok(harness.logs.some(entry => entry.message.includes('这次没读到背包蜜薯数量（itempb.ItemService.Bag timeout）')));
});

test('比价回包额度非法时换下一家，不打断整轮', async () => {
    // quota 一旦出现非法值，BigInt 会直接抛错并冒到 runYishuTick 被静默吞掉，
    // 连本轮后面的提成领取都被打断。这里必须只跳过这一家，整轮继续。
    const harness = createHarness({
        snapshot: makeSnapshot({ sweetPotato: { balance: '100' } }),
        shops: [
            makeShop({ gid: '3001', name: '坏回包', totalPrice: '300', quota: 'abc' }),
            makeShop({ gid: '3002', name: '好铺子', totalPrice: '200', quota: '100' }),
        ],
    });

    await harness.automation.runYishuAutomation({ ...ALL_ON, yishu_share: false, yishu_claim_commission: false });

    assert.deepEqual(harness.sells().map(entry => entry[1]), ['3002']);
    assert.ok(harness.logs.some(entry => entry.message.includes('回包额度无效')));
});

test('背包蜜薯数量过时（INSUFFICIENT）时停止卖薯，但提成照常领取', async () => {
    // 快照说有 500 个、实际已被别处消耗：换任何铺子都一样，应该停止卖薯。
    // 这是常态而非故障，记 skip 不记 error；且 sellSweetPotatoes 内部 return 不影响
    // 外层继续领提成。
    const harness = createHarness({
        snapshot: makeSnapshot({
            sweetPotato: { balance: '500' },
            commission: { pending: '86', claimable: true },
        }),
        shops: [makeShop({ gid: '4001', quota: '500' })],
        sell: () => {
            const error = new Error('背包只有 0 个蜜薯，不足 500 个');
            error.code = 'INSUFFICIENT_YSHF_SWEET_POTATO';
            throw error;
        },
    });

    await harness.automation.runYishuAutomation(ALL_ON);

    assert.equal(harness.sells().length, 1, '只尝试一家就停止，不换铺子重试');
    assert.ok(harness.logs.some(entry => entry.message.includes('背包蜜薯数量已变化')));
    assert.ok(!harness.logs.some(entry => entry.result === 'error' && entry.action === 'sell'), '不应记为错误');
    assert.equal(harness.calls.filter(entry => entry[0] === 'claimCommission').length, 1, '提成照常领取');
});
