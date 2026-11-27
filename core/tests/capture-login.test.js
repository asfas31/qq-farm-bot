const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const { createCaptureRouter } = require('../dist/controllers/admin/capture-routes');
const { normalizeCaptureSession } = require('../dist/services/capture-client');

async function startServer(router) {
    const app = express();
    app.use(express.json());
    app.use('/api/capture', router);
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function json(method, base, path, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
}

function fakeClient() {
    return {
        startSession: async () => ({ sessionId: 's1', status: 'waiting', host: '42.192.212.243', port: '5000' }),
        pollSession: async (id) => ({ sessionId: id, status: 'captured', code: 'CODE123', friendGids: [1001, 1002] }),
        cancelSession: async () => ({ cancelled: true }),
        getCert: async () => ({ buffer: Buffer.from('cert'), contentType: 'application/x-x509-ca-cert' }),
    };
}

test('normalizeCaptureSession flattens gateway payloads', () => {
    const result = normalizeCaptureSession({ session: { id: 'abc', status: 'ready' }, message: '手机已连接' });

    assert.equal(result.sessionId, 'abc');
    assert.equal(result.statusText, '手机已连接');
    assert.equal(result.status, 'ready');
});

test('capture routes expose session lifecycle', async () => {
    const router = createCaptureRouter({ getClient: fakeClient, isEnabled: () => true });
    const { server, base } = await startServer(router);
    try {
        const config = await json('GET', base, '/api/capture/config');
        assert.equal(config.data.data.enabled, true);
        assert.equal(config.data.data.configured, true);

        const started = await json('POST', base, '/api/capture/sessions', {});
        assert.equal(started.data.data.sessionId, 's1');

        const polled = await json('GET', base, '/api/capture/sessions/s1');
        assert.equal(polled.data.data.code, 'CODE123');
        assert.deepEqual(polled.data.data.friendGids, [1001, 1002]);

        const cert = await fetch(`${base}/api/capture/cert`);
        assert.equal(cert.headers.get('content-type'), 'application/x-x509-ca-cert');
        assert.equal(await cert.text(), 'cert');

        const cancelled = await json('DELETE', base, '/api/capture/sessions/s1');
        assert.equal(cancelled.data.data.cancelled, true);

        const expired = await json('GET', base, '/api/capture/sessions/s1');
        assert.equal(expired.status, 410);
    } finally {
        server.close();
        await once(server, 'close');
    }
});

test('capture routes refuse sessions when disabled', async () => {
    const router = createCaptureRouter({ getClient: fakeClient, isEnabled: () => false });
    const { server, base } = await startServer(router);
    try {
        const started = await json('POST', base, '/api/capture/sessions', {});
        assert.equal(started.status, 403);
        assert.match(started.data.error, /未启用/);
    } finally {
        server.close();
        await once(server, 'close');
    }
});
