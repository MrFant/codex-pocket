export class EventStream {
  constructor({ onEvent, onState, onResume = () => {}, fetcher = (...args) => globalThis.fetch(...args), heartbeatMs = 55_000, retryMs = 1_000,
    document = globalThis.document, window = globalThis.window, navigator = globalThis.navigator }) {
    Object.assign(this, { onEvent, onState, onResume, fetcher, heartbeatMs, retryMs, document, window, navigator });
    this.generation = 0;
    this.stopped = true;
    this.onVisibility = () => document.visibilityState === "visible" ? this.resume() : this.suspend();
    this.onOnline = () => this.resume();
    this.onOffline = () => { this.suspend(); onState("offline", "网络已断开"); };
  }
  start() {
    this.stopped = false;
    this.document?.addEventListener("visibilitychange", this.onVisibility);
    this.window?.addEventListener("online", this.onOnline);
    this.window?.addEventListener("offline", this.onOffline);
    this.resume(false);
  }
  suspend() {
    this.generation += 1;
    this.controller?.abort();
    clearTimeout(this.watchdog);
  }
  resume(reconcile = true) {
    if (this.stopped || this.document?.visibilityState === "hidden" || this.navigator?.onLine === false) return;
    this.suspend();
    if (reconcile) this.onResume();
    void this.run(this.generation);
  }
  stop() {
    this.stopped = true; this.suspend();
    this.document?.removeEventListener("visibilitychange", this.onVisibility);
    this.window?.removeEventListener("online", this.onOnline);
    this.window?.removeEventListener("offline", this.onOffline);
  }
  async run(generation) {
    let delay = this.retryMs;
    while (!this.stopped && generation === this.generation) {
      const controller = new AbortController(); this.controller = controller;
      let reader, watchdog;
      const touch = () => {
        clearTimeout(watchdog);
        watchdog = this.watchdog = setTimeout(() => controller.abort(), this.heartbeatMs);
      };
      try {
        this.onState("connecting", "连接中"); touch();
        const response = await this.fetcher("/api/events", { signal: controller.signal, cache: "no-store" });
        if (!response.ok || !response.body) throw new Error("事件流连接失败");
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = "";
        while (!controller.signal.aborted && generation === this.generation) {
          const { value, done } = await reader.read();
          if (done) break;
          touch();
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          if (buffer.length > 2_000_000) throw new Error("事件流帧过大");
          const frames = buffer.split("\n\n"); buffer = frames.pop() || "";
          for (const frame of frames) {
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
            if (!data) continue; // Heartbeat comments still renew the watchdog.
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            delay = this.retryMs;
            this.onState("online", "已连接"); this.onEvent(event);
          }
        }
      } catch { /* Reconcile from a new snapshot; never replay a write here. */ }
      finally {
        clearTimeout(watchdog);
        if (reader) await reader.cancel().catch(() => {});
      }
      if (generation !== this.generation || this.stopped) return;
      this.onState("offline", "重连中");
      await new Promise((resolve) => {
        const retryController = new AbortController();
        const finish = () => { clearTimeout(timer); retryController.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, delay);
        // Use a fresh controller: the stream may have timed out already.
        this.controller = retryController;
        retryController.signal.addEventListener("abort", finish, { once: true });
      });
      delay = Math.min(Math.round(delay * 1.8), 10_000);
    }
  }
}
