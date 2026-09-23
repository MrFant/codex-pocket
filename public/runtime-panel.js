export class RuntimePanel {
  constructor({ api, getThread, getSyncTime, getName, toast, onStatus = () => {}, pageBuild }) {
    Object.assign(this, { api, getThread, getSyncTime, getName, toast, onStatus, pageBuild });
    this.dialog = document.querySelector("#diagnostics-dialog");
    this.content = document.querySelector("#diagnostics-content");
    this.lease = document.querySelector("#runtime-lease");
    this.release = document.querySelector("#release-button");
    this.status = null;
    this.refreshing = null;
    this.releasing = false;
    document.querySelector("#connection-status").onclick = () => { this.dialog.showModal(); void this.refresh(); this.render(); };
    document.querySelector("#diagnostics-close").onclick = () => this.dialog.close();
    document.querySelector("#diagnostics-refresh").onclick = () => void this.refresh();
    this.release.onclick = async () => {
      const threadId = this.getThread()?.id;
      if (!threadId || this.releasing) return;
      this.releasing = true; this.render();
      try {
        await this.api(`/api/threads/${encodeURIComponent(threadId)}/release`, { method: "POST", timeoutMs: 10_000 });
        this.toast("Pocket 已释放此会话，可在电脑继续");
        await this.refresh();
      } catch (error) { this.toast(error.message); }
      finally { this.releasing = false; this.render(); }
    };
    setInterval(() => { if (document.visibilityState === "visible") this.renderLease(); }, 1_000);
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.api("/api/status", { timeoutMs: 8_000 }).then((status) => {
      this.status = status; this.onStatus(status); this.offset = (status.serverTime || Date.now()) - Date.now(); this.error = null;
    }).catch((error) => { this.status = null; this.error = error.message; })
      .finally(() => { this.refreshing = null; this.render(); });
    return this.refreshing;
  }
  renderLease() {
    const worker = this.status?.workers?.[this.getThread()?.id];
    this.lease.classList.toggle("hidden", !worker);
    this.release.classList.toggle("hidden", !worker);
    this.release.disabled = this.releasing || Boolean(worker?.busy);
    if (!worker) return;
    const seconds = Math.max(0, Math.ceil((worker.idleReleaseAt - Date.now() - (this.offset || 0)) / 1000));
    this.lease.textContent = worker.busy ? "Pocket 正在处理此会话" : worker.idleReleaseAt
      ? (seconds ? `Pocket 将在 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后释放会话` : "正在释放会话…") : "Pocket 持有此会话";
  }
  render() {
    this.renderLease();
    if (!this.dialog.open) return;
    this.content.replaceChildren();
    const line = (label, value) => {
      const row = document.createElement("p");
      const title = document.createElement("strong"); title.textContent = `${label}：`;
      row.append(title, document.createTextNode(String(value))); this.content.append(row);
    };
    line("连接", this.error || (this.status?.ready ? "正常" : this.status ? "待机" : "读取中…"));
    line("访问环境", `${location.protocol === "https:" ? "HTTPS" : "本地 HTTP"} · ${window.isSecureContext ? "安全上下文" : "非安全上下文"} · ${navigator.onLine ? "网络可用" : "离线"}`);
    line("离线缓存", navigator.serviceWorker?.controller ? "Service Worker 已接管" : "等待 Service Worker 接管");
    line("最近会话同步", this.getSyncTime() ? new Date(this.getSyncTime()).toLocaleString() : "尚未同步");
    if (!this.status) return;
    line("页面版本", this.pageBuild || "未知");
    line("服务版本", this.status.build || "未知");
    line("网关运行时间", this.status.startedAt ? `${Math.floor((Date.now() + this.offset - this.status.startedAt) / 60000)} 分钟` : "未知");
    line("会话进程", this.status.workerCount || 0);
    line("等待确认", this.status.pendingApprovals || 0);
    line("通知设备", this.status.notifications?.subscriptions || 0);
    if (this.status.notifications?.lastError) line("最近通知投递", `未送达（${this.status.notifications.lastError.code}）`);
    for (const [id, worker] of Object.entries(this.status.workers || {})) {
      line(this.getName(id), `${worker.busy ? "运行中或等待确认" : "空闲"}${worker.idleReleaseAt ? ` · ${new Date(worker.idleReleaseAt).toLocaleTimeString()} 自动释放` : ""}`);
    }
    line("近期服务错误", this.status.recentErrors?.length ? this.status.recentErrors.map((error) => `${new Date(error.at).toLocaleTimeString()} ${error.route} (${error.code})`).join("；") : "无");
  }
}
