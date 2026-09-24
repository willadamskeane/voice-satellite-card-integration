// Run with: node --experimental-vm-modules --test tests/toast-timeout.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

async function manager(config) {
  const timers = [];
  const context = vm.createContext({
    console, Date,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
  });
  const file = path.join(root, 'src/toast/index.js');
  const module = new vm.SourceTextModule(readFileSync(file, 'utf8'), { context, identifier: file });
  await module.link(() => { throw new Error('no imports expected'); });
  await module.evaluate();
  const session = { config, logger: { log() {}, error() {} } };
  return { toasts: new module.namespace.ToastManager(session), timers };
}

const error = { id: 'pipeline.unexpected-error', severity: 'error', category: 'Pipeline', description: 'x' };

test('error toasts stay until dismissed by default', async () => {
  const { toasts, timers } = await manager({});
  toasts.show(error);
  assert.equal(timers.length, 0);
  assert.equal(toasts.current.id, error.id);
});

test('error_toast_timeout_s clears error toasts after that many seconds', async () => {
  const { toasts, timers } = await manager({ error_toast_timeout_s: 30 });
  toasts.show(error);
  assert.equal(timers.at(-1).delay, 30000);
  timers.at(-1).fn();
  assert.equal(toasts.current, null);
});

test('the timeout leaves warnings and persistent toasts alone', async () => {
  const { toasts, timers } = await manager({ error_toast_timeout_s: 30 });
  toasts.show({ ...error, id: 'w', severity: 'warn' });
  assert.equal(timers.at(-1).delay, 8000);
  const before = timers.length;
  toasts.show({ ...error, id: 'p', persistent: true });
  assert.equal(timers.length, before);
});
