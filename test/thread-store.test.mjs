import assert from "node:assert/strict";
import test from "node:test";
import { ThreadStore } from "../public/thread-store.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("keeps a fresh fork visible while delayed canonical lists omit it", () => {
  let now = 1_000_000;
  const storage = memoryStorage();
  const store = new ThreadStore({ storage, now: () => now });
  store.replaceCanonical([{ id: "parent", name: "Parent", recencyAt: 10 }]);
  store.upsertOptimistic({ id: "fork", name: "Fork", recencyAt: 20, projectId: "project" });

  assert.deepEqual(store.list().map((thread) => thread.id), ["fork", "parent"]);
  store.replaceCanonical([{ id: "parent", name: "Parent", recencyAt: 10 }]);
  assert.deepEqual(store.list().map((thread) => thread.id), ["fork", "parent"]);

  const afterRefresh = new ThreadStore({ storage, now: () => now });
  afterRefresh.replaceCanonical([{ id: "parent", name: "Parent", recencyAt: 10 }]);
  assert.deepEqual(afterRefresh.list().map((thread) => thread.id), ["fork", "parent"]);

  now += 1_000;
  afterRefresh.replaceCanonical([
    { id: "fork", name: "Desktop title", recencyAt: 30 },
    { id: "parent", name: "Parent", recencyAt: 10 },
  ]);
  assert.equal(afterRefresh.list().filter((thread) => thread.id === "fork").length, 1);
  assert.equal(afterRefresh.get("fork").name, "Desktop title");
});

test("expires stale optimistic records and hides them from archived views", () => {
  let now = 1_000;
  const storage = memoryStorage();
  const store = new ThreadStore({ storage, now: () => now, ttlMs: 100 });
  store.upsertOptimistic({ id: "fork", name: "Fork" });
  assert.equal(store.list().length, 1);
  store.replaceCanonical([], { archived: true });
  assert.equal(store.list().length, 0);

  now += 101;
  const restored = new ThreadStore({ storage, now: () => now, ttlMs: 100 });
  restored.replaceCanonical([]);
  assert.equal(restored.list().length, 0);
});
