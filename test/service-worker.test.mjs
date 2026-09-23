import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')).replaceAll('__BUILD__', 'current').replace('__STATIC_FILES__', '[]');
function harness() {
  const listeners = {}, notices = [], routes = [], removed = [];
  const client = { url: 'https://pocket.example/?thread=old', state: { busy: false, build: 'older' },
    postMessage(message, ports) { if (message.type === 'CAN_UPDATE') ports[0].postMessage(this.state); else routes.push(message); },
    async focus() { routes.push('focus'); } };
  class Channel { constructor() { this.port1 = { close() {} }; this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage({ data })) }; } }
  const self = { location: { origin: 'https://pocket.example' }, registration: { showNotification: async (...args) => notices.push(args) },
    clients: { matchAll: async () => self.windows, claim: async () => {}, openWindow: async (url) => routes.push(url) },
    windows: [client], skipped: 0, skipWaiting: async () => self.skipped++, addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(source, { self, URL, MessageChannel: Channel, setTimeout, clearTimeout,
    caches: { keys: async () => ['codex-pocket-vcurrent', 'codex-pocket-volder', 'codex-pocket-vunused', 'other-app'], delete: async (key) => removed.push(key) } });
  async function dispatch(name, data = {}) { let pending; listeners[name]({ ...data, waitUntil: (promise) => { pending = promise; } }); await pending; }
  return { self, client, notices, routes, removed, dispatch };
}

test('updates require all pages to be ready; cleanup preserves caches still in use and pending installs', async () => {
  const h = harness(), replies = [];
  const event = (type) => ({ data: { type }, ports: [{ postMessage: (message) => replies.push(message) }] });
  h.client.state.busy = true;
  await h.dispatch('message', event('ACTIVATE_UPDATE')); assert.equal(h.self.skipped, 0); assert.equal(replies.at(-1).ok, false);
  h.client.state.busy = false;
  await h.dispatch('message', event('ACTIVATE_UPDATE')); assert.equal(h.self.skipped, 1);
  await h.dispatch('message', event('CLEAN_UNUSED_CACHES')); assert.deepEqual(h.removed, ['codex-pocket-vunused']);
  h.self.registration.waiting = {};
  await h.dispatch('message', event('CLEAN_UNUSED_CACHES')); assert.equal(replies.at(-1).reason, 'update_pending');
});

test('push uses generic text and clicks route existing pages without destroying drafts', async () => {
  const h = harness();
  await h.dispatch('push', { data: { json: () => ({ title: 'untrusted', body: 'private contents', kind: 'complete', threadId: 'A', tag: 'one' }) } });
  assert.equal(h.notices[0][0], 'Codex Pocket'); assert.equal(h.notices[0][1].body, '任务已完成，点击查看结果');
  const notification = { data: { threadId: 'A' }, close() {} };
  await h.dispatch('notificationclick', { notification });
  assert.equal(h.routes[0].type, 'OPEN_THREAD'); assert.equal(h.routes[0].threadId, 'A'); assert.equal(h.routes[1], 'focus');
  h.self.windows = []; notification.data.threadId = 'https://evil.example/?private=1';
  await h.dispatch('notificationclick', { notification });
  assert.equal(new URL(h.routes.at(-1)).origin, 'https://pocket.example');
  assert.equal(new URL(h.routes.at(-1)).searchParams.get('thread'), notification.data.threadId);
});
