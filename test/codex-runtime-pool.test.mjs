import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexClient, CodexRpcError } from "../lib/codex-client.mjs";
import { CodexRuntimePool } from "../lib/codex-runtime-pool.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

function makePool(options = {}) {
  return new CodexRuntimePool({
    clientOptions: {
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 2_000,
      idleReleaseMs: 70,
      ...options,
    },
    clientFactory: (clientOptions) => new CodexClient(clientOptions),
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state");
    await wait(10);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

class ControlledRuntimeClient extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.ready = false;
    this.released = false;
    this.stopPromise = null;
    this.blockedSend = null;
    this.loadedThreads = new Set();
  }

  async start() {
    if (this.released) {
      throw new CodexRpcError("runtime released", { code: "runtime_released" });
    }
    this.ready = true;
  }

  async sendMessage(_threadId, text) {
    if (this.released) {
      throw new CodexRpcError("runtime released", { code: "runtime_released" });
    }
    this.ready = true;
    if (text === "block") {
      this.blockedSend = deferred();
      return this.blockedSend.promise;
    }
    return { turn: { id: `turn-${this.id}` } };
  }

  async startThread() {
    if (this.released) {
      throw new CodexRpcError("runtime released", { code: "runtime_released" });
    }
    this.ready = true;
    const threadId = "thread-new";
    this.loadedThreads.add(threadId);
    return { thread: { id: threadId } };
  }

  async resumeThread(threadId) {
    if (this.released) {
      throw new CodexRpcError("runtime released", { code: "runtime_released" });
    }
    this.ready = true;
    this.loadedThreads.add(threadId);
    return { thread: { id: threadId } };
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    if (this.released) {
      throw new CodexRpcError("runtime released", { code: "runtime_released" });
    }
    if (this.id === 0 && threadId === "thread-needs-resume") {
      throw new CodexRpcError(`thread not loaded: ${threadId}`, { code: -32600 });
    }
    if (this.id > 0 && threadId === "thread-new" && includeTurns) {
      throw new CodexRpcError(
        `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`,
        { code: -32600 },
      );
    }
    if (this.id > 0 && !this.loadedThreads.has(threadId)) {
      throw new CodexRpcError(`thread not loaded: ${threadId}`, { code: -32600 });
    }
    return { thread: { id: threadId } };
  }

  beginIdleRelease() {
    this.released = true;
    const gate = deferred();
    this.stopPromise = gate.promise.then(() => {
      this.ready = false;
      this.emit("event", { kind: "gateway", status: "idle" });
    });
    return gate.resolve;
  }

  finishBlockedSend() {
    this.blockedSend.resolve({ turn: { id: `turn-${this.id}` } });
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.released = true;
    this.ready = false;
    this.emit("event", { kind: "gateway", status: "stopped" });
  }

  getStatus() {
    return {
      ready: this.ready,
      released: this.released,
      pid: this.ready ? 10_000 + this.id : null,
      activeTurns: {},
      threadStatuses: {},
      pendingApprovals: 0,
      stderr: [],
      idle: !this.ready,
      idleReleaseAt: null,
    };
  }
}

function makeControlledPool() {
  const clients = [];
  const pool = new CodexRuntimePool({
    clientFactory: () => {
      const client = new ControlledRuntimeClient(clients.length);
      clients.push(client);
      return client;
    },
  });
  return { clients, pool };
}

test("isolates writer leases so one active thread cannot hold another", async (t) => {
  const pool = makePool();
  t.after(() => pool.stop());
  await pool.start();

  await pool.sendMessage("thread-a", "keep running");
  await pool.sendMessage("thread-b", "finish independently");
  assert.equal(pool.getStatus().workerCount, 2);

  await pool.interrupt("thread-b");
  await waitUntil(() => pool.getStatus().workerCount === 1);
  assert.equal(pool.getStatus().workerCount, 1);
  assert.equal(pool.getStatus().activeTurns["thread-a"], "turn-1");
  assert.equal(pool.getStatus().workerPids["thread-b"], undefined);

  await pool.interrupt("thread-a");
  await waitUntil(() => pool.getStatus().workerCount === 0);
  assert.equal(pool.getStatus().workerCount, 0);
  assert.equal(pool.getStatus().ready, true, "the read-only control plane stays warm");
});

test("routes colliding raw approval ids to the correct thread workers", async (t) => {
  const pool = makePool();
  t.after(() => pool.stop());
  await pool.start();

  await pool.sendMessage("thread-a", "needs approval");
  await pool.sendMessage("thread-b", "needs approval");
  await wait(20);
  const approvals = pool.listPendingRequests();
  assert.equal(approvals.length, 2);
  assert.notEqual(approvals[0].id, approvals[1].id);
  assert.deepEqual(
    new Set(approvals.map(({ request }) => request.params.threadId)),
    new Set(["thread-a", "thread-b"]),
  );

  await pool.respondToServerRequest(approvals[0].id, { decision: "accept" });
  assert.equal(pool.listPendingRequests().length, 1);
  assert.equal(
    pool.listPendingRequests()[0].request.params.threadId,
    approvals[1].request.params.threadId,
  );
});

test("routes every interactive approval response back to its worker", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-approval-routing-"));
  const auditPath = path.join(directory, "approval-responses.jsonl");
  const previousAuditPath = process.env.FAKE_APPROVAL_AUDIT_PATH;
  process.env.FAKE_APPROVAL_AUDIT_PATH = auditPath;
  const pool = makePool({ idleReleaseMs: 5_000 });
  t.after(async () => {
    await pool.stop();
    if (previousAuditPath === undefined) delete process.env.FAKE_APPROVAL_AUDIT_PATH;
    else process.env.FAKE_APPROVAL_AUDIT_PATH = previousAuditPath;
    await rm(directory, { recursive: true, force: true });
  });
  await pool.start();

  const cases = [
    {
      threadId: "thread-command-approval",
      text: "approval:command-long",
      method: "item/commandExecution/requestApproval",
      rawId: "approval-command-long",
      result: { decision: "accept" },
    },
    {
      threadId: "thread-file-approval",
      text: "approval:file",
      method: "item/fileChange/requestApproval",
      rawId: "approval-file",
      result: { decision: "acceptForSession" },
    },
    {
      threadId: "thread-user-input",
      text: "approval:user-input",
      method: "item/tool/requestUserInput",
      rawId: "approval-user-input",
      result: {
        answers: {
          choice: { answers: ["方案 A"] },
          secret: { answers: ["test-secret"] },
        },
      },
    },
    {
      threadId: "thread-permissions-approval",
      text: "approval:permissions",
      method: "item/permissions/requestApproval",
      rawId: "approval-permissions",
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/project/input.txt"],
            write: ["/tmp/project/output.txt"],
          },
        },
        scope: "session",
        strictAutoReview: true,
      },
    },
  ];

  await Promise.all(cases.map(({ threadId, text }) => pool.sendMessage(threadId, text)));
  await waitUntil(() => pool.listPendingRequests().length === cases.length);

  const approvalsByMethod = new Map(
    pool.listPendingRequests().map((approval) => [approval.request.method, approval]),
  );
  for (const testCase of cases) {
    const approval = approvalsByMethod.get(testCase.method);
    assert.ok(approval, `missing ${testCase.method}`);
    assert.equal(approval.request.params.threadId, testCase.threadId);
    assert.equal(approval.request.params.itemId.length > 0, true);
    await pool.respondToServerRequest(approval.id, testCase.result);
  }
  assert.equal(pool.listPendingRequests().length, 0);

  let audited = [];
  await waitUntil(async () => {
    try {
      audited = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return audited.length === cases.length;
    } catch {
      return false;
    }
  });
  const auditById = new Map(audited.map((entry) => [entry.id, entry.result]));
  for (const testCase of cases) {
    assert.deepEqual(auditById.get(testCase.rawId), testCase.result);
  }
});

