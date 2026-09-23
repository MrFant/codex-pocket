import { test, expect } from "@playwright/test";
import { historyPage } from "../../lib/history-pages.mjs";

function makeThread(id, name, count = 12) {
  return { id, name, preview: name, cwd: "/tmp/project", permission: "workspaceWrite", model: "gpt-test", reasoningEffort: "high", status: { type: "idle" },
    turns: [{ id: `${id}-turn`, status: "completed", items: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, type: "agentMessage", text: `Message ${index}\n\n${"History content. ".repeat(20)}` })) }] };
}

async function setup(page, { count = 12, paginated = false } = {}) {
  const control = { threads: { A: makeThread("A", "Alpha", count), B: makeThread("B", "Beta", count) }, posts: [], requests: new Map(), writerOccupancy: {}, runtime: { ready: true, workers: {}, workerCount: 0, recentErrors: [] }, releases: [], failRead: false, onWrite: null, reads: 0, pages: [], diffs: 0 };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.startsWith("/api/images") || url.pathname.startsWith('/api/storage') || url.pathname.startsWith('/api/notifications')) return route.continue();
    const diffMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/diff$/);
    if (diffMatch) { control.diffs++; return reply(control.threads[diffMatch[1]].turns.flatMap((turn) => turn.items).find((item) => item.id === diffMatch[2]).changes[Number(url.searchParams.get('file'))]); }
    if (url.pathname === "/api/status") return reply(control.runtime);
    if (url.pathname.endsWith("/release")) {
      const id = url.pathname.split("/").at(-2); control.releases.push(id);
      delete control.runtime.workers[id]; control.runtime.workerCount = Object.keys(control.runtime.workers).length;
      return reply({ ok: true, released: true });
    }
    if (url.pathname === "/api/events") return route.abort();
    if (url.pathname === "/api/models") return reply({ data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }], defaultModel: "gpt-test", defaultEffort: "medium" });
    if (url.pathname === "/api/thread-statuses") return reply({ data: {}, permissions: {}, activities: {}, writerOccupancy: control.writerOccupancy });
    if (url.pathname.startsWith("/api/requests/")) {
      const record = control.requests.get(url.pathname.split("/").at(-1));
      return record ? reply(record) : reply({ code: "request_not_found", error: "Not received" }, 404);
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      if (url.pathname.endsWith("/read")) return reply({ ok: true });
      control.posts.push({ path: url.pathname, body });
      control.requests.set(body.clientRequestId, { status: "pending" });
      if (control.onWrite) return control.onWrite({ route, reply, body, path: url.pathname });
      const result = { turn: { id: "new-turn" } };
      control.requests.set(body.clientRequestId, { status: "confirmed", result });
      return reply(result);
    }
    if (url.pathname === "/api/threads") return reply({ data: Object.values(control.threads).map(({ turns, ...thread }) => thread), nextCursor: null });
    const id = url.pathname.split("/").at(-1);
    control.reads += 1;
    if (control.failRead) return reply({ error: "Temporary read failure" }, 503);
    control.pages.push(url.search);
    return control.threads[id] ? reply(paginated ? historyPage({ thread: control.threads[id] }, url.searchParams) : { thread: control.threads[id] }) : reply({ error: "Not found" }, 404);
  });
  await page.goto("/?thread=A");
  await expect(page.locator("#thread-title")).toHaveText("Alpha");
  await expect(page.locator("#model-select")).toHaveValue("gpt-test");
  await expect(page.locator("#effort-select")).toHaveValue("high");
  return control;
}

async function selectThread(page, title) {
  await page.locator("#menu-button").click();
  await page.locator(".thread-card").filter({ has: page.locator(".thread-card-title", { hasText: title }) }).click();
  await expect(page.locator("#thread-title")).toHaveText(title);
}

