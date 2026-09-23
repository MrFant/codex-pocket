import test from 'node:test';
import assert from 'node:assert/strict';
import { historyPage } from '../lib/history-pages.mjs';
import { mergeHistory, flattenHistory, threadWithItems } from '../public/history-window.js';
const result = { thread: { id: 'A', model: 'own-model', turns: [{ id: 'turn-A', status: 'completed', items: Array.from({ length: 1000 }, (_, n) => ({ id: `item-${n}`, type: 'agentMessage', text: `${n}` })) }] } };
const page = (options = {}, source = result) => historyPage(source, new URLSearchParams({ limit: '100', ...options }));

test('history cursors remain stable as new items append, and pages preserve thread settings', () => {
  const latest = page();
  assert.equal(latest.thread.model, 'own-model');
  assert.equal(flattenHistory(latest.thread).length, 100);
  assert.equal(flattenHistory(latest.thread)[0].id, 'item-900');
  const appended = structuredClone(result);
  appended.thread.turns[0].items.push({ id: 'new', type: 'agentMessage', text: 'new' });
  const earlier = page({ before: latest.history.beforeCursor }, appended);
  assert.equal(flattenHistory(earlier.thread)[0].id, 'item-800');
  assert.equal(flattenHistory(earlier.thread).at(-1).id, 'item-899');
  const later = page({ after: latest.history.afterCursor }, appended);
  assert.deepEqual(flattenHistory(later.thread).map((item) => item.id), ['new']);
  assert.equal(later.history.hasLater, false);
  const around = page({ around: 'item-450', limit: '200' });
  assert.equal(flattenHistory(around.thread)[100].id, 'item-450');
  assert.equal(around.history.hasLater, true);
  assert.equal(around.history.anchorFound, true);
});

test('history parameters are bounded and lost anchors fall back only for reopening', () => {
  for (const options of [{ limit: '201' }, { limit: '0' }, { limit: 'no' }, { before: 'a', after: 'b' }]) assert.throws(() => page(options), { status: 400 });
  assert.throws(() => page({ before: 'gone' }), { status: 409, code: 'history_cursor_missing' });
  assert.equal(page({ around: 'gone' }).history.anchorFound, false);
  const source = { thread: { turns: [{ id: 't', items: [{ id: 'file', type: 'fileChange', changes: [{ path: 'a.js', diff: '+secret' }] }] }] } };
  assert.equal(page({}, source).thread.turns[0].items[0].changes[0].diff, undefined);
  assert.equal(page({}, source).thread.turns[0].items[0].changes[0].diffAvailable, true);
  assert.equal(historyPage(source, new URLSearchParams()), source);
});

test('moving the history window in both directions bounds memory and keeps turn metadata', () => {
  let latest = page();
  let window = { items: flattenHistory(latest.thread), history: latest.history };
  for (let n = 0; n < 6; n++) {
    window = mergeHistory(window, page({ before: window.history.beforeCursor }), 'before');
    assert.ok(window.items.length <= 200);
    assert.equal(new Set(window.items.map((item) => item.id)).size, window.items.length);
  }
  assert.equal(window.items[0].id, 'item-300');
  assert.equal(window.history.hasLater, true);
  for (let n = 0; n < 6; n++) window = mergeHistory(window, page({ after: window.history.afterCursor }), 'after');
  assert.equal(window.items.at(-1).id, 'item-999');
  assert.equal(window.history.hasLater, false);
  assert.equal(threadWithItems(result.thread, window.items).turns[0].status, 'completed');
});
