import { newRequestId } from "./session-state.js?v=__BUILD__";

export class WriteOperations {
  constructor({ store, api, onChange = () => {}, onConfirmed = () => {} }) {
    Object.assign(this, { store, api, onChange, onConfirmed });
    this.checking = new Set();
    this.confirming = new Map();
  }

  update(record, changes) {
    const current = this.store.get(record.key);
    if (current && current.id !== record.id) return { ...record, ...changes };
    const next = this.store.save({ ...record, ...changes });
    this.onChange(next);
    return next;
  }

  async send(key, path, body, context = {}) {
    const previous = this.store.get(key);
    if (previous && !["confirmed", "failed", "dismissed"].includes(previous.status)) {
      throw Object.assign(new Error("上一条请求还在核对，请先查看发送状态"), { code: "request_pending" });
    }
    const record = this.store.save({ key, id: newRequestId(), path, body, context, createdAt: Date.now(), status: "pending" });
    if (!this.store.persistent) {
      const error = { message: "浏览器无法保存发送记录，请释放站点存储后重试；消息尚未发送", code: "storage_unavailable" };
      this.update(record, { status: "failed", error });
      throw Object.assign(new Error(error.message), error);
    }
    this.onChange(record);
    return this.post(record);
  }

  async confirm(record, result) {
    if (this.confirming.has(record.id)) return this.confirming.get(record.id);
    const promise = (async () => {
      const current = this.store.get(record.key);
      const active = current?.id === record.id ? current : record;
      const confirmed = this.update(active, {
        status: "confirmed", result, error: null, confirmedAt: active.confirmedAt || Date.now(),
      });
      if (!confirmed.applied) {
        await this.onConfirmed(confirmed, result);
        this.update(confirmed, { applied: true });
      }
      return result;
    })().finally(() => this.confirming.delete(record.id));
    this.confirming.set(record.id, promise);
    return promise;
  }

  async post(record) {
    let result;
    try {
      result = await this.api(record.path, {
        method: "POST", timeoutMs: 20_000,
        body: JSON.stringify({ ...record.body, clientRequestId: record.id }),
      });
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.code !== "request_outcome_unknown") {
        this.update(record, { status: "failed", error: { message: error.message, code: error.code, status: error.status } });
        throw error;
      }
      this.update(record, { status: "checking", error: { message: error.message } });
      const checked = await this.check(record.key);
      if (checked?.status === "confirmed") return checked.result;
      if (checked?.status === "failed") throw Object.assign(new Error(checked.error.message), checked.error);
      return null;
    }
    return this.confirm(record, result);
  }

  async check(key) {
    const record = this.store.get(key);
    if (!record || this.checking.has(key) || record.status === "dismissed") return record;
    if (record.status === "confirmed") {
      if (!record.applied) await this.confirm(record, record.result);
      return this.store.get(key);
    }
    this.checking.add(key);
    try {
      let remote;
      try { remote = await this.api(`/api/requests/${encodeURIComponent(record.id)}`); }
      catch (error) {
        return this.update(record, {
          status: error.code === "request_not_found" ? "not_received" : "checking",
          error: { message: error.message },
        });
      }
      if (remote.status === "confirmed") await this.confirm(record, remote.result);
      else this.update(record, { status: remote.status, error: remote.error || null });
      return this.store.get(key);
    } finally { this.checking.delete(key); }
  }

  async retry(key) {
    const checked = await this.check(key);
    // A missing journal entry is the only safe automatic re-dispatch. The same
    // ID also protects against a late arrival of the original HTTP request.
    if (checked?.status === "not_received") return this.post(this.update(checked, { status: "pending" }));
    return checked?.status === "confirmed" ? checked.result : null;
  }
}
