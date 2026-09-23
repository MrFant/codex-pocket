import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { ImageStore, MAX_IMAGE_BYTES } from "./lib/image-store.mjs";
import { loadStaticAssets } from "./lib/static-assets.mjs";
import { historyPage, withoutDiff } from "./lib/history-pages.mjs";
import { PushNotifications } from "./lib/push-notifications.mjs";
import { RequestJournal } from "./lib/request-journal.mjs";
import { fileURLToPath } from "node:url";
import { CodexRpcError } from "./lib/codex-client.mjs";
import { CodexRuntimePool } from "./lib/codex-runtime-pool.mjs";
import { LocalCodexState } from "./lib/local-codex-state.mjs";
import { inspectWriterOccupancy } from "./lib/writer-occupancy.mjs";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(rootDirectory, "public");
const host = process.env.POCKET_HOST || "127.0.0.1";
const port = Number(process.env.POCKET_PORT || 3210);
const clientOptions = process.env.POCKET_APP_SERVER_FIXTURE
  ? { command: process.execPath, args: [process.env.POCKET_APP_SERVER_FIXTURE] }
  : {};
const client = new CodexRuntimePool({ clientOptions });
const localStateOptions = {
  projectConfigPath: path.join(rootDirectory, "config", "projects.json"),
  ...(process.env.POCKET_CATALOG_PATH ? { catalogPath: process.env.POCKET_CATALOG_PATH } : {}),
  ...(process.env.POCKET_STATE_PATH ? { statePath: process.env.POCKET_STATE_PATH } : {}),
  ...(process.env.POCKET_DESKTOP_STATE_PATH === "none"
    ? { desktopStatePath: null }
    : process.env.POCKET_DESKTOP_STATE_PATH
      ? { desktopStatePath: process.env.POCKET_DESKTOP_STATE_PATH }
      : {}),
  ...(process.env.POCKET_OVERLAY_PATH === "none"
    ? { pocketStatePath: null }
    : process.env.POCKET_OVERLAY_PATH
      ? { pocketStatePath: process.env.POCKET_OVERLAY_PATH }
      : {}),
};
const localState = new LocalCodexState({
  ...localStateOptions,
});
try {
  await localState.initializeActivityTracking();
} catch (error) {
  console.error(`Activity tracking failed to initialize: ${error.message}`);
}
const eventStreams = new Set();
const threadReadCache = new Map();
const staticAssets = await loadStaticAssets(publicDirectory);
const startedAt = Date.now();
const recentErrors = [];
const imageStore = new ImageStore(process.env.POCKET_IMAGE_DIRECTORY
  || (process.env.POCKET_APP_SERVER_FIXTURE ? path.join(tmpdir(), `pocket-images-${process.pid}`)
    : path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "codex-pocket-images")));
const requestJournal = new RequestJournal(process.env.POCKET_REQUEST_DB_PATH
  || (process.env.POCKET_APP_SERVER_FIXTURE ? ":memory:"
    : path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "codex-pocket-requests.sqlite")));
const push = new PushNotifications(process.env.POCKET_PUSH_DB_PATH
  || (process.env.POCKET_APP_SERVER_FIXTURE ? ":memory:" : path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "codex-pocket-notifications.sqlite")));
const MAX_CACHED_THREADS = 20;
const BROWSER_NOTIFICATION_METHODS = new Set([
  "thread/status/changed",
  "thread/closed",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
]);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function validateText(value, images = []) {
  if (typeof value !== "string" || (!value.trim() && !images.length)) {
    throw Object.assign(new Error("Message text is required"), { status: 400 });
  }
  if (value.length > 100_000) {
    throw Object.assign(new Error("Message text is too long"), { status: 400 });
  }
  return value.trim();
}

function validateOptionalSetting(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw Object.assign(new Error(`${name} is invalid`), { status: 400 });
  }
  return value.trim();
}

function validatePermission(value) {
  const permission = value || "workspaceWrite";
  if (!["readOnly", "workspaceWrite", "dangerFullAccess"].includes(permission)) {
    throw Object.assign(new Error("Permission preset is invalid"), { status: 400 });
  }
  return permission;
}

function validateWorkingDirectory(value, { required = false } = {}) {
  const cwd = validateOptionalSetting(value, "Working directory");
  if (!cwd && !required) return null;
  if (!cwd || !path.isAbsolute(cwd)) {
    throw Object.assign(new Error("Working directory must be an absolute path"), { status: 400 });
  }
  return path.normalize(cwd);
}

