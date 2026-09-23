import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PushNotifications, validateSubscription } from '../lib/push-notifications.mjs';
const subscription = { endpoint: 'https://web.push.apple.com/test-token', keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };

test('subscriptions reject local endpoints and malformed encryption keys', () => {
  for (const endpoint of ['http://fcm.googleapis.com/token', 'https://127.0.0.1:3210/api/status', 'https://evil.push.apple.com.evil.example/token', 'https://a@web.push.apple.com/token', 'https://web.push.apple.com:3210/token']) {
    assert.throws(() => validateSubscription({ ...subscription, endpoint }), { status: 400 });
  }
  assert.throws(() => validateSubscription({ ...subscription, keys: { auth: 'bad', p256dh: 'bad' } }), { status: 400 });
  assert.deepEqual(validateSubscription(subscription), subscription);
});

test('push is opt in, private, deduplicated across restart and discards expired subscriptions', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pocket-push-'));
  const filename = path.join(directory, 'push.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent = []; let now = 1_000_000;
  let push = new PushNotifications(filename, { now: () => now, send: async (...args) => sent.push(args) });
  push.notify('A', 'complete', 'turn:A:one'); await push.flush(); assert.equal(sent.length, 0);
  push.subscribe(subscription);
  const key = push.keys().publicKey;
  push.notify('A', 'failed', 'turn:A:one'); push.notify('A', 'complete', 'turn:A:one');
  await Promise.all([push.flush(), push.flush()]); assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0][1]).kind, 'failed');
  assert.equal(JSON.parse(sent[0][1]).body.includes('A'), false);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await push.close();
  push = new PushNotifications(filename, { now: () => now, send: async () => { throw { statusCode: 410 }; } });
  t.after(() => push.close());
  assert.equal(push.keys().publicKey, key);
  push.notify('A', 'complete', 'turn:A:one'); await push.flush(); assert.equal(push.status().subscriptions, 1);
  push.notify('A', 'attention', 'approval:A:two'); await push.flush(); assert.equal(push.status().subscriptions, 0);
});

test('push retries temporarily unavailable services and observes only new, recent completions', async (t) => {
  let now = 1_000_000, attempts = 0;
  const push = new PushNotifications(':memory:', { now: () => now, send: async () => { attempts++; if (attempts === 1) throw { statusCode: 503 }; } });
  t.after(() => push.close()); push.subscribe(subscription);
  push.observe({ A: { completionKey: 'old', completedAt: 900 }, B: {} }); await push.flush(); assert.equal(attempts, 0);
  now += 1000;
  push.observe({ A: { completionKey: 'new', completedAt: now / 1000 } });
  await push.flush(); assert.equal(attempts, 1); assert.equal(push.status().lastError.code, 503);
  await push.flush(); assert.equal(attempts, 1);
  now += 15000; await push.flush(); assert.equal(attempts, 2);
  push.observe({ A: { completionKey: 'new', completedAt: now / 1000 } }); await push.flush(); assert.equal(attempts, 2);
  push.observe({ B: { completionKey: 'first', completedAt: now / 1000 }, C: { completionKey: 'brand-new', completedAt: now / 1000 } });
  await push.flush(); assert.equal(attempts, 4);
  push.notify('D', 'attention', 'stale-approval'); now += 31 * 60000; await push.flush(); assert.equal(attempts, 4);
});
