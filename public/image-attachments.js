import { newRequestId } from "./session-state.js?v=__BUILD__";

let database;
function imageDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("codex-pocket-images", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("blobs");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
async function blobOperation(method, key, value) {
  const db = await imageDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("blobs", method === "get" ? "readonly" : "readwrite");
    const store = transaction.objectStore("blobs");
    const request = method === "put" ? store.put(value, key) : store[method](key);
    transaction.oncomplete = () => resolve(method === 'get' && request.result?.bytes
      ? new Blob([request.result.bytes], { type: request.result.type }) : request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("图片存储不可用"));
  });
}

export class ImageAttachments {
  constructor({ drafts, api, onChange }) {
    this.drafts = drafts;
    this.api = api;
    this.onChange = onChange;
    this.uploads = new Set();
    this.pendingAdds = 0;
    this.previews = new Map();
  }
  list(threadId) { return this.drafts.get(threadId)?.attachments || []; }
  update(threadId, transform) {
    const draft = this.drafts.get(threadId);
    this.drafts.save(threadId, draft?.text || "", transform(draft?.attachments || []));
    this.onChange(threadId);
  }
  async add(threadId, files) {
    this.pendingAdds += 1; this.onChange(threadId);
    try {
    for (const file of files) {
      if (this.list(threadId).length >= 4) throw new Error("每条消息最多附带 4 张图片");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
      if (file.size > 10 * 1024 * 1024) throw new Error("每张图片需小于 10 MB");
      const localId = newRequestId();
      // Store bytes instead of a File/Blob: WebKit can reject Blob writes in
      // transient/private storage even when IndexedDB itself is available.
      await blobOperation("put", localId, { bytes: await file.arrayBuffer(), type: file.type });
      if (this.list(threadId).length >= 4) { await blobOperation("delete", localId); throw new Error("每条消息最多附带 4 张图片"); }
      this.update(threadId, (list) => [...list, { localId, name: file.name || "截图", status: "uploading" }]);
      if (!this.drafts.persistent) throw new Error("草稿存储不可用，请保持此页打开");
      void this.upload(threadId, localId);
    }
    } finally { this.pendingAdds -= 1; this.onChange(threadId); }
  }
  async upload(threadId, localId) {
    if (this.uploads.has(localId)) return;
    this.uploads.add(localId);
    const patch = (values) => this.update(threadId, (list) => list.map((item) => item.localId === localId ? { ...item, ...values } : item));
    patch({ status: "uploading", error: null });
    try {
      const blob = await blobOperation("get", localId);
      if (!blob) throw new Error("本地图片已不可用，请移除后重新选择");
      const result = await this.api("/api/images", { method: "POST", body: blob, headers: { "Content-Type": blob.type, "X-Pocket-Attachment-Id": localId }, timeoutMs: 30_000 });
      if (!this.list(threadId).some((item) => item.localId === localId)) void this.release({ ...result, localId });
      else patch({ ...result, status: "ready" });
      // Keep the durable blob until removal/send acknowledgement so interrupted
      // uploads can be retried across reloads without asking for the file again.
    } catch (error) { patch({ status: "failed", error: error.message }); }
    finally { this.uploads.delete(localId); this.onChange(threadId); }
  }
  resume(threadId) {
    for (const item of this.list(threadId)) if (item.status === "uploading") void this.upload(threadId, item.localId);
  }
  async release(item) {
    if (!item?.id || !item.tracked) return;
    try { await this.api(`/api/images/${item.id}/release`, { method: "POST", body: JSON.stringify({ ref: item.localId }), timeoutMs: 8000 }); }
    catch { /* Keep the server reference protected if retirement cannot be confirmed. */ }
  }
  remove(threadId, localId) {
    void this.release(this.list(threadId).find((item) => item.localId === localId));
    this.update(threadId, (list) => list.filter((item) => item.localId !== localId));
    this.cleanup([{ localId }]);
  }
  cleanup(items) {
    for (const item of items || []) {
      void blobOperation("delete", item.localId).catch(() => {});
      if (this.previews.has(item.localId)) URL.revokeObjectURL(this.previews.get(item.localId));
      this.previews.delete(item.localId);
    }
  }
  render(container, threadId) {
    container.replaceChildren();
    for (const item of this.list(threadId)) {
      const card = document.createElement("div");
      card.className = "attachment-card";
      card.dataset.status = item.status;
      const image = document.createElement("img");
      image.alt = item.name;
      if (item.url) image.src = item.url;
      else void blobOperation("get", item.localId).then((blob) => {
        if (!blob || !card.isConnected) return;
        if (!this.previews.has(item.localId)) this.previews.set(item.localId, URL.createObjectURL(blob));
        image.src = this.previews.get(item.localId);
      }).catch(() => {});
      const label = document.createElement("span");
      label.textContent = item.status === "ready" ? item.name : item.status === "uploading" ? "正在上传…" : item.error || "上传失败";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除图片 ${item.name}`);
      remove.onclick = () => this.remove(threadId, item.localId);
      card.append(image, label, remove);
      if (item.status === "failed") {
        const retry = document.createElement("button");
        retry.type = "button"; retry.textContent = "重试上传";
        retry.onclick = () => void this.upload(threadId, item.localId);
        card.append(retry);
      }
      container.append(card);
    }
  }
}
