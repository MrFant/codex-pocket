import { stat, open, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const INTERACTIVE_SOURCES = new Set(["cli", "vscode", "appServer", "unknown"]);
const LIFECYCLE_CHUNK_BYTES = 128 * 1024;
const OPTIMISTIC_THREAD_TTL_MS = 10 * 60 * 1_000;
const ACTIVITY_TTL_SECONDS = 24 * 60 * 60;

function safeDatabase(filename) {
  try {
    return new DatabaseSync(filename, { readOnly: true });
  } catch {
    return null;
  }
}

function loadProjectConfig(filename) {
  if (!filename) return {};
  try {
    const value = JSON.parse(readFileSync(filename, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function configProjectSnapshot(config = {}) {
  const projectById = new Map();
  const projectByThread = new Map();
  const projectByRoot = new Map();
  for (const [index, project] of (config.projects || []).entries()) {
    if (!project?.id) continue;
    const normalized = {
      ...project,
      order: project.order ?? index,
      rootPaths: project.rootPaths || (project.path ? [project.path] : []),
    };
    projectById.set(normalized.id, normalized);
    for (const threadId of project.threadIds || []) projectByThread.set(threadId, normalized);
    for (const root of normalized.rootPaths) projectByRoot.set(root, normalized);
  }
  return {
    projectById,
    projectByThread,
    projectByRoot,
    excludedThreadIds: new Set(),
    pinnedThreadIds: new Set(config.pinnedThreadIds || []),
    permissionByThread: new Map(),
    approvalByThread: new Map(),
    unreadThreadIds: new Set(),
    authoritativeAssignments: false,
  };
}

function appServerApprovalPolicy(value) {
  const aliases = {
    "on-request": "onRequest",
    "on-failure": "onFailure",
    "unless-trusted": "unlessTrusted",
  };
  const normalized = aliases[value] || value;
  return ["never", "onRequest", "onFailure", "unlessTrusted"].includes(normalized)
    ? normalized
    : null;
}

function permissionFromSandboxPolicy(value) {
  let policy = value;
  if (typeof policy === "string") {
    try {
      policy = JSON.parse(policy);
    } catch {
      return null;
    }
  }
  const type = policy?.type;
  if (["dangerFullAccess", "danger-full-access", "disabled"].includes(type)) {
    return "dangerFullAccess";
  }
  if (["readOnly", "read-only"].includes(type)) return "readOnly";
  if (["workspaceWrite", "workspace-write"].includes(type)) return "workspaceWrite";
  if (type === "managed") {
    const entries = policy.file_system?.entries || [];
    return entries.some((entry) => entry?.access === "write") ? "workspaceWrite" : "readOnly";
  }
  return null;
}

function seconds(value, millisecondValue = null) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return direct > 10_000_000_000 ? Math.floor(direct / 1_000) : direct;
  }
  const milliseconds = Number(millisecondValue);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1_000) : 0;
}

function stateSourceKind(row = {}) {
  if (INTERACTIVE_SOURCES.has(row.source)) return row.source;
  if (row.source === undefined || row.source === null || row.source === "") return "unknown";
  return null;
}

function isInteractiveStateRow(row = {}) {
  if (row.thread_source === "subagent") return false;
  if (typeof row.source === "string" && row.source.trimStart().startsWith("{")) {
    try {
      if (JSON.parse(row.source)?.subagent) return false;
    } catch {
      // Unknown serialized sources are handled as ordinary unknown clients.
    }
  }
  return INTERACTIVE_SOURCES.has(stateSourceKind(row));
}

async function atomicWrite(filename, contents) {
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function desktopProjectSnapshot(filename) {
  const state = loadProjectConfig(filename);
  if (!Object.keys(state).length) return null;
  const storedProjects = state["local-projects"] && typeof state["local-projects"] === "object"
    ? state["local-projects"]
    : {};

  const requestedOrder = Array.isArray(state["project-order"]) ? state["project-order"] : [];
  const projectIds = [...new Set([...requestedOrder, ...Object.keys(storedProjects)])];
  const projectById = new Map();
  const projectByRoot = new Map();
  for (const [fallbackOrder, projectId] of projectIds.entries()) {
    const project = storedProjects[projectId];
    if (!project) continue;
    const rootPaths = Array.isArray(project.rootPaths) ? project.rootPaths.filter(Boolean) : [];
    const normalized = {
      id: projectId,
      name: project.name || rootPaths[0]?.split("/").filter(Boolean).at(-1) || projectId,
      path: rootPaths[0] || null,
      rootPaths,
      order: requestedOrder.indexOf(projectId) >= 0 ? requestedOrder.indexOf(projectId) : fallbackOrder,
    };
    projectById.set(projectId, normalized);
    for (const root of rootPaths) projectByRoot.set(root, normalized);
  }

  const atoms = state["electron-persisted-atom-state"] || {};
  const permissionByThread = new Map();
  const approvalByThread = new Map();
  for (const [threadId, record] of Object.entries(atoms["heartbeat-thread-permissions-by-id"] || {})) {
    const permission = permissionFromSandboxPolicy(record?.sandboxPolicy);
    if (permission) permissionByThread.set(threadId, permission);
    const approvalPolicy = appServerApprovalPolicy(record?.approvalPolicy);
    if (approvalPolicy) approvalByThread.set(threadId, approvalPolicy);
  }
  const desktopUnread = atoms["unread-thread-ids-by-host-v1"]?.local;
  const unreadThreadIds = new Set(Array.isArray(desktopUnread) ? desktopUnread : []);
  const projectlessThreadIds = new Set(state["projectless-thread-ids"] || []);
  const excludedThreadIds = new Set(projectlessThreadIds);
  const projectByThread = new Map();
  for (const [threadId, assignment] of Object.entries(state["thread-project-assignments"] || {})) {
    if (excludedThreadIds.has(threadId) || assignment?.projectKind !== "local") continue;
    const project = projectById.get(assignment.projectId);
    if (project) projectByThread.set(threadId, project);
  }

  return {
    projectById,
    projectByThread,
    projectByRoot,
    excludedThreadIds,
    pinnedThreadIds: new Set(state["pinned-thread-ids"] || []),
    permissionByThread,
    approvalByThread,
    unreadThreadIds,
    authoritativeAssignments: true,
  };
}

function pocketStateSnapshot(filename) {
  const state = loadProjectConfig(filename);
  const projectByThread = new Map();
  for (const [threadId, projectId] of Object.entries(state.threadProjects || {})) {
    if (projectId === null || typeof projectId === "string") {
      projectByThread.set(threadId, projectId);
    }
  }
  const permissionByThread = new Map();
  for (const [threadId, permission] of Object.entries(state.threadPermissions || {})) {
    if (["readOnly", "workspaceWrite", "dangerFullAccess"].includes(permission)) {
      permissionByThread.set(threadId, permission);
    }
  }
  const activityByThread = new Map();
  for (const [threadId, activity] of Object.entries(state.threadActivity || {})) {
    if (!activity || typeof activity !== "object") continue;
    const seenKey = typeof activity.seenKey === "string" ? activity.seenKey : null;
    const seenAt = Number(activity.seenAt) || 0;
    if (seenKey || seenAt) activityByThread.set(threadId, { seenKey, seenAt });
  }
  const activityInitializedAt = Number(state.activityInitializedAt) || 0;
  return { projectByThread, permissionByThread, activityByThread, activityInitializedAt };
}

function loadPocketStateForWrite(filename) {
  try {
    const value = JSON.parse(readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Pocket state must be a JSON object");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Pocket state is invalid: ${error.message}`);
  }
}

function lifecycleFromLine(line) {
  if (!line.includes('"event_msg"') || (!line.includes('"task_started"') && !line.includes('"task_complete"'))) return null;
  try {
    const record = JSON.parse(line);
    if (record.type !== "event_msg") return null;
    if (record.payload?.type === "task_started") {
      return {
        type: "active",
        ...(record.payload.turn_id ? { turnId: String(record.payload.turn_id) } : {}),
      };
    }
    if (record.payload?.type === "task_complete") {
      const parsedTimestamp = Date.parse(record.timestamp || "");
      const completedAt = seconds(record.payload.completed_at)
        || (Number.isFinite(parsedTimestamp) ? Math.floor(parsedTimestamp / 1_000) : 0);
      const completionKey = record.payload.turn_id
        ? String(record.payload.turn_id)
        : completedAt ? `completed:${completedAt}` : null;
      return {
        type: "idle",
        ...(completionKey ? { completionKey } : {}),
        ...(completedAt ? { completedAt } : {}),
      };
    }
  } catch {
    // A partial line at a chunk boundary is handled by the next chunk.
  }
  return null;
}

async function readLatestLifecycle(filename, size, floor = 0) {
  const file = await open(filename, "r");
  try {
    let position = size;
    let suffix = "";
    while (position > floor) {
      const length = Math.min(LIFECYCLE_CHUNK_BYTES, position - floor);
      const start = position - length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      const parts = `${buffer.subarray(0, bytesRead).toString("utf8")}${suffix}`.split("\n");
      suffix = parts.shift() || "";
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const lifecycle = lifecycleFromLine(parts[index]);
        if (lifecycle) return lifecycle;
      }
      position = start;
    }
    return floor === 0 ? lifecycleFromLine(suffix) : null;
  } finally {
    await file.close();
  }
}

export class LocalCodexState {
  constructor(options = {}) {
    const codexHome = options.codexHome || process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
    this.catalog = safeDatabase(options.catalogPath || `${codexHome}/sqlite/codex-dev.db`);
    this.state = safeDatabase(options.statePath || `${codexHome}/state_5.sqlite`);
    this.desktopStatePath = options.desktopStatePath === null
      ? null
      : options.desktopStatePath || `${codexHome}/.codex-global-state.json`;
    this.pocketStatePath = options.pocketStatePath === null
      ? null
      : options.pocketStatePath || `${codexHome}/codex-pocket-state.json`;
    this.writerLockDirectory = options.writerLockDirectory === null
      ? null
      : options.writerLockDirectory || `${codexHome}/thread-writer-locks`;
    this.configSnapshot = configProjectSnapshot(loadProjectConfig(options.projectConfigPath));
    this.lifecycleCache = new Map();
    this.optimisticThreads = new Map();
    this.stateColumns = new Set();
    try {
      for (const column of this.state?.prepare("PRAGMA table_info(threads)").all() || []) {
        this.stateColumns.add(column.name);
      }
    } catch {
      // Older or partially initialized state databases still support catalog metadata.
    }
    this.pocketWriteQueue = Promise.resolve();
    this.activityInitializedAt = null;
  }

  #projectSnapshot() {
    const desktopSnapshot = desktopProjectSnapshot(this.desktopStatePath);
    let baseSnapshot;
    if (!desktopSnapshot) baseSnapshot = this.configSnapshot;
    else if (desktopSnapshot.projectById.size) baseSnapshot = desktopSnapshot;
    else {
      baseSnapshot = {
        ...this.configSnapshot,
        excludedThreadIds: desktopSnapshot.excludedThreadIds,
        pinnedThreadIds: desktopSnapshot.pinnedThreadIds,
        permissionByThread: desktopSnapshot.permissionByThread,
        approvalByThread: desktopSnapshot.approvalByThread,
        unreadThreadIds: desktopSnapshot.unreadThreadIds,
      };
    }

    const pocketSnapshot = pocketStateSnapshot(this.pocketStatePath);
    const projectByThread = new Map(baseSnapshot.projectByThread);
    const excludedThreadIds = new Set(baseSnapshot.excludedThreadIds);
    for (const [threadId, projectId] of pocketSnapshot.projectByThread) {
      if (projectByThread.has(threadId) || excludedThreadIds.has(threadId)) continue;
      if (projectId === null) excludedThreadIds.add(threadId);
      else {
        const project = baseSnapshot.projectById.get(projectId);
        if (project) projectByThread.set(threadId, project);
      }
    }

    const permissionByThread = new Map(baseSnapshot.permissionByThread);
    const approvalByThread = new Map(baseSnapshot.approvalByThread);
    for (const [threadId, permission] of pocketSnapshot.permissionByThread) {
      permissionByThread.set(threadId, permission);
      approvalByThread.set(threadId, permission === "workspaceWrite" ? "onRequest" : "never");
    }
    return {
      ...baseSnapshot,
      projectByThread,
      excludedThreadIds,
      permissionByThread,
      approvalByThread,
      activityByThread: pocketSnapshot.activityByThread,
      activityInitializedAt: this.activityInitializedAt
        ?? (pocketSnapshot.activityInitializedAt || Number.POSITIVE_INFINITY),
    };
  }

  #projectFor(row, snapshot) {
    if (snapshot.excludedThreadIds.has(row.thread_id)) return null;
    const explicitProjectId = row.projectId || row.stateRow?.project_id;
    return snapshot.projectByThread.get(row.thread_id)
      || (explicitProjectId ? snapshot.projectById.get(explicitProjectId) : null)
      || (!snapshot.authoritativeAssignments ? snapshot.projectByRoot.get(row.cwd) : null)
      || null;
  }

  #stateRows() {
    if (!this.state) return new Map();
    try {
      const columns = [
        "id", "preview", "rollout_path", "archived", "created_at", "created_at_ms",
        "updated_at", "updated_at_ms", "recency_at", "recency_at_ms", "cwd", "title",
        "name", "first_user_message", "source", "thread_source", "sandbox_policy",
        "approval_mode", "is_pinned", "project_id",
      ].filter((column) => this.stateColumns.has(column));
      if (!columns.includes("id")) return new Map();
      return new Map(this.state.prepare(`SELECT ${columns.join(", ")} FROM threads`)
        .all().map((row) => [row.id, row]));
    } catch {
      return new Map();
    }
  }

  #catalogRows() {
    if (!this.catalog) return new Map();
    try {
      return new Map(this.catalog.prepare(`
        SELECT thread_id, display_title, source_created_at, source_updated_at,
               source_recency_at, cwd, source_kind
        FROM local_thread_catalog
        WHERE host_id = 'local' AND missing_candidate = 0
      `).all().map((row) => [row.thread_id, row]));
    } catch {
      return new Map();
    }
  }

  #mergedRows() {
    const now = Date.now();
    const stateRows = this.#stateRows();
    const catalogRows = this.#catalogRows();
    const merged = new Map();

    for (const [threadId, stateRow] of stateRows) {
      if (!isInteractiveStateRow(stateRow)) continue;
      const catalogRow = catalogRows.get(threadId);
      const stateCreatedAt = seconds(stateRow.created_at, stateRow.created_at_ms);
      const stateUpdatedAt = seconds(stateRow.updated_at, stateRow.updated_at_ms);
      const stateRecencyAt = seconds(stateRow.recency_at, stateRow.recency_at_ms)
        || stateUpdatedAt || stateCreatedAt;
      merged.set(threadId, {
        thread_id: threadId,
        display_title: stateRow.name || catalogRow?.display_title || stateRow.title
          || stateRow.preview || stateRow.first_user_message || "未命名会话",
        source_created_at: stateCreatedAt || catalogRow?.source_created_at,
        source_updated_at: Math.max(catalogRow?.source_updated_at || 0, stateUpdatedAt),
        source_recency_at: Math.max(catalogRow?.source_recency_at || 0, stateRecencyAt),
        cwd: stateRow.cwd || catalogRow?.cwd || "",
        source_kind: catalogRow?.source_kind || stateSourceKind(stateRow),
        hasCatalog: Boolean(catalogRow),
        hasExplicitName: Boolean(stateRow.name),
        stateRow,
      });
    }

    for (const [threadId, catalogRow] of catalogRows) {
      if (stateRows.has(threadId) || !INTERACTIVE_SOURCES.has(catalogRow.source_kind)) continue;
      merged.set(threadId, { ...catalogRow, hasCatalog: true, stateRow: {} });
    }

    for (const [threadId, optimistic] of this.optimisticThreads) {
      if (now - optimistic.rememberedAt > OPTIMISTIC_THREAD_TTL_MS) {
        this.optimisticThreads.delete(threadId);
        continue;
      }
      const existing = merged.get(threadId);
      if (existing) {
        if (!existing.cwd && optimistic.cwd) existing.cwd = optimistic.cwd;
        if ((!existing.hasCatalog && !existing.hasExplicitName) && optimistic.display_title) {
          existing.display_title = optimistic.display_title;
        }
        if (!existing.permission && optimistic.permission) existing.permission = optimistic.permission;
        if (!existing.projectId && optimistic.projectId) existing.projectId = optimistic.projectId;
        continue;
      }
      merged.set(threadId, { ...optimistic, stateRow: optimistic.stateRow || {} });
    }

    return merged;
  }

  async #statusFor(row, threadId) {
    const filename = row.rollout_path;
    if (!filename) return { type: "notLoaded" };
    try {
      const info = await stat(filename);
      const cached = this.lifecycleCache.get(filename);
      let lifecycle;
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        lifecycle = cached.lifecycle;
      } else if (cached && info.size > cached.size) {
        const overlapStart = Math.max(0, cached.size - LIFECYCLE_CHUNK_BYTES);
        lifecycle = await readLatestLifecycle(filename, info.size, overlapStart) ?? cached.lifecycle;
      } else {
        lifecycle = await readLatestLifecycle(filename, info.size);
      }
      this.lifecycleCache.set(filename, { size: info.size, mtimeMs: info.mtimeMs, lifecycle });
      if (lifecycle?.type === "active" && this.writerLockDirectory && threadId) {
        try {
          await stat(`${this.writerLockDirectory}/${threadId}.lock`);
        } catch {
          return { type: "idle" };
        }
      }
      return lifecycle || { type: "notLoaded" };
    } catch {
      return { type: "notLoaded" };
    }
  }

  async #metadataFor(row, stateRow = {}, projectSnapshot = this.#projectSnapshot()) {
    const project = this.#projectFor(row, projectSnapshot);
    const permission = projectSnapshot.permissionByThread.get(row.thread_id)
      || row.permission
      || permissionFromSandboxPolicy(stateRow.sandbox_policy)
      || "workspaceWrite";
    const approvalPolicy = projectSnapshot.approvalByThread.get(row.thread_id)
      || appServerApprovalPolicy(stateRow.approval_mode)
      || (permission === "workspaceWrite" ? "onRequest" : "never");
    const status = await this.#statusFor(stateRow, row.thread_id);
    const activity = projectSnapshot.activityByThread.get(row.thread_id) || {};
    const now = Math.floor(Date.now() / 1_000);
    const completionKey = status.type === "idle" ? status.completionKey || null : null;
    const completedAt = status.type === "idle" ? Number(status.completedAt) || 0 : 0;
    const recentCompletion = Boolean(
      completionKey
      && completedAt > projectSnapshot.activityInitializedAt
      && completedAt <= now + 60
      && now - completedAt <= ACTIVITY_TTL_SECONDS,
    );
    const hasUnreadActivity = recentCompletion && activity.seenKey !== completionKey;
    return {
      id: row.thread_id,
      name: row.display_title,
      preview: stateRow.preview || row.display_title,
      cwd: row.cwd || "",
      rolloutPath: stateRow.rollout_path || row.rollout_path || null,
      createdAt: row.source_created_at,
      updatedAt: row.source_updated_at,
      recencyAt: row.source_recency_at,
      source: row.source_kind,
      status,
      projectId: project?.id || null,
      projectName: project?.name || null,
      projectPath: project?.path || null,
      projectOrder: project?.order ?? null,
      isPinned: projectSnapshot.pinnedThreadIds.has(row.thread_id) || Boolean(stateRow.is_pinned),
      hasUnreadActivity,
      activityCompletionKey: completionKey,
      activityCompletedAt: completedAt || null,
      permission,
      approvalPolicy,
    };
  }

  #updatePocketState(mutator) {
    if (!this.pocketStatePath) throw new Error("Pocket state persistence is unavailable");
    const update = this.pocketWriteQueue.then(async () => {
      const state = loadPocketStateForWrite(this.pocketStatePath);
      const result = mutator(state);
      state.version = 1;
      state.updatedAt = new Date().toISOString();
      await atomicWrite(this.pocketStatePath, JSON.stringify(state));
      return result;
    });
    this.pocketWriteQueue = update.catch(() => {});
    return update;
  }

  async initializeActivityTracking(initializedAt = Math.floor(Date.now() / 1_000)) {
    const current = pocketStateSnapshot(this.pocketStatePath).activityInitializedAt;
    if (current > 0) {
      this.activityInitializedAt = current;
      return { activityInitializedAt: current, initialized: false };
    }
    this.activityInitializedAt = initializedAt;
    if (!this.pocketStatePath) return { activityInitializedAt: initializedAt, initialized: true };
    return this.#updatePocketState((state) => {
      const persisted = Number(state.activityInitializedAt) || initializedAt;
      state.activityInitializedAt = persisted;
      this.activityInitializedAt = persisted;
      return { activityInitializedAt: persisted, initialized: persisted === initializedAt };
    });
  }

  async markThreadSeen(threadId, completionKey, seenAt = Math.floor(Date.now() / 1_000)) {
    if (!threadId || !completionKey) throw new Error("Completion key is required");
    return this.#updatePocketState((state) => {
      const activities = state.threadActivity && typeof state.threadActivity === "object"
        ? { ...state.threadActivity }
        : {};
      const current = activities[threadId] && typeof activities[threadId] === "object"
        ? activities[threadId]
        : {};
      activities[threadId] = {
        ...current,
        seenKey: completionKey,
        seenAt: Math.max(Number(current.seenAt) || 0, seenAt),
      };
      state.threadActivity = activities;
      return { threadId, completionKey, seenAt: activities[threadId].seenAt };
    });
  }

  async setThreadOverrides(threadId, {
    permission = null,
    projectId = null,
    persistProject = false,
  } = {}) {
    if (permission && !["readOnly", "workspaceWrite", "dangerFullAccess"].includes(permission)) {
      throw new Error("Permission preset is invalid");
    }
    return this.#updatePocketState((state) => {
      if (permission) {
        const permissions = state.threadPermissions && typeof state.threadPermissions === "object"
          ? { ...state.threadPermissions }
          : {};
        permissions[threadId] = permission;
        state.threadPermissions = permissions;
      }
      if (persistProject) {
        const projects = state.threadProjects && typeof state.threadProjects === "object"
          ? { ...state.threadProjects }
          : {};
        projects[threadId] = projectId || null;
        state.threadProjects = projects;
      }
      return {
        threadId,
        ...(permission ? { permission } : {}),
        ...(persistProject ? { projectId: projectId || null } : {}),
        storage: "pocket",
      };
    });
  }

  async setThreadPermission(threadId, permission) {
    return this.setThreadOverrides(threadId, { permission });
  }

  async setThreadProject(threadId, projectId = null) {
    return this.setThreadOverrides(threadId, { projectId, persistProject: true });
  }

  resolveProjectIdForCwd(cwd) {
    if (typeof cwd !== "string" || !cwd) return null;
    const normalizedCwd = path.resolve(cwd);
    const snapshot = this.#projectSnapshot();
    let match = null;
    let matchLength = -1;
    for (const project of snapshot.projectById.values()) {
      const roots = project.rootPaths || (project.path ? [project.path] : []);
      for (const root of roots) {
        if (typeof root !== "string" || !root) continue;
        const normalizedRoot = path.resolve(root);
        const relative = path.relative(normalizedRoot, normalizedCwd);
        const isInside = relative === ""
          || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        if (isInside && normalizedRoot.length > matchLength) {
          match = project.id;
          matchLength = normalizedRoot.length;
        }
      }
    }
    return match;
  }

  rememberThread(thread, { permission = null, cwd = null, projectId = null } = {}) {
    if (!thread?.id) return;
    const now = Math.floor(Date.now() / 1_000);
    const title = thread.name || thread.title || thread.preview || "新会话";
    this.optimisticThreads.set(thread.id, {
      thread_id: thread.id,
      display_title: title,
      source_created_at: seconds(thread.createdAt) || now,
      source_updated_at: seconds(thread.updatedAt) || now,
      source_recency_at: seconds(thread.recencyAt) || now,
      cwd: thread.cwd || cwd || "",
      source_kind: "appServer",
      permission,
      projectId,
      rememberedAt: Date.now(),
      stateRow: {
        preview: thread.preview || title,
        rollout_path: null,
        archived: 0,
      },
    });
  }

  async listThreads({ archived = false, searchTerm = null } = {}) {
    if (!this.catalog && !this.state && !this.optimisticThreads.size) return null;
    const rows = [...this.#mergedRows().values()];
    const projectSnapshot = this.#projectSnapshot();
    const query = searchTerm?.trim().toLocaleLowerCase() || "";
    const filtered = rows.filter((row) => {
      if (!INTERACTIVE_SOURCES.has(row.source_kind)) return false;
      const stateRow = row.stateRow || {};
      if (Boolean(stateRow?.archived) !== Boolean(archived)) return false;
      if (!query) return true;
      return [row.display_title, stateRow?.preview, row.cwd]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
    }).sort((left, right) => {
      const leftPinned = projectSnapshot.pinnedThreadIds.has(left.thread_id)
        || Boolean(left.stateRow?.is_pinned);
      const rightPinned = projectSnapshot.pinnedThreadIds.has(right.thread_id)
        || Boolean(right.stateRow?.is_pinned);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      return (right.source_recency_at || 0) - (left.source_recency_at || 0)
        || (right.source_created_at || 0) - (left.source_created_at || 0)
        || right.thread_id.localeCompare(left.thread_id);
    }).slice(0, 100);

    const data = await Promise.all(filtered.map((row) => (
      this.#metadataFor(row, row.stateRow || {}, projectSnapshot)
    )));

    data.sort((left, right) => {
      if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1;
      return (right.recencyAt || 0) - (left.recencyAt || 0);
    });
    return { data, nextCursor: null };
  }

  async getThreadMetadata(threadId) {
    try {
      const row = this.#mergedRows().get(threadId);
      if (!row) return null;
      const stateRow = row.stateRow || {};
      return this.#metadataFor(row, stateRow, this.#projectSnapshot());
    } catch {
      return null;
    }
  }

  async getStatuses() {
    const result = await this.listThreads();
    if (!result) return {};
    return Object.fromEntries(result.data.map((thread) => [thread.id, thread.status]));
  }

  async getThreadState() {
    const result = await this.listThreads();
    if (!result) return { statuses: {}, permissions: {} };
    return {
      statuses: Object.fromEntries(result.data.map((thread) => [thread.id, thread.status])),
      permissions: Object.fromEntries(result.data.map((thread) => [thread.id, thread.permission])),
      activities: Object.fromEntries(result.data.map((thread) => [thread.id, {
        hasUnreadActivity: thread.hasUnreadActivity,
        completionKey: thread.activityCompletionKey,
        completedAt: thread.activityCompletedAt,
      }])),
    };
  }

  close() {
    this.catalog?.close();
    this.state?.close();
  }
}
