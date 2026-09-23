import { test, expect } from "@playwright/test";
import http from 'node:http';
import { once } from 'node:events';

test.use({ serviceWorkers: "allow" });
test("fingerprinted modules are precached together and the page shell opens offline", async ({ page, context, browserName }) => {
  // A socket-level outage exercises WebKit's worker without the automation
  // offline toggle, which rejects navigation before a SW can provide fallback.
  let offline = false;
  const sockets = new Set();
  const proxy = http.createServer((request, response) => {
    if (offline) { request.socket.destroy(); return; }
    const upstream = http.request({ host: '127.0.0.1', port: 3219, path: request.url, method: request.method,
      headers: { ...request.headers, host: '127.0.0.1:3219' } }, (incoming) => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); });
    upstream.on('error', () => response.destroy());
    response.on('close', () => upstream.destroy()); request.pipe(upstream);
  });
  proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  try {
  const url = `http://127.0.0.1:${proxy.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const snapshot = await page.evaluate(async () => {
    const status = await fetch("/api/status").then((response) => response.json());
    const keys = await caches.keys();
    const cache = await caches.open(`codex-pocket-v${status.build}`);
    return { build: status.build, keys, urls: (await cache.keys()).map((request) => new URL(request.url).pathname + new URL(request.url).search) };
  });
  expect(snapshot.keys).toEqual([`codex-pocket-v${snapshot.build}`]);
  for (const filename of ["index.html", "app.js", "image-attachments.js", "runtime-panel.js", "file-diff.js", "session-state.js", "write-operations.js"]) {
    expect(snapshot.urls).toContain(`/${filename}?v=${snapshot.build}`);
  }
  offline = true;
  for (const socket of sockets) socket.destroy();
  if (browserName === 'chromium') await context.setOffline(true);
  try {
    await page.goto(`${url}/?offline-smoke=1`);
    await expect(page.locator(".brand")).toContainText("Codex Pocket");
    await expect(page.locator("#attention-filter")).toContainText("待处理");
    await expect(page.getByRole("button", { name: "查看运行诊断" })).toBeVisible();
    expect(await page.locator('script[type="module"]').getAttribute("src")).toBe(`/app.js?v=${snapshot.build}`);
  } finally { offline = false; await context.setOffline(false); }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => proxy.close(resolve)); }
});
