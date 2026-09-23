import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function requestError(message, code) {
  return Object.assign(new Error(message), { status: 409, code });
}

// A timeout or process exit does not prove that a write failed. Persist the
// intent before dispatch and never replay an interrupted write automatically.
export class RequestJournal {
  constructor(filename) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, signature TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      UPDATE requests SET status = 'unknown' WHERE status = 'pending';
    `);
    this.inFlight = new Map();
  }

  stats() {
    const rows = this.database.prepare("SELECT status, COUNT(*) AS count FROM requests GROUP BY status").all();
    const pages = this.database.prepare("PRAGMA page_count").get().page_count;
    const pageSize = this.database.prepare("PRAGMA page_size").get().page_size;
    return { bytes: pages * pageSize, count: rows.reduce((sum, row) => sum + row.count, 0), statuses: Object.fromEntries(rows.map((row) => [row.status, row.count])) };
  }

  get(id) {
    const row = this.database.prepare("SELECT * FROM requests WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.result ? { result: JSON.parse(row.result) } : {}),
      ...(row.error ? { error: JSON.parse(row.error) } : {}),
    };
  }

  async execute(id, payload, operation) {
    if (!id) return operation(); // Compatibility with older clients.
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      throw Object.assign(new Error("Invalid client request ID"), { status: 400 });
    }
    const signature = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
    const existing = this.database.prepare("SELECT signature FROM requests WHERE id = ?").get(id);
    if (existing) {
      if (existing.signature !== signature) throw requestError("请求编号已用于不同内容", "idempotency_conflict");
      if (this.inFlight.has(id)) return this.inFlight.get(id);
      const record = this.get(id);
      if (record.status === "confirmed") return record.result;
      if (record.status === "failed") throw Object.assign(new Error(record.error.message), record.error);
      throw requestError("请求结果尚不确定，请先核对会话；不会自动重复执行", "request_outcome_unknown");
    }
    const now = Date.now();
    this.database.prepare("INSERT INTO requests (id, signature, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
      .run(id, signature, now, now);
    const promise = Promise.resolve().then(operation).then((result) => {
      this.database.prepare("UPDATE requests SET status = 'confirmed', result = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result ?? { ok: true }), Date.now(), id);
      return result;
    }).catch((error) => {
      const definite = ["thread_writer_conflict", "no_active_turn", "stale_turn", "active_turn", "runtime_stopping", -32602].includes(error.code)
        || (error.status >= 400 && error.status < 500);
      const detail = { message: error.message, code: error.code || null, status: error.status || 409 };
      this.database.prepare("UPDATE requests SET status = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(definite ? "failed" : "unknown", JSON.stringify(detail), Date.now(), id);
      if (definite) throw error;
      throw requestError("请求结果尚不确定，请先核对会话；不会自动重复执行", "request_outcome_unknown");
    }).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, promise);
    return promise;
  }

  async close() {
    await Promise.allSettled([...this.inFlight.values()]);
    this.database.close();
  }
}