async function anchor(page) {
  return page.locator("#messages").evaluate((container) => {
    const top = container.getBoundingClientRect().top;
    const node = [...container.querySelectorAll("[data-item-id]")].find((item) => item.getBoundingClientRect().bottom > top + 1);
    return { id: node?.dataset.itemId, offset: node?.getBoundingClientRect().top - top };
  });
}

test("drafts stay with their conversation through switching, reload, and back/forward", async ({ page }) => {
  await setup(page);
  await page.locator("#message-input").fill("Alpha draft");
  await selectThread(page, "Beta");
  await expect(page.locator("#message-input")).toHaveValue("");
  await page.locator("#message-input").fill("Beta draft");
  await page.reload();
  await expect(page.locator("#message-input")).toHaveValue("Beta draft");
  await page.goBack();
  await expect(page.locator("#thread-title")).toHaveText("Alpha");
  await expect(page.locator("#message-input")).toHaveValue("Alpha draft");
  await page.goForward();
  await expect(page.locator("#message-input")).toHaveValue("Beta draft");
});

test("writer occupancy appears in the list and conversation, then clears when released", async ({ page }) => {
  const control = await setup(page);
  control.writerOccupancy = { A: "desktop", B: "pocket" };
  await page.reload();
  await expect(page.locator("#writer-owner")).toHaveText("Desktop");
  await expect(page.locator("#composer-hint")).toContainText("发送冲突时可选择创建副本");
  await page.locator("#menu-button").click();
  await expect(page.locator(".thread-card").filter({ hasText: "Alpha" }).locator(".writer-indicator")).toHaveText("Desktop");
  await expect(page.locator(".thread-card").filter({ hasText: "Beta" }).locator(".writer-indicator")).toHaveText("Pocket");
  await page.setViewportSize({ width: 320, height: 700 });
  const heading = page.locator(".thread-card").filter({ hasText: "Alpha" }).locator(".thread-card-heading");
  const title = await heading.locator(".thread-card-title").boundingBox();
  const owner = await heading.locator(".writer-indicator").boundingBox();
  expect(title.x + title.width).toBeLessThanOrEqual(owner.x);
  control.writerOccupancy = {};
  await page.reload();
  await expect(page.locator("#writer-owner")).toBeHidden();
  await page.locator("#menu-button").click();
  await expect(page.locator(".thread-card .writer-indicator")).toHaveCount(0);
});

test("late confirmation keeps newer input and does not erase another conversation's draft", async ({ page }) => {
  const control = await setup(page);
  let finish;
  control.onWrite = ({ reply, body }) => new Promise((resolve) => { finish = async () => {
    const result = { turn: { id: "late-turn" } };
    control.requests.set(body.clientRequestId, { status: "confirmed", result });
    await reply(result); resolve();
  }; });
  await page.locator("#message-input").fill("Submitted text");
  await page.locator("#send-button").click();
  await expect.poll(() => control.posts.length).toBe(1);
  await page.locator("#message-input").fill("Next Alpha draft");
  await selectThread(page, "Beta");
  await page.locator("#message-input").fill("Beta draft");
  await finish();
  await expect(page.locator("#message-input")).toHaveValue("Beta draft");
  await selectThread(page, "Alpha");
  await expect(page.locator("#message-input")).toHaveValue("Next Alpha draft");
  await expect(page.locator('.request-status[data-status="confirmed"]')).toBeVisible();
});

test("lost response is reconciled without a duplicate send", async ({ page }) => {
  const control = await setup(page);
  control.onWrite = ({ route, body }) => {
    control.requests.set(body.clientRequestId, { status: "confirmed", result: { turn: { id: "once" } } });
    return route.abort();
  };
  await page.locator("#message-input").fill("Send exactly once");
  await page.locator("#send-button").click();
  await expect(page.locator('.request-status[data-status="confirmed"]')).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("");
  expect(control.posts).toHaveLength(1);
});

