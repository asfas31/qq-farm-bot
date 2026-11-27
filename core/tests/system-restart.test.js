const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveRestartSupport } = require('../dist/services/system-update');

test('systemd invocation enables the panel restart button', () => {
    const support = resolveRestartSupport('c1@systemd', false);

    assert.equal(support.supported, true);
    assert.equal(support.manager, 'systemd');
    assert.match(support.reason, /systemd/);
});

test('start.sh managed process enables the panel restart button', () => {
    const support = resolveRestartSupport('', true);

    assert.equal(support.supported, true);
    assert.equal(support.manager, 'control');
    assert.match(support.reason, /start\.sh/);
});

test('plain node process refuses the restart button', () => {
    const support = resolveRestartSupport('', false);

    assert.equal(support.supported, false);
    assert.equal(support.manager, 'none');
    assert.match(support.reason, /终端手动重启/);
});
