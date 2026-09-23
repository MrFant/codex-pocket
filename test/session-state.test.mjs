import test from "node:test";
import assert from "node:assert/strict";
import { DraftStore, OperationStore } from "../public/session-state.js";
import { WriteOperations } from "../public/write-operations.js";

function storage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, value), key: (index) => [...map.keys()][index], get length() { return map.size; } };
}

test("drafts survive reload per thread and acknowledgements never erase newer revisions", () => {
  const disk = storage();
  let drafts = new DraftStore(disk);
  const submitted = drafts.save("A", "first");
  drafts.save("B", "another conversation");
  drafts.save("A", "next message while waiting");
  drafts = new DraftStore(disk);
  assert.equal(drafts.get("A").text, "next message while waiting");
  assert.equal(drafts.get("B").text, "another conversation");
  assert.equal(drafts.acknowledge("A", submitted), false);
  drafts.save("A", "first");
  assert.equal(drafts.acknowledge("A", submitted), false, "retyped identical content has a new revision");
  assert.equal(drafts.acknowledge("A", drafts.get("A")), true);
  assert.equal(drafts.get("B").text, "another conversation");
});

test("storage failures preserve the latest in-memory draft instead of restoring stale disk data", () => {
  const disk = storage();
  const drafts = new DraftStore(disk);
  drafts.save("A", "old");
  disk.setItem = () => { throw new Error("Quota exceeded"); };
  drafts.save("A", "latest");
  assert.equal(drafts.get("A").text, "latest");
  assert.equal(drafts.persistent, false);
});

test("a lost HTTP response is recovered by querying the journal without posting twice", async () => {
  const disk = storage();
  const store = new OperationStore(disk);
  let posts = 0;
  let confirmations = 0;
  const writes = new WriteOperations({ store, api: async (_path, options) => {
    if (options?.method) { posts += 1; throw new TypeError("Network failure"); }
    return { status: "confirmed", result: { turn: { id: "sent-once" } } };
  }, onConfirmed: () => { confirmations += 1; } });
  const result = await writes.send("A", "/api/threads/A/messages", { text: "hello" });
  assert.equal(result.turn.id, "sent-once");
  assert.equal(posts, 1);
  assert.equal(confirmations, 1);
  assert.equal(new OperationStore(disk).get("A").status, "confirmed");
});

test("unknown writes survive browser reload and cannot be retried; missing writes reuse the original ID", async () => {
  const disk = storage();
  let remote = "unknown";
  const postIds = [];
  const api = async (_path, options) => {
    if (options?.method) { postIds.push(JSON.parse(options.body).clientRequestId); throw new TypeError("Network failure"); }
    if (remote === "not_received") throw Object.assign(new Error("Not received"), { status: 404, code: "request_not_found" });
    return { status: remote };
  };
  let writes = new WriteOperations({ store: new OperationStore(disk), api });
  assert.equal(await writes.send("A", "/api/threads/A/messages", { text: "hello" }), null);
  writes = new WriteOperations({ store: new OperationStore(disk), api });
  await writes.retry("A");
  await assert.rejects(writes.send("A", "/api/threads/A/messages", { text: "hello" }), { code: "request_pending" });
  assert.equal(postIds.length, 1);
  remote = "not_received";
  await writes.retry("A");
  assert.equal(postIds.length, 2);
  assert.equal(postIds[0], postIds[1]);
});

test("query and late POST confirmations apply a successful result only once", async () => {
  const store = new OperationStore(storage());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let confirmations = 0;
  const writes = new WriteOperations({ store, api: async () => ({}), onConfirmed: async () => { confirmations += 1; await gate; } });
  const record = store.save({ key: "A", id: "one", createdAt: 1, status: "pending", context: {} });
  const first = writes.confirm(record, { turn: { id: "accepted" } });
  const second = writes.confirm(record, { turn: { id: "accepted" } });
  release();
  await Promise.all([first, second]);
  await writes.confirm(record, { turn: { id: "accepted" } });
  assert.equal(confirmations, 1);
});

test("a browser that cannot persist a request does not dispatch an unrecoverable write", async () => {
  const disk = storage();
  disk.setItem = () => { throw new Error("Quota exceeded"); };
  let posts = 0;
  const writes = new WriteOperations({ store: new OperationStore(disk), api: async () => { posts += 1; } });
  await assert.rejects(writes.send("A", "/api/threads/A/messages", { text: "Keep my input" }), { code: "storage_unavailable" });
  assert.equal(posts, 0);
});

test("image attachments participate in draft revisions and survive restoring an older text-only draft", () => {
  const storage = new Map();
  const disk = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const drafts = new DraftStore(disk);
  const original = drafts.save("A", "", [{ id: "first", status: "ready" }]);
  const changed = drafts.save("A", "", [...original.attachments, { id: "second", status: "ready" }]);
  assert.notEqual(original.revision, changed.revision);
  assert.equal(drafts.acknowledge("A", original), false);
  assert.equal(new DraftStore(disk).get("A").attachments.length, 2);
  drafts.save("A", "added text");
  assert.equal(drafts.get("A").attachments.length, 2);
  assert.equal(drafts.acknowledge("A", drafts.get("A")), true);
  assert.deepEqual(drafts.get("A").attachments, []);
});

test('a saved draft in another thread cannot hide an unsaved draft during an update', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem(key, value) { if (key.endsWith(':A')) throw new Error('quota'); values.set(key, value); } };
  const drafts = new DraftStore(storage);
  drafts.save('A', 'Must survive in memory');
  drafts.save('B', 'Successfully persisted');
  assert.equal(drafts.persistent, false);
  assert.equal(drafts.get('A').text, 'Must survive in memory');
});
