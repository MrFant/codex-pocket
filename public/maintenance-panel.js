export function formatBytes(value = 0) {
  return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
}

export class MaintenancePanel {
  constructor({ api, updates, toast }) {
    Object.assign(this, { api, updates, toast });
    this.notificationStatus = document.querySelector('#notification-status');
    this.notificationButton = document.querySelector('#notification-toggle');
    this.storageStatus = document.querySelector('#storage-status');
    this.cleanupButton = document.querySelector('#cleanup-images');
    this.cacheButton = document.querySelector('#cleanup-cache');
    this.notificationButton.onclick = () => void this.toggleNotifications();
    this.cleanupButton.onclick = () => void this.cleanupImages();
    this.cacheButton.onclick = () => void this.cleanupCache();
    document.querySelector('#maintenance-refresh').onclick = () => void this.refresh();
    document.querySelector('#maintenance-options').addEventListener('toggle', (event) => { if (event.target.open) void this.refresh(); });
  }
  async refresh() { await Promise.allSettled([this.refreshNotifications(), this.refreshStorage()]); }
  supported() { return 'Notification' in window && 'PushManager' in window && Boolean(navigator.serviceWorker); }
  async registration() {
    const registration = this.updates.registration || await navigator.serviceWorker.getRegistration();
    if (!registration?.active) throw new Error('离线组件尚未就绪，请稍后重试');
    return registration;
  }
  async refreshNotifications() {
    if (this.changingNotifications) return;
    this.notificationButton.disabled = true;
    if (!this.supported()) {
      this.notificationStatus.textContent = '此浏览器暂不支持通知。iPhone 请先添加到主屏幕，再从主屏幕打开。'; return;
    }
    try {
      const registration = await this.registration();
      this.subscription = await registration.pushManager.getSubscription();
      this.enabled = this.subscription ? (await this.api('/api/notifications/status', { method: 'POST', timeoutMs: 8000,
        body: JSON.stringify({ endpoint: this.subscription.endpoint }) })).subscribed : false;
      this.notificationStatus.textContent = this.enabled ? '此设备已开启：完成、失败和等待确认时提醒。通知不包含对话正文。'
        : Notification.permission === 'denied' ? '通知权限已被关闭，请在系统或浏览器设置中允许。' : '此设备未开启通知。开启后，通知会通过浏览器推送服务送达。';
      this.notificationButton.textContent = this.enabled ? '关闭此设备通知' : '开启此设备通知';
      this.notificationButton.disabled = !this.enabled && Notification.permission === 'denied';
    } catch (error) { this.notificationStatus.textContent = error.message; }
  }
  async toggleNotifications() {
    if (this.changingNotifications || !this.supported()) return;
    this.changingNotifications = true; this.notificationButton.disabled = true;
    try {
      if (this.enabled) {
        await this.api('/api/notifications/unsubscribe', { method: 'POST', timeoutMs: 8000, body: JSON.stringify({ endpoint: this.subscription.endpoint }) });
        await this.subscription.unsubscribe(); this.enabled = false;
      } else {
        // Request directly in the click handler, before any network work (iOS).
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('尚未允许通知，可稍后再开启');
        const registration = await this.registration();
        const { publicKey } = await this.api('/api/notifications/key');
        const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
        this.subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await this.api('/api/notifications/subscribe', { method: 'POST', timeoutMs: 10000, body: JSON.stringify({ subscription: this.subscription.toJSON() }) });
        this.enabled = true;
      }
      this.toast(this.enabled ? '已开启此设备通知' : '已关闭此设备通知');
    } catch (error) { this.toast(error.message); }
    finally { this.changingNotifications = false; await this.refreshNotifications(); }
  }
  async refreshStorage() {
    if (this.refreshingStorage) return;
    this.refreshingStorage = true; this.cleanupButton.disabled = true;
    try {
      const result = await this.api('/api/storage');
      const local = await navigator.storage?.estimate?.().catch(() => null);
      this.candidates = result.images.candidates.slice(0, 100);
      this.storageStatus.textContent = `服务器图片 ${formatBytes(result.images.bytes)}（${result.images.count} 张）；请求记录 ${formatBytes(result.journal.bytes)}；会话内存缓存 ${formatBytes(result.historyCacheBytes)}；日志 ${formatBytes(result.logs.reduce((n, log) => n + log.bytes, 0))}。${local ? `此设备存储约 ${formatBytes(local.usage)}。` : ''}`;
      const preview = document.querySelector('#cleanup-preview'); preview.replaceChildren();
      for (const item of this.candidates) {
        const link = document.createElement('a'); link.href = `/api/images/${item.id}`; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = `${item.id.slice(0, 12)}… · ${formatBytes(item.bytes)}`; preview.append(link);
      }
      this.cleanupButton.textContent = this.candidates.length ? `清理上述 ${this.candidates.length} 张图片（${formatBytes(this.candidates.reduce((n, item) => n + item.bytes, 0))}）` : '暂无可清理的图片';
      this.cleanupButton.disabled = !this.candidates.length;
    } catch (error) { this.storageStatus.textContent = error.message; this.candidates = []; }
    finally { this.refreshingStorage = false; }
  }
  async cleanupImages() {
    if (!this.candidates?.length || this.cleaningImages) return;
    this.cleaningImages = true; this.cleanupButton.disabled = true;
    const ids = this.candidates.map((item) => item.id);
    try {
      const result = await this.api('/api/storage/cleanup', { method: 'POST', timeoutMs: 12000, body: JSON.stringify({ images: ids }) });
      this.toast(`已清理 ${result.removed.length} 张图片${result.skipped.length ? `，保留 ${result.skipped.length} 张引用已变化的图片` : ''}`);
    } catch (error) { this.toast(error.message); }
    finally { this.cleaningImages = false; await this.refreshStorage(); }
  }
  async cleanupCache() {
    if (this.cleaningCache) return;
    this.cleaningCache = true; this.cacheButton.disabled = true;
    try {
      const worker = (await this.registration()).active;
      const result = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error('缓存清理确认超时，请稍后重试')); }, 8000);
        channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
        worker.postMessage({ type: 'CLEAN_UNUSED_CACHES' }, [channel.port2]);
      });
      if (!result.ok) throw new Error(result.reason === 'update_pending' ? '新版本正在安装或等待刷新，请先完成更新' : '有 Pocket 页面正在操作或尚未就绪，请稍后重试');
      for (const key of Object.keys(sessionStorage)) if (/^codex-pocket-thread-(v|cache-index-v)/.test(key)) sessionStorage.removeItem(key);
      this.toast('已清理旧版资源和会话阅读缓存，草稿及发送记录已保留');
      await this.refreshStorage();
    } catch (error) { this.toast(error.message); }
    finally { this.cleaningCache = false; this.cacheButton.disabled = false; }
  }
}