test("serializes same-thread sends and records the active turn from the RPC response", async (t) => {
  const pool = makePool();
  t.after(() => pool.stop());
  await pool.start();

  const first = pool.sendMessage("thread-a", "first");
  const second = pool.sendMessage("thread-a", "second");
  assert.equal((await first).turn.id, "turn-1");
  await assert.rejects(
    second,
    (error) => error instanceof CodexRpcError && error.code === "active_turn",
  );
  assert.equal(pool.getStatus().workerCount, 1);
});

test("releases start-only threads and preserves a fork id when its first turn fails", async (t) => {
  const pool = makePool();
  t.after(() => pool.stop());
  await pool.start();

  const started = await pool.startThread({ cwd: "/tmp/project" });
  assert.equal(started.thread.id, "thread-new");
  await waitUntil(() => pool.getStatus().workerCount === 0);
  assert.equal(pool.getStatus().workerCount, 0, "a start-only writer must expire");

  const forked = await pool.forkAndSend("thread-source", "fail turn");
  assert.equal(forked.thread.id, "thread-source-fork");
  assert.equal(forked.sendError.code, -32001);
  assert.equal(pool.getStatus().workerCount, 1);
  await waitUntil(() => pool.getStatus().workerCount === 0);
  assert.equal(pool.getStatus().workerCount, 0);
});

