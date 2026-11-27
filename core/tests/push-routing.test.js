const assert = require('node:assert/strict');
const test = require('node:test');

const userStore = require('../dist/models/user-store');
const { createRealtimePushService } = require('../dist/services/realtime-push');
const { sendToOwnerTargets } = require('../dist/services/daily-report');

function createStore(overrides = {}) {
    return {
        getAccounts: () => ({ accounts: [{ id: '1', name: '账号一', ownerId: 'admin' }] }),
        getOfflineReminder: () => ({
            channels: [{
                channel: 'qqbot',
                endpoint: 'c2c:USER_OPENID',
                token: 'appid',
                secret: 'secret',
                enabled: true,
            }],
            pushTargets: [{
                id: 't1',
                ownerId: 'admin',
                label: '管理员',
                endpoint: 'c2c:USER_OPENID',
                enabled: true,
            }],
            realtimePush: { enabled: true, windowSec: 5, minIntervalSec: 10, dailyLimit: 10, markdown: true },
            ...overrides,
        }),
    };
}

test('realtime push merges upgrade and levelUp into one counter', async () => {
    const sent = [];
    const service = createRealtimePushService({
        store: createStore(),
        sendPushooMessage: async (payload) => {
            sent.push(payload);
            return { ok: true, code: 'ok', msg: 'ok' };
        },
        log: () => {},
    });

    service.recordEvent({ accountId: '1', type: 'upgrade', count: 1 });
    service.recordEvent({ accountId: '1', type: 'levelUp', count: 2 });
    await service.flush('admin');
    service.stop();

    assert.equal(sent.length, 1);
    assert.equal((sent[0].content.match(/升级/g) || []).length, 1);
    assert.match(sent[0].content, /升级 3/);
});

test('realtime push stops after the daily limit', async () => {
    const sent = [];
    const store = createStore({ realtimePush: { enabled: true, windowSec: 5, minIntervalSec: 10, dailyLimit: 1, markdown: true } });
    const service = createRealtimePushService({
        store,
        sendPushooMessage: async (payload) => {
            sent.push(payload);
            return { ok: true, code: 'ok', msg: 'ok' };
        },
        log: () => {},
    });

    service.recordEvent({ accountId: '1', type: 'harvest', count: 1 });
    await service.flush('admin');
    service.recordEvent({ accountId: '1', type: 'harvest', count: 1 });
    await service.flush('admin');
    service.stop();

    assert.equal(sent.length, 1);
});

test('realtime push falls back to admin non-QQ channels', async () => {
    const sent = [];
    const store = createStore({
        channels: [{ channel: 'webhook', endpoint: 'https://example.com/hook', token: '', secret: '', enabled: true }],
        pushTargets: [],
    });
    const service = createRealtimePushService({
        store,
        sendPushooMessage: async (payload) => {
            sent.push(payload);
            return { ok: true, code: 'ok', msg: 'ok' };
        },
        log: () => {},
    });

    service.recordEvent({ accountId: '1', type: 'harvest', count: 4 });
    await service.flush('admin');
    service.stop();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'webhook');
    assert.equal(sent[0].endpoint, 'https://example.com/hook');
});

test('user push binding works without a global qqbot channel', async () => {
    const sent = [];
    const original = userStore.getPushBinding;
    userStore.getPushBinding = () => ({
        enabled: true,
        endpoint: 'c2c:USER_OPENID',
        appId: 'user-appid',
        appSecret: 'user-secret',
    });
    try {
        const results = await sendToOwnerTargets({
            store: {
                getAccounts: () => ({ accounts: [] }),
                // 管理员没有配置任何推送渠道
                getOfflineReminder: () => ({ channels: [], pushTargets: [] }),
            },
            ownerId: 'u1',
            message: { title: 't', content: 'c' },
            sendPushooMessage: async (payload) => {
                sent.push(payload);
                return { ok: true, code: 'ok', msg: 'ok' };
            },
        });

        assert.equal(sent.length, 1);
        assert.equal(sent[0].token, 'user-appid');
        assert.equal(sent[0].secret, 'user-secret');
        assert.equal(results[0].ok, true);
        assert.equal(results[0].label, '我的推送');
    } finally {
        userStore.getPushBinding = original;
    }
});
