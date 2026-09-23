import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventStream } from '../public/event-stream.js';
async function until(condition) { for (let n = 0; n < 200; n++) { if (condition()) return; await sleep(5); } assert.fail('stream did not reach expected state'); }
function harness(t) {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const win = new EventTarget(), nav = { onLine: true };
  const connections = [], states = [], events = [];
  let resumes = 0;
  const stream = new EventStream({ document: doc, window: win, navigator: nav, heartbeatMs: 45, retryMs: 10,
    onEvent: (event) => events.push(event), onState: (state) => states.push(state), onResume: () => resumes++,
    fetcher: async (url, options) => {
      assert.equal(url, '/api/events'); assert.equal(options.method, undefined);
      let controller;
      const body = new ReadableStream({ start(value) { controller = value; } });
      options.signal.addEventListener('abort', () => { try { controller.error(new Error('aborted')); } catch {} });
      connections.push({ signal: options.signal, write(text) { controller.enqueue(new TextEncoder().encode(text)); }, close() { controller.close(); } });
      return new Response(body);
    },
  });
  t.after(() => stream.stop()); stream.start();
  return { stream, doc, win, nav, connections, states, events, resumes: () => resumes };
}

test('silent and cleanly closed SSE streams reconnect with backoff without replaying writes', async (t) => {
  const h = harness(t);
  await until(() => h.connections.length >= 2);
  assert.equal(h.connections[0].signal.aborted, true);
  const current = h.connections.at(-1);
  current.write('data: {"kind":"snap'); current.write('shot"}\n\n');
  await until(() => h.events.length === 1);
  assert.deepEqual(h.events[0], { kind: 'snapshot' });
  const count = h.connections.length; current.close();
  await sleep(2); assert.equal(h.connections.length, count);
  await until(() => h.connections.length > count);
  assert.ok(h.states.includes('offline'));
});

test('heartbeats renew the watchdog and lock screen/offline suspension only resume reads', async (t) => {
  const h = harness(t);
  for (let n = 0; n < 5; n++) { h.connections[0].write(': keepalive\n\n'); await sleep(15); }
  assert.equal(h.connections.length, 1);
  h.doc.visibilityState = 'hidden'; h.doc.dispatchEvent(new Event('visibilitychange'));
  await sleep(60); assert.equal(h.connections.length, 1);
  h.doc.visibilityState = 'visible'; h.doc.dispatchEvent(new Event('visibilitychange'));
  await until(() => h.connections.length === 2); assert.equal(h.resumes(), 1);
  h.nav.onLine = false; h.win.dispatchEvent(new Event('offline'));
  await sleep(60); assert.equal(h.connections.length, 2);
  h.nav.onLine = true; h.win.dispatchEvent(new Event('online'));
  await until(() => h.connections.length === 3); assert.equal(h.resumes(), 2);
});
