export function localStorageOrNull() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function newRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

class LocalRecords {
  constructor(prefix, storage = localStorageOrNull()) {
    this.prefix = prefix;
    this.storage = storage;
    this.memory = new Map();
    this.dirty = new Set();
    this.persistent = Boolean(storage);
  }

  get(key) {
    if (this.dirty.has(key)) return this.memory.get(key) || null;
    try {
      const value = JSON.parse(this.storage?.getItem(this.prefix + key) || "null");
      if (value) this.memory.set(key, value);
    } catch { /* An unavailable cache must not block the page. */ }
    return this.memory.get(key) || null;
  }

  set(key, value) {
    this.memory.set(key, value);
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      this.storage.setItem(this.prefix + key, JSON.stringify(value));
      this.dirty.delete(key);
      this.persistent = this.dirty.size === 0;
    } catch { this.persistent = false; this.dirty.add(key); }
    return value;
  }

  list() {
    try {
      for (let index = 0; index < (this.storage?.length || 0); index += 1) {
        const key = this.storage.key(index);
        if (key?.startsWith(this.prefix)) this.get(key.slice(this.prefix.length));
      }
    } catch { /* Keep the in-memory records. */ }
    return [...this.memory.values()];
  }
}

export class DraftStore extends LocalRecords {
  constructor(storage) { super("codex-pocket-draft-v1:", storage); }

  save(threadId, text, attachments) {
    const previous = this.get(threadId);
    attachments ??= previous?.attachments || [];
    if (previous?.text === text && JSON.stringify(previous?.attachments || []) === JSON.stringify(attachments)) return previous;
    return this.set(threadId, { threadId, text, attachments, revision: newRequestId(), updatedAt: Date.now() });
  }

  acknowledge(threadId, snapshot) {
    const current = this.get(threadId);
    if (!snapshot || current?.revision !== snapshot.revision || current?.text !== snapshot.text) return false;
    this.save(threadId, "", []);
    return true;
  }
}

export class OperationStore extends LocalRecords {
  constructor(storage) { super("codex-pocket-operation-v1:", storage); }
  save(record) { return this.set(record.key, { ...record, updatedAt: Date.now() }); }
  pending() { return this.list().filter((record) => record.status === "confirmed" ? !record.applied : !["failed", "dismissed"].includes(record.status)); }
}

export class ReadingStore extends LocalRecords {
  constructor(storage) { super("codex-pocket-reading-v1:", storage); }
  save(threadId, position) { return this.set(threadId, { ...position, threadId }); }
}

export function captureReadingPosition(container) {
  const bounds = container.getBoundingClientRect();
  const anchor = [...container.querySelectorAll("[data-item-id]")]
    .find((node) => node.getBoundingClientRect().bottom > bounds.top + 1);
  return {
    atBottom: container.scrollHeight - container.scrollTop - container.clientHeight < 80,
    itemId: anchor?.dataset.itemId || null,
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
    scrollTop: container.scrollTop,
  };
}

export function restoreReadingPosition(container, position) {
  if (!position || position.atBottom) container.scrollTop = container.scrollHeight;
  else {
    const anchor = [...container.querySelectorAll("[data-item-id]")].find((node) => node.dataset.itemId === position.itemId);
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
    else container.scrollTop = position.scrollTop || 0;
  }
}
