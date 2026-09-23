import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexClient, CodexRpcError } from "../lib/codex-client.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

function makeClient(options = {}) {
  return new CodexClient({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 2_000,
    ...options,
  });
}

function waitForEvent(client, predicate) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (!predicate(event)) return;
      client.off("event", listener);
      resolve(event);
    };
    client.on("event", listener);
  });
}

test("lists, reads, resumes, sends, steers, and interrupts a thread", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  const models = await client.listModels({ cwd: "/tmp/project" });
  assert.equal(models.data[0].model, "gpt-test");
  assert.equal(models.data[0].defaultReasoningEffort, "medium");
  assert.equal(models.defaultModel, "gpt-test");
  assert.equal(models.defaultEffort, "high");

  const list = await client.listThreads();
  assert.equal(list.data[0].id, "thread-1");

  const read = await client.readThread("thread-1");
  assert.equal(read.thread.turns[0].id, "turn-old");

  const started = waitForEvent(
    client,
    (event) => event.kind === "notification" && event.message.method === "turn/started",
  );
  const turn = await client.sendMessage("thread-1", "hello", {
    model: "gpt-test",
    effort: "high",
  });
  assert.equal(turn.turn.id, "turn-1");
  assert.equal(turn.turn.model, "gpt-test");
  assert.equal(turn.turn.effort, "high");
  await started;
  assert.equal(client.getStatus().activeTurns["thread-1"], "turn-1");
  assert.equal(client.getStatus().threadStatuses["thread-1"].type, "active");

  const steered = await client.steer("thread-1", "be concise");
  assert.equal(steered.turnId, "turn-1");

  await assert.rejects(
    () => client.sendMessage("thread-1", "second turn"),
    (error) => error instanceof CodexRpcError && error.code === "active_turn",
  );

  const completed = waitForEvent(
    client,
    (event) => event.kind === "notification" && event.message.method === "turn/completed",
  );
  await client.interrupt("thread-1");
  await completed;
  assert.equal(client.getStatus().activeTurns["thread-1"], undefined);
  assert.equal(client.getStatus().threadStatuses["thread-1"].type, "idle");
});

test("reads thread settings without requesting turns or loading a writer", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  const result = await client.readThread("thread-1", { includeTurns: false });
  assert.deepEqual(result.thread.turns, []);
  assert.equal(result.thread.model, "gpt-original");
  assert.equal(result.thread.reasoningEffort, "high");
  assert.equal(client.loadedThreads.size, 0);
});

test("starts a thread and applies permission presets to new turns", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  const created = await client.startThread({
    cwd: "/tmp/new-project",
    model: "gpt-test",
    permission: "readOnly",
  });
  assert.equal(created.thread.id, "thread-new");
  assert.equal(created.thread.cwd, "/tmp/new-project");
  assert.equal(created.thread.approvalPolicy, "never");
  assert.equal(created.thread.sandbox, "read-only");

  const turn = await client.sendMessage("thread-new", "make the change", {
    cwd: "/tmp/new-project",
    permission: "workspaceWrite",
  });
  assert.equal(turn.turn.cwd, "/tmp/new-project");
  assert.equal(turn.turn.approvalPolicy, "on-request");
  assert.equal(turn.turn.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(turn.turn.sandboxPolicy.writableRoots, ["/tmp/new-project"]);
  assert.equal(turn.turn.sandboxPolicy.networkAccess, false);
});

test("tracks and resolves App Server approval requests", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  const approvalEvent = new Promise((resolve) => {
    const listener = (event) => {
      if (event.kind === "serverRequest") {
        client.off("event", listener);
        resolve(event);
      }
    };
    client.on("event", listener);
  });

  await client.request("test/requestApproval");
  const event = await approvalEvent;
  assert.equal(event.request.id, "approval-1");
  assert.equal(client.listPendingRequests().length, 1);

  await client.respondToServerRequest("approval-1", { decision: "accept" });
  assert.equal(client.listPendingRequests().length, 0);
});

test("clears externally resolved approvals and schedules the idle release", async (t) => {
  const client = makeClient({ idleReleaseMs: 500 });
  t.after(() => client.stop());

  const approval = waitForEvent(client, (event) => event.kind === "serverRequest");
  const resolved = waitForEvent(
    client,
    (event) => event.kind === "serverRequestResolved"
      && event.requestId === "approval-resolved",
  );
  await client.request("test/requestApprovalThenResolve");
  await approval;
  assert.equal(client.listPendingRequests().length, 1);
  await resolved;
  assert.equal(client.listPendingRequests().length, 0);
  assert.ok(client.getStatus().idleReleaseAt > Date.now());
});

test("drops stale approvals when App Server exits", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  const approval = waitForEvent(client, (event) => event.kind === "serverRequest");
  const resolved = waitForEvent(
    client,
    (event) => event.kind === "serverRequestResolved"
      && event.requestId === "approval-before-exit",
  );
  const stopped = waitForEvent(
    client,
    (event) => event.kind === "gateway" && event.status === "stopped",
  );
  await client.request("test/requestApprovalAndExit");
  await approval;
  assert.equal(client.listPendingRequests().length, 1);
  await stopped;
  await resolved;
  assert.equal(client.listPendingRequests().length, 0);
});

test("rejects steering and interrupting when no turn is active", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  await client.start();

  await assert.rejects(
    () => client.steer("thread-1", "change direction"),
    (error) => error instanceof CodexRpcError && error.code === "no_active_turn",
  );
  await assert.rejects(
    () => client.interrupt("thread-1"),
    (error) => error instanceof CodexRpcError && error.code === "no_active_turn",
  );
});