async function defaultThreadCwd() {
  const configured = validateWorkingDirectory(process.env.CODEX_DEFAULT_CWD);
  if (configured) return configured;
  const listed = await localState.listThreads();
  const recentCwd = listed?.data?.find((thread) => thread.cwd)?.cwd;
  return validateWorkingDirectory(recentCwd) || process.cwd();
}

function broadcast(payload) {
  const frame = `event: codex\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of eventStreams) writeEventStream(response, frame);
}

function writeEventStream(response, frame) {
  if (response.destroyed || response.writableEnded) {
    eventStreams.delete(response);
    return false;
  }
  try {
    if (response.write(frame)) return true;
  } catch {
    // A disconnected mobile client will reconnect and re-read its open thread.
  }
  eventStreams.delete(response);
  response.destroy();
  return false;
}

function compactItem(item) {
  if (!item || item.type === "reasoning" || item.type === "hookPrompt" || item.type === "contextCompaction") return null;
  const base = {
    id: item.id,
    type: item.type,
    ...(item.status ? { status: item.status } : {}),
  };
  if (item.type === "userMessage") {
    return {
      ...base,
      content: (item.content || []).map((input) => ({
        type: input.type,
        ...(input.text ? { text: input.text } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.path ? { path: input.path, imageUrl: imageStore.urlForPath(input.path) } : {}),
      })),
    };
  }
  if (item.type === "agentMessage") return { ...base, text: item.text || "" };
  if (item.type === "commandExecution") {
    return {
      ...base,
      command: item.command || "",
      cwd: item.cwd || "",
      aggregatedOutput: String(item.aggregatedOutput || "").slice(-20_000),
      outputTruncated: Boolean(item.outputTruncated) || String(item.aggregatedOutput || "").length > 20_000,
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null,
    };
  }
  if (item.type === "fileChange") {
    let remaining = 200_000;
    return {
      ...base,
      changes: (item.changes || []).map((change) => {
        const diff = String(change.diff || "");
        const kept = diff.slice(0, Math.min(40_000, remaining));
        remaining -= kept.length;
        return {
        path: change.path || change.file || "",
        ...(change.kind ? { kind: change.kind } : {}),
        diff: kept,
        diffTruncated: diff.length > kept.length,
      }; }),
    };
  }
  const summary = item.query || item.name || item.toolName || item.command || item.url
    || item.title || item.server || item.type;
  return { ...base, summary: String(summary).slice(0, 1_000) };
}

function compactThreadResult(result) {
  if (!result?.thread) return result;
  return {
    ...result,
    thread: {
      ...result.thread,
      turns: (result.thread.turns || []).map((turn) => ({
        id: turn.id,
        status: turn.status,
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        items: (turn.items || []).map(compactItem).filter(Boolean),
      })),
    },
  };
}

function rolloutItem(item) {
  if (!item || !item.id) return null;
  const base = { id: item.id };
  if (item.type === "UserMessage") {
    return {
      ...base,
      type: "userMessage",
      content: (item.content || []).map((input) => ({
        type: input.type === "LocalImage" || input.type === "local_image" ? "localImage" : input.type === "Image" ? "image" : input.type,
        ...(input?.text ? { text: input.text } : {}),
        ...(input?.path ? { path: input.path } : {}),
      })),
    };
  }
  if (item.type === "AgentMessage") {
    const text = (item.content || [])
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("\n");
    return { ...base, type: "agentMessage", text };
  }
  if (item.type === "CommandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    return {
      ...base,
      type: "commandExecution",
      command: command || "",
      cwd: String(item.cwd || "").replace(/^file:\/\//, ""),
      aggregatedOutput: String(item.aggregated_output || item.aggregatedOutput || item.stdout || ""),
      exitCode: item.exit_code ?? item.exitCode ?? null,
      durationMs: item.duration_ms ?? item.durationMs ?? null,
      ...(item.status ? { status: item.status } : {}),
    };
  }
  if (item.type === "FileChange") {
    const changes = Object.entries(item.changes || {}).map(([file, change]) => ({
      path: change?.path || file,
      ...(change?.type ? { kind: change.type } : {}),
      diff: change?.unified_diff || change?.diff || change?.content || "",
    }));
    return { ...base, type: "fileChange", changes, ...(item.status ? { status: item.status } : {}) };
  }
  if (["Reasoning", "ContextCompaction"].includes(item.type)) return null;
  const summary = item.tool || item.name || item.kind || item.type;
  return { ...base, type: "toolCall", summary: String(summary || "事件").slice(0, 1_000) };
}

async function readRolloutFallback(metadata, threadId) {
  if (!metadata?.rolloutPath) return null;
  const contents = await readFile(metadata.rolloutPath, "utf8");
  const turns = new Map();
  const ensureTurn = (turnId) => {
    const id = String(turnId || `turn-${turns.size + 1}`);
    let turn = turns.get(id);
    if (!turn) {
      turn = { id, status: "inProgress", items: [] };
      turns.set(id, turn);
    }
    return turn;
  };
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload || {};
    if (payload.type === "task_started") ensureTurn(payload.turn_id);
    if (payload.type === "task_complete") ensureTurn(payload.turn_id).status = "completed";
    if (payload.type !== "item_completed") continue;
    const turn = ensureTurn(payload.turn_id);
    const item = rolloutItem(payload.item);
    if (item) turn.items.push(item);
  }
  return {
    thread: {
      id: threadId,
      cwd: metadata.cwd || "",
      turns: [...turns.values()],
    },
  };
}

function compactBrowserEvent(payload) {
  if (payload.kind !== "notification") return payload;
  const { method, params = {} } = payload.message || {};
  if (!BROWSER_NOTIFICATION_METHODS.has(method)) return null;
  const compactParams = { ...params };
  if (params.item) {
    compactParams.item = compactItem(params.item);
    if (compactParams.item) compactParams.item = { ...withoutDiff(compactParams.item), historyCursor: JSON.stringify([String(params.turnId), String(params.item.id)]) };
    if (!compactParams.item) return null;
  }
  if (params.turn) {
    compactParams.turn = {
      id: params.turn.id,
      status: params.turn.status,
      ...(params.turn.model ? { model: params.turn.model } : {}),
      ...(params.turn.effort ? { effort: params.turn.effort } : {}),
    };
  }
  if (typeof compactParams.delta === "string") {
    compactParams.delta = compactParams.delta.slice(0, 50_000);
  }
  return { ...payload, message: { ...payload.message, params: compactParams } };
}

function cacheThread(threadId, version, result) {
  threadReadCache.delete(threadId);
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 24 * 1024 * 1024) return;
  threadReadCache.set(threadId, { version, result, bytes });
  while (threadReadCache.size > MAX_CACHED_THREADS || [...threadReadCache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 24 * 1024 * 1024) {
    threadReadCache.delete(threadReadCache.keys().next().value);
  }
}

function threadReadVersion(metadata) {
  return `${metadata?.updatedAt ?? ""}\u0000${metadata?.activityCompletionKey ?? ""}`;
}

function liveThreadStatus(threadId, fallback = null) {
  const runtime = client.getStatus();
  if (runtime.activeTurns[threadId]) {
    return runtime.threadStatuses[threadId] || { type: "active", activeFlags: [] };
  }
  return runtime.threadStatuses[threadId] || fallback;
}

function overlayRuntimeState(result) {
  if (!result?.data) return result;
  return {
    ...result,
    data: result.data.map((thread) => ({
      ...thread,
      status: liveThreadStatus(thread.id, thread.status),
    })),
  };
}

function decorateThreadResult(result, metadata, threadId) {
  if (!result?.thread) return result;
  const runtime = client.getStatus();
  const metadataFields = metadata ? {
    name: metadata.name || result.thread.name || result.thread.title,
    preview: metadata.preview || result.thread.preview,
    cwd: metadata.cwd || result.thread.cwd,
    createdAt: metadata.createdAt || result.thread.createdAt,
    updatedAt: metadata.updatedAt || result.thread.updatedAt,
    recencyAt: metadata.recencyAt || result.thread.recencyAt,
    projectId: metadata.projectId,
    projectName: metadata.projectName,
    projectPath: metadata.projectPath,
    projectOrder: metadata.projectOrder,
    isPinned: metadata.isPinned,
    hasUnreadActivity: metadata.hasUnreadActivity,
    activityCompletionKey: metadata.activityCompletionKey,
    activityCompletedAt: metadata.activityCompletedAt,
    permission: metadata.permission,
  } : {};
  return {
    ...result,
    thread: {
      ...result.thread,
      ...metadataFields,
      pocketActiveTurnId: runtime.activeTurns[threadId] || null,
      status: runtime.threadStatuses[threadId]
        || (runtime.activeTurns[threadId] ? { type: "active", activeFlags: [] } : null)
        || (metadata?.status?.type === "notLoaded" ? result.thread.status : metadata?.status)
        || result.thread.status,
    },
  };
}

async function rememberThread(result, options = {}) {
  const thread = result?.thread;
  if (!thread?.id) return;
  localState.rememberThread(thread, options);
  if (options.permission || options.persistProject) {
    await localState.setThreadOverrides(thread.id, {
      permission: options.permission || null,
      projectId: options.projectId || null,
      persistProject: Boolean(options.persistProject),
    }).catch((error) => {
      console.error(`Failed to persist Pocket metadata for ${thread.id}: ${error.message}`);
    });
  }
}

function queueNotification(threadId, kind, key) {
  const failed = () => { push.lastError = { at: Date.now(), code: 'notification_storage_error' }; };
  try {
    push.notify(threadId, kind, key);
    void push.flush().catch(failed);
  } catch { failed(); } // Optional notification storage must not break session events.
}

client.on("event", (payload) => {
  if (payload.kind === "serverRequest") {
    const params = payload.request.params || {};
    const threadId = params.threadId || params.conversationId;
    queueNotification(threadId, "attention", `approval:${payload.request.id}`);
  }
  if (payload.kind === "notification") {
    const { method, params = {} } = payload.message || {};
    if (method === "turn/completed" && ["completed", "failed"].includes(params.turn?.status)) {
      queueNotification(params.threadId, params.turn.status === "failed" ? "failed" : "complete", `turn:${params.threadId}:${params.turn.id}`);
    }
    if (params.threadId && (method?.startsWith("item/") || method?.startsWith("turn/"))) {
      threadReadCache.delete(params.threadId);
    }
  }
  const browserEvent = compactBrowserEvent(payload);
  if (browserEvent) broadcast(browserEvent);
});

async function serveStatic(requestPath, response, headOnly = false, acceptEncoding = "", version = null) {
  const requested = requestPath === "/" ? "/index.html" : requestPath;
  const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filename = path.join(publicDirectory, normalized);
  if (!filename.startsWith(publicDirectory)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = staticAssets.files.get(requested);
    if (!body) { json(response, 404, { error: "Not found" }); return; }
    const extension = path.extname(filename);
    const isLongLivedAsset = version === staticAssets.version && !["/sw.js", "/index.html"].includes(requested);
    const compressible = [".html", ".js", ".css", ".json", ".webmanifest", ".svg"].includes(extension);
    const accepted = acceptEncoding;
    let encodedBody = body;
    let contentEncoding = null;
    if (compressible && body.length > 1_024 && accepted.includes("br")) {
      encodedBody = brotliCompressSync(body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      });
      contentEncoding = "br";
    } else if (compressible && body.length > 1_024 && accepted.includes("gzip")) {
      encodedBody = gzipSync(body, { level: 6 });
      contentEncoding = "gzip";
    }
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extension) || "application/octet-stream",
      "Cache-Control": isLongLivedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "Content-Length": encodedBody.length,
      Vary: "Accept-Encoding",
      ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(headOnly ? undefined : encodedBody);
  } catch (error) {
    if (error.code === "ENOENT") json(response, 404, { error: "Not found" });
    else throw error;
  }
}

async function readThreadResult(threadId) {
    const metadata = await localState.getThreadMetadata(threadId);
    const version = threadReadVersion(metadata);
    const cached = threadReadCache.get(threadId);
    if (cached && cached.version === version) {
      threadReadCache.delete(threadId);
      threadReadCache.set(threadId, cached);
      return decorateThreadResult(cached.result, metadata, threadId);
    }
    let result;
    try {
      result = compactThreadResult(await client.readThread(threadId));
    } catch (error) {
      const isDeserializeFailure = /failed to deserialize stored thread item|unknown variant/i.test(error?.message || "");
      if (!isDeserializeFailure) throw error;
      result = compactThreadResult(await readRolloutFallback(metadata, threadId));
      if (!result) throw error;
    }
    cacheThread(threadId, version, result);
    return decorateThreadResult(result, metadata, threadId);
}

async function handleApi(request, response, url) {
  if (request.method !== "GET" && !isSameOrigin(request)) {
    json(response, 403, { error: "Cross-origin requests are not allowed" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    json(response, 200, {
      ...client.getStatus(),
      build: staticAssets.version, startedAt, serverTime: Date.now(), recentErrors, notifications: push.status(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notifications/key") {
    json(response, 200, { publicKey: push.keys().publicKey }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/status") {
    const body = await readJson(request);
    json(response, 200, { subscribed: push.hasSubscription(body.endpoint) }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/subscribe") {
    const body = await readJson(request);
    const result = push.subscribe(body.subscription);
    push.observe((await localState.getThreadState()).activities);
    json(response, 200, result); return;
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/unsubscribe") {
    const body = await readJson(request);
    json(response, 200, push.unsubscribe(body.endpoint)); return;
  }

  if (request.method === "POST" && url.pathname === "/api/images") {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw Object.assign(new Error("每张图片需小于 10 MB"), { status: 413 });
      chunks.push(chunk);
    }
    json(response, 201, await imageStore.put(Buffer.concat(chunks), request.headers["x-pocket-attachment-id"] || null));
    return;
  }
  const imageRelease = url.pathname.match(/^\/api\/images\/([^/]+)\/release$/);
  if (request.method === "POST" && imageRelease) {
    const body = await readJson(request);
    json(response, 200, await imageStore.release(imageRelease[1], body.ref)); return;
  }
  if (request.method === "GET" && url.pathname === "/api/storage") {
    const images = await imageStore.stats();
    const logs = await Promise.all(["launchagent.out.log", "launchagent.err.log"].map(async (name) => ({ name,
      bytes: await stat(path.join(rootDirectory, "logs", name)).then((info) => info.size, () => 0),
    })));
    json(response, 200, { images, journal: requestJournal.stats(), historyCacheBytes: [...threadReadCache.values()].reduce((sum, entry) => sum + entry.bytes, 0), logs }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/storage/cleanup") {
    const body = await readJson(request);
    json(response, 200, await imageStore.cleanup(body.images)); return;
  }
  const imageMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/);
  if (request.method === "GET" && imageMatch) {
    try {
      const { bytes, type } = await imageStore.read(imageMatch[1]);
      response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length,
        "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
      response.end(bytes);
    } catch (error) {
      if (error.code === "ENOENT") json(response, 404, { error: "图片不存在" });
      else throw error;
    }
    return;
  }
  const releaseMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/release$/);
  if (request.method === "POST" && releaseMatch) {
    json(response, 200, await client.releaseThread(decodeURIComponent(releaseMatch[1])));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    eventStreams.add(response);
    writeEventStream(response, `event: codex\ndata: ${JSON.stringify({ kind: "snapshot", status: client.getStatus(), approvals: client.listPendingRequests() })}\n\n`);
    request.on("close", () => eventStreams.delete(response));
    response.on("error", () => eventStreams.delete(response));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/threads") {
    const options = {
      archived: url.searchParams.get("archived") === "true",
      searchTerm: url.searchParams.get("search") || null,
      cursor: url.searchParams.get("cursor") || null,
    };
    const result = await localState.listThreads(options) || await client.listThreads(options);
    json(response, 200, overlayRuntimeState(result));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/threads") {
    const body = await readJson(request);
    const cwd = validateWorkingDirectory(body.cwd) || await defaultThreadCwd();
    const permission = validatePermission(body.permission);
    const projectId = localState.resolveProjectIdForCwd(cwd);
    const model = validateOptionalSetting(body.model, "Model");
    const result = await requestJournal.execute(body.clientRequestId, { action: "start", body: { ...body, clientRequestId: undefined } }, async () => {
      const result = await client.startThread({
        cwd,
        model,
        permission,
      });
      await rememberThread(result, {
        cwd,
        permission,
        projectId,
        persistProject: true,
      });
      const metadata = result.thread?.id
        ? await localState.getThreadMetadata(result.thread.id)
        : null;
      if (metadata) {
        result.thread = {
          ...result.thread,
          name: result.thread.name || result.thread.title || metadata.name,
          preview: result.thread.preview || metadata.preview,
          projectId: metadata.projectId,
          projectName: metadata.projectName,
          projectPath: metadata.projectPath,
          projectOrder: metadata.projectOrder,
          permission: metadata.permission,
        };
      }
      return compactThreadResult(result);
    });
    json(response, 201, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/thread-statuses") {
    const state = await localState.getThreadState();
    const runtime = client.getStatus();
    const writerOccupancy = await inspectWriterOccupancy(localState.writerLockDirectory, runtime.workerPids);
    json(response, 200, {
      data: { ...state.statuses, ...runtime.threadStatuses },
      permissions: state.permissions,
      activities: state.activities,
      writerOccupancy: Object.fromEntries(Object.entries(writerOccupancy)
        .filter(([id]) => Object.hasOwn(state.statuses, id) || Object.hasOwn(runtime.workers, id))),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const cwd = validateWorkingDirectory(url.searchParams.get("cwd"));
    const result = await client.listModels({ cwd });
    json(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/approvals") {
    json(response, 200, { data: client.listPendingRequests() });
    return;
  }

  const requestMatch = url.pathname.match(/^\/api\/requests\/([a-zA-Z0-9_-]{1,128})$/);
  if (request.method === "GET" && requestMatch) {
    const record = requestJournal.get(requestMatch[1]);
    json(response, record ? 200 : 404, record || { error: "Request not received", code: "request_not_found" });
    return;
  }

  const diffMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)\/diff$/);
  if (request.method === "GET" && diffMatch) {
    const result = await readThreadResult(decodeURIComponent(diffMatch[1]));
    const turn = result.thread?.turns?.find((turn) => turn.id === url.searchParams.get("turnId"));
    const item = turn?.items?.find((item) => item.id === decodeURIComponent(diffMatch[2]) && item.type === "fileChange");
    const index = Number(url.searchParams.get("file"));
    const change = Number.isInteger(index) && index >= 0 ? item?.changes?.[index] : null;
    if (!change) { json(response, 404, { error: "差异暂未就绪，请稍后重试" }); return; }
    json(response, 200, change); return;
  }

  let match = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (request.method === "GET" && match) {
    const threadId = decodeURIComponent(match[1]);
    json(response, 200, historyPage(await readThreadResult(threadId), url.searchParams));
    return;
  }

  match = url.pathname.match(/^\/api\/threads\/([^/]+)\/permission$/);
  if (request.method === "PUT" && match) {
    const threadId = decodeURIComponent(match[1]);
    const metadata = await localState.getThreadMetadata(threadId);
    if (!metadata) throw Object.assign(new Error("Thread not found"), { status: 404 });
    const body = await readJson(request);
    const permission = validatePermission(body.permission);
    const result = await localState.setThreadPermission(threadId, permission);
    threadReadCache.delete(threadId);
    broadcast({ kind: "permissionChanged", threadId, permission });
    json(response, 200, { ...result, appliesFrom: "nextTurn" });
    return;
  }

  match = url.pathname.match(/^\/api\/threads\/([^/]+)\/read$/);
  if (request.method === "POST" && match) {
    const threadId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const completionKey = validateOptionalSetting(body.completionKey, "Completion key");
    if (!completionKey) throw Object.assign(new Error("Completion key is required"), { status: 400 });
    const metadata = await localState.getThreadMetadata(threadId);
    if (!metadata) throw Object.assign(new Error("Thread not found"), { status: 404 });
    if (metadata.activityCompletionKey !== completionKey) {
      throw Object.assign(new Error("A newer completion is available"), {
        status: 409,
        code: "stale_completion",
      });
    }
    const result = await localState.markThreadSeen(threadId, completionKey);
    broadcast({
      kind: "activityChanged",
      threadId,
      completionKey,
      hasUnreadActivity: false,
    });
    json(response, 200, result);
    return;
  }

  match = url.pathname.match(/^\/api\/threads\/([^/]+)\/(messages|fork|steer|interrupt)$/);
  if (request.method === "POST" && match) {
    const threadId = decodeURIComponent(match[1]);
    const action = match[2];
    const body = await readJson(request);
    if (action !== "interrupt") validateText(body.text, Array.isArray(body.images) ? body.images : []);
    const result = await requestJournal.execute(body.clientRequestId,
      { action, threadId, body: { ...body, clientRequestId: undefined } }, async () => {
        let result;
        const images = action === "interrupt" ? [] : await imageStore.resolve(body.images);
        const text = action === "interrupt" ? "" : validateText(body.text, images);
        if (action === "messages") {
          const permission = validatePermission(body.permission);
          const metadata = await localState.getThreadMetadata(threadId);
          result = await client.sendMessage(threadId, text, {
            images,
            model: validateOptionalSetting(body.model, "Model"),
            effort: validateOptionalSetting(body.effort, "Reasoning effort"),
            cwd: validateWorkingDirectory(body.cwd),
            permission,
            approvalPolicy: metadata?.permission === permission ? metadata.approvalPolicy : null,
          });
        }
        if (action === "fork") {
          const sourceMetadata = await localState.getThreadMetadata(threadId);
          const permission = validatePermission(body.permission);
          const model = validateOptionalSetting(body.model, "Model");
          const effort = validateOptionalSetting(body.effort, "Reasoning effort");
          const cwd = validateWorkingDirectory(body.cwd);
          const forkOperation = async () => {
            const forkResult = await client.forkAndSend(threadId, text, {
              images,
              model,
              effort,
              cwd,
              permission,
            });
            const durableResult = {
              ...forkResult,
              thread: {
                ...forkResult.thread,
                name: forkResult.thread?.name || forkResult.thread?.title
                  || `副本 · ${sourceMetadata?.name || "新会话"}`,
                preview: forkResult.thread?.preview || text,
                cwd: forkResult.thread?.cwd || cwd || sourceMetadata?.cwd || "",
              },
            };
            await rememberThread(durableResult, {
              cwd: cwd || sourceMetadata?.cwd || null,
              permission,
              projectId: sourceMetadata?.projectId || null,
              persistProject: true,
            });
            return durableResult;
          };
          result = await forkOperation();
        }
        if (action === "steer") result = await client.steer(threadId, text, body.turnId || null, images);
        if (action === "interrupt") result = await client.interrupt(threadId, body.turnId || null);
        return compactThreadResult(result || { ok: true });
    });
    json(response, 200, result);
    return;
  }

  match = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (request.method === "POST" && match) {
    const body = await readJson(request);
    if (!body.result || typeof body.result !== "object") {
      throw Object.assign(new Error("Approval result is required"), { status: 400 });
    }
    const result = await client.respondToServerRequest(decodeURIComponent(match[1]), body.result);
    json(response, 200, result);
    return;
  }

  json(response, 404, { error: "API route not found" });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(
        url.pathname,
        response,
        request.method === "HEAD",
        request.headers["accept-encoding"] || "",
        url.searchParams.get("v"),
      );
    }
    else json(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error.status || (error instanceof CodexRpcError ? 409 : 500);
    if (status >= 500) {
      recentErrors.push({ at: Date.now(), code: error.code || "server_error", route: (request.url || "").split("?")[0].replace(/\/threads\/[^/]+/, "/threads/:id") });
      if (recentErrors.length > 10) recentErrors.shift();
    }
    json(response, status, {
      error: error.message || "Unexpected server error",
      code: error.code || null,
    });
  }
});

const heartbeat = setInterval(() => {
  for (const response of eventStreams) writeEventStream(response, ": keepalive\n\n");
}, 20_000);
heartbeat.unref();

let notificationPoll = null;
const notificationTimer = setInterval(() => {
  if (notificationPoll || !push.status().subscriptions) return;
  notificationPoll = (async () => { push.observe((await localState.getThreadState()).activities); await push.flush(); })()
    .catch(() => { push.lastError = { at: Date.now(), code: 'notification_storage_error' }; })
    .finally(() => { notificationPoll = null; });
}, 15_000);
notificationTimer.unref();

let shutdownPromise = null;

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  const forceExit = setTimeout(() => process.exit(1), 4_500);
  forceExit.unref();
  shutdownPromise = (async () => {
    clearInterval(heartbeat);
    clearInterval(notificationTimer);
    const serverClosed = new Promise((resolve) => server.close(resolve));
    for (const response of eventStreams) response.end();
    await client.stop();
    server.closeAllConnections();
    await serverClosed;
    await requestJournal.close();
    await imageStore.close();
    await notificationPoll;
    await push.close();
    localState.close();
    clearTimeout(forceExit);
    process.exit(0);
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

server.listen(port, host, async () => {
  console.log(`Codex Pocket listening on http://${host}:${port}`);
  try {
    await client.start();
  } catch (error) {
    console.error(`Codex App Server failed to start: ${error.message}`);
  }
});