test("confirmed requests disappear after a short delay and stay hidden after reload", async ({ page }) => {
  const control = await setup(page);
  await page.locator("#message-input").fill("Send once");
  await page.locator("#send-button").click();
  await expect(page.locator('.request-status[data-status="confirmed"]')).toBeVisible();
  await expect(page.locator("#request-tray")).toBeHidden({ timeout: 8_000 });
  expect(control.posts).toHaveLength(1);

  // Records left by older versions must not reappear indefinitely.
  await page.evaluate(() => localStorage.setItem("codex-pocket-operation-v1:__new__", JSON.stringify({
    key: "__new__", id: "old-success", status: "confirmed", applied: true, updatedAt: Date.now() - 60_000,
  })));
  await page.reload();
  await expect(page.locator("#request-tray")).toBeHidden();
  expect(control.posts).toHaveLength(1);
});

test("uncertain execution survives reload, preserves the draft, and blocks blind resend", async ({ page }) => {
  const control = await setup(page);
  control.onWrite = ({ route, body }) => { control.requests.set(body.clientRequestId, { status: "unknown" }); return route.abort(); };
  await page.locator("#message-input").fill("Potentially sent");
  await page.locator("#send-button").click();
  await expect(page.locator('.request-status[data-status="unknown"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('.request-status[data-status="unknown"]')).toBeVisible();
  await expect(page.locator("#message-input")).toHaveValue("Potentially sent");
  await expect(page.locator("#send-button")).toBeDisabled();
  await page.getByRole("button", { name: "核对结果", exact: true }).click();
  expect(control.posts).toHaveLength(1);
});

test("an unreceived request retries with its original ID", async ({ page }) => {
  const control = await setup(page);
  control.onWrite = ({ route, reply, body }) => {
    if (control.posts.length === 1) { control.requests.delete(body.clientRequestId); return route.abort(); }
    const result = { turn: { id: "received" } };
    control.requests.set(body.clientRequestId, { status: "confirmed", result });
    return reply(result);
  };
  await page.locator("#message-input").fill("Retry safely");
  await page.locator("#send-button").click();
  await expect(page.getByRole("button", { name: "重试原请求" })).toBeVisible();
  await page.getByRole("button", { name: "重试原请求" }).click();
  await expect(page.locator('.request-status[data-status="confirmed"]')).toBeVisible();
  expect(control.posts).toHaveLength(2);
  expect(control.posts[0].body.clientRequestId).toBe(control.posts[1].body.clientRequestId);
});

test("long history batches, restores its anchor, and keeps content after a failed refresh", async ({ page }) => {
  const control = await setup(page, { count: 250 });
  await expect(page.locator("#messages [data-item-id]")).toHaveCount(100);
  await page.locator('[data-item-id="A-200"]').scrollIntoViewIfNeeded();
  const original = await anchor(page);
  await page.reload();
  await expect(page.locator('[data-item-id="A-200"]')).toBeVisible();
  const restored = await anchor(page);
  expect(restored.id).toBe(original.id);
  expect(Math.abs(restored.offset - original.offset)).toBeLessThan(3);
  control.failRead = true;
  await page.reload();
  await expect(page.locator("#thread-notice")).toContainText("已保留现有内容");
  await expect(page.locator('[data-item-id="A-200"]')).toBeVisible();
  control.failRead = false;
  control.threads.A.turns[0].items.push({ id: "A-new", type: "agentMessage", text: "New reply" });
  await page.getByRole("button", { name: "重试同步" }).click();
  await expect(page.locator("#latest-button")).toContainText("有新回复");
  expect((await anchor(page)).id).toBe(original.id);
  await page.locator("#latest-button").click();
  await expect(page.locator('[data-item-id="A-new"]')).toBeVisible();
  await page.locator(".load-earlier").scrollIntoViewIfNeeded();
  await page.locator(".load-earlier").click();
  await expect(page.locator("#messages [data-item-id]")).toHaveCount(200);
});

test("fork remains explicit and keeps the new conversation when first send fails", async ({ page }) => {
  const control = await setup(page);
  control.onWrite = ({ reply, body, path }) => {
    if (path.endsWith("/messages")) {
      const error = { message: "Owned by Desktop", code: "thread_writer_conflict", status: 409 };
      control.requests.set(body.clientRequestId, { status: "failed", error });
      return reply({ error: error.message, code: error.code }, 409);
    }
    const thread = makeThread("fork-A", "Fork Alpha");
    control.threads[thread.id] = thread;
    const result = { thread, sendError: { message: "First send failed" } };
    control.requests.set(body.clientRequestId, { status: "confirmed", result });
    return reply(result);
  };
  await page.locator("#message-input").fill("Continue on phone");
  await page.locator("#send-button").click();
  await expect(page.locator("#writer-dialog")).toBeVisible();
  expect(control.posts).toHaveLength(1);
  await page.getByRole("button", { name: "创建副本继续", exact: true }).click();
  await expect(page.locator("#thread-title")).toHaveText("Fork Alpha");
  await expect(page.locator("#message-input")).toHaveValue("Continue on phone");
  await page.reload();
  await expect(page.locator("#thread-title")).toHaveText("Fork Alpha");
  await expect(page.locator("#message-input")).toHaveValue("Continue on phone");
});

test("creating a thread can recover a lost response without making another thread", async ({ page }) => {
  const control = await setup(page);
  control.onWrite = ({ route, body }) => {
    const thread = makeThread("created", "Created", 0);
    control.threads[thread.id] = thread;
    control.requests.set(body.clientRequestId, { status: "confirmed", result: { thread } });
    return route.abort();
  };
  await page.locator("#menu-button").click();
  await page.locator("#new-thread-button").click();
  await page.locator("#new-thread-submit").click();
  await expect(page.locator("#thread-title")).toHaveText("Created");
  expect(control.posts).toHaveLength(1);
});

test("real fixture SSE, approval, and stop remain usable on the mobile layout", async ({ page }, testInfo) => {
  const threadId = `sse-${testInfo.project.name}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?thread=${threadId}`);
  await expect(page.locator("#thread-id")).toHaveText(threadId);
  await expect(page.locator("#message-input")).toBeEnabled();
  await page.locator("#message-input").fill("needs approval");
  await page.locator("#send-button").click();
  await expect(page.locator("#approval-tray")).toBeVisible();
  await expect(page.locator("#approval-tray")).toContainText("echo approve");
  await page.locator("#approval-tray").getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.locator("#approval-tray")).toBeHidden();
  await page.locator("#stop-button").click();
  await expect(page.locator("#stop-button")).toBeHidden();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

const screenshot = { name: "screen.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64") };

test("image upload retries after reload, stays with its thread and sends without text", async ({ page }) => {
  const control = await setup(page);
  let uploads = 0;
  await page.route("**/api/images", (route) => ++uploads === 1 ? route.abort() : route.continue());
  await page.locator("#image-input").setInputFiles(screenshot);
  await expect(page.locator('.attachment-card[data-status="failed"]')).toBeVisible();
  await expect(page.locator("#send-button")).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "重试上传" })).toBeVisible();
  await page.getByRole("button", { name: "重试上传" }).click();
  await expect(page.locator('.attachment-card[data-status="ready"]')).toBeVisible();
  await selectThread(page, "Beta");
  await expect(page.locator(".attachment-card")).toHaveCount(0);
  await selectThread(page, "Alpha");
  await expect(page.locator('.attachment-card[data-status="ready"]')).toBeVisible();
  control.onWrite = ({ reply, body }) => {
    control.threads.A.turns[0].items.push({ id: "uploaded", type: "userMessage", content: [{ type: "localImage", imageUrl: `/api/images/${body.images[0]}` }] });
    const result = { turn: { id: "with-image" } };
    control.requests.set(body.clientRequestId, { status: "confirmed", result });
    return reply(result);
  };
  await page.locator("#send-button").click();
  await expect(page.locator(".attachment-card")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".message-image")).toBeVisible();
  expect(control.posts[0].body.text).toBe("");
  expect(control.posts[0].body.images).toHaveLength(1);
  await expect.poll(() => page.locator(".message-image").evaluate((image) => image.complete && image.naturalWidth > 0)).toBeTruthy();
});