test("classifies writer conflicts and forks only after an explicit follow-up", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  await assert.rejects(
    () => client.sendMessage("thread-busy", "continue here"),
    (error) => error instanceof CodexRpcError && error.code === "thread_writer_conflict",
  );

  const started = waitForEvent(
    client,
    (event) => event.kind === "notification"
      && event.message.method === "turn/started"
      && event.message.params.threadId === "thread-busy-fork",
  );
  const result = await client.forkAndSend("thread-busy", "continue in a copy", {
    model: "gpt-test",
    effort: "high",
    permission: "dangerFullAccess",
  });
  assert.equal(result.thread.id, "thread-busy-fork");
  assert.equal(result.forkedFromThreadId, "thread-busy");
  assert.equal(result.turn.model, "gpt-test");
  assert.equal(result.turn.effort, "high");
  assert.equal(result.turn.approvalPolicy, "never");
  assert.equal(result.turn.sandboxPolicy.type, "dangerFullAccess");
  await started;
  assert.equal(client.getStatus().activeTurns["thread-busy-fork"], "turn-1");
});

test("recovers a durable fork id from thread/started when the RPC response is lost", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  const result = await client.forkAndSend("thread-notification-first", "continue recovered fork");
  assert.equal(result.thread.id, "thread-notification-first-fork");
  assert.equal(result.forkedFromThreadId, "thread-notification-first");
  assert.equal(client.getStatus().activeTurns["thread-notification-first-fork"], "turn-1");
});

test("releases the writer after an idle completed turn and prewarms a clean app-server", async (t) => {
  const client = makeClient({ idleReleaseMs: 80 });
  t.after(() => client.stop());

  await client.sendMessage("thread-1", "hello");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.getStatus().ready, true, "an active turn must keep the writer alive");

  const idle = waitForEvent(
    client,
    (event) => event.kind === "gateway" && event.status === "idle",
  );
  const scheduled = waitForEvent(
    client,
    (event) => event.kind === "lease" && event.status === "scheduled",
  );
  await client.interrupt("thread-1");
  await scheduled;
  assert.ok(client.getStatus().idleReleaseAt > Date.now());

  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.readThread("thread-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.getStatus().ready, true, "activity must refresh the idle lease");

  await idle;
  const ready = waitForEvent(
    client,
    (event) => event.kind === "gateway" && event.status === "ready",
  );
  if (!client.getStatus().ready) await ready;
  assert.equal(client.getStatus().ready, true, "a clean app-server should be prewarmed");

  const list = await client.listThreads();
  assert.equal(list.data[0].id, "thread-1");
  assert.equal(client.getStatus().ready, true);
});

test("does not resurrect a turn that completed before the start response", async (t) => {
  const client = makeClient({ idleReleaseMs: 500 });
  t.after(() => client.stop());

  const result = await client.sendMessage("thread-1", "complete before response");
  assert.equal(result.turn.id, "turn-fast");
  assert.equal(client.getStatus().activeTurns["thread-1"], undefined);
  assert.ok(client.getStatus().idleReleaseAt > Date.now());
});

test("survives an App Server exit while a request is being written", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  await assert.rejects(() => client.request("test/exitBeforeResponse"));
  const result = await client.listThreads();
  assert.equal(result.data[0].id, "thread-1");
});

test("keeps the idle lease after steering a start-only thread with no active turn", async (t) => {
  const client = makeClient({ idleReleaseMs: 50, prewarmAfterIdle: false });
  t.after(() => client.stop());

  await client.startThread({ cwd: "/tmp/project" });
  const idle = waitForEvent(
    client,
    (event) => event.kind === "gateway" && event.status === "idle",
  );
  await assert.rejects(
    () => client.steer("thread-new", "nothing to steer"),
    (error) => error instanceof CodexRpcError && error.code === "no_active_turn",
  );
  await idle;
  assert.equal(client.getStatus().ready, false);
  assert.equal(client.getStatus().released, true);
});

test("ignores a late completion from an older turn", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());

  await client.sendMessage("thread-1", "first turn");
  const firstCompleted = waitForEvent(
    client,
    (event) => event.kind === "notification"
      && event.message.method === "turn/completed"
      && event.message.params.turn?.id === "turn-1",
  );
  await client.interrupt("thread-1");
  await firstCompleted;

  const second = await client.sendMessage("thread-1", "start unique second turn");
  assert.equal(second.turn.id, "turn-2");
  assert.equal(client.getStatus().activeTurns["thread-1"], "turn-2");

  const staleCompletion = waitForEvent(
    client,
    (event) => event.kind === "notification"
      && event.message.method === "turn/completed"
      && event.message.params.turn?.id === "turn-1",
  );
  await client.request("test/emitStaleCompletion", {
    threadId: "thread-1",
    turnId: "turn-1",
  });
  await staleCompletion;
  assert.equal(client.getStatus().activeTurns["thread-1"], "turn-2");
});

test("images accompany normal, steer and explicit fork inputs, including image-only turns", async (t) => {
  const client = makeClient();
  t.after(() => client.stop());
  const images = ["/tmp/pocket/screenshot.png"];
  const sent = await client.sendMessage("thread-images", "", { images });
  assert.deepEqual(sent.turn.input, [{ type: "localImage", path: images[0] }]);
  const steered = await client.steer("thread-images", "look here", "turn-1", images);
  assert.deepEqual(steered.input, [{ type: "text", text: "look here", text_elements: [] }, { type: "localImage", path: images[0] }]);
  const forked = await client.forkAndSend("thread-busy", "", { images });
  assert.deepEqual(forked.turn.input, [{ type: "localImage", path: images[0] }]);
});
