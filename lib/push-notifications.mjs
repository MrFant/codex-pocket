import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import webpush from "web-push";

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
export function validateSubscription(value) {
  let url;
  try { url = new URL(value?.endpoint); } catch { throw invalid("通知订阅地址无效"); }
  const allowed = url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com"
    || /(^|\.)push\.apple\.com$/.test(url.hostname);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !allowed || url.href.length > 4096) throw invalid("仅接受浏览器推送服务的 HTTPS 地址");
  const { p256dh, auth } = value.keys || {};
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh || "") || Buffer.from(p256dh, "base64url").length !== 65
    || !/^[A-Za-z0-9_-]+$/.test(auth || "") || Buffer.from(auth, "base64url").length !== 16) throw invalid("通知订阅密钥无效");
  return { endpoint: url.href, keys: { p256dh, auth } };
}

export class PushNotifications {
  constructor(filename, { send = webpush.sendNotification.bind(webpush), now = () => Date.now(), subject = "mailto:codex-pocket@example.invalid" } = {}) {
    Object.assign(this, { send, now, subject });
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observed (thread_id TEXT PRIMARY KEY, completion_key TEXT NOT NULL);`);
    this.flushing = null;
    this.lastError = null;
  }
  keys() {
    let value = this.db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get()?.value;
    if (!value) {
      value = JSON.stringify(webpush.generateVAPIDKeys());
      this.db.prepare("INSERT INTO settings VALUES ('vapid', ?)").run(value);
    }
    return JSON.parse(value);
  }
  status() { return { subscriptions: this.db.prepare("SELECT COUNT(*) AS count FROM subscriptions").get().count, lastError: this.lastError }; }
  subscribe(value) {
    const subscription = validateSubscription(value);
    if (this.status().subscriptions >= 16 && !this.db.prepare("SELECT 1 FROM subscriptions WHERE endpoint = ?").get(subscription.endpoint)) throw invalid("已达到通知设备数量上限");
    this.keys();
    if (!this.status().subscriptions) this.db.prepare("INSERT INTO settings VALUES ('monitor_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(this.now()));
    this.db.prepare("INSERT INTO subscriptions VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET value = excluded.value").run(subscription.endpoint, JSON.stringify(subscription));
    return { ok: true };
  }
  hasSubscription(endpoint) { return typeof endpoint === "string" && Boolean(this.db.prepare("SELECT 1 FROM subscriptions WHERE endpoint = ?").get(endpoint)); }
  unsubscribe(endpoint) {
    if (typeof endpoint !== "string" || endpoint.length > 4096) throw invalid("订阅地址无效");
    this.db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").run(endpoint);
    this.db.prepare("DELETE FROM deliveries WHERE endpoint = ?").run(endpoint);
    return { ok: true };
  }
  notify(threadId, kind, key) {
    if (!threadId || !["complete", "failed", "attention"].includes(kind)) return;
    const payload = JSON.stringify({ title: "Codex Pocket", body: ({ complete: "任务已完成，点击查看结果", failed: "任务遇到问题，点击查看", attention: "有一项操作等待你确认" })[kind],
      threadId, kind, tag: createHash("sha256").update(String(key)).digest("hex").slice(0, 32) });
    for (const { endpoint } of this.db.prepare("SELECT endpoint FROM subscriptions").all()) {
      const id = createHash("sha256").update(`${endpoint}\0${key}`).digest("hex");
      this.db.prepare("INSERT OR IGNORE INTO deliveries (id, endpoint, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, endpoint, payload, this.now(), this.now());
    }
  }
  observe(activities) {
    const start = Number(this.db.prepare("SELECT value FROM settings WHERE key = 'monitor_start'").get()?.value || this.now());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [threadId, activity] of Object.entries(activities || {})) {
        if (!activity) continue;
        const previous = this.db.prepare("SELECT completion_key FROM observed WHERE thread_id = ?").get(threadId);
        const key = String(activity.completionKey || '');
        if (previous?.completion_key === key) continue;
        this.db.prepare("INSERT INTO observed VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET completion_key = excluded.completion_key").run(threadId, key);
        const changed = previous || activity.completedAt * 1000 > start;
        if (key && changed && activity.completedAt * 1000 > Math.max(start, this.now() - 300_000) && activity.completedAt * 1000 <= this.now() + 60_000) this.notify(threadId, "complete", `turn:${threadId}:${key}`);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async deliver() {
    // Stale alerts are discarded, and old notification dedupe rows can expire.
    // The separate write-request journal is never pruned here.
    this.db.prepare("UPDATE deliveries SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(this.now() - 30 * 60_000);
    this.db.prepare("DELETE FROM deliveries WHERE status != 'pending' AND created_at < ?").run(this.now() - 30 * 86400_000);
    const jobs = this.db.prepare("SELECT * FROM deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT 16").all(this.now());
    for (const job of jobs) {
      const subscription = this.db.prepare("SELECT value FROM subscriptions WHERE endpoint = ?").get(job.endpoint);
      if (!subscription) continue;
      try {
        await this.send(JSON.parse(subscription.value), job.payload, { vapidDetails: { subject: this.subject, ...this.keys() }, timeout: 5000, TTL: 300,
          topic: JSON.parse(job.payload).tag, urgency: JSON.parse(job.payload).kind === "attention" ? "high" : "normal" });
        this.db.prepare("UPDATE deliveries SET status = 'sent' WHERE id = ?").run(job.id);
        this.lastError = null;
      } catch (error) {
        const code = Number(error.statusCode) || 0;
        this.lastError = { at: this.now(), code: code || "push_unreachable" };
        if ([404, 410].includes(code)) { this.unsubscribe(job.endpoint); continue; }
        const retry = (!code || code === 429 || code >= 500) && job.attempts < 3;
        this.db.prepare("UPDATE deliveries SET status = ?, attempts = attempts + 1, next_at = ? WHERE id = ?")
          .run(retry ? "pending" : "failed", this.now() + 15_000 * 2 ** job.attempts, job.id);
      }
    }
  }
  async close() { await this.flushing; this.db.close(); }
}
