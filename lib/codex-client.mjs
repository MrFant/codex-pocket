import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_RELEASE_MS = 3 * 60 * 1_000;
const INTERACTIVE_SOURCES = ["cli", "vscode", "appServer", "unknown"];

function isThreadWriterConflict(error) {
  return /thread.+already has (?:an? )?(?:active )?writer/i.test(error?.message || "");
}

function threadPermissionParams(permission) {
  if (permission === "readOnly") return { approvalPolicy: "never", sandbox: "read-only" };
  if (permission === "dangerFullAccess") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function wireApprovalPolicy(value, fallback = "on-request") {
  const policies = {
    never: "never",
    untrusted: "untrusted",
    unlessTrusted: "untrusted",
    "unless-trusted": "untrusted",
    onRequest: "on-request",
    "on-request": "on-request",
    onFailure: "on-request",
    "on-failure": "on-request",
  };
  return policies[value] || fallback;
}

function turnPermissionParams(permission, cwd = null, approvalPolicy = null) {
  if (permission === "readOnly") {
    return {
      approvalPolicy: wireApprovalPolicy(approvalPolicy, "never"),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  }
  if (permission === "dangerFullAccess") {
    return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  }
  return {
    approvalPolicy: wireApprovalPolicy(approvalPolicy),
    sandboxPolicy: {
      type: "workspaceWrite",
      ...(cwd ? { writableRoots: [cwd] } : {}),
      networkAccess: false,
    },
  };
}

export class CodexRpcError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexRpcError";
    this.code = details.code;
    this.data = details.data;
  }
}