test("reads a newly started thread without acquiring writers for unloaded metadata threads", async (t) => {
  const { clients, pool } = makeControlledPool();
  t.after(() => pool.stop());
  await pool.start();

  await pool.startThread({ cwd: "/tmp/project" });
  const startedRead = await pool.readThread("thread-new");
  assert.equal(startedRead.thread.id, "thread-new");
  assert.equal(clients[0].loadedThreads.has("thread-new"), false);
  assert.equal(clients[1].loadedThreads.has("thread-new"), true);

  await assert.rejects(() => pool.readThread("thread-needs-resume"), /thread not loaded/);
  assert.equal(clients.length, 2, "reading must not create or resume a writer");
  assert.equal(pool.getStatus().workerCount, 1);
});

test("reads persisted turns when a paginated writer cannot list turns, preserving its settings", async (t) => {
  const { clients, pool } = makeControlledPool();
  t.after(() => pool.stop());
  await pool.startThread();
  const calls = [];
  const turns = [{ id: "turn-saved", items: [{ id: "saved-message", type: "agentMessage", text: "Keep this history" }] }];
  clients[1].readThread = async (id, { includeTurns = true } = {}) => {
    calls.push(["writer", includeTurns]);
    if (includeTurns) throw new CodexRpcError("list_turns is not supported yet", { code: -32601 });
    return { thread: { id, model: "gpt-session", reasoningEffort: "high", status: { type: "idle" }, turns: [] } };
  };
  clients[0].readThread = async (id) => {
    calls.push(["metadata", true]);
    return { thread: { id, model: null, reasoningEffort: null, status: { type: "notLoaded" }, turns } };
  };

  const result = await pool.readThread("thread-new");
  assert.deepEqual(result.thread.turns, turns, "unsupported history must not become an empty conversation");
  assert.equal(result.thread.model, "gpt-session");
  assert.equal(result.thread.reasoningEffort, "high");
  assert.equal(result.thread.status.type, "idle");
  assert.deepEqual(calls, [["writer", true], ["writer", false], ["metadata", true]]);
  assert.equal(clients.length, 2);
  assert.equal(pool.getStatus().workerCount, 1);
});

test("propagates failed history fallback without inventing empty turns or acquiring a writer", async (t) => {
  const { clients, pool } = makeControlledPool();
  t.after(() => pool.stop());
  await pool.startThread();
  clients[1].readThread = async (id, { includeTurns = true } = {}) => {
    if (includeTurns) throw new CodexRpcError("list_turns is not supported yet", { code: -32601 });
    return { thread: { id, turns: [] } };
  };
  clients[0].readThread = async () => { throw new CodexRpcError("thread not loaded", { code: -32600 }); };

  await assert.rejects(() => pool.readThread("thread-new"), /thread not loaded/);
  assert.equal(clients.length, 2);
  assert.equal(pool.getStatus().workerCount, 1);
  assert.equal(clients[1].released, false);
});

test("read-only operations never create a thread worker and conflicts discard empty workers", async (t) => {
  const pool = makePool();
  t.after(() => pool.stop());
  await pool.start();

  await pool.listThreads();
  await pool.readThread("thread-1");
  await pool.listModels({ cwd: "/tmp/project" });
  assert.equal(pool.getStatus().workerCount, 0);

  await assert.rejects(
    () => pool.sendMessage("thread-busy", "continue"),
    (error) => error instanceof CodexRpcError && error.code === "thread_writer_conflict",
  );
  assert.equal(pool.getStatus().workerCount, 0);
});

test("rejects stale browser turn ids after the authoritative turn completes", async (t) => {
  const pool = makePool({ idleReleaseMs: 500 });
  t.after(() => pool.stop());
  await pool.start();

  const first = await pool.sendMessage("thread-stale", "first");
  await pool.interrupt("thread-stale", first.turn.id);
  await waitUntil(() => !pool.getStatus().activeTurns["thread-stale"]);
  await assert.rejects(
    () => pool.steer("thread-stale", "stale steer", "turn-1"),
    (error) => error instanceof CodexRpcError && error.code === "no_active_turn",
  );
  await assert.rejects(
    () => pool.interrupt("thread-stale", "turn-1"),
    (error) => error instanceof CodexRpcError && error.code === "no_active_turn",
  );

  const second = await pool.sendMessage("thread-stale", "start unique second turn");
  assert.equal(second.turn.id, "turn-2");
  await assert.rejects(
    () => pool.steer("thread-stale", "must not reach turn two", "turn-1"),
    (error) => error instanceof CodexRpcError && error.code === "stale_turn",
  );
  await assert.rejects(
    () => pool.interrupt("thread-stale", "turn-1"),
    (error) => error instanceof CodexRpcError && error.code === "stale_turn",
  );
  assert.equal(pool.getStatus().activeTurns["thread-stale"], "turn-2");
  await pool.interrupt("thread-stale", "turn-2");
});

