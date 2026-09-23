import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync } from "node:fs";

const input = createInterface({ input: process.stdin });
let startedThread = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function auditServerRequestResponse(message) {
  const auditPath = process.env.FAKE_APPROVAL_AUDIT_PATH;
  if (!auditPath) return;
  appendFileSync(auditPath, `${JSON.stringify({
    id: String(message.id),
    ...(Object.hasOwn(message, "result") ? { result: message.result } : {}),
    ...(Object.hasOwn(message, "error") ? { error: message.error } : {}),
  })}\n`);
}

function approvalRequest(text, threadId, turnId) {
  const startedAtMs = Date.now();
  const longReason = `需要在移动端完整展示这段授权原因：${"审批说明".repeat(80)}`;
  const longPath = `/tmp/project/${"nested-directory/".repeat(24)}artifact.txt`;

  if (text === "needs approval") {
    return {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "command-item-1",
        startedAtMs,
        environmentId: null,
        command: "echo approve",
      },
    };
  }
  if (text === "approval:command-long") {
    return {
      id: "approval-command-long",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "command-item-long",
        startedAtMs,
        environmentId: null,
        reason: longReason,
        command: `curl https://example.invalid/resource --header X-Long:${"x".repeat(1_000)}`,
        cwd: longPath,
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: { read: [longPath], write: [], entries: [] },
        },
        networkApprovalContext: { protocol: "https", host: "example.invalid" },
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    };
  }
  if (text === "approval:file") {
    return {
      id: "approval-file",
      method: "item/fileChange/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "file-item-1",
        startedAtMs,
        reason: longReason,
        grantRoot: longPath,
      },
    };
  }
  if (text === "approval:user-input") {
    return {
      id: "approval-user-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: "input-item-1",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "choice",
            header: "执行方案",
            question: `请选择后续执行方案。${"这是一段较长的移动端问题描述。".repeat(16)}`,
            isOther: true,
            isSecret: false,
            options: [
              { label: "方案 A", description: `优先保证速度。${"补充说明。".repeat(12)}` },
              { label: "方案 B", description: `优先保证完整性。${"补充说明。".repeat(12)}` },
            ],
          },
          {
            id: "secret",
            header: "敏感输入",
            question: "请输入测试密钥。",
            isOther: false,
            isSecret: true,
            options: null,
          },
        ],
      },
    };
  }
  if (text === "approval:permissions") {
    return {
      id: "approval-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "permissions-item-1",
        environmentId: null,
        startedAtMs,
        cwd: "/tmp/project",
        reason: longReason,
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: [longPath],
            write: [longPath.replace("artifact.txt", "output.txt")],
            entries: [],
          },
        },
      },
    };
  }
  return null;
}