export class CodexClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command ?? process.env.CODEX_BIN ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.cwd = options.cwd ?? process.env.CODEX_DEFAULT_CWD ?? process.cwd();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleReleaseMs = options.idleReleaseMs
      ?? Number(process.env.POCKET_IDLE_RELEASE_MS || DEFAULT_IDLE_RELEASE_MS);
    this.prewarmAfterIdle = options.prewarmAfterIdle ?? true;
    this.released = false;
    this.child = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.exitPromise = null;
    this.stopReason = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.loadedThreads = new Set();
    this.activeTurns = new Map();
    this.completedTurns = new Set();
    this.threadStatuses = new Map();
    this.stderrTail = [];
    this.ready = false;
    this.idleTimer = null;
    this.idleReleaseAt = null;
  }

  async start() {
    if (this.released) {
      throw new CodexRpcError("This thread runtime lease has already been released", {
        code: "runtime_released",
      });
    }
    if (this.ready && this.child) return;
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#launch();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #launch() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopReason = null;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const suffix = signal ? `signal ${signal}` : `code ${code}`;
        this.#handleExit(child, new Error(`Codex App Server exited with ${suffix}`));
        resolve();
      });
    });

    child.once("error", (error) => this.#handleExit(child, error));
    child.stdin.on("error", (error) => {
      if (this.child !== child) return;
      child.kill("SIGTERM");
      this.#handleExit(child, error);
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.#handleLine(line));

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      this.stderrTail.push(line);
      this.stderrTail = this.stderrTail.slice(-20);
      this.emit("event", { kind: "stderr", line });
    });

    await this.#requestRaw("initialize", {
      clientInfo: {
        name: "codex_pocket",
        title: "Codex Pocket",
        version: "0.1.0",
      },
    });
    this.#notify("initialized", {});
    this.ready = true;
    this.emit("event", { kind: "gateway", status: "ready", pid: child.pid });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("event", { kind: "protocolError", message: "Invalid JSON from app-server" });
      return;
    }

    if (message.method && message.id !== undefined) {
      const requestId = String(message.id);
      this.#cancelIdleRelease();
      this.serverRequests.set(requestId, message);
      this.emit("event", { kind: "serverRequest", request: message });
      return;
    }

    if (message.method) {
      this.#trackLifecycle(message);
      this.emit("event", { kind: "notification", message });
      return;
    }

    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error) {
      pending.reject(
        new CodexRpcError(message.error.message ?? "Codex RPC request failed", message.error),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #trackLifecycle({ method, params = {} }) {
    if (method === "thread/started" && params.thread?.id) {
      this.loadedThreads.add(params.thread.id);
      if (params.thread.status) this.threadStatuses.set(params.thread.id, params.thread.status);
    }
    if (method === "thread/status/changed" && params.threadId && params.status) {
      this.threadStatuses.set(params.threadId, params.status);
    }
    if (method === "thread/closed" && params.threadId) {
      this.loadedThreads.delete(params.threadId);
      this.activeTurns.delete(params.threadId);
      this.threadStatuses.delete(params.threadId);
      this.#scheduleIdleRelease();
    }
    if (method === "turn/started" && params.threadId && params.turn?.id) {
      if (this.completedTurns.has(params.turn.id)) return;
      this.#cancelIdleRelease();
      this.activeTurns.set(params.threadId, params.turn.id);
    }
    if (method === "turn/completed" && params.threadId) {
      const completedTurnId = params.turn?.id || null;
      if (completedTurnId) {
        this.completedTurns.add(completedTurnId);
        if (this.completedTurns.size > 1_000) {
          this.completedTurns.delete(this.completedTurns.values().next().value);
        }
      }
      const activeTurnId = this.activeTurns.get(params.threadId);
      if (!completedTurnId || !activeTurnId || activeTurnId === completedTurnId) {
        this.activeTurns.delete(params.threadId);
      }
      this.#scheduleIdleRelease();
    }
    if (method === "serverRequest/resolved" && params.requestId !== undefined) {
      const requestId = String(params.requestId);
      if (this.serverRequests.delete(requestId)) {
        this.emit("event", { kind: "serverRequestResolved", requestId });
      }
      this.#scheduleIdleRelease();
    }
  }

  #handleExit(child, error) {
    if (this.child !== child) return;
    const stopReason = this.stopReason;
    this.ready = false;
    this.child = null;
    this.exitPromise = null;
    this.stopReason = null;
    this.#cancelIdleRelease();
    this.loadedThreads.clear();
    this.activeTurns.clear();
    this.completedTurns.clear();
    this.threadStatuses.clear();
    const staleRequestIds = [...this.serverRequests.keys()];
    this.serverRequests.clear();
    for (const requestId of staleRequestIds) {
      this.emit("event", { kind: "serverRequestResolved", requestId });
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("event", {
      kind: "gateway",
      status: stopReason === "idle" ? "idle" : "stopped",
      ...(stopReason ? {} : { error: error.message, stderr: this.stderrTail }),
    });
  }

  #cancelIdleRelease() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleReleaseAt = null;
  }

  #scheduleIdleRelease() {
    this.#cancelIdleRelease();
    if (!this.ready || this.activeTurns.size || this.serverRequests.size) return;
    if (!Number.isFinite(this.idleReleaseMs) || this.idleReleaseMs <= 0) return;

    this.idleReleaseAt = Date.now() + this.idleReleaseMs;
    this.emit("event", {
      kind: "lease",
      status: "scheduled",
      releaseAt: this.idleReleaseAt,
      idleReleaseMs: this.idleReleaseMs,
    });
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.idleReleaseAt = null;
      if (this.activeTurns.size || this.serverRequests.size) return;
      if (!this.prewarmAfterIdle) this.released = true;
      this.stop({ reason: "idle" }).then(() => (
        this.prewarmAfterIdle ? this.start() : undefined
      )).catch((error) => {
        this.emit("event", { kind: "gateway", status: "error", error: error.message });
      });
    }, this.idleReleaseMs);
    this.idleTimer.unref();
  }

  #touchIdleRelease() {
    if (this.idleTimer) this.#scheduleIdleRelease();
  }

  #write(message) {
    const child = this.child;
    if (!child?.stdin?.writable || child.stdin.writableEnded || child.stdin.destroyed) {
      throw new Error("Codex App Server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && this.child === child) this.#handleExit(child, error);
    });
  }

  #notify(method, params) {
    this.#write({ method, params });
  }

  #requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, method });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs) {
    this.#touchIdleRelease();
    await this.start();
    return this.#requestRaw(method, params, timeoutMs);
  }

  async listThreads({ archived = false, searchTerm = null, cursor = null } = {}) {
    return this.request("thread/list", {
      archived,
      cursor,
      limit: 100,
      searchTerm: searchTerm || null,
      useStateDbOnly: true,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: INTERACTIVE_SOURCES,
    });
  }

  async listModels({ cwd = null } = {}) {
    const result = await this.request("model/list", {
      limit: 100,
      includeHidden: false,
    });
    let config = {};
    try {
      const configResult = await this.request("config/read", {
        cwd,
        includeLayers: false,
      });
      config = configResult?.config || {};
    } catch {
      // A model picker can still work when config discovery is unavailable.
    }

    const models = result.data || [];
    const configuredModel = models.find((model) => model.model === config.model);
    const defaultModel = configuredModel
      || models.find((model) => model.isDefault)
      || models[0]
      || null;
    return {
      ...result,
      defaultModel: defaultModel?.model || null,
      defaultEffort: config.model_reasoning_effort
        || defaultModel?.defaultReasoningEffort
        || null,
    };
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  async startThread({ cwd = null, model = null, permission = "workspaceWrite" } = {}) {
    this.#cancelIdleRelease();
    const params = {
      ...threadPermissionParams(permission),
      serviceName: "codex_pocket",
    };
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    const result = await this.request("thread/start", params);
    if (result?.thread?.id) {
      this.loadedThreads.add(result.thread.id);
      this.#scheduleIdleRelease();
    }
    return result;
  }

  async resumeThread(threadId) {
    this.#cancelIdleRelease();
    if (this.loadedThreads.has(threadId)) return { alreadyLoaded: true };
    let result;
    try {
      result = await this.request("thread/resume", { threadId });
    } catch (error) {
      if (!isThreadWriterConflict(error)) throw error;
      throw new CodexRpcError("此任务正在另一个 Codex 客户端中使用", {
        code: "thread_writer_conflict",
        data: { threadId },
      });
    } finally {
      if (!this.activeTurns.size) this.#scheduleIdleRelease();
    }
    this.loadedThreads.add(threadId);
    return result;
  }

  async sendMessage(threadId, text, {
    model = null,
    effort = null,
    images = [],
    permission = "workspaceWrite",
    approvalPolicy = null,
    cwd = null,
  } = {}) {
    await this.resumeThread(threadId);
    if (this.activeTurns.has(threadId)) {
      throw new CodexRpcError("This thread already has an active turn", {
        code: "active_turn",
      });
    }
    const params = {
      threadId,
      input: [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...images.map((path) => ({ type: "localImage", path }))],
      ...turnPermissionParams(permission, cwd, approvalPolicy),
    };
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    if (effort) params.effort = effort;
    try {
      const result = await this.request("turn/start", params);
      if (result?.turn?.id && !this.completedTurns.has(result.turn.id)) {
        this.#cancelIdleRelease();
        this.activeTurns.set(threadId, result.turn.id);
        this.threadStatuses.set(threadId, { type: "active", activeFlags: [] });
      }
      return result;
    } catch (error) {
      // resume may already own the writer even when starting the turn fails.
      this.#scheduleIdleRelease();
      throw error;
    }
  }

  async forkThread(threadId) {
    let resolveAnnouncedThread;
    const announcedThread = new Promise((resolve) => {
      resolveAnnouncedThread = resolve;
    });
    const onEvent = (event) => {
      const thread = event.kind === "notification"
        && event.message?.method === "thread/started"
        ? event.message.params?.thread
        : null;
      if (thread?.id
        && thread.id !== threadId
        && (!thread.forkedFromId || thread.forkedFromId === threadId)) {
        resolveAnnouncedThread(thread);
      }
    };
    this.on("event", onEvent);
    const request = this.request("thread/fork", { threadId });
    let fork;
    try {
      const winner = await Promise.race([
        request.then((value) => ({ source: "response", value })),
        announcedThread.then((thread) => ({ source: "notification", thread })),
      ]);
      if (winner.source === "notification") {
        request.catch(() => {});
        fork = { thread: winner.thread, recoveredFromNotification: true };
      } else {
        fork = winner.value;
      }
    } finally {
      this.off("event", onEvent);
    }
    const forkedThreadId = fork?.thread?.id;
    if (!forkedThreadId) {
      throw new CodexRpcError("Codex did not return the forked thread", {
        code: "invalid_fork_response",
      });
    }
    this.loadedThreads.add(forkedThreadId);
    this.#scheduleIdleRelease();
    return fork;
  }

  async forkAndSend(threadId, text, {
    model = null,
    effort = null,
    images = [],
    permission = "workspaceWrite",
    cwd = null,
  } = {}) {
    const fork = await this.forkThread(threadId);
    const forkedThreadId = fork.thread.id;
    const params = {
      threadId: forkedThreadId,
      input: [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...images.map((path) => ({ type: "localImage", path }))],
      ...turnPermissionParams(permission, cwd),
    };
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    if (effort) params.effort = effort;
    let turn;
    try {
      turn = await this.request("turn/start", params);
      if (turn?.turn?.id && !this.completedTurns.has(turn.turn.id)) {
        this.#cancelIdleRelease();
        this.activeTurns.set(forkedThreadId, turn.turn.id);
        this.threadStatuses.set(forkedThreadId, { type: "active", activeFlags: [] });
      }
    } catch (error) {
      this.#scheduleIdleRelease();
      return {
        thread: fork.thread,
        forkedFromThreadId: threadId,
        sendError: { message: error.message, code: error.code || null },
      };
    }
    return {
      ...turn,
      thread: fork.thread,
      forkedFromThreadId: threadId,
    };
  }

  async steer(threadId, text, turnId = null, images = []) {
    await this.resumeThread(threadId);
    const expectedTurnId = turnId || this.activeTurns.get(threadId);
    if (!expectedTurnId) {
      this.#scheduleIdleRelease();
      throw new CodexRpcError("No active turn is available to steer", {
        code: "no_active_turn",
      });
    }
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...images.map((path) => ({ type: "localImage", path }))],
    });
  }

  async interrupt(threadId, turnId = null) {
    const activeTurnId = turnId || this.activeTurns.get(threadId);
    if (!activeTurnId) {
      throw new CodexRpcError("No active turn is available to interrupt", {
        code: "no_active_turn",
      });
    }
    return this.request("turn/interrupt", { threadId, turnId: activeTurnId });
  }

  async respondToServerRequest(requestId, result) {
    this.#cancelIdleRelease();
    await this.start();
    const request = this.serverRequests.get(String(requestId));
    if (!request) throw new Error("Approval request is no longer pending");
    this.#write({ id: request.id, result });
    this.serverRequests.delete(String(requestId));
    this.emit("event", {
      kind: "serverRequestResolved",
      requestId: String(requestId),
    });
    this.#scheduleIdleRelease();
    return { ok: true };
  }

  getStatus() {
    return {
      ready: this.ready,
      pid: this.child?.pid ?? null,
      activeTurns: Object.fromEntries(this.activeTurns),
      threadStatuses: Object.fromEntries(this.threadStatuses),
      pendingApprovals: this.serverRequests.size,
      stderr: this.ready ? [] : this.stderrTail,
      idle: !this.ready && !this.child,
      idleReleaseAt: this.idleReleaseAt,
      idleReleaseMs: this.idleReleaseMs,
      released: this.released,
    };
  }

  listPendingRequests() {
    return [...this.serverRequests.entries()].map(([id, request]) => ({ id, request }));
  }

  async stop({ reason = "shutdown" } = {}) {
    if (this.stopPromise) return this.stopPromise;
    if (!this.prewarmAfterIdle || reason !== "idle") this.released = true;
    this.#cancelIdleRelease();
    if (!this.child) return;

    this.stopPromise = (async () => {
      const child = this.child;
      const exitPromise = this.exitPromise;
      this.stopReason = reason;
      child.stdin?.end();

      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (this.child === child) child.kill("SIGTERM");
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (this.child === child) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }
}
