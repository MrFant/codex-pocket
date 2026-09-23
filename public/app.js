import { MaintenancePanel } from "./maintenance-panel.js?v=__BUILD__";
import { AppUpdates, PAGE_BUILD } from "./app-updates.js?v=__BUILD__";
import { EventStream } from "./event-stream.js?v=__BUILD__";
import { flattenHistory, mergeHistory, threadWithItems, MAX_VISIBLE_ITEMS } from "./history-window.js?v=__BUILD__";
import { ImageAttachments } from "./image-attachments.js?v=__BUILD__";
import { fileDiffElement } from "./file-diff.js?v=__BUILD__";
import { RuntimePanel } from "./runtime-panel.js?v=__BUILD__";
import { renderMarkdownInto } from "./markdown.js?v=__BUILD__";
import { ThreadStore } from "./thread-store.js?v=__BUILD__";
import { buildUserInputResult, defaultApprovalResult, toGrantedPermissions } from "./approval-utils.js?v=__BUILD__";

import { DraftStore, OperationStore, ReadingStore, captureReadingPosition, restoreReadingPosition } from "./session-state.js?v=__BUILD__";
import { WriteOperations } from "./write-operations.js?v=__BUILD__";

const elements = {
  appShell: document.querySelector(".app-shell"),
  menuButton: document.querySelector("#menu-button"),
  sidebar: document.querySelector("#sidebar"),
  sidebarScrim: document.querySelector("#sidebar-scrim"),
  refreshButton: document.querySelector("#refresh-button"),
  newThreadButton: document.querySelector("#new-thread-button"),
  attentionFilter: document.querySelector("#attention-filter"),
  imageInput: document.querySelector("#image-input"),
  attachImage: document.querySelector("#attach-image"),
  imageAttachments: document.querySelector("#image-attachments"),
  searchInput: document.querySelector("#search-input"),
  archiveCheckbox: document.querySelector("#archive-checkbox"),
  threadList: document.querySelector("#thread-list"),
  connectionStatus: document.querySelector("#connection-status"),
  emptyState: document.querySelector("#empty-state"),
  chatView: document.querySelector("#chat-view"),
  threadTitle: document.querySelector("#thread-title"),
  threadStatus: document.querySelector("#thread-status"),
  writerOwner: document.querySelector("#writer-owner"),
  threadPath: document.querySelector("#thread-path"),
  threadId: document.querySelector("#thread-id"),
  copyThreadIdButton: document.querySelector("#copy-thread-id-button"),
  messages: document.querySelector("#messages"),
  threadNotice: document.querySelector("#thread-notice"),
  latestButton: document.querySelector("#latest-button"),
  requestTray: document.querySelector("#request-tray"),
  draftStatus: document.querySelector("#draft-status"),
  approvalTray: document.querySelector("#approval-tray"),
  composer: document.querySelector("#composer"),
  modelSelect: document.querySelector("#model-select"),
  effortSelect: document.querySelector("#effort-select"),
  permissionButton: document.querySelector("#permission-button"),
  messageInput: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  stopButton: document.querySelector("#stop-button"),
  composerHint: document.querySelector("#composer-hint"),
  writerDialog: document.querySelector("#writer-dialog"),
  newThreadDialog: document.querySelector("#new-thread-dialog"),
  newThreadForm: document.querySelector("#new-thread-form"),
  newThreadCwd: document.querySelector("#new-thread-cwd"),
  newThreadTarget: document.querySelector("#new-thread-target"),
  newThreadPermission: document.querySelector("#new-thread-permission"),
  newThreadPermissionDescription: document.querySelector("#new-thread-permission-description"),
  newThreadCancel: document.querySelector("#new-thread-cancel"),
  newThreadSubmit: document.querySelector("#new-thread-submit"),
  permissionDialog: document.querySelector("#permission-dialog"),
  permissionForm: document.querySelector("#permission-form"),
  permissionCancel: document.querySelector("#permission-cancel"),
  toast: document.querySelector("#toast"),
};

class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const state = {
  threadStore: new ThreadStore(),
  allThreads: [],
  threads: [],
  models: [],
  modelDefaults: { model: "", effort: "" },
  modelCache: new Map(),
  threadSettings: readThreadSettings(),
  threadPermissions: {},
  collapsedProjects: readCollapsedProjects(),
  attentionOnly: false,
  failedTurns: new Set(),
  currentThread: null,
  openingThreadId: null,
  sendingThreads: new Set(),
  draftThreadId: null,
  renderedThreadId: null,
  visibleItemLimit: 100,
  history: null,
  historyLoading: false,
  itemSignatures: new Map(),
  lastSyncedAt: null,
  threadFresh: false,
  unseenItems: false,
  items: [],
  activeTurns: new Map(),
  threadStatuses: new Map(),
  writerOccupancy: new Map(),
  approvals: new Map(),
  approvalDrafts: new Map(),
  submittingApprovals: new Set(),
  approvalRestoreFocus: null,
  approvalFocusFrame: null,
  eventAbortController: null,
  hasEventSnapshot: false,
  searchTimer: null,
  toastTimer: null,
  openRequestId: 0,
  openAbortController: null,
  threadListRequestId: 0,
  threadListAbortController: null,
  itemElements: new Map(),
  pendingItemRenders: new Set(),
  itemRenderFrame: null,
  readingActivities: new Set(),
  refreshingActivityThreads: new Set(),
  copyThreadIdTimer: null,
  newThreadCwd: "",
};

const THREAD_CACHE_PREFIX = "codex-pocket-thread-v__BUILD__:";
const THREAD_CACHE_INDEX = "codex-pocket-thread-cache-index-v__BUILD__";
const MAX_SESSION_THREADS = 6;
const FORK_DEFAULT_PERMISSION = "dangerFullAccess";
const CONFIRMED_STATUS_DURATION_MS = 4_000;
const drafts = new DraftStore();
const operations = new OperationStore();
const readingPositions = new ReadingStore();
const confirmedStatusTimers = new Map();
const writes = new WriteOperations({ store: operations, api, onChange: () => { renderWriteStatus(); renderThreads(); updates.render(); }, onConfirmed: applyConfirmedOperation });
const images = new ImageAttachments({ drafts, api, onChange(threadId) {
  if (state.draftThreadId === threadId) {
    images.render(elements.imageAttachments, threadId);
    persistDraft(); updateComposerState();
  }
  updates.render();
} });
function pageBusy() {
  return state.sendingThreads.size > 0 || images.uploads.size > 0 || images.pendingAdds > 0
    || operations.pending().some((record) => ["pending", "checking"].includes(record.status))
    || (!drafts.persistent && drafts.list().some((draft) => draft.text || draft.attachments?.length));
}
const updates = new AppUpdates({ busy: pageBusy, save: () => { persistDraft(); saveReadingPosition(); }, toast: showToast });
const runtimePanel = new RuntimePanel({ api, pageBuild: PAGE_BUILD, onStatus: (status) => updates.observeStatus(status), getThread: () => state.currentThread,
  getSyncTime: () => state.lastSyncedAt,
  getName: (id) => threadTitle(state.allThreads.find((thread) => thread.id === id) || { id }), toast: showToast });

const maintenance = new MaintenancePanel({ api, updates, toast: showToast });

