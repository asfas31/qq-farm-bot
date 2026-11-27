const assert = require('node:assert/strict');
const test = require('node:test');

const { buildNetworkGitArgs } = require('../dist/services/system-update');

const ORIGIN = 'https://github.com/asfas31/qq-farm-bot.git';
const MIRROR = 'https://ghproxy.net/';

test('mirror fetch adds an explicit remote-tracking refspec', () => {
    const args = buildNetworkGitArgs(['fetch', '--prune', 'origin'], 'origin', ORIGIN, MIRROR);

    assert.deepEqual(args, [
        'fetch',
        '--prune',
        `${MIRROR}${ORIGIN}`,
        '+refs/heads/*:refs/remotes/origin/*',
    ]);
});

test('mirror pull rewrites the remote without a refspec', () => {
    const args = buildNetworkGitArgs(['pull', '--ff-only', 'origin', 'main'], 'origin', ORIGIN, MIRROR);

    assert.deepEqual(args, ['pull', '--ff-only', `${MIRROR}${ORIGIN}`, 'main']);
});

test('direct attempt leaves git args untouched', () => {
    const args = ['fetch', '--prune', 'origin'];

    assert.deepEqual(buildNetworkGitArgs(args, 'origin', ORIGIN, ''), args);
});

test('ssh remote is never rewritten to a public mirror', () => {
    const args = ['fetch', '--prune', 'origin'];

    assert.deepEqual(buildNetworkGitArgs(args, 'origin', 'git@github.com:asfas31/qq-farm-bot.git', MIRROR), args);
});