function persistThread(thread, preview) {
  const statePath = process.env.FAKE_STATE_PATH;
  if (!statePath) return;
  const database = new DatabaseSync(statePath);
  try {
    const now = Math.floor(Date.now() / 1_000);
    database.prepare(`
      INSERT OR REPLACE INTO threads (
        id, preview, rollout_path, archived, created_at, updated_at, recency_at,
        cwd, title, source, thread_source, sandbox_policy, approval_mode
      ) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, 'appServer', NULL, ?, 'on-request')
    `).run(
      thread.id,
      preview,
      now,
      now,
      now,
      thread.cwd,
      preview,
      JSON.stringify({ type: "workspaceWrite" }),
    );
  } finally {
    database.close();
  }
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  if (!message.method && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    auditServerRequestResponse(message);
    return;
  }

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-app-server" } });
    return;
  }
  if (message.method === "thread/list") {
    send({
      id: message.id,
      result: {
        data: [{ id: "thread-1", preview: "Test thread", cwd: "/tmp/project", status: { type: "notLoaded" }, turns: [] }],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          description: "Test model",
          hidden: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deeper reasoning" },
          ],
          isDefault: true,
        }],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === "config/read") {
    send({
      id: message.id,
      result: {
        config: {
          model: "gpt-test",
          model_reasoning_effort: "high",
        },
        origins: {},
        layers: null,
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    if (!new Set(["read-only", "workspace-write", "danger-full-access"]).has(message.params.sandbox)
      || !new Set(["untrusted", "on-request", "never"]).has(message.params.approvalPolicy)) {
      send({ id: message.id, error: { code: -32602, message: "Invalid thread/start permission enum" } });
      return;
    }
    const thread = {
      id: "thread-new",
      cwd: message.params.cwd || "/tmp/project",
      turns: [],
      status: { type: "idle" },
      approvalPolicy: message.params.approvalPolicy,
      sandbox: message.params.sandbox,
      model: message.params.model || null,
      reasoningEffort: "high",
    };
    startedThread = thread;
    persistThread(thread, "Persisted new thread");
    send({ id: message.id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "thread/read" && message.params.threadId === "thread-review") {
    send({ id: message.id, result: { thread: { id: "thread-review", turns: [{ id: "review", status: "completed", items: [
      { id: "files", type: "fileChange", status: "completed", changes: [
        { path: "/tmp/example.js", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-before\n+after" },
        { path: "/tmp/large.js", kind: { type: "add" }, diff: "+".repeat(45_000) },
      ] },
      { id: "command", type: "commandExecution", command: "npm test", aggregatedOutput: "output".repeat(4_000), exitCode: 1, durationMs: 1500 },
    ] }] } } }); return;
  }
  if (message.method === "thread/read") {
    if (process.env.FAKE_READ_AUDIT_PATH) {
      appendFileSync(process.env.FAKE_READ_AUDIT_PATH, `${message.params.threadId}\n`);
    }
    if (message.params.threadId === "thread-new") {
      if (!message.params.includeTurns || (process.env.FAKE_PAGINATED_READ && !startedThread)) {
        send({ id: message.id, result: { thread: startedThread || {
          id: "thread-new", model: null, reasoningEffort: null, turns: [],
        } } });
        return;
      }
      send({
        id: message.id,
        error: {
          code: process.env.FAKE_PAGINATED_READ ? -32601 : -32600,
          message: process.env.FAKE_PAGINATED_READ
            ? "list_turns is not supported yet"
            : `thread ${message.params.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
        },
      });
      return;
    }
    if (message.params.threadId === "thread-corrupt") {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: "failed to deserialize stored thread item subagent-completed-1: unknown variant `completed`, expected one of `started`, `interacted`, `interrupted`",
        },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          cwd: "/tmp/project",
          model: "gpt-original",
          reasoningEffort: "high",
          turns: message.params.includeTurns ? [{ id: "turn-old", status: "completed", items: [] }] : [],
        },
      },
    });
    return;
  }
  if (message.method === "thread/resume") {
    if (message.params.threadId === "thread-busy") {
      send({ id: message.id, error: { code: -32600, message: "Thread thread-busy already has an active writer" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
    send({ method: "thread/started", params: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "thread/fork") {
    const uniqueSuffix = process.env.FAKE_UNIQUE_FORK_ID === "1" ? `-${process.pid}` : "";
    const thread = {
      id: `${message.params.threadId}-fork${uniqueSuffix}`,
      cwd: "/tmp/project",
      turns: [{ id: "turn-old", status: "completed", items: [] }],
    };
    persistThread(thread, `Persisted fork of ${message.params.threadId}`);
    if (message.params.threadId === "thread-notification-first") {
      send({ method: "thread/started", params: { thread } });
      return;
    }
    send({ id: message.id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "turn/start") {
    if (!new Set(["untrusted", "on-request", "never"]).has(message.params.approvalPolicy)) {
      send({ id: message.id, error: { code: -32602, message: "Invalid turn/start approval policy" } });
      return;
    }
    const text = message.params.input?.[0]?.text || "";
    if (text === "fail turn") {
      send({ id: message.id, error: { code: -32001, message: "Synthetic turn failure" } });
      return;
    }
    if (text === "complete before response") {
      send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn-fast" } } });
      send({
        method: "turn/completed",
        params: { threadId: message.params.threadId, turn: { id: "turn-fast", status: "completed" } },
      });
      send({ id: message.id, result: { turn: { id: "turn-fast", status: "completed", items: [] } } });
      return;
    }
    const turnId = text === "start unique second turn" ? "turn-2" : "turn-1";
    send({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          status: "inProgress",
          items: [],
          model: message.params.model || null,
          effort: message.params.effort || null,
          cwd: message.params.cwd || null,
          approvalPolicy: message.params.approvalPolicy || null,
          sandboxPolicy: message.params.sandboxPolicy || null,
          input: message.params.input,
        },
      },
    });
    send({
      method: "thread/status/changed",
      params: { threadId: message.params.threadId, status: { type: "active", activeFlags: [] } },
    });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
    send({
      method: "item/started",
      params: {
        threadId: message.params.threadId,
        turnId,
        item: { id: "item-1", type: "agentMessage", text: "" },
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId: message.params.threadId, turnId, itemId: "item-1", delta: "hello" },
    });
    if (text === "approval:multiple") {
      send(approvalRequest("approval:command-long", message.params.threadId, turnId));
      send(approvalRequest("approval:permissions", message.params.threadId, turnId));
    } else {
      const request = approvalRequest(text, message.params.threadId, turnId);
      if (request) send(request);
    }
    if (text === "exit during turn") setTimeout(() => process.exit(1), 10);
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId, input: message.params.input } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "thread/status/changed",
      params: { threadId: message.params.threadId, status: { type: "idle" } },
    });
    send({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } },
    });
    return;
  }
  if (message.method === "test/requestApproval") {
    send({ id: message.id, result: { ok: true } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "echo safe" },
    });
    return;
  }
  if (message.method === "test/emitStaleCompletion") {
    send({ id: message.id, result: { ok: true } });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: "completed" },
      },
    });
    return;
  }
  if (message.method === "test/requestApprovalThenResolve") {
    send({ id: message.id, result: { ok: true } });
    send({
      id: "approval-resolved",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "echo resolved" },
    });
    setTimeout(() => {
      send({ method: "serverRequest/resolved", params: { requestId: "approval-resolved" } });
    }, 20);
    return;
  }
  if (message.method === "test/requestApprovalAndExit") {
    send({ id: message.id, result: { ok: true } });
    send({
      id: "approval-before-exit",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "echo exit" },
    });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (message.method === "test/exitBeforeResponse") {
    process.exit(1);
  }

  send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
});