test("upload completion and late send acknowledgement preserve the right draft revision", async ({ page }) => {
  const control = await setup(page);
  let finishUpload;
  await page.route("**/api/images", (route) => new Promise((resolve) => {
    finishUpload = async () => { await route.continue(); resolve(); };
  }));
  await page.locator("#image-input").setInputFiles(screenshot);
  await expect(page.locator('.attachment-card[data-status="uploading"]')).toBeVisible();
  await expect(page.locator("#send-button")).toBeDisabled();
  await expect.poll(() => typeof finishUpload).toBe("function");
  await selectThread(page, "Beta");
  await page.locator("#message-input").fill("Beta stays untouched");
  await finishUpload();
  await expect(page.locator("#message-input")).toHaveValue("Beta stays untouched");
  await selectThread(page, "Alpha");
  await expect(page.locator('.attachment-card[data-status="ready"]')).toBeVisible();
  let finishSend;
  control.onWrite = ({ reply }) => new Promise((resolve) => { finishSend = async () => { await reply({ turn: { id: "image-turn" } }); resolve(); }; });
  await page.locator("#send-button").click();
  await expect.poll(() => control.posts.length).toBe(1);
  await page.locator("#message-input").fill("A newer note");
  await finishSend();
  await expect(page.locator("#message-input")).toHaveValue("A newer note");
  await expect(page.locator('.attachment-card[data-status="ready"]')).toBeVisible();
  await page.getByRole("button", { name: "移除图片 screen.png" }).click();
  await expect(page.locator(".attachment-card")).toHaveCount(0);
});

