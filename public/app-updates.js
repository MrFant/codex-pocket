export const PAGE_BUILD = "__BUILD__";

export class AppUpdates {
  constructor({ busy, save, toast }) {
    Object.assign(this, { busy, save, toast });
    this.banner = document.querySelector("#update-banner");
    this.message = document.querySelector("#update-message");
    this.button = document.querySelector("#apply-update");
    this.button.onclick = () => void this.apply();
    navigator.serviceWorker?.addEventListener("message", (event) => {
      if (event.data?.type === "CAN_UPDATE") {
        this.save(); event.ports[0]?.postMessage({ build: PAGE_BUILD, busy: this.busy() });
      }
    });
  }
  async start() {
    if (!navigator.serviceWorker) return;
    try {
      this.registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      const observe = () => {
        this.registration.installing?.addEventListener("statechange", () => this.render());
        this.render();
      };
      this.registration.addEventListener("updatefound", observe); observe();
    } catch { /* Browsing and durable drafts remain usable without a worker. */ }
  }
  observeStatus(status) {
    this.remoteBuild = status?.build;
    if (this.remoteBuild !== PAGE_BUILD && /^[a-f0-9]{16}$/.test(this.remoteBuild || "") && Date.now() - (this.lastCheck || 0) > 60_000) {
      this.lastCheck = Date.now(); void this.registration?.update().catch(() => {});
    }
    this.render();
  }
  render() {
    const newer = this.registration?.waiting || (/^[a-f0-9]{16}$/.test(this.remoteBuild || "") && this.remoteBuild !== PAGE_BUILD);
    this.banner.classList.toggle("hidden", !newer);
    const busy = this.busy();
    this.message.textContent = busy ? "新版本已就绪，上传或发送完成后可刷新" : "新版本已就绪，草稿会保留";
    this.button.disabled = Boolean(busy || this.applying);
  }
  async apply() {
    if (this.busy() || this.applying) return;
    this.save();
    if (this.busy()) { this.toast("草稿尚未保存，暂时不能刷新"); return; }
    this.applying = true; this.render();
    try {
      if (this.registration) {
        await this.registration.update();
        if (this.registration.installing) await new Promise((resolve, reject) => {
          const worker = this.registration.installing;
          const timer = setTimeout(() => reject(new Error("更新仍在下载，请稍后重试")), 10_000);
          const changed = () => { if (["installed", "redundant"].includes(worker.state)) { clearTimeout(timer); worker.removeEventListener("statechange", changed); resolve(); } };
          worker.addEventListener("statechange", changed); changed();
        });
        const worker = this.registration.waiting;
        if (worker) {
          const result = await new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); reject(new Error("更新确认超时，请稍后重试")); }, 8_000);
            channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
            worker.postMessage({ type: "ACTIVATE_UPDATE" }, [channel.port2]);
          });
          if (!result.ok) throw new Error("其他 Pocket 页面正在操作或尚未就绪，请稍后重试或关闭其他页面");
          await new Promise((resolve) => {
            if (worker.state === "activated") { resolve(); return; }
            const timer = setTimeout(resolve, 3_000);
            worker.addEventListener("statechange", () => { if (worker.state === "activated") { clearTimeout(timer); resolve(); } });
          });
        }
      }
      this.save();
      if (this.busy()) throw new Error("还有上传或发送正在处理，请完成后刷新");
      location.reload();
    } catch (error) { this.toast(error.message); }
    finally { this.applying = false; this.render(); }
  }
}