test("waits for an idle-released writer before retrying a send on a fresh worker", async (t) => {
  const { clients, pool } = makeControlledPool();
  t.after(() => pool.stop());
  await pool.start();

  await pool.sendMessage("thread-a", "first");
  const oldWorker = clients[1];
  const finishIdleStop = oldWorker.beginIdleRelease();
  const replacementSend = pool.sendMessage("thread-a", "after idle boundary");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients.length, 2, "a replacement must wait until the old writer has stopped");

  finishIdleStop();
  const result = await replacementSend;
  assert.equal(result.turn.id, "turn-2");
  assert.equal(clients.length, 3);
  assert.equal(pool.getStatus().workerCount, 1);
});

test("rejects a queued same-thread operation once pool shutdown begins", async () => {
  const { clients, pool } = makeControlledPool();
  await pool.start();

  const first = pool.sendMessage("thread-a", "block");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(clients[1].blockedSend, "the first operation must be in flight");

  const queued = pool.sendMessage("thread-a", "must not start");
  const queuedAssertion = assert.rejects(
    queued,
    (error) => error instanceof CodexRpcError && error.code === "runtime_stopping",
  );
  const stopping = pool.stop();
  clients[1].finishBlockedSend();

  assert.equal((await first).turn.id, "turn-1");
  await queuedAssertion;
  await stopping;
  assert.equal(clients.length, 2, "shutdown must not create a late replacement worker");
  assert.equal(pool.getStatus().workerCount, 0);
});

test("identifies an active thread whose worker exits unexpectedly", async (t) => {
  const pool = makePool();
  t.after(() => pool.stop());
  await pool.start();

  const crashed = new Promise((resolve) => {
    const listener = (event) => {
      if (event.kind !== "gateway" || event.threadId !== "thread-crash" || !event.error) return;
      pool.off("event", listener);
      resolve(event);
    };
    pool.on("event", listener);
  });
  await pool.sendMessage("thread-crash", "exit during turn");
  const event = await crashed;

  assert.equal(event.runtimeStatus, "stopped");
  assert.equal(event.status, "ready", "the metadata control plane remains available");
  assert.equal(pool.getStatus().activeTurns["thread-crash"], undefined);
  assert.equal(pool.getStatus().workerCount, 0);
});

test("manual release is serialized, refuses active or approval-bound workers, and leaves other leases intact", async (t) => {
  const pool = makePool({ idleReleaseMs: 60_000 });
  t.after(() => pool.stop());
  assert.deepEqual(await pool.releaseThread("unloaded"), { ok: true, released: false });
  assert.equal(pool.getStatus().workerCount, 0);
  const send = pool.sendMessage("thread-a", "needs approval");
  const release = pool.releaseThread("thread-a");
  await assert.rejects(release, (error) => error.code === "runtime_busy");
  await send;
  await waitUntil(() => pool.listPendingRequests().length === 1);
  await pool.interrupt("thread-a");
  await waitUntil(() => !pool.getStatus().activeTurns["thread-a"]);
  await assert.rejects(pool.releaseThread("thread-a"), (error) => error.code === "runtime_busy");
  await pool.respondToServerRequest(pool.listPendingRequests()[0].id, { decision: "decline" });
  await pool.sendMessage("thread-b", "keep working");
  const otherPid = pool.getStatus().workerPids["thread-b"];
  assert.ok(pool.getStatus().workers["thread-a"].idleReleaseAt > Date.now());
  assert.equal(pool.getStatus().workers["thread-a"].busy, false);
  assert.deepEqual(await pool.releaseThread("thread-a"), { ok: true, released: true });
  assert.equal(pool.getStatus().workers["thread-a"], undefined);
  assert.equal(pool.getStatus().workerPids["thread-b"], otherPid);
  assert.equal(pool.getStatus().workers["thread-b"].busy, true);
});