async function api(path, options = {}) {
  const {
    timeoutMs = options.method ? 0 : 12_000,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  let timeout = null;
  let timedOut = false;
  let abortListener = null;
  let requestSignal = externalSignal;
  if (timeoutMs > 0) {
    const controller = new AbortController();
    requestSignal = controller.signal;
    if (externalSignal) {
      abortListener = () => controller.abort(externalSignal.reason);
      if (externalSignal.aborted) abortListener();
      else externalSignal.addEventListener("abort", abortListener, { once: true });
    }
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  try {
    const response = await fetch(path, {
      ...fetchOptions,
      ...(requestSignal ? { signal: requestSignal } : {}),
      headers: {
        ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.headers || {}),
      },
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (requestSignal?.aborted) throw error;
      if (response.ok) throw new ApiError("服务端响应不完整，请核对请求结果", { code: "invalid_response" });
      payload = {};
    }
    if (!response.ok) {
      throw new ApiError(payload.error || `请求失败 (${response.status})`, {
        status: response.status,
        code: payload.code || null,
      });
    }
    return payload;
  } catch (error) {
    if (timedOut) throw new ApiError("请求超时，请检查 Tailscale 连接", { code: "timeout" });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (externalSignal && abortListener) externalSignal.removeEventListener("abort", abortListener);
  }
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 180)}px`;
}

function persistDraft() {
  if (!state.draftThreadId) return null;
  const snapshot = drafts.save(state.draftThreadId, elements.messageInput.value);
  elements.draftStatus.textContent = !drafts.persistent ? "浏览器存储不可用，草稿暂存在此页"
    : snapshot.text || snapshot.attachments?.length ? "草稿已保存" : "";
  return snapshot;
}

function acknowledgeDraft(threadId, snapshot) {
  if (!drafts.acknowledge(threadId, snapshot)) return;
  images.cleanup(snapshot.attachments);
  if (state.draftThreadId === threadId) {
    elements.messageInput.value = "";
    images.render(elements.imageAttachments, threadId);
    resizeComposer();
    elements.draftStatus.textContent = "";
  }
}

function saveReadingPosition() {
  if (!state.renderedThreadId || state.currentThread?.id !== state.renderedThreadId) return;
  const position = captureReadingPosition(elements.messages);
  readingPositions.save(state.renderedThreadId, { ...position, atBottom: position.atBottom && !state.history?.hasLater });
}

function updateReadingState() {
  if (!state.renderedThreadId) return;
  const atBottom = isNearMessageBottom() && !state.history?.hasLater;
  if (atBottom) state.unseenItems = false;
  elements.latestButton.classList.toggle("hidden", atBottom);
  elements.latestButton.textContent = state.unseenItems ? "有新回复 · 跳到最新 ↓" : "回到最新 ↓";
  saveReadingPosition();
  const thread = state.currentThread;
  if (atBottom && state.threadFresh && document.visibilityState === "visible" && thread?.hasUnreadActivity && thread.activityCompletionKey) {
    void markThreadRead(thread.id, thread.activityCompletionKey);
  }
}

function showThreadNotice(text, retry = false) {
  elements.threadNotice.replaceChildren();
  elements.threadNotice.classList.toggle("hidden", !text);
  if (!text) return;
  const label = document.createElement("span");
  label.textContent = text;
  elements.threadNotice.append(label);
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "重试同步";
    button.addEventListener("click", () => { if (state.currentThread) void openThread(state.currentThread.id, { navigation: "none" }); });
    elements.threadNotice.append(button);
  }
}

function autoDismissConfirmedStatus(record) {
  // A fork can succeed while its first message fails; that needs explicit attention.
  if (record.status !== "confirmed" || !record.applied || record.result?.sendError) return false;
  const remaining = (record.confirmedAt || record.updatedAt || Date.now()) + CONFIRMED_STATUS_DURATION_MS - Date.now();
  if (remaining <= 0) {
    operations.save({ ...record, status: "dismissed" });
    return true;
  }
  if (confirmedStatusTimers.get(record.key)?.id === record.id) return false;
  const previous = confirmedStatusTimers.get(record.key);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    confirmedStatusTimers.delete(record.key);
    const current = operations.get(record.key);
    if (current?.id === record.id && current.status === "confirmed" && current.applied && !current.result?.sendError) {
      writes.update(current, { status: "dismissed" });
    }
  }, remaining);
  confirmedStatusTimers.set(record.key, { id: record.id, timer });
  return false;
}

function renderWriteStatus() {
  const position = state.renderedThreadId ? captureReadingPosition(elements.messages) : null;
  const selected = new Map(operations.pending().map((record) => [record.key, record]));
  for (const key of [state.currentThread?.id, "__new__"]) {
    const record = key && operations.get(key);
    if (record && record.status !== "dismissed") selected.set(key, record);
  }
  for (const [key, record] of selected) {
    if (autoDismissConfirmedStatus(record)) selected.delete(key);
  }
  elements.requestTray.replaceChildren();
  elements.requestTray.classList.toggle("hidden", selected.size === 0);
  const labels = {
    pending: "正在等待服务端确认…", checking: "连接中断，正在核对结果", not_received: "服务端尚未收到，可使用原请求重试",
    unknown: "执行结果待核对，请先查看会话；不会自动重发", confirmed: "已确认送达", failed: "请求失败",
  };
  for (const record of selected.values()) {
    const row = document.createElement("div");
    row.className = "request-status";
    row.dataset.requestId = record.id;
    row.dataset.status = record.status;
    const label = document.createElement("span");
    const title = record.key === "__new__" ? "新建会话" : threadTitle(state.threadStore.get(record.key) || record.context.source || {});
    label.textContent = `${title}：${labels[record.status] || record.status}${record.status === "failed" && record.error?.message ? ` · ${record.error.message}` : ""}`;
    if (record.result?.sendError) label.textContent = `${title}：副本已创建，首条消息未获确认，请在副本中核对`;
    row.append(label);
    const button = (text, action) => {
      const node = document.createElement("button");
      node.type = "button";
      node.textContent = text;
      node.addEventListener("click", async () => {
        node.disabled = true;
        try { await action(); } catch (error) { showToast(error.message); }
        finally { node.disabled = false; updateComposerState(); }
      });
      row.append(node);
    };
    if (["checking", "pending", "unknown", "not_received"].includes(record.status)) button("核对结果", () => writes.check(record.key));
    if (record.status === "not_received") button("重试原请求", () => writes.retry(record.key));
    const targetId = record.result?.thread?.id || record.context.source?.id;
    if (targetId && (targetId !== state.currentThread?.id || record.status === "unknown")) button("查看会话", () => openThread(targetId));
    if (["confirmed", "failed", "unknown"].includes(record.status)) button(record.status === "unknown" ? "已核对，结束跟踪" : "收起", () => {
      writes.update(record, { status: "dismissed" });
    });
    elements.requestTray.append(row);
  }
  if (position) restoreReadingPosition(elements.messages, position);
  const request = operations.get(state.currentThread?.id);
  elements.sendButton.disabled = images.list(state.currentThread?.id).some((item) => item.status !== "ready") || !state.currentThread || Boolean(state.openingThreadId)
    || state.sendingThreads.has(state.currentThread?.id)
    || Boolean(request && !["confirmed", "failed", "dismissed"].includes(request.status));
}

async function applyConfirmedOperation(record, result) {
  const { source, snapshot, settings = {}, permission } = record.context;
  if (!result.thread?.id) {
    if (source?.id) acknowledgeDraft(source.id, snapshot);
    return;
  }
  const threadId = result.thread.id;
  state.allThreads = state.threadStore.upsertOptimistic({
    ...result.thread,
    id: threadId,
    name: result.thread.name || result.thread.title || "新会话",
    preview: result.thread.preview || "新会话",
    permission,
  });
  saveThreadPermission(permission, threadId);
  if (settings.model) {
    state.threadSettings[threadId] = settings;
    try { localStorage.setItem("codex-pocket-thread-settings", JSON.stringify(state.threadSettings)); } catch { /* Memory settings remain usable. */ }
  }
  if (source?.id) {
    if (!result.sendError) acknowledgeDraft(source.id, snapshot);
    else if (!drafts.get(threadId)?.text && !drafts.get(threadId)?.attachments?.length) drafts.save(threadId, snapshot?.text || record.body.text || "", snapshot?.attachments || []);
  }
  applyThreadFilter();
  if (record.key === "__new__") elements.newThreadDialog.close();
  const mayNavigate = record.key === "__new__"
    ? (state.currentThread?.id || null) === (record.context.openThreadId || null)
    : state.currentThread?.id === source?.id;
  if (mayNavigate) await openThread(threadId, record.key === "__new__" ? { initialResult: result } : {});
  void loadThreads({ silent: true });
}

async function checkPendingOperations() {
  await Promise.allSettled(operations.pending().map((record) => writes.check(record.key)));
  renderWriteStatus();
}

function confirmFork() {
  elements.writerDialog.returnValue = "";
  return new Promise((resolve) => {
    elements.writerDialog.addEventListener(
      "close",
      () => resolve(elements.writerDialog.returnValue === "fork"),
      { once: true },
    );
    elements.writerDialog.showModal();
  });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2_500);
}

function setThreadIdentity(threadId) {
  const value = String(threadId || "");
  clearTimeout(state.copyThreadIdTimer);
  state.copyThreadIdTimer = null;
  elements.threadId.textContent = value || "—";
  elements.threadId.title = value;
  elements.copyThreadIdButton.dataset.threadId = value;
  elements.copyThreadIdButton.textContent = "复制";
  elements.copyThreadIdButton.disabled = !value;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Older installed PWAs may require the selection-based fallback.
    }
  }
  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  let copied = false;
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus();
  }
  if (!copied) throw new Error("Clipboard is unavailable");
}

function setConnection(status, label) {
  elements.connectionStatus.dataset.status = status;
  elements.connectionStatus.textContent = label;
}

function closeSidebar() {
  elements.sidebar.classList.remove("open");
  elements.sidebarScrim.classList.remove("open");
}

function routeThreadId() {
  return new URL(location.href).searchParams.get("thread");
}

function updateThreadRoute(threadId, { replace = false } = {}) {
  const url = new URL(location.href);
  if (threadId) url.searchParams.set("thread", threadId);
  else url.searchParams.delete("thread");
  history[replace ? "replaceState" : "pushState"]({ threadId }, "", url);
}

function closeThreadView() {
  saveReadingPosition();
  persistDraft();
  state.draftThreadId = null;
  state.renderedThreadId = null;
  state.openRequestId += 1;
  state.openAbortController?.abort();
  state.currentThread = null;
  state.openingThreadId = null;
  state.items = [];
  setThreadIdentity(null);
  elements.chatView.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  renderThreads();
}

function formatDate(seconds) {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortPath(value = "") {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) || value || "local";
}

function threadTitle(thread) {
  return thread.name || thread.preview || "未命名会话";
}

function readCollapsedProjects() {
  try {
    const value = JSON.parse(localStorage.getItem("codex-pocket-collapsed-projects") || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function arrangeThreads(threads) {
  const ordinaryThreads = [];
  const groups = new Map();
  for (const [index, thread] of threads.entries()) {
    if (!thread.projectId) {
      ordinaryThreads.push({ type: "thread", thread });
      continue;
    }
    let group = groups.get(thread.projectId);
    if (!group) {
      group = {
        type: "project",
        key: thread.projectId,
        name: thread.projectName || shortPath(thread.projectPath || thread.cwd),
        path: thread.projectPath || thread.cwd,
        order: Number.isFinite(thread.projectOrder) ? thread.projectOrder : Number.MAX_SAFE_INTEGER,
        firstIndex: index,
        threads: [],
      };
      groups.set(thread.projectId, group);
    }
    group.threads.push(thread);
  }
  const projectGroups = [...groups.values()].sort((left, right) => (
    left.order - right.order || left.firstIndex - right.firstIndex
  ));
  return [...projectGroups, ...ordinaryThreads];
}

function saveCollapsedProjects() {
  localStorage.setItem(
    "codex-pocket-collapsed-projects",
    JSON.stringify([...state.collapsedProjects]),
  );
}

function threadActivity(thread) {
  const threadId = typeof thread === "string" ? thread : thread?.id;
  const listedStatus = typeof thread === "string" ? null : thread?.status;
  const status = state.threadStatuses.get(threadId) || listedStatus || {};
  const flags = status.activeFlags || [];
  const waitingForApproval = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")
    || [...state.approvals.values()].some((request) => request.params?.threadId === threadId);

  if (waitingForApproval) return { state: "attention", label: "等待确认" };
  if (state.activeTurns.has(threadId) || status.type === "active") {
    return { state: "processing", label: "正在处理" };
  }
  if (operations.get(threadId)?.status === "failed") return { state: "error", label: "请求失败" };
  if (operations.get(threadId)?.status === "unknown") return { state: "attention", label: "结果待核对" };
  if (status.type === "systemError" || state.failedTurns.has(threadId)) return { state: "error", label: "状态异常" };
  if (status.type === "idle") return { state: "idle", label: "空闲" };
  return { state: "unknown", label: "未加载" };
}

function activityBadge(thread, className = "") {
  const badge = document.createElement("span");
  badge.className = `thread-state ${className}`.trim();
  renderActivityBadge(badge, threadActivity(thread));
  return badge;
}

function renderActivityBadge(badge, activity) {
  const spinning = activity.state === "processing" || activity.state === "loading";
  badge.dataset.state = activity.state;
  badge.hidden = activity.state === "idle" || activity.state === "unknown";
  if (spinning) {
    if (!badge.querySelector(".thread-spinner")) {
      // Desktop's compact task indicator: a faint track and a 3/4 arc.
      badge.innerHTML = '<svg class="thread-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7" opacity="0.3"/><path d="M12 5a7 7 0 1 1-7 7"/></svg>';
      // List refreshes recreate the badge; preserve the rotation phase.
      badge.firstElementChild.style.animationDelay = `-${Date.now() % 2000}ms`;
    }
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", activity.label);
    badge.title = activity.label;
  } else {
    badge.textContent = badge.hidden ? "" : activity.label;
    badge.removeAttribute("role");
    badge.removeAttribute("aria-label");
    badge.removeAttribute("title");
  }
}

function writerOwnerLabel(owner) {
  return { desktop: "Desktop", pocket: "Pocket", external: "其他端" }[owner] || "";
}

function renderWriterIndicator(indicator, owner) {
  indicator.replaceChildren();
  indicator.classList.toggle("hidden", !owner);
  if (!owner) return;
  const icon = document.createElement("span");
  icon.className = "writer-lock";
  icon.setAttribute("aria-hidden", "true");
  indicator.append(icon, document.createTextNode(writerOwnerLabel(owner)));
  indicator.setAttribute("aria-label", `${writerOwnerLabel(owner)} 正在使用此会话`);
}

function writerIndicator(threadId) {
  const owner = state.writerOccupancy.get(threadId);
  if (!owner) return null;
  const indicator = document.createElement("span");
  indicator.className = "writer-indicator";
  renderWriterIndicator(indicator, owner);
  return indicator;
}

function unreadActivityDot(label = "有新活动") {
  const dot = document.createElement("span");
  dot.className = "thread-activity-dot";
  dot.title = label;
  dot.setAttribute("aria-label", label);
  return dot;
}

function setThreadActivity(threadId, activity = {}) {
  let changed = false;
  const apply = (thread) => {
    if (!thread || thread.id !== threadId) return;
    const unread = Boolean(activity.hasUnreadActivity);
    if (thread.hasUnreadActivity !== unread) changed = true;
    thread.hasUnreadActivity = unread;
    if (activity.completionKey !== undefined) thread.activityCompletionKey = activity.completionKey;
    if (activity.completedAt !== undefined) thread.activityCompletedAt = activity.completedAt;
  };
  apply(state.threadStore.get(threadId));
  apply(state.currentThread);
  return changed;
}

function hasActivityKeyConflict(threadId, completionKey) {
  const listedKey = state.threadStore.get(threadId)?.activityCompletionKey;
  const currentKey = state.currentThread?.id === threadId
    ? state.currentThread.activityCompletionKey
    : null;
  return Boolean(
    (listedKey && listedKey !== completionKey)
    || (currentKey && currentKey !== completionKey),
  );
}

async function markThreadRead(threadId, completionKey) {
  if (!threadId || !completionKey) return;
  if (hasActivityKeyConflict(threadId, completionKey)) {
    void loadThreads({ silent: true });
    return;
  }
  const requestKey = JSON.stringify([threadId, completionKey]);
  if (state.readingActivities.has(requestKey)) return;
  state.readingActivities.add(requestKey);
  if (setThreadActivity(threadId, { hasUnreadActivity: false, completionKey })) renderThreads();
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completionKey }),
    });
  } catch (error) {
    const keyConflict = hasActivityKeyConflict(threadId, completionKey);
    if (!keyConflict) {
      if (setThreadActivity(threadId, { hasUnreadActivity: true, completionKey })) renderThreads();
    }
    if (keyConflict || error.code === "stale_completion") void loadThreads({ silent: true });
  } finally {
    state.readingActivities.delete(requestKey);
  }
}

function refreshVisibleThreadForActivity(threadId) {
  if (!threadId
    || document.visibilityState !== "visible"
    || state.currentThread?.id !== threadId
    || state.refreshingActivityThreads.has(threadId)) return;
  state.refreshingActivityThreads.add(threadId);
  void openThread(threadId, { navigation: "none" }).finally(() => {
    state.refreshingActivityThreads.delete(threadId);
  });
}

function renderCurrentThreadStatus() {
  if (!state.currentThread) return;
  renderActivityBadge(elements.threadStatus, threadActivity(state.currentThread));
  const owner = state.writerOccupancy.get(state.currentThread.id);
  renderWriterIndicator(elements.writerOwner, owner === "pocket" ? null : owner);
}

function readThreadSettings() {
  try {
    const value = JSON.parse(localStorage.getItem("codex-pocket-thread-settings") || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const permissionPresets = {
  readOnly: {
    label: "只读",
    description: "只能查看文件，不能写入；网络访问关闭。",
  },
  workspaceWrite: {
    label: "工作区写入",
    description: "可修改当前项目；敏感操作仍会请求确认。",
  },
  dangerFullAccess: {
    label: "完全访问",
    description: "不询问确认，可访问并修改电脑上的所有文件。",
  },
};

function currentPermission() {
  const threadId = state.currentThread?.id;
  const transient = threadId ? state.threadPermissions[threadId] : null;
  if (permissionPresets[transient]) return transient;
  return permissionPresets[state.currentThread?.permission]
    ? state.currentThread.permission
    : "workspaceWrite";
}

function saveThreadPermission(permission, threadId = state.currentThread?.id) {
  if (!threadId || !permissionPresets[permission]) return;
  state.threadPermissions[threadId] = permission;
  const listed = state.allThreads.find((thread) => thread.id === threadId);
  if (listed) listed.permission = permission;
  if (state.currentThread?.id === threadId) state.currentThread.permission = permission;
}

function renderPermissionControl() {
  const permission = currentPermission();
  elements.permissionButton.textContent = `权限：${permissionPresets[permission].label}`;
  elements.permissionButton.disabled = !state.currentThread;
}

function updateNewThreadPermissionDescription() {
  const preset = permissionPresets[elements.newThreadPermission.value]
    || permissionPresets.workspaceWrite;
  elements.newThreadPermissionDescription.textContent = preset.description;
}

function openNewThreadDialog({ cwd = null, projectName = null } = {}) {
  const automaticCwd = cwd || state.currentThread?.cwd || state.allThreads.find((thread) => thread.cwd)?.cwd || "";
  state.newThreadCwd = automaticCwd;
  elements.newThreadCwd.value = automaticCwd;
  elements.newThreadTarget.textContent = automaticCwd
    ? `${projectName ? `将在项目“${projectName}”中` : "将自动使用当前项目"}创建会话：${automaticCwd}`
    : "将自动使用 Codex 的默认工作目录创建会话";
  elements.newThreadPermission.value = "workspaceWrite";
  updateNewThreadPermissionDescription();
  elements.newThreadDialog.showModal();
  requestAnimationFrame(() => elements.newThreadSubmit.focus());
}

function currentThreadSettings() {
  const saved = state.currentThread
    ? state.threadSettings[state.currentThread.id] || {}
    : {};
  const threadModel = state.currentThread?.model || "";
  const threadEffort = state.currentThread?.reasoningEffort || state.currentThread?.effort || "";
  const preferredModel = threadModel || saved.model;
  const selectedModel = state.models.find((model) => model.model === preferredModel)
    || (preferredModel ? {
      model: preferredModel,
      defaultReasoningEffort: threadEffort || saved.effort || "",
      supportedReasoningEfforts: [],
    } : null)
    || state.models.find((model) => model.model === state.modelDefaults.model)
    || state.models.find((model) => model.isDefault)
    || state.models[0]
    || null;
  if (!selectedModel) return { model: "", effort: "" };

  const efforts = selectedModel.supportedReasoningEfforts || [];
  const preferredEffort = threadEffort
    || saved.effort
    || (selectedModel.model === state.modelDefaults.model ? state.modelDefaults.effort : "")
    || selectedModel.defaultReasoningEffort;
  const selectedEffort = efforts.find((option) => option.reasoningEffort === preferredEffort)
    || efforts[0]
    || null;
  return {
    model: selectedModel.model,
    effort: selectedEffort?.reasoningEffort || preferredEffort || "",
  };
}

function saveThreadSettings(settings) {
  if (!state.currentThread) return;
  state.currentThread.model = settings.model;
  state.currentThread.reasoningEffort = settings.effort;
  state.threadSettings[state.currentThread.id] = settings;
  localStorage.setItem("codex-pocket-thread-settings", JSON.stringify(state.threadSettings));
}

const effortLabels = {
  none: "无",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极高",
};

function addOption(select, value, label, title = "") {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  if (title) option.title = title;
  select.append(option);
}

function renderModelControls() {
  const settings = currentThreadSettings();
  const active = Boolean(state.currentThread && state.activeTurns.get(state.currentThread.id));
  elements.modelSelect.replaceChildren();

  if (!state.models.length) {
    addOption(elements.modelSelect, "", "模型不可用");
    elements.modelSelect.disabled = true;
  } else {
    if (settings.model && !state.models.some((model) => model.model === settings.model)) {
      addOption(elements.modelSelect, settings.model, `${settings.model} · 会话原模型`);
    }
    for (const model of state.models) {
      addOption(
        elements.modelSelect,
        model.model,
        `${model.displayName || model.model}${model.model === state.modelDefaults.model ? " · 系统默认" : ""}`,
        model.description || "",
      );
    }
    elements.modelSelect.value = settings.model;
    elements.modelSelect.disabled = !state.currentThread || active;
  }

  elements.effortSelect.replaceChildren();
  const selectedModel = state.models.find((model) => model.model === elements.modelSelect.value)
    || (elements.modelSelect.value === settings.model ? {
      defaultReasoningEffort: settings.effort,
      supportedReasoningEfforts: settings.effort
        ? [{ reasoningEffort: settings.effort, description: "当前会话使用的思考深度" }]
        : [],
    } : null);
  if (!selectedModel) {
    addOption(elements.effortSelect, "", "模型不可用");
    elements.effortSelect.disabled = true;
    return;
  }

  const efforts = selectedModel.supportedReasoningEfforts?.length
    ? selectedModel.supportedReasoningEfforts
    : selectedModel.defaultReasoningEffort
      ? [{ reasoningEffort: selectedModel.defaultReasoningEffort, description: "" }]
      : [];
  for (const option of efforts) {
    addOption(
      elements.effortSelect,
      option.reasoningEffort,
      effortLabels[option.reasoningEffort] || option.reasoningEffort,
      option.description || "",
    );
  }
  elements.effortSelect.value = settings.effort;
  elements.effortSelect.disabled = !state.currentThread || active || !efforts.length;
}

async function loadModels(cwd = null, expectedThreadId = null) {
  const cacheKey = cwd || "";
  const cached = state.modelCache.get(cacheKey);
  if (cached) {
    state.models = cached.data || [];
    state.modelDefaults = {
      model: cached.defaultModel || "",
      effort: cached.defaultEffort || "",
    };
    updateComposerState();
    return;
  }
  try {
    const query = new URLSearchParams();
    if (cwd) query.set("cwd", cwd);
    const result = await api(`/api/models?${query}`);
    if (expectedThreadId && state.currentThread?.id !== expectedThreadId) return;
    state.models = result.data || [];
    state.modelDefaults = {
      model: result.defaultModel || "",
      effort: result.defaultEffort || "",
    };
    state.modelCache.set(cacheKey, result);
  } catch (error) {
    if (expectedThreadId && state.currentThread?.id !== expectedThreadId) return;
    state.models = [];
    showToast(`模型列表加载失败：${error.message}`);
  }
  updateComposerState();
}

function applyThreadFilter() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase();
  state.threads = query
    ? state.allThreads.filter((thread) => [threadTitle(thread), thread.preview, thread.cwd]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)))
    : [...state.allThreads];
  renderThreads();
}

async function loadThreads({ silent = false } = {}) {
  const requestId = ++state.threadListRequestId;
  state.threadListAbortController?.abort();
  const controller = new AbortController();
  state.threadListAbortController = controller;
  if (!silent && !state.allThreads.length) {
    elements.threadList.innerHTML = '<p class="thread-empty">正在加载…</p>';
  }
  const query = new URLSearchParams();
  const archived = elements.archiveCheckbox.checked;
  if (archived) query.set("archived", "true");
  try {
    const result = await api(`/api/threads?${query}`, { signal: controller.signal });
    if (requestId !== state.threadListRequestId
      || archived !== elements.archiveCheckbox.checked) return;
    state.allThreads = state.threadStore.replaceCanonical(result.data || [], {
      archived,
    });
    if (state.currentThread) {
      const listedCurrent = state.allThreads.find((thread) => thread.id === state.currentThread.id);
      if (listedCurrent?.permission) {
        delete state.threadPermissions[state.currentThread.id];
        state.currentThread.permission = listedCurrent.permission;
      }
    }
    for (const thread of state.allThreads) {
      if (thread.status) state.threadStatuses.set(thread.id, thread.status);
    }
    applyThreadFilter();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (!silent) elements.threadList.innerHTML = `<p class="thread-empty">${escapeText(error.message)}</p>`;
  }
}

async function refreshThreadStatuses() {
  try {
    const result = await api("/api/thread-statuses");
    const nextOccupancy = new Map(Object.entries(result.writerOccupancy || {}));
    const occupancyChanged = nextOccupancy.size !== state.writerOccupancy.size
      || [...nextOccupancy].some(([id, owner]) => state.writerOccupancy.get(id) !== owner);
    state.writerOccupancy = nextOccupancy;
    let changed = false;
    for (const [threadId, status] of Object.entries(result.data || {})) {
      if (state.activeTurns.has(threadId)) continue;
      const previousStatus = state.threadStatuses.get(threadId);
      if (previousStatus?.type !== status?.type
        || previousStatus?.completionKey !== status?.completionKey) changed = true;
      state.threadStatuses.set(threadId, status);
      const listed = state.allThreads.find((thread) => thread.id === threadId);
      if (listed) listed.status = status;
      if (state.currentThread?.id === threadId) state.currentThread.status = status;
    }
    let permissionChanged = false;
    for (const [threadId, permission] of Object.entries(result.permissions || {})) {
      if (!permissionPresets[permission] || state.threadPermissions[threadId]) continue;
      const listed = state.allThreads.find((thread) => thread.id === threadId);
      if (listed && listed.permission !== permission) {
        listed.permission = permission;
        permissionChanged = true;
      }
      if (state.currentThread?.id === threadId && state.currentThread.permission !== permission) {
        state.currentThread.permission = permission;
        permissionChanged = true;
      }
    }
    let activityChanged = false;
    for (const [threadId, activity] of Object.entries(result.activities || {})) {
      const isVisibleCurrent = document.visibilityState === "visible"
        && state.currentThread?.id === threadId
        && !state.openingThreadId;
      if (setThreadActivity(threadId, activity)) activityChanged = true;
      if (isVisibleCurrent && activity?.hasUnreadActivity && activity.completionKey) {
        refreshVisibleThreadForActivity(threadId);
      }
    }
    if (changed || activityChanged || occupancyChanged) {
      renderThreads();
      renderCurrentThreadStatus();
      if (occupancyChanged) updateComposerState();
    }
    if (permissionChanged) renderPermissionControl();
  } catch {
    // The event stream handles reconnect state; status polling is best effort.
  }
}

function needsAttention(thread) {
  return ["attention", "error"].includes(threadActivity(thread).state) || thread.hasUnreadActivity;
}

function renderThreads() {
  const count = state.allThreads.filter(needsAttention).length;
  elements.attentionFilter.textContent = `待处理 · ${count}`;
  elements.attentionFilter.setAttribute("aria-pressed", String(state.attentionOnly));
  const visibleThreads = state.attentionOnly ? state.threads.filter(needsAttention) : state.threads;
  elements.threadList.replaceChildren();
  if (!visibleThreads.length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = state.attentionOnly ? "暂无待处理会话" : "没有找到会话";
    elements.threadList.append(empty);
    return;
  }
  const searching = state.attentionOnly || Boolean(elements.searchInput.value.trim());
  for (const entry of arrangeThreads(visibleThreads)) {
    if (entry.type === "thread") {
      elements.threadList.append(threadCard(entry.thread));
      continue;
    }
    const group = entry;
    const section = document.createElement("section");
    section.className = "project-group";

    const header = document.createElement("div");
    header.className = "project-header";
    const expanded = searching || !state.collapsedProjects.has(group.key);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "project-toggle";
    toggle.title = group.path || group.name;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.disabled = searching;

    const chevron = document.createElement("span");
    chevron.className = "project-chevron";
    chevron.textContent = "›";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = group.name;
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = String(group.threads.length);
    toggle.append(chevron, name);
    if (group.threads.some((thread) => thread.hasUnreadActivity)) {
      toggle.append(unreadActivityDot("项目中有新活动"));
    }
    toggle.append(count);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "project-add";
    add.textContent = "+";
    add.title = `在项目“${group.name}”中创建会话`;
    add.setAttribute("aria-label", `在项目“${group.name}”中创建会话`);
    add.disabled = searching;

    const body = document.createElement("div");
    body.className = "project-threads";
    body.hidden = !expanded;
    for (const thread of group.threads) body.append(threadCard(thread));

    toggle.addEventListener("click", () => {
      if (state.collapsedProjects.has(group.key)) state.collapsedProjects.delete(group.key);
      else state.collapsedProjects.add(group.key);
      saveCollapsedProjects();
      renderThreads();
    });
    add.addEventListener("click", () => openNewThreadDialog({ cwd: group.path, projectName: group.name }));
    header.append(toggle, add);
    section.append(header, body);
    elements.threadList.append(section);
  }
}

function threadCard(thread) {
  const button = document.createElement("button");
  button.className = "thread-card";
  if (state.currentThread?.id === thread.id || state.openingThreadId === thread.id) {
    button.classList.add("active");
  }

  const heading = document.createElement("span");
  heading.className = "thread-card-heading";
  const title = document.createElement("span");
  title.className = "thread-card-title";
  title.textContent = threadTitle(thread);
  heading.append(title);
  if (thread.hasUnreadActivity) heading.append(unreadActivityDot());
  heading.append(activityBadge(thread));
  const indicator = writerIndicator(thread.id);
  if (indicator) heading.append(indicator);

  const preview = document.createElement("span");
  preview.className = "thread-card-preview";
  preview.textContent = thread.preview || "本地 Codex 会话";

  const meta = document.createElement("span");
  meta.className = "thread-card-meta";
  const date = document.createElement("span");
  date.textContent = formatDate(thread.recencyAt || thread.updatedAt || thread.createdAt);
  meta.append(date);

  button.append(heading, preview, meta);
  button.addEventListener("click", () => openThread(thread.id));
  return button;
}

function readCachedThread(threadId) {
  try {
    const cached = JSON.parse(sessionStorage.getItem(`${THREAD_CACHE_PREFIX}${threadId}`) || "null");
    return cached?.result?.thread?.id === threadId ? cached.result : null;
  } catch {
    return null;
  }
}

function cacheThreadResult(threadId, result) {
  const key = `${THREAD_CACHE_PREFIX}${threadId}`;
  let index;
  try {
    index = JSON.parse(sessionStorage.getItem(THREAD_CACHE_INDEX) || "[]");
    if (!Array.isArray(index)) index = [];
  } catch {
    index = [];
  }
  index = [threadId, ...index.filter((id) => id !== threadId)];
  const evicted = index.slice(MAX_SESSION_THREADS);
  index = index.slice(0, MAX_SESSION_THREADS);
  try {
    sessionStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), result }));
    sessionStorage.setItem(THREAD_CACHE_INDEX, JSON.stringify(index));
    for (const evictedThreadId of evicted) sessionStorage.removeItem(`${THREAD_CACHE_PREFIX}${evictedThreadId}`);
  } catch {
    for (const oldThreadId of index.slice(1).reverse()) {
      sessionStorage.removeItem(`${THREAD_CACHE_PREFIX}${oldThreadId}`);
      try {
        sessionStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), result }));
        sessionStorage.setItem(THREAD_CACHE_INDEX, JSON.stringify([threadId]));
        return;
      } catch {
        // Continue evicting until the current compact thread fits.
      }
    }
  }
}

async function openThread(threadId, { navigation = "push", initialResult = null, latest = false } = {}) {
  saveReadingPosition();
  persistDraft();
  const sameThread = state.renderedThreadId === threadId && state.currentThread?.id === threadId;
  if (state.draftThreadId !== threadId) {
    state.draftThreadId = threadId;
    elements.messageInput.value = drafts.get(threadId)?.text || "";
    images.render(elements.imageAttachments, threadId);
    images.resume(threadId);
    elements.draftStatus.textContent = elements.messageInput.value || images.list(threadId).length ? "草稿已恢复" : "";
    resizeComposer();
  }
  if (!sameThread) {
    state.visibleItemLimit = 100;
    state.lastSyncedAt = null;
    state.unseenItems = false;
    elements.latestButton.classList.add("hidden");
  }
  const requestId = ++state.openRequestId;
  state.openAbortController?.abort();
  const controller = new AbortController();
  state.openAbortController = controller;
  if (navigation === "push") updateThreadRoute(threadId);
  if (navigation === "replace") updateThreadRoute(threadId, { replace: true });
  closeSidebar();
  elements.emptyState.classList.add("hidden");
  elements.chatView.classList.remove("hidden");
  setThreadIdentity(threadId);
  const cached = initialResult || readCachedThread(threadId);
  let modelsStarted = sameThread;
  state.openingThreadId = sameThread ? null : threadId;
  state.threadFresh = false;
  showThreadNotice(sameThread ? "正在同步…" : cached ? "已显示缓存，正在同步…" : "");

  const showResult = (result) => {
    if (requestId !== state.openRequestId || !result?.thread) return;
    let listed = state.threadStore.get(threadId);
    if (!listed) {
      state.allThreads = state.threadStore.upsertOptimistic({
        id: threadId,
        name: result.thread.name || result.thread.title || result.thread.preview || "未命名会话",
        preview: result.thread.preview || result.thread.name || result.thread.title || "新会话",
        cwd: result.thread.cwd || "",
        permission: result.thread.permission || "workspaceWrite",
        status: result.thread.status || { type: "notLoaded" },
      });
      listed = state.threadStore.get(threadId);
    }
    state.openingThreadId = null;
    state.currentThread = {
      ...result.thread,
      ...(listed ? {
        name: result.thread.name || result.thread.title || listed.name,
        preview: result.thread.preview || listed.preview,
        cwd: result.thread.cwd || listed.cwd,
        createdAt: result.thread.createdAt || listed.createdAt,
        updatedAt: result.thread.updatedAt || listed.updatedAt,
        recencyAt: result.thread.recencyAt || listed.recencyAt,
        projectId: listed.projectId,
        projectName: listed.projectName,
        projectPath: listed.projectPath,
        projectOrder: listed.projectOrder,
        isPinned: listed.isPinned,
        permission: listed.permission,
        status: state.threadStatuses.get(threadId) || result.thread.status,
      } : {}),
    };
    if (state.currentThread.status) state.threadStatuses.set(threadId, state.currentThread.status);
    const latestTurn = state.currentThread.turns?.at(-1);
    if (latestTurn?.status === "failed") state.failedTurns.add(threadId);
    else if (latestTurn?.status === "completed") state.failedTurns.delete(threadId);
    const nextItems = flattenHistory(state.currentThread).slice(-MAX_VISIBLE_ITEMS);
    state.history = result.history || null;
    if (result.history) state.visibleItemLimit = MAX_VISIBLE_ITEMS;
    state.historyLoading = false;
    if (state.renderedThreadId === threadId && JSON.stringify(state.items) !== JSON.stringify(nextItems) && !isNearMessageBottom()) state.unseenItems = true;
    state.items = nextItems;
    inferActiveTurn(state.currentThread);
    applyThreadFilter();
    renderThread();
    if (latest) { elements.messages.scrollTop = elements.messages.scrollHeight; updateReadingState(); }
    if (!modelsStarted) {
      modelsStarted = true;
      void loadModels(state.currentThread.cwd || null, threadId);
    }
  };

  if (cached && !sameThread) showResult(cached);
  else if (!sameThread) {
    const listed = state.threadStore.get(threadId);
    state.currentThread = null;
    elements.writerOwner.classList.add("hidden");
    state.renderedThreadId = null;
    state.items = [];
    state.history = null;
    elements.threadTitle.textContent = listed ? threadTitle(listed) : "正在读取会话…";
    elements.threadPath.textContent = listed?.cwd || threadId;
    renderActivityBadge(elements.threadStatus, { state: "loading", label: "正在加载" });
    elements.messages.innerHTML = '<p class="thread-empty">正在读取会话…</p>';
    elements.approvalTray.classList.add("hidden");
    renderThreads();
    updateComposerState();
  }

  // thread/start already returns an authoritative empty thread. Reading it
  // again immediately can race the rollout being materialized by App Server.
  if (initialResult) {
    cacheThreadResult(threadId, initialResult);
    state.threadFresh = true;
    state.lastSyncedAt = Date.now();
    showThreadNotice("");
    return true;
  }

  try {
    const position = latest ? null : readingPositions.get(threadId);
    const query = new URLSearchParams({ limit: position && !position.atBottom ? String(MAX_VISIBLE_ITEMS) : "100" });
    if (position && !position.atBottom && position.itemId) query.set("around", position.itemId);
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}?${query}`, {
      signal: controller.signal,
    });
    cacheThreadResult(threadId, result);
    if (requestId !== state.openRequestId) return false;
    state.threadFresh = true;
    state.lastSyncedAt = Date.now();
    showThreadNotice("");
    showResult(result);
    if (requestId === state.openRequestId && document.visibilityState === "visible") {
      const completionKey = state.currentThread?.activityCompletionKey;
      if (state.currentThread?.hasUnreadActivity && completionKey && isNearMessageBottom() && !state.history?.hasLater) {
        void markThreadRead(threadId, completionKey);
      }
    }
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (requestId === state.openRequestId) state.openingThreadId = null;
    if (error.status === 404 && requestId === state.openRequestId) {
      state.allThreads = state.threadStore.remove(threadId);
      applyThreadFilter();
      if (routeThreadId() === threadId) updateThreadRoute(null, { replace: true });
      if (requestId === state.openRequestId) closeThreadView();
    }
    if (requestId === state.openRequestId && error.status !== 404 && (cached || sameThread)) {
      const time = state.lastSyncedAt ? `，上次同步 ${new Date(state.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
      showThreadNotice(`同步失败，已保留现有内容${time}`, true);
    } else if (requestId === state.openRequestId && error.status !== 404) {
      renderActivityBadge(elements.threadStatus, { state: "error", label: "读取失败" });
      elements.messages.replaceChildren();
      const message = document.createElement("p");
      message.className = "thread-empty";
      message.textContent = "会话读取失败，请重试。";
      const detail = document.createElement("p");
      detail.className = "thread-empty thread-error-detail";
      detail.textContent = error.message || "未知错误";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary-button thread-retry-button";
      retry.textContent = "重试加载";
      retry.addEventListener("click", () => { void openThread(threadId, { navigation: "none" }); });
      elements.messages.append(message, detail, retry);
    }
    updateComposerState();
    if (!cached && requestId === state.openRequestId) showToast(error.message);
    return false;
  }
  return true;
}

function isVisibleItem(item) {
  return item && item.type !== "reasoning" && item.type !== "hookPrompt";
}

function inferActiveTurn(thread) {
  if (thread.pocketActiveTurnId) state.activeTurns.set(thread.id, thread.pocketActiveTurnId);
  else state.activeTurns.delete(thread.id);
  updateComposerState();
}

async function loadHistory(direction) {
  if (state.historyLoading || !state.currentThread) return;
  const threadId = state.currentThread.id;
  const requestId = state.openRequestId;
  const cursor = direction === "before" ? state.history?.beforeCursor : state.history?.afterCursor;
  if (!cursor) return;
  state.historyLoading = true; renderThread();
  try {
    const query = new URLSearchParams({ limit: "100", [direction]: cursor });
    const page = await api(`/api/threads/${encodeURIComponent(threadId)}?${query}`);
    if (state.currentThread?.id !== threadId || requestId !== state.openRequestId) return;
    const next = mergeHistory({ items: state.items, history: state.history }, page, direction);
    state.items = next.items; state.history = next.history; state.visibleItemLimit = MAX_VISIBLE_ITEMS;
    state.currentThread = threadWithItems({ ...state.currentThread, turns: [...(state.currentThread.turns || []), ...(page.thread.turns || [])] }, state.items);
    cacheThreadResult(threadId, { thread: state.currentThread, history: state.history });
    renderThread();
  } catch (error) { if (state.currentThread?.id === threadId) showToast(error.message); }
  finally { if (state.currentThread?.id === threadId && requestId === state.openRequestId) { state.historyLoading = false; renderThread(); } }
}

function renderThread() {
  const thread = state.currentThread;
  if (!thread) return;
  const sameThread = state.renderedThreadId === thread.id;
  const position = sameThread ? captureReadingPosition(elements.messages) : readingPositions.get(thread.id);
  setThreadIdentity(thread.id);
  elements.threadTitle.textContent = threadTitle(thread);
  elements.threadPath.textContent = thread.cwd || thread.id;
  renderCurrentThreadStatus();
  if (!sameThread) {
    elements.messages.replaceChildren();
    state.itemElements.clear();
    state.itemSignatures.clear();
  }
  state.renderedThreadId = thread.id;
  state.pendingItemRenders.clear();
  if (state.itemRenderFrame) cancelAnimationFrame(state.itemRenderFrame);
  state.itemRenderFrame = null;
  const anchorIndex = position?.itemId ? state.items.findIndex((item) => item.id === position.itemId) : -1;
  if (anchorIndex >= 0) state.visibleItemLimit = Math.min(MAX_VISIBLE_ITEMS, Math.max(state.visibleItemLimit, state.items.length - anchorIndex + 5));
  const visible = state.items.slice(-state.visibleItemLimit);
  const visibleIds = new Set(visible.map((item) => item.id));
  for (const [id, node] of state.itemElements) {
    if (!visibleIds.has(id)) { node.remove(); state.itemElements.delete(id); state.itemSignatures.delete(id); }
  }
  elements.messages.querySelectorAll('.thread-empty, .thread-retry-button, .load-earlier, .load-later').forEach((node) => node.remove());
  if (visible.length < state.items.length || state.history?.hasEarlier) {
    const earlier = document.createElement("button");
    earlier.type = "button";
    earlier.className = "secondary-button load-earlier";
    earlier.textContent = state.historyLoading ? "正在加载…" : "加载更早的消息";
    earlier.disabled = state.historyLoading;
    earlier.addEventListener("click", () => {
      if (visible.length < state.items.length) { state.visibleItemLimit = Math.min(MAX_VISIBLE_ITEMS, state.visibleItemLimit + 100); renderThread(); }
      else void loadHistory("before");
    });
    elements.messages.prepend(earlier);
  }
  for (const item of visible) {
    const signature = JSON.stringify(item);
    let node = state.itemElements.get(item.id);
    if (!node || state.itemSignatures.get(item.id) !== signature) {
      const wasOpen = node instanceof HTMLDetailsElement && node.open;
      const openFiles = [...(node?.querySelectorAll(".file-diff[open] summary") || [])].map((summary) => summary.textContent);
      const next = renderItem(item);
      for (const file of next.querySelectorAll(".file-diff")) if (openFiles.includes(file.querySelector("summary").textContent)) file.open = true;
      if (wasOpen && next instanceof HTMLDetailsElement) next.open = true;
      node?.replaceWith(next);
      node = next;
      state.itemElements.set(item.id, node);
      state.itemSignatures.set(item.id, signature);
    }
    elements.messages.append(node);
  }
  if (state.history?.hasLater) {
    const later = document.createElement("button"); later.className = "secondary-button load-later";
    later.textContent = state.historyLoading ? "正在加载…" : "加载后面的消息"; later.disabled = state.historyLoading;
    later.onclick = () => void loadHistory("after"); elements.messages.append(later);
  }
  if (!state.items.length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "这个会话还没有消息";
    elements.messages.append(empty);
  }
  restoreReadingPosition(elements.messages, position);
  updateReadingState();
  renderApprovals();
  updateComposerState();
}

function renderItem(item) {
  let node;
  if (item.type === "userMessage") {
    node = messageElement("user", "You", (item.content || []).map(inputText).filter(Boolean).join("\n"));
    for (const input of item.content || []) {
      if (!/^\/api\/images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(input.imageUrl || "")) continue;
      const link = document.createElement("a"); link.href = input.imageUrl; link.target = "_blank"; link.rel = "noopener";
      const image = document.createElement("img"); image.src = input.imageUrl; image.alt = "消息附图"; image.loading = "lazy"; image.className = "message-image";
      link.append(image); node.querySelector(".message-body").append(link);
    }
  } else if (item.type === "agentMessage") {
    node = messageElement("agent", "Codex", item.text || "");
  } else if (item.type === "commandExecution") {
    node = toolElement(`$ ${item.command} · ${item.status || "running"}${item.exitCode != null ? ` · 退出码 ${item.exitCode}` : ""}${item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ""}`, `${item.outputTruncated ? "[仅显示最后 20,000 个字符]\n" : ""}${item.aggregatedOutput || item.cwd || ""}`);
  } else if (item.type === "fileChange") {
    const threadId = state.currentThread?.id;
    node = fileDiffElement(item, (index) => api(`/api/threads/${encodeURIComponent(threadId)}/items/${encodeURIComponent(item.id)}/diff?${new URLSearchParams({ turnId: item.turnId, file: String(index) })}`));
  } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    node = toolElement(`${item.type} · ${item.status || "running"}`, JSON.stringify(item, null, 2));
  } else {
    node = toolElement(item.type || "事件", item.summary || JSON.stringify(item, null, 2));
  }
  if (item.id) node.dataset.itemId = item.id;
  return node;
}

function isNearMessageBottom() {
  return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 120;
}

function scheduleItemRender(itemId) {
  if (!itemId) return;
  state.pendingItemRenders.add(itemId);
  if (state.itemRenderFrame) return;
  const stickToBottom = isNearMessageBottom();
  state.itemRenderFrame = requestAnimationFrame(() => {
    state.itemRenderFrame = null;
    const pending = [...state.pendingItemRenders];
    state.pendingItemRenders.clear();
    for (const pendingId of pending) {
      const item = state.items.find((candidate) => candidate.id === pendingId);
      if (!item || !isVisibleItem(item)) continue;
      const existing = state.itemElements.get(pendingId);
      if (existing && item.type === "agentMessage") {
        const body = existing.querySelector(".message-body");
        if (body) renderMarkdownInto(body, item.text || "");
        continue;
      }
      const node = renderItem(item);
      if (existing) existing.replaceWith(node);
      else {
        elements.messages.querySelector(".thread-empty")?.remove();
        elements.messages.append(node);
      }
      state.itemElements.set(pendingId, node);
    }
    if (stickToBottom) elements.messages.scrollTop = elements.messages.scrollHeight;
    else state.unseenItems = true;
    updateReadingState();
  });
}

function inputText(input) {
  if (input.type === "text") return input.text;
  if (input.type === "image" || input.type === "localImage") return input.imageUrl ? "" : "[图片：请在电脑查看原始附件]";
  if (input.type === "audio" || input.type === "localAudio") return `[音频] ${input.url || input.path || ""}`;
  return "";
}

function messageElement(role, label, text) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;
  const heading = document.createElement("p");
  heading.className = "message-role";
  heading.textContent = label;
  const body = document.createElement("div");
  body.className = "message-body";
  renderMarkdownInto(body, text);
  wrapper.append(heading, body);
  return wrapper;
}

function toolElement(title, content) {
  const details = document.createElement("details");
  details.className = "tool-card";
  const summary = document.createElement("summary");
  summary.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = content;
  details.append(summary, pre);
  return details;
}

function updateComposerState() {
  const available = Boolean(state.currentThread) && !state.openingThreadId;
  const active = available && state.activeTurns.get(state.currentThread.id);
  const settings = currentThreadSettings();
  const model = state.models.find((candidate) => candidate.model === settings.model);
  const configuration = model
    ? `${model.displayName || model.model} · 思考${effortLabels[settings.effort] || settings.effort}`
    : "模型配置不可用";
  const permission = permissionPresets[currentPermission()].label;
  elements.stopButton.classList.toggle("hidden", !active);
  document.querySelector("#composer-options-summary").textContent = `${configuration} · ${permission}`;
  const externalOwner = state.writerOccupancy.get(state.currentThread?.id);
  elements.composerHint.textContent = !available
    ? (state.openingThreadId ? "正在读取会话，加载完成后即可发送" : "请先选择一个会话")
    : active
      ? "正在处理 · 新消息会用于调整当前回合"
      : externalOwner === "desktop" ? "Desktop 正在使用；发送冲突时可选择创建副本"
        : externalOwner === "external" ? "其他客户端正在使用；发送冲突时可选择创建副本" : "发送新回合";
  elements.messageInput.placeholder = !available
    ? "正在读取会话…"
    : active ? "追加要求或调整方向…" : "给 Codex 发送消息…";
  elements.messageInput.disabled = !available;
  const request = operations.get(state.currentThread?.id);
  const unresolved = request && !["confirmed", "failed", "dismissed"].includes(request.status);
  elements.attachImage.disabled = !available;
  runtimePanel.renderLease();
  updates.render();
  elements.sendButton.disabled = images.list(state.currentThread?.id).some((item) => item.status !== "ready") || !available || state.sendingThreads.has(state.currentThread?.id) || Boolean(unresolved);
  renderWriteStatus();
  renderModelControls();
  renderPermissionControl();
}

function upsertItem(item, turnId) {
  if (!isVisibleItem(item)) return;
  const index = state.items.findIndex((candidate) => candidate.id === item.id);
  const next = { ...item, turnId };
  if (index >= 0) state.items[index] = { ...state.items[index], ...next };
  else if (state.history?.hasLater || (state.items.length >= MAX_VISIBLE_ITEMS && !isNearMessageBottom())) {
    state.history = { ...state.history, hasLater: true, afterCursor: state.items.at(-1)?.historyCursor };
    state.unseenItems = true; updateReadingState(); return;
  } else {
    state.items.push({ ...next, historyCursor: next.historyCursor || JSON.stringify([String(turnId), String(item.id)]) });
    if (state.items.length > MAX_VISIBLE_ITEMS) {
      state.items.shift();
      state.history = { ...state.history, hasEarlier: true, beforeCursor: state.items[0]?.historyCursor };
      renderThread();
    }
  }
}

function handleCodexEvent(event) {
  if (event.kind === "snapshot") {
    const isReconnect = state.hasEventSnapshot;
    state.hasEventSnapshot = true;
    setConnection(event.status?.ready ? "online" : "idle", event.status?.ready ? "已连接" : "待机");
    state.activeTurns = new Map(Object.entries(event.status?.activeTurns || {}));
    state.threadStatuses = new Map(Object.entries(event.status?.threadStatuses || {}));
    state.approvals.clear();
    for (const approval of event.approvals || []) state.approvals.set(String(approval.id), approval.request);
    renderApprovals();
    renderThreads();
    renderCurrentThreadStatus();
    updateComposerState();
    if (isReconnect && state.currentThread && !state.openingThreadId) {
      void openThread(state.currentThread.id, { navigation: "none" });
    }
    return;
  }
  if (event.kind === "gateway") {
    const idle = event.status === "idle";
    setConnection(event.status === "ready" ? "online" : idle ? "idle" : "offline", event.status === "ready" ? "已连接" : idle ? "已释放" : "离线");
    if (event.threadId && ["idle", "stopped", "error"].includes(event.runtimeStatus)) {
      state.activeTurns.delete(event.threadId);
      state.threadStatuses.set(
        event.threadId,
        event.error ? { type: "systemError" } : { type: "idle" },
      );
      renderThreads();
      renderCurrentThreadStatus();
      updateComposerState();
      if (state.currentThread?.id === event.threadId && !state.openingThreadId) {
        setTimeout(() => {
          if (state.currentThread?.id === event.threadId
            && !state.openingThreadId
            && !state.activeTurns.has(event.threadId)) {
            void openThread(event.threadId, { navigation: "none" });
          }
        }, 150);
      }
    }
    return;
  }
  if (event.kind === "serverRequest") {
    state.approvals.set(String(event.request.id), event.request);
    renderApprovals();
    renderThreads();
    renderCurrentThreadStatus();
    return;
  }
  if (event.kind === "serverRequestResolved") {
    state.approvals.delete(String(event.requestId));
    state.approvalDrafts.delete(String(event.requestId));
    state.submittingApprovals.delete(String(event.requestId));
    renderApprovals();
    renderThreads();
    renderCurrentThreadStatus();
    return;
  }
  if (event.kind === "activityChanged" && event.threadId) {
    if (!event.hasUnreadActivity
      && event.completionKey
      && hasActivityKeyConflict(event.threadId, event.completionKey)) {
      void loadThreads({ silent: true });
      return;
    }
    const isVisibleCurrent = document.visibilityState === "visible"
      && state.currentThread?.id === event.threadId
      && !state.openingThreadId;
    const changed = setThreadActivity(event.threadId, {
      hasUnreadActivity: event.hasUnreadActivity,
      completionKey: event.completionKey,
      completedAt: event.completedAt,
    });
    if (changed) renderThreads();
    if (isVisibleCurrent && event.hasUnreadActivity && event.completionKey) {
      refreshVisibleThreadForActivity(event.threadId);
    }
    return;
  }
  if (event.kind !== "notification") return;
  const { method, params = {} } = event.message;
  const isCurrent = params.threadId && params.threadId === state.currentThread?.id;

  if (method === "thread/status/changed" && params.threadId && params.status) {
    state.threadStatuses.set(params.threadId, params.status);
    renderThreads();
    renderCurrentThreadStatus();
  }
  if (method === "thread/closed" && params.threadId) {
    state.threadStatuses.delete(params.threadId);
    renderThreads();
    renderCurrentThreadStatus();
  }

  if (method === "turn/started" && params.threadId && params.turn?.id) {
    state.failedTurns.delete(params.threadId);
    state.activeTurns.set(params.threadId, params.turn.id);
    renderThreads();
    renderCurrentThreadStatus();
    updateComposerState();
  }
  if (method === "turn/completed" && params.threadId) {
    if (params.turn?.status === "failed") state.failedTurns.add(params.threadId);
    void runtimePanel.refresh();
    const completedTurnId = params.turn?.id || null;
    const activeTurnId = state.activeTurns.get(params.threadId);
    if (!completedTurnId || !activeTurnId || activeTurnId === completedTurnId) {
      state.activeTurns.delete(params.threadId);
    }
    renderThreads();
    renderCurrentThreadStatus();
    updateComposerState();
    if (isCurrent) {
      setTimeout(() => {
        if (state.currentThread?.id === params.threadId) {
          void openThread(params.threadId, { navigation: "none" });
        }
      }, 150);
    }
    loadThreads();
  }
  if (isCurrent && (method === "item/started" || method === "item/completed") && params.item) {
    upsertItem(params.item, params.turnId);
    scheduleItemRender(params.item.id);
  }
  if (isCurrent && method === "item/agentMessage/delta") {
    let item = state.items.find((candidate) => candidate.id === params.itemId);
    if (!item) {
      item = { id: params.itemId, type: "agentMessage", text: "", turnId: params.turnId };
      upsertItem(item, params.turnId);
      item = state.items.find((candidate) => candidate.id === params.itemId);
      if (!item) return;
    }
    item.text = `${item.text || ""}${params.delta || ""}`;
    scheduleItemRender(item.id);
  }
}

let resumePromise;
function reconcileAfterResume() {
  if (resumePromise) return resumePromise;
  resumePromise = Promise.allSettled([
    checkPendingOperations(), runtimePanel.refresh(), refreshThreadStatuses(), loadThreads({ silent: true }),
    state.currentThread && !state.openingThreadId ? openThread(state.currentThread.id, { navigation: "none" }) : Promise.resolve(),
  ]).finally(() => { resumePromise = null; });
  return resumePromise;
}
const eventStream = new EventStream({ onEvent: handleCodexEvent, onState: setConnection, onResume: reconcileAfterResume });

function renderApprovals() {
  const relevant = [...state.approvals.entries()].filter(([, request]) => {
    const threadId = request.params?.threadId || request.params?.conversationId;
    return !threadId || !state.currentThread || threadId === state.currentThread.id;
  });
  const wasHidden = elements.approvalTray.classList.contains("hidden");
  const viewState = captureApprovalViewState();
  let restoreTarget = wasHidden && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  if (restoreTarget?.closest("#permission-dialog")) restoreTarget = elements.permissionButton;
  else if (restoreTarget?.closest("#new-thread-dialog")) restoreTarget = elements.newThreadButton;
  else if (restoreTarget?.closest("#writer-dialog")) restoreTarget = elements.messageInput;
  for (const id of state.approvalDrafts.keys()) {
    if (!state.approvals.has(id)) state.approvalDrafts.delete(id);
  }

  if (relevant.length === 0) {
    elements.approvalTray.classList.add("hidden");
    elements.approvalTray.setAttribute("aria-hidden", "true");
    elements.approvalTray.replaceChildren();
    elements.appShell.inert = false;
    if (!wasHidden && state.approvalRestoreFocus?.isConnected) {
      state.approvalRestoreFocus.focus({ preventScroll: true });
    }
    state.approvalRestoreFocus = null;
    return;
  }

  const panel = document.createElement("section");
  panel.className = "approval-panel";
  panel.tabIndex = -1;
  const header = document.createElement("header");
  header.className = "approval-panel-header";
  const heading = document.createElement("div");
  heading.className = "approval-panel-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "AUTHORIZATION";
  const panelTitle = document.createElement("h2");
  panelTitle.id = "approval-panel-title";
  panelTitle.textContent = "需要你的确认";
  heading.append(eyebrow, panelTitle);
  const count = document.createElement("span");
  count.className = "approval-count";
  count.textContent = relevant.length === 1 ? "1 项" : `${relevant.length} 项`;
  if (relevant.length > 1) count.title = "将按顺序逐项处理";
  header.append(heading, count);
  const list = document.createElement("div");
  list.className = "approval-list";
  const [activeId, activeRequest] = relevant[0];
  const rendered = renderApprovalCard(String(activeId), activeRequest);
  list.append(rendered.card);
  panel.append(header, list, rendered.actions);
  elements.approvalTray.replaceChildren(panel);
  elements.approvalTray.classList.remove("hidden");
  elements.approvalTray.setAttribute("aria-hidden", "false");
  if (wasHidden) {
    for (const dialog of [elements.newThreadDialog, elements.permissionDialog, elements.writerDialog, document.querySelector("#diagnostics-dialog")]) {
      if (dialog.open) dialog.close();
    }
    state.approvalRestoreFocus = restoreTarget;
  }
  elements.appShell.inert = true;

  const isSameApproval = viewState.approvalId === String(activeId);
  list.scrollTop = isSameApproval ? viewState.scrollTop : 0;
  if (wasHidden) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    panel.focus({ preventScroll: true });
  } else if (!isSameApproval) {
    panel.focus({ preventScroll: true });
  } else {
    restoreApprovalFocus(viewState);
  }
}

function captureApprovalViewState() {
  const active = document.activeElement;
  return {
    approvalId: elements.approvalTray.querySelector(".approval-card")?.dataset.approvalId || "",
    focusKey: active instanceof HTMLElement ? active.dataset.approvalFocusKey || "" : "",
    selectionStart: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.selectionStart
      : null,
    selectionEnd: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.selectionEnd
      : null,
    scrollTop: elements.approvalTray.querySelector(".approval-list")?.scrollTop || 0,
  };
}

function restoreApprovalFocus(viewState) {
  const panel = elements.approvalTray.querySelector(".approval-panel");
  if (!viewState.focusKey) {
    panel?.focus({ preventScroll: true });
    return;
  }
  const target = [...elements.approvalTray.querySelectorAll("[data-approval-focus-key]")]
    .find((candidate) => candidate.dataset.approvalFocusKey === viewState.focusKey);
  if (!(target instanceof HTMLElement)) {
    panel?.focus({ preventScroll: true });
    return;
  }
  target.focus({ preventScroll: true });
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && viewState.selectionStart !== null) {
    target.setSelectionRange(viewState.selectionStart, viewState.selectionEnd ?? viewState.selectionStart);
  }
}

function renderApprovalCard(id, request) {
  const method = request.method || "";
  const params = request.params || {};
  const draft = approvalDraft(id, method);
  const card = document.createElement("section");
  card.className = "approval-card";
  card.dataset.approvalId = id;
  card.setAttribute("aria-busy", state.submittingApprovals.has(id) ? "true" : "false");
  const body = document.createElement("div");
  body.className = "approval-card-body";
  const title = document.createElement("h3");
  title.textContent = approvalTitle(method);
  const description = document.createElement("p");
  description.className = "approval-description";
  description.textContent = params.reason || params.message || approvalDescription(method);
  body.append(title, description);
  const actions = document.createElement("div");
  actions.className = "approval-actions";

  if (method.includes("commandExecution")) {
    appendApprovalField(body, "命令", params.command, { multiline: true, monospace: true });
    appendApprovalField(body, "工作目录", params.cwd, { monospace: true });
    const additionalPermissionItems = permissionSummaryItems(params.additionalPermissions || {});
    if (params.networkApprovalContext?.host) {
      const protocol = params.networkApprovalContext.protocol || "network";
      additionalPermissionItems.push(`网络目标：${protocol} · ${params.networkApprovalContext.host}`);
    }
    appendPermissionSummaryList(body, "命令申请的额外权限", additionalPermissionItems);
    renderDecisionActions(id, request, body, actions);
  } else if (method === "execCommandApproval") {
    const command = Array.isArray(params.command)
      ? params.command.map((argument, index) => `[${index}] ${argument}`).join("\n")
      : params.command;
    appendApprovalField(body, Array.isArray(params.command) ? "命令参数" : "命令", command, { multiline: true, monospace: true });
    appendApprovalField(body, "工作目录", params.cwd, { monospace: true });
    renderLegacyDecisionActions(id, actions);
  } else if (method.includes("fileChange")) {
    const change = state.items.find((item) => item.id === params.itemId && item.type === "fileChange");
    if (change) { const diff = fileDiffElement(change); diff.open = true; body.append(diff); }
    appendApprovalField(body, "授权写入范围", params.grantRoot, { monospace: true });
    renderDecisionActions(id, request, body, actions);
  } else if (method === "applyPatchApproval") {
    appendApprovalField(body, "授权写入范围", params.grantRoot, { monospace: true });
    const changedFiles = Object.keys(params.fileChanges || {});
    if (changedFiles.length > 0) appendApprovalField(body, "将修改的文件", changedFiles.join("\n"), { multiline: true, monospace: true });
    renderLegacyDecisionActions(id, actions);
  } else if (method.includes("requestUserInput")) {
    renderUserInputApproval(id, request, body, actions);
  } else if (method.includes("permissions")) {
    renderPermissionApproval(id, request, body, actions);
  } else {
    appendRawResponseEditor(id, method, body, actions);
  }

  const raw = document.createElement("details");
  raw.className = "tool-card";
  raw.open = Boolean(draft.detailsOpen);
  raw.addEventListener("toggle", () => { draft.detailsOpen = raw.open; });
  const summary = document.createElement("summary");
  summary.textContent = "查看原始请求详情";
  summary.dataset.approvalFocusKey = `${id}:request-details`;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(params, null, 2);
  raw.append(summary, pre);
  body.append(raw);
  card.append(body);
  if (state.submittingApprovals.has(id)) {
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
  }
  return { card, actions };
}

function approvalDraft(id, method) {
  let draft = state.approvalDrafts.get(id);
  if (!draft || draft.method !== method) {
    draft = {
      method,
      answers: {},
      otherAnswers: {},
      rawResponse: defaultApprovalResult(method),
      rawResponseTouched: false,
      detailsOpen: false,
    };
    state.approvalDrafts.set(id, draft);
  }
  return draft;
}

function approvalDescription(method = "") {
  if (method.includes("commandExecution") || method === "execCommandApproval") return "Codex 想要运行下面的命令。";
  if (method.includes("fileChange") || method === "applyPatchApproval") return "Codex 想要修改当前授权范围之外的文件。";
  if (method.includes("requestUserInput")) return "Codex 已暂停处理，正在等待你的回答。";
  if (method.includes("permissions")) return "Codex 需要以下额外访问权限才能继续。";
  return "Codex 正在等待你的响应。";
}

function appendApprovalField(container, label, value, { multiline = false, monospace = false } = {}) {
  if (value === undefined || value === null || value === "") return;
  const field = document.createElement("div");
  field.className = "approval-field";
  const labelNode = document.createElement("span");
  labelNode.className = "approval-field-label";
  labelNode.textContent = label;
  const valueNode = document.createElement(multiline ? "pre" : "p");
  valueNode.className = multiline ? "approval-command" : "approval-field-value";
  if (monospace) valueNode.classList.add("approval-mono");
  valueNode.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  field.append(labelNode, valueNode);
  container.append(field);
}

function renderDecisionActions(id, request, body, actions) {
  const definitions = new Map([
    ["accept", { decision: "accept", label: "允许", className: "approve" }],
    ["acceptForSession", { decision: "acceptForSession", label: "本会话允许", className: "" }],
    ["decline", { decision: "decline", label: "拒绝", className: "danger" }],
    ["cancel", { decision: "cancel", label: "拒绝并停止", className: "danger" }],
  ]);
  const available = request.params?.availableDecisions;
  const offered = Array.isArray(available) ? available : [...definitions.keys()];
  const decisions = [];
  const unsupported = [];
  for (const decision of offered) {
    if (typeof decision === "string" && definitions.has(decision)) {
      decisions.push(definitions.get(decision));
      continue;
    }
    if (decision && typeof decision === "object" && decision.acceptWithExecpolicyAmendment) {
      const rules = decision.acceptWithExecpolicyAmendment.execpolicy_amendment || [];
      if (rules.length > 0) {
        appendApprovalField(body, "允许后将记住的命令规则", rules.join("\n"), { multiline: true, monospace: true });
      }
      decisions.push({ decision, label: "允许并记住命令规则", className: "approve" });
      continue;
    }
    if (decision && typeof decision === "object" && decision.applyNetworkPolicyAmendment) {
      const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment || {};
      if (amendment.host) {
        appendApprovalField(
          body,
          "允许后将保存的网络规则",
          `${amendment.action || "allow"} · ${amendment.host}`,
          { monospace: true },
        );
      }
      const label = amendment.action === "deny"
        ? `应用拒绝网络规则${amendment.host ? ` · ${amendment.host}` : ""}`
        : `允许并记住网络主机${amendment.host ? ` · ${amendment.host}` : ""}`;
      decisions.push({ decision, label, className: amendment.action === "deny" ? "danger" : "approve" });
      continue;
    }
    unsupported.push(decision);
  }
  for (const { decision, label, className } of decisions) {
    actions.append(approvalButton(id, label, className, () => answerApproval(id, { decision })));
  }
  if (decisions.length === 0 || unsupported.length > 0) {
    const note = document.createElement("p");
    note.className = "approval-description";
    note.textContent = decisions.length === 0
      ? "此请求只提供了高级决策，请核对并提交下方协议响应。"
      : "请求还包含未识别的高级决策，可在下方核对并提交。";
    body.append(note);
    const draft = approvalDraft(id, request.method);
    if (!draft.rawResponseTouched && unsupported.length > 0) {
      draft.rawResponse = JSON.stringify({ decision: unsupported[0] }, null, 2);
    }
    appendRawResponseEditor(id, request.method, body, actions);
  }
}

function renderLegacyDecisionActions(id, actions) {
  actions.append(
    approvalButton(id, "允许", "approve", () => answerApproval(id, { decision: "approved" })),
    approvalButton(id, "本会话允许", "", () => answerApproval(id, { decision: "approved_for_session" })),
    approvalButton(id, "拒绝", "danger", () => answerApproval(id, {
      decision: { denied: { rejection: "用户拒绝了此操作。" } },
    })),
    approvalButton(id, "拒绝并停止", "danger", () => answerApproval(id, { decision: "abort" })),
  );
}

function renderPermissionApproval(id, request, body, actions) {
  const params = request.params || {};
  appendApprovalField(body, "工作目录", params.cwd, { monospace: true });
  const requestedPermissions = params.permissions && typeof params.permissions === "object"
    ? params.permissions
    : {};
  const grantedPermissions = toGrantedPermissions(requestedPermissions);
  const items = permissionSummaryItems(requestedPermissions);
  appendPermissionSummaryList(body, "申请的权限", items, { showEmpty: true });
  actions.append(
    approvalButton(id, "本回合允许", "approve", () => answerApproval(id, { permissions: grantedPermissions, scope: "turn" })),
    approvalButton(id, "本会话允许", "", () => answerApproval(id, { permissions: grantedPermissions, scope: "session" })),
    approvalButton(id, "拒绝", "danger", () => answerApproval(id, { permissions: {}, scope: "turn" })),
  );
}

function appendPermissionSummaryList(container, label, items, { showEmpty = false } = {}) {
  if (items.length === 0 && !showEmpty) return;
  const field = document.createElement("div");
  field.className = "approval-field";
  const labelNode = document.createElement("span");
  labelNode.className = "approval-field-label";
  labelNode.textContent = label;
  const list = document.createElement("ul");
  list.className = "approval-permission-list";
  const visibleItems = items.length > 0
    ? items
    : ["请求中没有可识别的权限条目，请核对原始详情。"];
  for (const text of visibleItems) {
    const item = document.createElement("li");
    item.textContent = text;
    list.append(item);
  }
  field.append(labelNode, list);
  container.append(field);
}

function permissionSummaryItems(permissions) {
  const items = [];
  if (permissions.network?.enabled === true) items.push("访问网络");
  if (permissions.network?.enabled === false) items.push("关闭网络访问");
  const fileSystem = permissions.fileSystem || {};
  for (const path of fileSystem.read || []) items.push(`读取：${formatPermissionPath(path)}`);
  for (const path of fileSystem.write || []) items.push(`写入：${formatPermissionPath(path)}`);
  for (const entry of fileSystem.entries || []) {
    const access = { read: "读取", write: "写入", deny: "禁止访问" }[entry?.access] || entry?.access || "访问";
    items.push(`${access}：${formatPermissionPath(entry?.path)}`);
  }
  return items;
}

function formatPermissionPath(path) {
  if (typeof path === "string") return path;
  if (!path || typeof path !== "object") return String(path ?? "未知路径");
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return path.pattern;
  if (path.type === "special") {
    const value = path.value || {};
    return [value.kind, value.path, value.subpath].filter(Boolean).join(": ") || "特殊路径";
  }
  return JSON.stringify(path);
}

function renderUserInputApproval(id, request, body, actions) {
  const questions = Array.isArray(request.params?.questions) ? request.params.questions : [];
  const draft = approvalDraft(id, request.method);
  if (questions.length === 0) {
    appendRawResponseEditor(id, request.method, body, actions);
    return;
  }
  questions.forEach((question, questionIndex) => {
    const questionId = String(question.id || `question-${questionIndex + 1}`);
    const fieldset = document.createElement("fieldset");
    fieldset.className = "approval-question";
    const legend = document.createElement("legend");
    legend.textContent = question.header || `问题 ${questionIndex + 1}`;
    const prompt = document.createElement("p");
    prompt.className = "approval-question-text";
    prompt.textContent = question.question || "请输入你的回答。";
    fieldset.append(legend, prompt);
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length > 0) {
      const optionList = document.createElement("div");
      optionList.className = "approval-option-list";
      const selected = draft.answers[questionId]?.[0] || "";
      const optionLabels = new Set(options.map((option) => String(option.label)));
      options.forEach((option, optionIndex) => {
        const label = document.createElement("label");
        label.className = "approval-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `approval-${id}-${questionIndex}`;
        input.value = option.label;
        input.checked = selected === option.label;
        input.dataset.approvalFocusKey = `${id}:${questionId}:option:${optionIndex}`;
        input.addEventListener("change", () => {
          if (input.checked) draft.answers[questionId] = [input.value];
        });
        const copy = document.createElement("span");
        copy.className = "approval-option-copy";
        const strong = document.createElement("strong");
        strong.textContent = option.label;
        const small = document.createElement("small");
        small.textContent = option.description || "";
        copy.append(strong);
        if (option.description) copy.append(small);
        label.append(input, copy);
        optionList.append(label);
      });
      if (question.isOther) {
        const row = document.createElement("div");
        row.className = "approval-option approval-option-other";
        const choiceLabel = document.createElement("label");
        choiceLabel.className = "approval-other-choice";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `approval-${id}-${questionIndex}`;
        radio.value = "__other__";
        const selectedOther = Boolean(selected) && !optionLabels.has(selected);
        radio.checked = selectedOther;
        radio.dataset.approvalFocusKey = `${id}:${questionId}:other-choice`;
        const copy = document.createElement("span");
        copy.className = "approval-option-copy";
        const strong = document.createElement("strong");
        strong.textContent = "其他";
        const input = document.createElement("input");
        input.type = question.isSecret ? "password" : "text";
        input.className = "approval-other-input";
        input.placeholder = "输入其他回答";
        input.autocomplete = "off";
        input.setAttribute("aria-label", `${question.header || `问题 ${questionIndex + 1}`}：其他回答`);
        input.value = draft.otherAnswers[questionId] ?? (selectedOther ? selected : "");
        input.dataset.approvalFocusKey = `${id}:${questionId}:other-text`;
        const selectOther = () => {
          radio.checked = true;
          draft.otherAnswers[questionId] = input.value;
          draft.answers[questionId] = [input.value];
        };
        radio.addEventListener("change", () => {
          if (radio.checked) draft.answers[questionId] = [input.value];
        });
        input.addEventListener("focus", selectOther);
        input.addEventListener("input", selectOther);
        choiceLabel.append(radio, strong);
        copy.append(choiceLabel, input);
        row.append(copy);
        optionList.append(row);
      }
      fieldset.append(optionList);
    } else {
      const input = document.createElement("input");
      input.type = question.isSecret ? "password" : "text";
      input.className = "approval-text-input";
      input.autocomplete = "off";
      input.placeholder = question.isSecret ? "输入内容（将隐藏显示）" : "输入回答";
      input.setAttribute("aria-label", `${question.header || `问题 ${questionIndex + 1}`}：${question.question || "回答"}`);
      input.value = draft.answers[questionId]?.[0] || "";
      input.dataset.approvalFocusKey = `${id}:${questionId}:text`;
      input.addEventListener("input", () => { draft.answers[questionId] = [input.value]; });
      fieldset.append(input);
    }
    body.append(fieldset);
  });
  actions.append(approvalButton(id, "提交回答", "approve", () => {
    let result;
    try {
      result = buildUserInputResult(questions, draft.answers);
    } catch (error) {
      const fieldset = body.querySelectorAll(".approval-question")[error.questionIndex];
      const otherChoice = fieldset?.querySelector('.approval-other-choice input[type="radio"]');
      const focusTarget = otherChoice?.checked
        ? fieldset.querySelector(".approval-other-input")
        : fieldset?.querySelector("input");
      focusTarget?.focus({ preventScroll: true });
      ensureFocusedApprovalControlVisible();
      throw error;
    }
    return answerApproval(id, result);
  }));
}

function appendRawResponseEditor(id, method, body, actions) {
  const draft = approvalDraft(id, method);
  const input = document.createElement("textarea");
  input.className = "approval-raw-input";
  input.value = draft.rawResponse;
  input.setAttribute("aria-label", "JSON 响应");
  input.dataset.approvalFocusKey = `${id}:raw-response`;
  input.addEventListener("input", () => {
    draft.rawResponse = input.value;
    draft.rawResponseTouched = true;
  });
  body.append(input);
  actions.append(approvalButton(id, "提交响应", "approve", () => {
    let result;
    try {
      result = JSON.parse(draft.rawResponse);
    } catch (error) {
      throw new Error(`JSON 无效：${error.message}`);
    }
    return answerApproval(id, result);
  }));
}

function approvalTitle(method = "") {
  if (method.includes("commandExecution") || method === "execCommandApproval") return "需要批准命令";
  if (method.includes("fileChange") || method === "applyPatchApproval") return "需要批准文件修改";
  if (method.includes("requestUserInput")) return "Codex 需要你的输入";
  if (method.includes("permissions")) return "需要额外权限";
  return "Codex 等待响应";
}

function approvalButton(id, label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.approvalFocusKey = `${id}:action:${label}`;
  if (className) button.className = className;
  button.addEventListener("click", async () => {
    if (state.submittingApprovals.has(id)) return;
    state.submittingApprovals.add(id);
    const panel = button.closest(".approval-panel");
    const card = panel?.querySelector(".approval-card");
    const actionRoot = button.closest(".approval-actions");
    card?.setAttribute("aria-busy", "true");
    for (const candidate of actionRoot?.querySelectorAll("button") || []) candidate.disabled = true;
    try {
      await action();
    } catch (error) {
      showToast(error.message || "提交失败");
    } finally {
      state.submittingApprovals.delete(id);
      if (card?.isConnected && actionRoot?.isConnected) {
        card.setAttribute("aria-busy", "false");
        for (const candidate of actionRoot.querySelectorAll("button")) candidate.disabled = false;
      } else if (state.approvals.has(String(id))) {
        renderApprovals();
      }
    }
  });
  return button;
}

async function answerApproval(id, result) {
  await api(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ result }),
  });
  state.approvals.delete(String(id));
  state.approvalDrafts.delete(String(id));
  renderApprovals();
  renderThreads();
  renderCurrentThreadStatus();
}

function escapeText(value) {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

elements.menuButton.addEventListener("click", () => {
  elements.sidebar.classList.add("open");
  elements.sidebarScrim.classList.add("open");
});
elements.sidebarScrim.addEventListener("click", closeSidebar);
elements.refreshButton.addEventListener("click", loadThreads);
elements.newThreadButton.addEventListener("click", openNewThreadDialog);
elements.archiveCheckbox.addEventListener("change", loadThreads);
elements.searchInput.addEventListener("input", applyThreadFilter);
elements.copyThreadIdButton.addEventListener("click", async () => {
  const threadId = elements.copyThreadIdButton.dataset.threadId;
  if (!threadId) return;
  try {
    await copyText(threadId);
    showToast("会话 ID 已复制");
    if (elements.copyThreadIdButton.dataset.threadId !== threadId) return;
    elements.copyThreadIdButton.textContent = "已复制";
    clearTimeout(state.copyThreadIdTimer);
    state.copyThreadIdTimer = setTimeout(() => {
      if (elements.copyThreadIdButton.dataset.threadId === threadId) {
        elements.copyThreadIdButton.textContent = "复制";
      }
    }, 1_500);
  } catch {
    showToast("自动复制失败，请长按会话 ID 手动复制");
  }
});

elements.newThreadPermission.addEventListener("change", updateNewThreadPermissionDescription);
elements.newThreadCancel.addEventListener("click", () => elements.newThreadDialog.close());
elements.newThreadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cwd = state.newThreadCwd || "";
  const permission = elements.newThreadPermission.value;
  const settings = currentThreadSettings();
  elements.newThreadSubmit.disabled = true;
  try {
    await writes.send("__new__", "/api/threads", { cwd, permission, model: settings.model || null }, {
      settings, permission, openThreadId: state.currentThread?.id || null,
    });
    elements.newThreadDialog.close();
  } catch (error) {
    showToast(error.message);
  } finally { elements.newThreadSubmit.disabled = false; }
});

elements.permissionButton.addEventListener("click", () => {
  if (!state.currentThread) return;
  const input = elements.permissionForm.querySelector(`input[value="${currentPermission()}"]`);
  if (input) input.checked = true;
  elements.permissionDialog.showModal();
});
elements.permissionCancel.addEventListener("click", () => elements.permissionDialog.close());
elements.permissionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const permission = new FormData(elements.permissionForm).get("permission");
  if (!permissionPresets[permission]) return;
  const threadId = state.currentThread?.id;
  if (!threadId) return;
  const submit = elements.permissionForm.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/permission`, {
      method: "PUT",
      body: JSON.stringify({ permission }),
    });
    saveThreadPermission(permission, threadId);
    delete state.threadPermissions[threadId];
    elements.permissionDialog.close();
    updateComposerState();
    showToast(`已保存到 Pocket；下回合权限：${permissionPresets[permission].label}`);
  } catch (error) {
    showToast(`权限保存失败：${error.message}`);
  } finally {
    if (submit) submit.disabled = false;
  }
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  const source = state.currentThread && { id: state.currentThread.id, name: threadTitle(state.currentThread), cwd: state.currentThread.cwd };
  const attachments = images.list(source?.id);
  if ((!text && !attachments.length) || attachments.some((item) => item.status !== "ready") || !source || state.openingThreadId || state.sendingThreads.has(source.id)) return;
  const snapshot = persistDraft();
  const settings = currentThreadSettings();
  const permission = currentPermission();
  const context = { source, snapshot, settings, permission };
  const threadId = source.id;
  const endpoint = `/api/threads/${encodeURIComponent(threadId)}`;
  const body = { text, images: attachments.map((item) => item.id), model: settings.model || null, effort: settings.effort || null, permission, cwd: source.cwd || null };
  state.sendingThreads.add(threadId);
  updateComposerState();
  try {
    const turnId = state.activeTurns.get(threadId);
    if (turnId) {
      try { await writes.send(threadId, `${endpoint}/steer`, { text, images: body.images, turnId }, context); }
      catch (error) {
        if (error.code !== "no_active_turn") throw error;
        state.activeTurns.delete(threadId);
        await writes.send(threadId, `${endpoint}/messages`, body, context);
      }
    } else await writes.send(threadId, `${endpoint}/messages`, body, context);
  } catch (error) {
    if (error.code === "thread_writer_conflict" && await confirmFork()) {
      try {
        await writes.send(threadId, `${endpoint}/fork`, { ...body, permission: FORK_DEFAULT_PERMISSION }, {
          ...context, permission: FORK_DEFAULT_PERMISSION,
        });
      } catch (forkError) { showToast(forkError.message); }
    } else if (error.code !== "thread_writer_conflict") showToast(error.message);
  } finally {
    state.sendingThreads.delete(threadId);
    updateComposerState();
  }
});