test("file diffs remain inert and attention filters approvals, unread completions and failures", async ({ page }) => {
  const control = await setup(page);
  control.threads.A.turns[0].items = [
    { id: "change", type: "fileChange", status: "completed", changes: [{ path: "src/main.js", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>" }] },
    { id: "command", type: "commandExecution", command: "npm test", status: "completed", exitCode: 1, durationMs: 2000, aggregatedOutput: "1 failure", outputTruncated: true },
  ];
  control.threads.B.hasUnreadActivity = true;
  control.threads.C = { ...makeThread("C", "Failed"), status: { type: "systemError" } };
  control.threads.D = { ...makeThread("D", "Question"), status: { type: "active", activeFlags: ["waitingOnUserInput"] } };
  await page.reload();
  await page.locator(".file-changes > summary").click();
  await page.locator(".file-diff > summary").click();
  await expect(page.locator(".diff-added")).toHaveText("+<img src=x onerror=alert(1)>");
  await expect(page.locator(".diff-added img")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/pocket-enhancements-diff.png" });
  await expect(page.locator('[data-item-id="command"] > summary')).toContainText("退出码 1 · 2.0 秒");
  await page.locator("#menu-button").click();
  await expect(page.locator("#attention-filter")).toHaveText("待处理 · 3");
  await page.locator("#attention-filter").click();
  await expect(page.locator(".thread-card")).toHaveCount(3);
  await expect(page.locator(".thread-card-title", { hasText: "Alpha" })).toHaveCount(0);
  await expect(page.locator(".thread-card-title", { hasText: "Question" })).toBeVisible();
});

test("diagnostics shows independent leases and releasing one leaves the other visible", async ({ page }) => {
  const control = await setup(page);
  control.runtime = { ready: true, build: "test-build", workerCount: 2, serverTime: Date.now(), startedAt: Date.now(), workers: {
    A: { idleReleaseAt: Date.now() + 120_000, busy: false },
    B: { idleReleaseAt: null, busy: true },
  }, recentErrors: [] };
  await page.getByRole("button", { name: "查看运行诊断" }).click();
  await expect(page.locator("#diagnostics-content")).toContainText("test-build");
  await expect(page.locator("#diagnostics-content")).toContainText("Beta：运行中或等待确认");
  await page.screenshot({ path: "/tmp/pocket-enhancements-diagnostics.png" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator("#runtime-lease")).toContainText("后释放会话");
  await page.locator("#release-button").click();
  await expect(page.locator("#release-button")).toBeHidden();
  expect(control.releases).toEqual(["A"]);
  await selectThread(page, "Beta");
  await expect(page.locator("#release-button")).toBeDisabled();
  await expect(page.locator("#runtime-lease")).toContainText("正在处理");
});

test('server pages keep a thousand-item thread bounded and restore an older window', async ({ page }) => {
  const control = await setup(page, { count: 1000, paginated: true });
  await expect(page.locator('#messages [data-item-id]')).toHaveCount(100);
  for (let index = 0; index < 5; index++) {
    await page.locator('.load-earlier').scrollIntoViewIfNeeded();
    await page.locator('.load-earlier').click();
    await expect(page.locator('#messages [data-item-id]').first()).toHaveAttribute('data-item-id', `A-${800 - index * 100}`);
    await expect(page.locator('#messages [data-item-id]')).toHaveCount(200);
  }
  await page.locator('[data-item-id="A-450"]').scrollIntoViewIfNeeded();
  const previous = await anchor(page);
  await page.locator('#message-input').fill('Draft while reading history');
  await page.reload();
  await expect(page.locator('[data-item-id="A-450"]')).toBeAttached();
  await expect.poll(async () => (await anchor(page)).id).toBe(previous.id);
  expect(Math.abs((await anchor(page)).offset - previous.offset)).toBeLessThan(3);
  await expect(page.locator('#messages [data-item-id]')).toHaveCount(200);
  expect(control.pages.some((url) => url.includes('around='))).toBe(true);
  await page.locator('.load-later').scrollIntoViewIfNeeded();
  await page.locator('.load-later').click();
  await expect(page.locator('#messages [data-item-id]')).toHaveCount(200);
  await page.locator('#latest-button').click();
  await expect(page.locator('[data-item-id="A-999"]')).toBeVisible();
  await expect(page.locator('.load-later')).toHaveCount(0);
  await expect(page.locator('#message-input')).toHaveValue('Draft while reading history');
});

test('diffs download only when a file is opened and collapse keeps the result', async ({ page }) => {
  const control = await setup(page, { paginated: true });
  control.threads.A.turns[0].items = [{ id: 'change', type: 'fileChange', changes: [{ path: 'a.js', kind: { type: 'update' }, diff: '+<script>bad()</script>' }] }];
  await page.reload();
  expect(control.diffs).toBe(0);
  await page.locator('.file-changes > summary').click();
  expect(control.diffs).toBe(0);
  await page.locator('.file-diff > summary').click();
  await expect(page.locator('.diff-added')).toHaveText('+<script>bad()</script>');
  expect(control.diffs).toBe(1);
  await page.locator('.file-diff > summary').click();
  await page.locator('.file-diff > summary').click();
  expect(control.diffs).toBe(1);
  await expect(page.locator('.file-diff script')).toHaveCount(0);
});

test('explicit updates wait for sends and preserve the newer draft on reload', async ({ page }) => {
  const control = await setup(page);
  let finish;
  control.onWrite = ({ reply, body }) => new Promise((resolve) => { finish = async () => {
    const result = { turn: { id: 'done' } };
    control.requests.set(body.clientRequestId, { status: 'confirmed', result });
    await reply(result); resolve();
  }; });
  await page.locator('#message-input').fill('Submitted');
  await page.locator('#send-button').click();
  await expect.poll(() => control.posts.length).toBe(1);
  await page.locator('#message-input').fill('Keep this newer draft');
  control.runtime.build = 'ffffffffffffffff';
  await page.locator('#connection-status').click();
  await expect(page.locator('#diagnostics-content')).toContainText(control.runtime.build);
  await page.locator('#diagnostics-close').click();
  await expect(page.locator('#update-banner')).toBeVisible();
  await expect(page.locator('#apply-update')).toBeDisabled();
  await finish();
  await expect(page.locator('#apply-update')).toBeEnabled();
  await page.locator('#apply-update').click();
  await expect(page.locator('#message-input')).toHaveValue('Keep this newer draft');
  expect(control.posts).toHaveLength(1);
});

test('notification opt in and storage cleanup use explicit actions and retain drafts', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.permissionRequests = 0;
    class NotificationMock { static permission = 'default'; static async requestPermission() { window.permissionRequests++; this.permission = 'granted'; return 'granted'; } }
    Object.defineProperty(window, 'Notification', { value: NotificationMock });
    Object.defineProperty(window, 'PushManager', { value: class {} });
    let subscription = null;
    const container = new EventTarget(), registration = new EventTarget();
    registration.active = { postMessage(_data, ports) { ports[0].postMessage({ ok: true }); } };
    registration.pushManager = { async getSubscription() { return subscription; }, async subscribe() {
      subscription = { endpoint: 'https://web.push.apple.com/test', toJSON() { return { endpoint: this.endpoint, keys: { auth: 'test', p256dh: 'test' } }; }, async unsubscribe() { subscription = null; return true; } }; return subscription;
    } };
    container.register = async () => registration; container.getRegistration = async () => registration;
    Object.defineProperty(navigator, 'serviceWorker', { value: container });
  });
  const control = await setup(page);
  let subscribed = false, cleanup = 0;
  await page.route('**/api/notifications/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/subscribe')) subscribed = true;
    if (path.endsWith('/unsubscribe')) subscribed = false;
    return route.fulfill({ json: path.endsWith('/key') ? { publicKey: 'AQAB' } : { ok: true, subscribed } });
  });
  const candidate = { id: 'a'.repeat(64) + '.png', bytes: 128 };
  await page.route('**/api/storage**', (route) => {
    if (route.request().method() === 'POST') { cleanup++; expect(route.request().postDataJSON()).toEqual({ images: [candidate.id] }); return route.fulfill({ json: { removed: [candidate.id], skipped: [] } }); }
    return route.fulfill({ json: { images: { count: 2, bytes: 256, candidates: cleanup ? [] : [candidate] }, journal: { bytes: 4096 }, historyCacheBytes: 128, logs: [] } });
  });
  await page.locator('#message-input').fill('Keep my draft');
  await page.locator('#connection-status').click();
  await page.locator('#maintenance-options > summary').click();
  await expect(page.locator('#notification-status')).toContainText('此设备未开启');
  expect(await page.evaluate(() => window.permissionRequests)).toBe(0);
  await page.locator('#notification-toggle').click();
  await expect(page.locator('#notification-status')).toContainText('此设备已开启');
  expect(await page.evaluate(() => window.permissionRequests)).toBe(1);
  await page.locator('#notification-toggle').click();
  await expect(page.locator('#notification-status')).toContainText('此设备未开启');
  expect(subscribed).toBe(false);
  await expect(page.locator('#cleanup-preview a')).toHaveCount(1);
  expect(cleanup).toBe(0);
  await page.locator('#cleanup-images').click();
  await expect(page.locator('#cleanup-images')).toBeDisabled();
  expect(cleanup).toBe(1);
  await page.locator('#cleanup-cache').click();
  await expect(page.locator('#toast')).toContainText('草稿及发送记录已保留');
  await page.screenshot({ path: `/tmp/pocket-maintenance-${testInfo.project.name}.png` });
  await page.locator('#diagnostics-close').click();
  await page.reload();
  await expect(page.locator('#message-input')).toHaveValue('Keep my draft');
  expect(control.posts).toHaveLength(0);
  await page.screenshot({ path: `/tmp/pocket-compact-${testInfo.project.name}.png` });
});
