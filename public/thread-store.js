const STORAGE_KEY = "codex-pocket-recent-threads-v1";
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const MAX_RECENT_THREADS = 20;

function recency(thread = {}) {
  return Number(thread.recencyAt || thread.updatedAt || thread.createdAt || 0);
}

export class ThreadStore {
  constructor({ storage = globalThis.localStorage, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.storage = storage;
    this.now = now;
    this.ttlMs = ttlMs;
    this.canonical = new Map();
    this.optimistic = new Map();
    this.archived = false;
    this.#restore();
  }

  #restore() {
    if (!this.storage) return;
    try {
      const entries = JSON.parse(this.storage.getItem(STORAGE_KEY) || "[]");
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry?.thread?.id || this.now() - entry.savedAt > this.ttlMs) continue;
        this.optimistic.set(entry.thread.id, entry);
      }
      this.#persist();
    } catch {
      // Storage is an acceleration layer; corrupt data must never block the app.
    }
  }

  #persist() {
    if (!this.storage) return;
    try {
      const entries = [...this.optimistic.values()]
        .filter((entry) => this.now() - entry.savedAt <= this.ttlMs)
        .sort((left, right) => right.savedAt - left.savedAt)
        .slice(0, MAX_RECENT_THREADS);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Private browsing and storage quotas are safe to ignore.
    }
  }

  replaceCanonical(threads, { archived = false } = {}) {
    this.archived = archived;
    this.canonical = new Map((threads || []).filter((thread) => thread?.id)
      .map((thread) => [thread.id, thread]));
    for (const threadId of this.canonical.keys()) this.optimistic.delete(threadId);
    for (const [threadId, entry] of this.optimistic) {
      if (this.now() - entry.savedAt > this.ttlMs) this.optimistic.delete(threadId);
    }
    this.#persist();
    return this.list();
  }

  upsertOptimistic(thread) {
    if (!thread?.id) return this.list();
    const existing = this.get(thread.id) || {};
    const nowSeconds = Math.floor(this.now() / 1_000);
    const merged = {
      ...existing,
      ...thread,
      createdAt: thread.createdAt || existing.createdAt || nowSeconds,
      updatedAt: thread.updatedAt || nowSeconds,
      recencyAt: thread.recencyAt || nowSeconds,
      optimistic: true,
    };
    this.optimistic.set(thread.id, { savedAt: this.now(), thread: merged });
    this.#persist();
    return this.list();
  }

  remove(threadId) {
    this.canonical.delete(threadId);
    this.optimistic.delete(threadId);
    this.#persist();
    return this.list();
  }

  get(threadId) {
    return this.canonical.get(threadId) || this.optimistic.get(threadId)?.thread || null;
  }

  list() {
    const canonical = [...this.canonical.values()];
    if (this.archived) return canonical;
    const recent = [...this.optimistic.values()]
      .map((entry) => entry.thread)
      .filter((thread) => !this.canonical.has(thread.id))
      .sort((left, right) => recency(right) - recency(left));
    return [...recent, ...canonical];
  }
}