elements.attentionFilter.addEventListener("click", () => { state.attentionOnly = !state.attentionOnly; renderThreads(); });
elements.attachImage.addEventListener("click", () => elements.imageInput.click());
async function addImages(files) {
  if (!state.draftThreadId || state.openingThreadId) return;
  persistDraft();
  try { await images.add(state.draftThreadId, files); }
  catch (error) { showToast(error.message); }
}
elements.imageInput.addEventListener("change", () => {
  void addImages([...elements.imageInput.files]); elements.imageInput.value = "";
});
elements.messageInput.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); void addImages(files); }
});

elements.messageInput.addEventListener("input", () => {
  resizeComposer();
  persistDraft();
});

elements.messages.addEventListener("scroll", updateReadingState, { passive: true });
elements.latestButton.addEventListener("click", () => {
  if (state.history?.hasLater && state.currentThread) { void openThread(state.currentThread.id, { navigation: "none", latest: true }); return; }
  elements.messages.scrollTop = elements.messages.scrollHeight;
  updateReadingState();
});
window.addEventListener("pagehide", () => { persistDraft(); saveReadingPosition(); });

elements.modelSelect.addEventListener("change", () => {
  const model = state.models.find((candidate) => candidate.model === elements.modelSelect.value);
  const effort = model?.defaultReasoningEffort
    || model?.supportedReasoningEfforts?.[0]?.reasoningEffort
    || "";
  saveThreadSettings({ model: elements.modelSelect.value, effort });
  updateComposerState();
});

