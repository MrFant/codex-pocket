import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CodexClient, CodexRpcError } from "./codex-client.mjs";

function isThreadHistoryUnsupported(error) {
  return error?.code === -32601 && error.message === "list_turns is not supported yet";
}

function isThreadNotMaterialized(error) {
  return /not materialized yet|includeTurns is unavailable before first user message/i.test(error?.message || "");
}

function uniqueClients(metadataClient, workers, pendingWorkers) {
  return new Set([metadataClient, ...workers.values(), ...pendingWorkers]);
}

/**
 * Keeps read-only App Server traffic separate from writer-owning thread workers.
 * Each Pocket thread gets its own worker, so an active turn or approval in one
 * conversation cannot keep unrelated thread writers locked.
 */
export class CodexRuntimePool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clientOptions = options.clientOptions || {};
    this.clientFactory = options.clientFactory
      || ((clientOptions) => new CodexClient(clientOptions));
    this.metadataClient = options.metadataClient || this.clientFactory({
      ...this.clientOptions,
      prewarmAfterIdle: true,
    });
    this.workers = new Map();
    this.failedTurns = new Map();
    this.pendingWorkers = new Set();
    this.clientIds = new WeakMap();
    this.approvals = new Map();
    this.approvalsByClient = new WeakMap();
    this.operations = new Map();
    this.inFlightOperations = new Set();
    this.nextClientId = 1;
    this.runtimeNonce = randomUUID();
    this.stopping = false;
    this.stopPromise = null;
    this.#attach(this.metadataClient, { metadata: true });
  }

  #clientId(client) {
    let id = this.clientIds.get(client);
    if (!id) {
      id = `runtime-${this.nextClientId++}`;
      this.clientIds.set(client, id);
    }
    return id;
  }

  #attach(client, { metadata = false } = {}) {
    this.#clientId(client);
    this.approvalsByClient.set(client, new Map());
    client.on("event", (event) => this.#handleClientEvent(client, event, { metadata }));
  }

  #newWorker() {
    this.#assertRunning();
    const client = this.clientFactory({
      ...this.clientOptions,
      prewarmAfterIdle: false,
    });
    this.pendingWorkers.add(client);
    this.#attach(client);
    return client;
  }

  #bindWorker(threadId, client) {
    this.#assertRunning();
    this.pendingWorkers.delete(client);
    this.workers.set(threadId, client);
  }

  #workerFor(threadId) {
    const existing = this.workers.get(threadId);
    if (existing) return existing;
    const client = this.#newWorker();
    this.#bindWorker(threadId, client);
    return client;
  }

  #serialize(threadId, operation) {
    const previous = this.operations.get(threadId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(threadId, current);
    return current.finally(() => {
      if (this.operations.get(threadId) === current) this.operations.delete(threadId);
    });
  }

  #trackOperation(operation) {
    const promise = Promise.resolve().then(() => {
      this.#assertRunning();
      return operation();
    });
    this.inFlightOperations.add(promise);
    return promise.finally(() => this.inFlightOperations.delete(promise));
  }

  #removeWorker(client) {
    this.pendingWorkers.delete(client);
    for (const [threadId, candidate] of this.workers) {
      if (candidate === client) { this.workers.delete(threadId); this.failedTurns.delete(threadId); }
    }
  }

  #externalApprovalId(client) {
    return `${this.runtimeNonce}:${this.#clientId(client)}:${randomUUID()}`;
  }

  #assertRunning() {
    if (this.stopping) {
      throw new CodexRpcError("Codex Pocket is shutting down", { code: "runtime_stopping" });
    }
  }

  #handleClientEvent(client, event, { metadata = false } = {}) {
    if (event.kind === "notification") {
      const { method, params = {} } = event.message || {};
      if (method === "turn/started") this.failedTurns.delete(params.threadId);
      if (method === "turn/completed" && params.turn?.status === "failed") {
        const active = client.getStatus().activeTurns?.[params.threadId];
        if (!active || active === params.turn.id) this.failedTurns.set(params.threadId, params.turn.id);
        if (this.failedTurns.size > 1000) this.failedTurns.delete(this.failedTurns.keys().next().value);
      }
    }
    if (event.kind === "serverRequest") {
      const rawId = String(event.request.id);
      const id = this.#externalApprovalId(client);
      const request = { ...event.request, id };
      this.approvals.set(id, { client, rawId, request });
      this.approvalsByClient.get(client)?.set(rawId, id);
      this.emit("event", { ...event, request });
      return;
    }

    if (event.kind === "serverRequestResolved") {
      const rawId = String(event.requestId);
      const id = this.approvalsByClient.get(client)?.get(rawId);
      if (!id) return;
      this.approvalsByClient.get(client)?.delete(rawId);
      this.approvals.delete(id);
      this.emit("event", { ...event, requestId: id });
      return;
    }

    if (event.kind === "gateway") {
      const threadId = metadata
        ? null
        : [...this.workers].find(([, candidate]) => candidate === client)?.[0] || null;
      if (!metadata && ["idle", "stopped", "error"].includes(event.status)) {
        this.#removeWorker(client);
      }
      if (!this.stopping) {
        const status = this.getStatus();
        this.emit("event", {
          kind: "gateway",
          status: status.ready ? "ready" : status.idle ? "idle" : "stopped",
          ...(threadId ? { threadId, runtimeStatus: event.status } : {}),
          ...(event.error ? { error: event.error } : {}),
        });
      }
      return;
    }

    if (event.kind === "lease") {
      const threadId = [...this.workers].find(([, candidate]) => candidate === client)?.[0] || null;
      this.emit("event", { ...event, threadId });
      return;
    }

    this.emit("event", event);
  }

  async #discardWorker(client, reason = "error") {
    this.#removeWorker(client);
    await client.stop({ reason }).catch(() => {});
  }

  async start() {
    this.#assertRunning();
    await this.metadataClient.start();
  }

  listThreads(options) {
    this.#assertRunning();
    return this.metadataClient.listThreads(options);
  }

  listModels(options) {
    this.#assertRunning();
    return this.metadataClient.listModels(options);
  }

  readThread(threadId) {
    this.#assertRunning();
    return this.#serialize(threadId, async () => {
      const boundWorker = this.workers.get(threadId);
      if (boundWorker) {
        try {
          return await boundWorker.readThread(threadId);
        } catch (error) {
          // App Server creates a start-only thread before its rollout exists.
          // thread/read cannot include turns until the first user message, but
          // the caller still needs a valid empty thread to open the composer.
          if (isThreadNotMaterialized(error)) {
            return boundWorker.readThread(threadId, { includeTurns: false });
          }
          if (isThreadHistoryUnsupported(error)) {
            // CLI 0.154 can return thread/start before its paginated history
            // backend supports list_turns. The control process can still read
            // persisted turns. Keep the writer's live model/settings, and use
            // actual stored history rather than assuming this thread is empty.
            const summary = await boundWorker.readThread(threadId, { includeTurns: false });
            const history = await this.metadataClient.readThread(threadId);
            return {
              ...history,
              thread: {
                ...history.thread,
                ...summary.thread,
                model: summary.thread.model ?? history.thread.model,
                reasoningEffort: summary.thread.reasoningEffort ?? history.thread.reasoningEffort,
                turns: history.thread.turns,
              },
            };
          }
          if (error?.code !== "runtime_released") throw error;
          // The idle timer may have released the worker between lookup and
          // read. Fall through to the read-only metadata process.
          this.#removeWorker(boundWorker);
        }
      }

      // Even a "not loaded" response must not turn a read into a writer lease.
      return this.metadataClient.readThread(threadId);
    });
  }

  startThread(options) {
    this.#assertRunning();
    return this.#trackOperation(async () => {
      const client = this.#newWorker();
      try {
        const result = await client.startThread(options);
        const threadId = result?.thread?.id;
        if (!threadId) throw new CodexRpcError("Codex did not return the new thread", {
          code: "invalid_thread_response",
        });
        this.#bindWorker(threadId, client);
        return result;
      } catch (error) {
        await this.#discardWorker(client);
        throw error;
      }
    });
  }

  async sendMessage(threadId, text, options) {
    this.#assertRunning();
    return this.#serialize(threadId, async () => {
      this.#assertRunning();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const client = this.#workerFor(threadId);
        try {
          return await client.sendMessage(threadId, text, options);
        } catch (error) {
          if (error?.code === "runtime_released") {
            await this.#discardWorker(client, "released");
            continue;
          }
          if (error?.code === "thread_writer_conflict") {
            await this.#discardWorker(client, "conflict");
          }
          throw error;
        }
      }
      throw new CodexRpcError("The thread runtime changed while sending", {
        code: "runtime_released",
      });
    });
  }

  forkAndSend(threadId, text, options) {
    this.#assertRunning();
    return this.#trackOperation(async () => {
      const client = this.#newWorker();
      try {
        const result = await client.forkAndSend(threadId, text, options);
        const forkedThreadId = result?.thread?.id;
        if (!forkedThreadId) throw new CodexRpcError("Codex did not return the forked thread", {
          code: "invalid_fork_response",
        });
        this.#bindWorker(forkedThreadId, client);
        return result;
      } catch (error) {
        await this.#discardWorker(client);
        throw error;
      }
    });
  }

  steer(threadId, text, turnId = null, images = []) {
    this.#assertRunning();
    return this.#serialize(threadId, () => {
      this.#assertRunning();
      const client = this.workers.get(threadId);
      const activeTurnId = client?.getStatus().activeTurns?.[threadId] || null;
      if (!client || !activeTurnId) {
        throw new CodexRpcError("No active turn is available to steer", { code: "no_active_turn" });
      }
      if (turnId && turnId !== activeTurnId) {
        throw new CodexRpcError("回合状态已经变化，请刷新后重试", {
          code: "stale_turn",
          data: { threadId, requestedTurnId: turnId, activeTurnId },
        });
      }
      return client.steer(threadId, text, activeTurnId, images);
    });
  }

  interrupt(threadId, turnId = null) {
    this.#assertRunning();
    return this.#serialize(threadId, () => {
      this.#assertRunning();
      const client = this.workers.get(threadId);
      const activeTurnId = client?.getStatus().activeTurns?.[threadId] || null;
      if (!client || !activeTurnId) {
        throw new CodexRpcError("No active turn is available to interrupt", { code: "no_active_turn" });
      }
      if (turnId && turnId !== activeTurnId) {
        throw new CodexRpcError("回合状态已经变化，请刷新后重试", {
          code: "stale_turn",
          data: { threadId, requestedTurnId: turnId, activeTurnId },
        });
      }
      return client.interrupt(threadId, activeTurnId);
    });
  }

  releaseThread(threadId) {
    this.#assertRunning();
    return this.#serialize(threadId, async () => {
      this.#assertRunning();
      const client = this.workers.get(threadId);
      if (!client) return { ok: true, released: false };
      const status = client.getStatus();
      if (Object.keys(status.activeTurns || {}).length || status.pendingApprovals) {
        throw new CodexRpcError("当前会话仍在运行或等待确认，暂时不能释放", { code: "runtime_busy" });
      }
      await this.#discardWorker(client, "manual");
      return { ok: true, released: true };
    });
  }

  async respondToServerRequest(requestId, result) {
    this.#assertRunning();
    const approval = this.approvals.get(String(requestId));
    if (!approval) throw new Error("Approval request is no longer pending");
    return approval.client.respondToServerRequest(approval.rawId, result);
  }

  listPendingRequests() {
    return [...this.approvals.entries()].map(([id, approval]) => ({
      id,
      request: approval.request,
    }));
  }

  getStatus() {
    const clients = uniqueClients(this.metadataClient, this.workers, this.pendingWorkers);
    const statuses = [...clients].map((client) => ({ client, status: client.getStatus() }));
    const activeTurns = {};
    const threadStatuses = {};
    const workerPids = {};
    const workers = {};
    let idleReleaseAt = null;
    for (const { client, status } of statuses) {
      Object.assign(activeTurns, status.activeTurns || {});
      Object.assign(threadStatuses, status.threadStatuses || {});
      if (status.idleReleaseAt && (!idleReleaseAt || status.idleReleaseAt < idleReleaseAt)) {
        idleReleaseAt = status.idleReleaseAt;
      }
      const threadId = [...this.workers].find(([, candidate]) => candidate === client)?.[0];
      if (threadId && status.pid) workerPids[threadId] = status.pid;
      if (threadId) workers[threadId] = {
        pid: status.pid, idleReleaseAt: status.idleReleaseAt,
        busy: Boolean(Object.keys(status.activeTurns || {}).length || status.pendingApprovals || this.operations.has(threadId)),
        pendingApprovals: status.pendingApprovals,
      };
    }
    for (const [threadId, turnId] of this.failedTurns) {
      if (!activeTurns[threadId]) threadStatuses[threadId] = { type: "systemError", failedTurnId: turnId };
    }
    const metadataStatus = this.metadataClient.getStatus();
    const ready = statuses.some(({ status }) => status.ready);
    return {
      ready,
      pid: metadataStatus.pid || statuses.find(({ status }) => status.pid)?.status.pid || null,
      metadataPid: metadataStatus.pid || null,
      workerPids,
      workers,
      workerCount: this.workers.size + this.pendingWorkers.size,
      activeTurns,
      threadStatuses,
      pendingApprovals: this.approvals.size,
      stderr: ready ? [] : statuses.flatMap(({ status }) => status.stderr || []).slice(-20),
      idle: !ready,
      idleReleaseAt,
      idleReleaseMs: this.clientOptions.idleReleaseMs
        ?? Number(process.env.POCKET_IDLE_RELEASE_MS || 3 * 60 * 1_000),
    };
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      const firstPass = uniqueClients(this.metadataClient, this.workers, this.pendingWorkers);
      await Promise.allSettled([...firstPass].map((client) => client.stop()));
      await Promise.allSettled([...this.operations.values()]);
      await Promise.allSettled([...this.inFlightOperations]);
      const secondPass = uniqueClients(this.metadataClient, this.workers, this.pendingWorkers);
      await Promise.allSettled([...secondPass].map((client) => client.stop()));
      this.workers.clear();
      this.pendingWorkers.clear();
      this.approvals.clear();
      this.operations.clear();
      this.inFlightOperations.clear();
    })();
    return this.stopPromise;
  }
}
