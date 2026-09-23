import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = path.join(projectRoot, "server.mjs");
const fixturePath = path.join(projectRoot, "test", "fixtures", "fake-app-server.mjs");

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes("Codex Pocket listening")) return;
      cleanup();
      resolve();
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`Test server exited before startup: ${output}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

test("fork is immediately durable in the API catalog and idempotent for retries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.sqlite");
  const rolloutPath = path.join(directory, "thread-busy-rollout.jsonl");
  const corruptRolloutPath = path.join(directory, "thread-corrupt-rollout.jsonl");
  const desktopStatePath = path.join(directory, ".codex-global-state.json");
  const pocketStatePath = path.join(directory, "codex-pocket-state.json");
  const readAuditPath = path.join(directory, "thread-read-audit.log");
  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, preview TEXT, rollout_path TEXT, archived INTEGER,
      created_at INTEGER, updated_at INTEGER, recency_at INTEGER, cwd TEXT,
      title TEXT, source TEXT, thread_source TEXT, sandbox_policy TEXT,
      approval_mode TEXT
    );
  `);
  state.prepare(`
    INSERT INTO threads VALUES (
      'thread-busy', 'Busy source', ?, 0, 1, 2, 2, '/tmp/project',
      'Busy source', 'vscode', 'user', '{"type":"workspaceWrite"}', 'on-request'
    )
  `).run(rolloutPath);
  state.prepare(`
    INSERT INTO threads VALUES (
      'thread-corrupt', 'Corrupt thread', ?, 0, 1, 2, 2, '/tmp/project',
      'Corrupt thread', 'vscode', 'user', '{"type":"workspaceWrite"}', 'on-request'
    )
  `).run(corruptRolloutPath);
  state.close();
  await writeFile(rolloutPath, "");
  await writeFile(corruptRolloutPath, `${JSON.stringify({
    type: "event_msg", payload: { type: "task_started", turn_id: "turn-corrupt" },
  })}\n${JSON.stringify({
    type: "event_msg", payload: { type: "item_completed", turn_id: "turn-corrupt", item: {
      type: "UserMessage", id: "user-corrupt", content: [{ type: "text", text: "保留的用户消息" }],
    } },
  })}\n${JSON.stringify({
    type: "event_msg", payload: { type: "item_completed", turn_id: "turn-corrupt", item: {
      type: "AgentMessage", id: "agent-corrupt", content: [{ type: "Text", text: "保留的回复" }],
    } },
  })}\n${JSON.stringify({
    type: "event_msg", payload: { type: "task_complete", turn_id: "turn-corrupt" },
  })}\n`);
  const initialDesktopState = JSON.stringify({
    "local-projects": {
      alpha: { id: "alpha", name: "Alpha", rootPaths: ["/tmp/project"] },
    },
    "project-order": ["alpha"],
    "thread-project-assignments": {},
    "projectless-thread-ids": ["thread-busy"],
    "pinned-thread-ids": [],
    "electron-persisted-atom-state": {},
  });
  await writeFile(desktopStatePath, initialDesktopState);

  const port = await availablePort();
  const children = [];
  const serverEnvironment = {
    ...process.env,
    POCKET_PORT: String(port),
    POCKET_STATE_PATH: statePath,
    POCKET_CATALOG_PATH: path.join(directory, "missing-catalog.sqlite"),
    POCKET_DESKTOP_STATE_PATH: desktopStatePath,
    POCKET_OVERLAY_PATH: pocketStatePath,
    POCKET_IMAGE_DIRECTORY: path.join(directory, "images"),
    POCKET_REQUEST_DB_PATH: path.join(directory, "requests.sqlite"),
    POCKET_APP_SERVER_FIXTURE: fixturePath,
    POCKET_IDLE_RELEASE_MS: "80",
    FAKE_STATE_PATH: statePath,
    FAKE_UNIQUE_FORK_ID: "1",
    FAKE_READ_AUDIT_PATH: readAuditPath,
    FAKE_PAGINATED_READ: "1",
  };
  const startServer = async () => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: serverEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForServer(child);
    return child;
  };
  t.after(async () => {
    await Promise.all(children.map((child) => stopServer(child).catch(() => {})));
  });
  let child = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const initializedPocketState = JSON.parse(await readFile(pocketStatePath, "utf8"));
  await request(baseUrl, "/api/threads/thread-busy");
  const originalSettingsRead = await request(baseUrl, "/api/threads/thread-busy");
  assert.equal(originalSettingsRead.body.thread.model, "gpt-original");
  assert.equal(originalSettingsRead.body.thread.reasoningEffort, "high");
  assert.equal((await readFile(readAuditPath, "utf8")).trim().split("\n").length, 1);
  const firstCompletedAt = initializedPocketState.activityInitializedAt + 1;
  await appendFile(rolloutPath, `${JSON.stringify({
    timestamp: new Date(firstCompletedAt * 1_000).toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "desktop-turn-1", completed_at: firstCompletedAt },
  })}\n`);
  await request(baseUrl, "/api/threads/thread-busy");
  assert.equal(
    (await readFile(readAuditPath, "utf8")).trim().split("\n").length,
    2,
    "a new completion invalidates the compact thread-read cache",
  );
  const unreadList = await request(baseUrl, "/api/threads");
  const unreadThread = unreadList.body.data.find((thread) => thread.id === "thread-busy");
  assert.equal(unreadThread.hasUnreadActivity, true);
  assert.equal(unreadThread.activityCompletionKey, "desktop-turn-1");
  const corruptRead = await request(baseUrl, "/api/threads/thread-corrupt");
  assert.equal(corruptRead.response.status, 200);
  assert.equal(
    corruptRead.body.thread.turns[0].items.find((item) => item.type === "agentMessage").text,
    "保留的回复",
  );

  const markedRead = await request(baseUrl, "/api/threads/thread-busy/read", {
    method: "POST",
    body: JSON.stringify({ completionKey: "desktop-turn-1" }),
  });
  assert.equal(markedRead.response.status, 200);
  const readList = await request(baseUrl, "/api/threads");
  assert.equal(readList.body.data.find((thread) => thread.id === "thread-busy").hasUnreadActivity, false);

  const secondCompletedAt = firstCompletedAt + 1;
  await appendFile(rolloutPath, `${JSON.stringify({
    timestamp: new Date(secondCompletedAt * 1_000).toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "desktop-turn-2", completed_at: secondCompletedAt },
  })}\n`);
  const staleRead = await request(baseUrl, "/api/threads/thread-busy/read", {
    method: "POST",
    body: JSON.stringify({ completionKey: "desktop-turn-1" }),
  });
  assert.equal(staleRead.response.status, 409);
  assert.equal(staleRead.body.code, "stale_completion");
  const secondUnread = await request(baseUrl, "/api/threads");
  const secondUnreadThread = secondUnread.body.data.find((thread) => thread.id === "thread-busy");
  assert.equal(secondUnreadThread.hasUnreadActivity, true);
  assert.equal(secondUnreadThread.activityCompletionKey, "desktop-turn-2");
  await request(baseUrl, "/api/threads/thread-busy/read", {
    method: "POST",
    body: JSON.stringify({ completionKey: "desktop-turn-2" }),
  });

  const conflict = await request(baseUrl, "/api/threads/thread-busy/messages", {
    method: "POST",
    body: JSON.stringify({ text: "continue", permission: "workspaceWrite" }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, "thread_writer_conflict");

  const forkBody = {
    text: "continue in copy",
    permission: "dangerFullAccess",
    clientRequestId: "retry-safe-request",
  };
  const forked = await request(baseUrl, "/api/threads/thread-busy/fork", {
    method: "POST",
    body: JSON.stringify(forkBody),
  });
  assert.equal(forked.response.status, 200);
  const forkedThreadId = forked.body.thread.id;
  assert.match(forkedThreadId, /^thread-busy-fork-\d+$/);

  const immediateList = await request(baseUrl, "/api/threads");
  assert.equal(immediateList.body.data.filter((thread) => thread.id === forkedThreadId).length, 1);
  const metadata = immediateList.body.data.find((thread) => thread.id === forkedThreadId);
  assert.equal(metadata.permission, "dangerFullAccess");
  assert.equal(metadata.name, "副本 · Busy source");
  const forkRead = await request(baseUrl, `/api/threads/${encodeURIComponent(forkedThreadId)}`);
  assert.equal(forkRead.response.status, 200);
  assert.equal(forkRead.body.thread.name, "副本 · Busy source");
  assert.equal(forkRead.body.thread.pocketActiveTurnId, "turn-1");
  const interrupted = await request(
    baseUrl,
    `/api/threads/${encodeURIComponent(forkedThreadId)}/interrupt`,
    { method: "POST", body: JSON.stringify({ turnId: "turn-1" }) },
  );
  assert.equal(interrupted.response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const readAfterInterrupt = await request(
    baseUrl,
    `/api/threads/${encodeURIComponent(forkedThreadId)}`,
  );
  assert.equal(readAfterInterrupt.body.thread.pocketActiveTurnId, null);

  const retried = await request(baseUrl, "/api/threads/thread-busy/fork", {
    method: "POST",
    body: JSON.stringify(forkBody),
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.thread.id, forkedThreadId);

  const mismatchedRetry = await request(baseUrl, "/api/threads/thread-busy/fork", {
    method: "POST",
    body: JSON.stringify({ ...forkBody, text: "different copy payload" }),
  });
  assert.equal(mismatchedRetry.response.status, 409);
  assert.equal(mismatchedRetry.body.code, "idempotency_conflict");

  const afterForkPocketState = JSON.parse(await readFile(pocketStatePath, "utf8"));
  assert.equal(afterForkPocketState.threadProjects[forkedThreadId], null);
  assert.equal(afterForkPocketState.threadPermissions[forkedThreadId], "dangerFullAccess");
  assert.equal(await readFile(desktopStatePath, "utf8"), initialDesktopState);

  const changedPermission = await request(
    baseUrl,
    `/api/threads/${encodeURIComponent(forkedThreadId)}/permission`,
    { method: "PUT", body: JSON.stringify({ permission: "readOnly" }) },
  );
  assert.equal(changedPermission.response.status, 200);
  assert.equal(changedPermission.body.storage, "pocket");
  const readAfterPermission = await request(
    baseUrl,
    `/api/threads/${encodeURIComponent(forkedThreadId)}`,
  );
  assert.equal(readAfterPermission.body.thread.permission, "readOnly");

  const created = await request(baseUrl, "/api/threads", {
    method: "POST",
    body: JSON.stringify({ permission: "workspaceWrite", model: "gpt-session", clientRequestId: "create-durable" }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.thread.id, "thread-new");
  assert.equal(created.body.thread.projectId, "alpha");
  const createdRead = await request(baseUrl, "/api/threads/thread-new");
  assert.equal(createdRead.response.status, 200);
  assert.deepEqual(createdRead.body.thread.turns, []);
  assert.equal(createdRead.body.thread.model, "gpt-session");
  assert.equal(createdRead.body.thread.reasoningEffort, "high");
  const afterStartPocketState = JSON.parse(await readFile(pocketStatePath, "utf8"));
  assert.equal(afterStartPocketState.threadProjects["thread-new"], "alpha");
  assert.equal(afterStartPocketState.threadPermissions["thread-new"], "workspaceWrite");
  assert.equal(await readFile(desktopStatePath, "utf8"), initialDesktopState);

  const messageBody = { text: "durable message", permission: "workspaceWrite", clientRequestId: "message-durable" };
  const sent = await request(baseUrl, "/api/threads/thread-new/messages", { method: "POST", body: JSON.stringify(messageBody) });
  assert.equal(sent.response.status, 200);
  const duplicate = await request(baseUrl, "/api/threads/thread-new/messages", { method: "POST", body: JSON.stringify(messageBody) });
  assert.equal(duplicate.response.status, 200);
  assert.deepEqual(duplicate.body, sent.body);
  const steerBody = { text: "steer once", turnId: sent.body.turn.id, clientRequestId: "steer-durable" };
  const steered = await request(baseUrl, "/api/threads/thread-new/steer", { method: "POST", body: JSON.stringify(steerBody) });
  assert.equal(steered.response.status, 200);
  const steeredTwice = await request(baseUrl, "/api/threads/thread-new/steer", { method: "POST", body: JSON.stringify(steerBody) });
  assert.deepEqual(steeredTwice.body, steered.body);
  const sendStatus = await request(baseUrl, "/api/requests/message-durable");
  assert.equal(sendStatus.body.status, "confirmed");
  const missingRequest = await request(baseUrl, "/api/requests/does-not-exist");
  assert.equal(missingRequest.response.status, 404);

  await stopServer(child);
  child = await startServer();
  const restartedFork = await request(baseUrl, "/api/threads/thread-busy/fork", { method: "POST", body: JSON.stringify(forkBody) });
  assert.equal(restartedFork.body.thread.id, forkedThreadId);
  const restartedCreate = await request(baseUrl, "/api/threads", { method: "POST", body: JSON.stringify({ permission: "workspaceWrite", model: "gpt-session", clientRequestId: "create-durable" }) });
  assert.equal(restartedCreate.response.status, 201);
  const restartedSend = await request(baseUrl, "/api/threads/thread-new/messages", { method: "POST", body: JSON.stringify(messageBody) });
  assert.deepEqual(restartedSend.body, sent.body);
  const restartedStatus = await request(baseUrl, "/api/status");
  assert.equal(restartedStatus.body.workerCount, 0, "replaying confirmed results must not acquire writers");

  const afterRestart = await request(baseUrl, "/api/threads");
  assert.equal(
    afterRestart.body.data.filter((thread) => thread.id === forkedThreadId).length,
    1,
  );
  assert.equal(
    afterRestart.body.data.find((thread) => thread.id === forkedThreadId).projectId,
    null,
  );
  assert.equal(
    afterRestart.body.data.find((thread) => thread.id === "thread-new").projectId,
    "alpha",
  );

  const build = (await request(baseUrl, "/api/status")).body.build;
  const staticResponse = await fetch(`${baseUrl}/app.js?v=${build}`, {
    headers: { "Accept-Encoding": "br" },
  });
  assert.equal(staticResponse.status, 200);
  assert.equal(staticResponse.headers.get("content-encoding"), "br");
  const indexResponse = await fetch(baseUrl);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /id="thread-id"/);
  assert.match(indexHtml, /id="copy-thread-id-button"[^>]+aria-label="复制会话 ID"/);
  assert.ok(indexHtml.includes(`app.js?v=${build}`));
  assert.match(staticResponse.headers.get("cache-control"), /immutable/);
  assert.equal(indexHtml.includes("__BUILD__"), false);
  assert.match(indexHtml, /interactive-widget=resizes-content/);
  assert.match(indexHtml, /id="approval-tray"[^>]+role="alertdialog"/s);
});

test("HTTP images, diff output and runtime diagnostics use bounded, writer-safe routes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-media-http-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, POCKET_HOST: "127.0.0.1", POCKET_PORT: String(port), POCKET_APP_SERVER_FIXTURE: fixturePath,
    POCKET_STATE_PATH: path.join(directory, "missing.sqlite"), POCKET_CATALOG_PATH: path.join(directory, "missing-catalog.sqlite"),
    POCKET_DESKTOP_STATE_PATH: "none", POCKET_OVERLAY_PATH: path.join(directory, "pocket.json"),
    POCKET_IMAGE_DIRECTORY: path.join(directory, "images"), POCKET_REQUEST_DB_PATH: path.join(directory, "requests.sqlite"), POCKET_IDLE_RELEASE_MS: "60000",
  } });
  t.after(async () => { await stopServer(child); await rm(directory, { recursive: true, force: true }); });
  await waitForServer(child);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
  const uploaded = await request(baseUrl, "/api/images", { method: "POST", body: png, headers: { "Content-Type": "image/png" } });
  assert.equal(uploaded.response.status, 201);
  const id = uploaded.body.id;
  const preview = await fetch(`${baseUrl}${uploaded.body.url}`);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const badOrigin = await request(baseUrl, "/api/images", { method: "POST", body: png, headers: { Origin: "https://example.com" } });
  assert.equal(badOrigin.response.status, 403);
  const invalid = await request(baseUrl, "/api/images", { method: "POST", body: "<svg/>" });
  assert.equal(invalid.response.status, 415);
  const badPath = await request(baseUrl, "/api/threads/thread-images/messages", { method: "POST", body: JSON.stringify({ text: "", images: ["/etc/passwd"] }) });
  assert.equal(badPath.response.status, 400);
  assert.equal((await request(baseUrl, "/api/status")).body.workerCount, 0);
  const body = { text: "", images: [id], clientRequestId: "image-send" };
  const sent = await request(baseUrl, "/api/threads/thread-images/messages", { method: "POST", body: JSON.stringify(body) });
  assert.equal(sent.response.status, 200);
  assert.deepEqual(sent.body.turn.input, [{ type: "localImage", path: path.join(directory, "images", id) }]);
  const duplicate = await request(baseUrl, "/api/threads/thread-images/messages", { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(duplicate.body, sent.body);
  const steer = await request(baseUrl, "/api/threads/thread-images/steer", { method: "POST", body: JSON.stringify({ text: "look here", images: [id], turnId: "turn-1" }) });
  assert.equal(steer.body.input[1].type, "localImage");
  const busy = await request(baseUrl, "/api/threads/thread-images/release", { method: "POST" });
  assert.equal(busy.body.code, "runtime_busy");
  await request(baseUrl, "/api/threads/thread-images/interrupt", { method: "POST", body: "{}" });
  const release = await request(baseUrl, "/api/threads/thread-images/release", { method: "POST" });
  assert.equal(release.body.released, true);
  const review = await request(baseUrl, "/api/threads/thread-review");
  const [files, command] = review.body.thread.turns[0].items;
  assert.equal(files.changes[0].diff, "@@ -1 +1 @@\n-before\n+after");
  assert.equal(files.changes[1].diff.length, 40_000);
  assert.equal(files.changes[1].diffTruncated, true);
  assert.equal(command.exitCode, 1);
  assert.equal(command.durationMs, 1500);
  assert.equal(command.aggregatedOutput.length, 20_000);
  assert.equal(command.outputTruncated, true);
  const paged = await request(baseUrl, '/api/threads/thread-review?limit=1');
  assert.equal(paged.body.thread.turns[0].items.length, 1);
  assert.equal(paged.body.thread.turns[0].items[0].id, 'command');
  assert.equal(paged.body.history.hasEarlier, true);
  const before = await request(baseUrl, `/api/threads/thread-review?${new URLSearchParams({ limit: '1', before: paged.body.history.beforeCursor })}`);
  assert.equal(before.body.thread.turns[0].items[0].changes[0].diff, undefined);
  assert.equal(before.body.thread.turns[0].items[0].changes[0].diffAvailable, true);
  const diff = await request(baseUrl, '/api/threads/thread-review/items/files/diff?turnId=review&file=0');
  assert.equal(diff.body.diff, files.changes[0].diff);
  assert.equal((await request(baseUrl, '/api/threads/thread-review?limit=999')).response.status, 400);
  const storage = await request(baseUrl, '/api/storage');
  assert.equal(storage.body.images.count, 1);
  assert.deepEqual(storage.body.images.candidates, []);
  assert.ok(storage.body.journal.bytes > 0);
  assert.deepEqual((await request(baseUrl, '/api/storage/cleanup', { method: 'POST', body: JSON.stringify({ images: [id] }) })).body.skipped, [id]);
  assert.equal((await request(baseUrl, '/api/notifications/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: baseUrl + '/api/status' } }) })).response.status, 400);
  const status = (await request(baseUrl, "/api/status")).body;
  assert.equal(status.workerCount, 0);
  assert.match(status.build, /^[a-f0-9]{16}$/);
  assert.equal(typeof status.serverTime, "number");
});