elements.effortSelect.addEventListener("change", () => {
  const settings = currentThreadSettings();
  saveThreadSettings({ ...settings, effort: elements.effortSelect.value });
  updateComposerState();
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.stopButton.addEventListener("click", async () => {
  if (!state.currentThread) return;
  try {
    const turnId = state.activeTurns.get(state.currentThread.id);
    await api(`/api/threads/${encodeURIComponent(state.currentThread.id)}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ turnId }),
    });
  } catch (error) { showToast(error.message); }
});

window.addEventListener("popstate", () => {
  const threadId = routeThreadId();
  if (threadId) void openThread(threadId, { navigation: "none" });
  else closeThreadView();
});

function ensureFocusedApprovalControlVisible() {
  cancelAnimationFrame(state.approvalFocusFrame);
  state.approvalFocusFrame = requestAnimationFrame(() => {
    state.approvalFocusFrame = null;
    const active = document.activeElement;
    const list = elements.approvalTray.querySelector(".approval-list");
    if (!(active instanceof HTMLElement) || !list?.contains(active)) return;
    active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  });
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = Math.max(1, viewport?.height || window.innerHeight);
  const width = Math.max(1, viewport?.width || window.innerWidth);
  const offsetTop = Math.max(0, viewport?.offsetTop || 0);
  const offsetLeft = Math.max(0, viewport?.offsetLeft || 0);
  document.documentElement.style.setProperty("--visual-viewport-height", `${height}px`);
  document.documentElement.style.setProperty("--visual-viewport-top", `${offsetTop}px`);
  document.documentElement.style.setProperty("--visual-viewport-width", `${width}px`);
  document.documentElement.style.setProperty("--visual-viewport-left", `${offsetLeft}px`);
  if (!elements.approvalTray.classList.contains("hidden")) ensureFocusedApprovalControlVisible();
}

syncVisualViewport();
elements.approvalTray.addEventListener("focusin", ensureFocusedApprovalControlVisible);
elements.approvalTray.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...elements.approvalTray.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element instanceof HTMLElement && element.offsetParent !== null);
  if (focusable.length === 0) {
    event.preventDefault();
    elements.approvalTray.querySelector(".approval-panel")?.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement?.classList.contains("approval-panel"))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
window.addEventListener("resize", syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener("resize", syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener("scroll", syncVisualViewport, { passive: true });

async function boot() {
  localStorage.removeItem("codex-pocket-key");
  localStorage.removeItem("codex-pocket-thread-permissions");
  void updates.start();
  try {
    eventStream.start();
    void runtimePanel.refresh();
    const initialThreadId = routeThreadId();
    const initialOpen = initialThreadId
      ? openThread(initialThreadId, { navigation: "none" })
      : Promise.resolve();
    await Promise.allSettled([initialOpen, loadThreads()]);
    void refreshThreadStatuses();
    void checkPendingOperations();
    setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshThreadStatuses();
        void runtimePanel.refresh();
        void checkPendingOperations();
      }
    }, 10_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") { persistDraft(); saveReadingPosition(); }
    });
    window.addEventListener("pageshow", (event) => { if (event.persisted) eventStream.resume(); });
  } catch (error) {
    showToast(error.message);
  }
}

boot();

// Notification routing uses the normal thread switch so current drafts survive.
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'OPEN_THREAD' && typeof event.data.threadId === 'string' && event.data.threadId) {
    persistDraft(); saveReadingPosition();
    void openThread(event.data.threadId);
  }
});
