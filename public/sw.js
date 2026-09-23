const CACHE = "codex-pocket-v__BUILD__";
const FALLBACK_PAGE = "/index.html?v=__BUILD__";
const STATIC_FILES = __STATIC_FILES__;

function fetchWithTimeout(request, milliseconds = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC_FILES)));
});

// Existing pages retain their matching cache until a safe cleanup. Installing
// a new worker never changes an in-flight page without an explicit update.
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

async function clientReadiness() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return Promise.all(clients.map((client) => new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({ busy: true }); }, 2_000);
    channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data || { busy: true }); };
    client.postMessage({ type: "CAN_UPDATE" }, [channel.port2]);
  })));
}
self.addEventListener("message", (event) => {
  if (!["ACTIVATE_UPDATE", "CLEAN_UNUSED_CACHES"].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    if (event.data.type === 'CLEAN_UNUSED_CACHES' && (self.registration.waiting || self.registration.installing)) {
      event.ports[0]?.postMessage({ ok: false, reason: 'update_pending' }); return;
    }
    const states = await clientReadiness();
    if (states.some((state) => state.busy)) { event.ports[0]?.postMessage({ ok: false }); return; }
    if (event.data.type === "ACTIVATE_UPDATE") {
      event.ports[0]?.postMessage({ ok: true }); await self.skipWaiting();
    } else {
      const keep = new Set([CACHE, ...states.map((state) => `codex-pocket-v${state.build}`)]);
      for (const key of await caches.keys()) if (key.startsWith("codex-pocket-v") && !keep.has(key)) await caches.delete(key);
      event.ports[0]?.postMessage({ ok: true });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(event.request)
        .then((response) => {
          // The precached shell must keep its matching module versions.
          // A newer online document belongs to a different installation.
          return response;
        })
        .catch(() => caches.match(FALLBACK_PAGE)),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }))
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Always show an incoming push. */ }
  const messages = { complete: '任务已完成，点击查看结果', failed: '任务遇到问题，点击查看', attention: '有一项操作等待你确认' };
  event.waitUntil(self.registration.showNotification('Codex Pocket', {
    body: messages[data.kind] || '有新的会话动态，点击查看',
    tag: typeof data.tag === 'string' ? data.tag.slice(0, 64) : 'pocket-activity',
    data: { threadId: typeof data.threadId === 'string' ? data.threadId.slice(0, 256) : '' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL('/', self.location.origin);
  if (event.notification.data?.threadId) url.searchParams.set('thread', event.notification.data.threadId);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find((item) => new URL(item.url).origin === url.origin);
    if (client) {
      // Let the page persist its current draft before switching threads.
      client.postMessage({ type: 'OPEN_THREAD', threadId: event.notification.data?.threadId || '' });
      await client.focus();
    } else await self.clients.openWindow(url.href);
  })());
});
