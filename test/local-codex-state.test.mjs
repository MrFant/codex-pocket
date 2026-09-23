import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalCodexState } from "../lib/local-codex-state.mjs";

test("reads metadata directly for archived threads outside the first list page", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, "catalog.sqlite");
  const statePath = path.join(directory, "state.sqlite");

  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT PRIMARY KEY,
      display_title TEXT,
      source_created_at INTEGER,
      source_updated_at INTEGER,
      source_recency_at INTEGER,
      cwd TEXT,
      source_kind TEXT,
      host_id TEXT,
      missing_candidate INTEGER
    )
  `);
  const insertCatalog = catalog.prepare(`
    INSERT INTO local_thread_catalog VALUES (?, ?, ?, ?, ?, ?, 'cli', 'local', 0)
  `);
  for (let index = 0; index < 101; index += 1) {
    insertCatalog.run(`thread-${index}`, `Thread ${index}`, index, index, 1_000 - index, `/tmp/${index}`);
  }
  insertCatalog.run("archived-old", "Archived old", 0, 7, 0, "/tmp/archived");
  catalog.close();

  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      preview TEXT,
      rollout_path TEXT,
      archived INTEGER,
      updated_at_ms INTEGER
    )
  `);
  const insertState = state.prepare("INSERT INTO threads VALUES (?, ?, NULL, ?, ?)");
  for (let index = 0; index < 101; index += 1) {
    insertState.run(`thread-${index}`, `Preview ${index}`, 0, index);
  }
  insertState.run("archived-old", "Archived preview", 1, 7_000);
  state.close();

  const localState = new LocalCodexState({ catalogPath, statePath, desktopStatePath: null });
  t.after(() => localState.close());
  const visible = await localState.listThreads();
  assert.equal(visible.data.length, 100);
  assert.equal(visible.data.some((thread) => thread.id === "archived-old"), false);

  const metadata = await localState.getThreadMetadata("archived-old");
  assert.equal(metadata.id, "archived-old");
  assert.equal(metadata.preview, "Archived preview");
  assert.equal(metadata.updatedAt, 7);
  assert.equal(metadata.cwd, "/tmp/archived");
});

test("mirrors Desktop project titles, explicit assignments, order, and projectless exclusions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, "catalog.sqlite");
  const statePath = path.join(directory, "state.sqlite");
  const desktopStatePath = path.join(directory, ".codex-global-state.json");
  const pocketStatePath = path.join(directory, "codex-pocket-state.json");

  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT PRIMARY KEY,
      display_title TEXT,
      source_created_at INTEGER,
      source_updated_at INTEGER,
      source_recency_at INTEGER,
      cwd TEXT,
      source_kind TEXT,
      host_id TEXT,
      missing_candidate INTEGER
    )
  `);
  const insertCatalog = catalog.prepare(`
    INSERT INTO local_thread_catalog VALUES (?, ?, 1, ?, ?, ?, 'cli', 'local', 0)
  `);
  insertCatalog.run("assigned", "Assigned", 50, 50, "/elsewhere");
  insertCatalog.run("root-inferred", "Root inferred", 40, 40, "/work/alpha");
  insertCatalog.run("projectless", "Projectless", 30, 30, "/work/alpha");
  insertCatalog.run("client-bound", "Client bound", 20, 20, "/work/beta");
  insertCatalog.run("ordinary", "Ordinary", 10, 10, "/other");
  catalog.close();

  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      preview TEXT,
      rollout_path TEXT,
      archived INTEGER,
      updated_at_ms INTEGER
    )
  `);
  const insertState = state.prepare("INSERT INTO threads VALUES (?, ?, NULL, 0, 1)");
  for (const threadId of ["assigned", "root-inferred", "projectless", "client-bound", "ordinary"]) {
    insertState.run(threadId, threadId);
  }
  state.close();

  await writeFile(desktopStatePath, JSON.stringify({
    "local-projects": {
      alpha: { id: "alpha", name: "Alpha renamed", rootPaths: ["/work/alpha"] },
      beta: { id: "beta", name: "Beta", rootPaths: ["/work/beta"] },
    },
    "project-order": ["beta", "alpha"],
    "thread-project-assignments": {
      assigned: { projectKind: "local", projectId: "beta" },
      "client-bound": { projectKind: "local", projectId: "beta" },
      projectless: { projectKind: "local", projectId: "beta" },
    },
    "projectless-thread-ids": ["projectless"],
    "pinned-thread-ids": ["ordinary"],
    "electron-persisted-atom-state": {
      "client-thread-bindings-v1": { pending: "client-bound" },
      "heartbeat-thread-permissions-by-id": {
        assigned: {
          activePermissionProfile: { id: ":danger-full-access", extends: null },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        ordinary: {
          activePermissionProfile: { id: ":read-only", extends: null },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      },
    },
  }));

  const desktopStateBeforePocketWrites = await readFile(desktopStatePath, "utf8");
  const localState = new LocalCodexState({
    catalogPath,
    statePath,
    desktopStatePath,
    pocketStatePath,
  });
  t.after(() => localState.close());
  const result = await localState.listThreads();
  const byId = new Map(result.data.map((thread) => [thread.id, thread]));

  assert.equal(localState.resolveProjectIdForCwd("/work/alpha/"), "alpha");
  assert.equal(localState.resolveProjectIdForCwd("/work/alpha/subdirectory"), "alpha");
  assert.equal(localState.resolveProjectIdForCwd("/work/alpha-other"), null);
  assert.equal(localState.resolveProjectIdForCwd("/other"), null);

  assert.deepEqual(
    [byId.get("assigned").projectId, byId.get("assigned").projectName, byId.get("assigned").projectOrder],
    ["beta", "Beta", 0],
  );
  assert.equal(byId.get("root-inferred").projectId, null);
  assert.equal(byId.get("projectless").projectId, null);
  assert.equal(byId.get("client-bound").projectId, "beta");
  assert.equal(byId.get("ordinary").projectId, null);
  assert.equal(byId.get("ordinary").isPinned, true);
  assert.equal(byId.get("assigned").permission, "dangerFullAccess");
  assert.equal(byId.get("ordinary").permission, "readOnly");

  await localState.setThreadPermission("assigned", "workspaceWrite");
  const persisted = JSON.parse(await readFile(pocketStatePath, "utf8"));
  assert.equal(persisted.threadPermissions.assigned, "workspaceWrite");
  assert.equal(await readFile(desktopStatePath, "utf8"), desktopStateBeforePocketWrites);

  const refreshed = await localState.getThreadMetadata("assigned");
  assert.equal(refreshed.permission, "workspaceWrite");
  const liveState = await localState.getThreadState();
  assert.equal(liveState.permissions.assigned, "workspaceWrite");

  await localState.setThreadProject("ordinary", "alpha");
  assert.equal((await localState.getThreadMetadata("ordinary")).projectId, "alpha");
  assert.equal(await readFile(desktopStatePath, "utf8"), desktopStateBeforePocketWrites);
  const rebuilt = new LocalCodexState({
    catalogPath,
    statePath,
    desktopStatePath,
    pocketStatePath,
  });
  assert.equal((await rebuilt.getThreadMetadata("ordinary")).projectId, "alpha");
  rebuilt.close();

  const desktopOverride = JSON.parse(desktopStateBeforePocketWrites);
  desktopOverride["thread-project-assignments"].ordinary = {
    projectKind: "local",
    projectId: "beta",
  };
  await writeFile(desktopStatePath, JSON.stringify(desktopOverride));
  assert.equal((await localState.getThreadMetadata("ordinary")).projectId, "beta");

  await localState.setThreadProject("root-inferred", null);
  const projectState = JSON.parse(await readFile(pocketStatePath, "utf8"));
  assert.equal(projectState.threadProjects["root-inferred"], null);
});

test("falls back to the state database permission when Desktop has no thread override", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-permissions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, "catalog.sqlite");
  const statePath = path.join(directory, "state.sqlite");

  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT PRIMARY KEY, display_title TEXT, source_created_at INTEGER,
      source_updated_at INTEGER, source_recency_at INTEGER, cwd TEXT,
      source_kind TEXT, host_id TEXT, missing_candidate INTEGER
    );
    INSERT INTO local_thread_catalog VALUES
      ('readonly', 'Readonly', 1, 1, 1, '/tmp/a', 'cli', 'local', 0),
      ('workspace', 'Workspace', 1, 1, 1, '/tmp/b', 'cli', 'local', 0),
      ('full', 'Full', 1, 1, 1, '/tmp/c', 'cli', 'local', 0);
  `);
  catalog.close();

  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, preview TEXT, rollout_path TEXT, archived INTEGER,
      updated_at_ms INTEGER, sandbox_policy TEXT, approval_mode TEXT
    )
  `);
  const insert = state.prepare("INSERT INTO threads VALUES (?, ?, NULL, 0, 1, ?, 'never')");
  insert.run("readonly", "Readonly", JSON.stringify({
    type: "managed",
    file_system: { type: "restricted", entries: [{ access: "read" }] },
  }));
  insert.run("workspace", "Workspace", JSON.stringify({
    type: "managed",
    file_system: { type: "restricted", entries: [{ access: "read" }, { access: "write" }] },
  }));
  insert.run("full", "Full", JSON.stringify({ type: "disabled" }));
  state.close();

  const localState = new LocalCodexState({ catalogPath, statePath, desktopStatePath: null });
  t.after(() => localState.close());
  const result = await localState.listThreads();
  const permissions = Object.fromEntries(result.data.map((thread) => [thread.id, thread.permission]));
  assert.deepEqual(permissions, {
    readonly: "readOnly",
    workspace: "workspaceWrite",
    full: "dangerFullAccess",
  });
});

test("lists a persisted state-only fork immediately and after rebuilding the reader", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-fork-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, "catalog.sqlite");
  const statePath = path.join(directory, "state.sqlite");

  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT PRIMARY KEY, display_title TEXT, source_created_at INTEGER,
      source_updated_at INTEGER, source_recency_at INTEGER, cwd TEXT,
      source_kind TEXT, host_id TEXT, missing_candidate INTEGER
    );
    INSERT INTO local_thread_catalog VALUES
      ('parent', 'Desktop parent title', 10, 20, 20, '/work/project', 'vscode', 'local', 0),
      ('subagent', 'Catalog must not revive subagent', 60, 60, 60, '/work/project', 'vscode', 'local', 0),
      ('json-subagent', 'Catalog must not revive JSON subagent', 70, 70, 70, '/work/project', 'vscode', 'local', 0),
      ('exec', 'Catalog must not revive exec', 80, 80, 80, '/work/project', 'vscode', 'local', 0);
  `);
  catalog.close();

  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, preview TEXT, rollout_path TEXT, archived INTEGER,
      created_at INTEGER, updated_at INTEGER, recency_at INTEGER, cwd TEXT,
      title TEXT, name TEXT, first_user_message TEXT, source TEXT,
      thread_source TEXT, sandbox_policy TEXT, approval_mode TEXT,
      is_pinned INTEGER, project_id TEXT
    );
  `);
  const insert = state.prepare(`
    INSERT INTO threads VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '{}', 'on-request', 0, NULL)
  `);
  insert.run("parent", "Parent preview", 10, 20, 20, "/work/project", "State parent", "Parent", "vscode", "user");
  insert.run("fork", "Fork preview", 30, 40, 50, "/work/project", "Fork title", "Fork", "vscode", null);
  insert.run("subagent", "Internal", 60, 60, 60, "/work/project", "Internal", "Internal", "vscode", "subagent");
  insert.run("json-subagent", "Internal JSON", 70, 70, 70, "/work/project", "Internal JSON", "Internal", JSON.stringify({ subagent: {} }), null);
  insert.run("exec", "Internal exec", 80, 80, 80, "/work/project", "Internal exec", "Internal", "exec", null);
  state.close();

  for (let pass = 0; pass < 2; pass += 1) {
    const localState = new LocalCodexState({ catalogPath, statePath, desktopStatePath: null });
    const result = await localState.listThreads();
    assert.deepEqual(result.data.map((thread) => thread.id), ["fork", "parent"]);
    assert.equal(result.data[0].name, "Fork title");
    assert.equal(result.data[0].recencyAt, 50);
    assert.equal((await localState.getThreadMetadata("fork")).preview, "Fork preview");
    localState.close();
  }

  const enrichedCatalog = new DatabaseSync(catalogPath);
  enrichedCatalog.prepare(`
    INSERT INTO local_thread_catalog VALUES
      ('fork', 'Desktop fork title', 30, 35, 35, '/work/project', 'vscode', 'local', 0)
  `).run();
  enrichedCatalog.close();
  const enriched = new LocalCodexState({ catalogPath, statePath, desktopStatePath: null });
  t.after(() => enriched.close());
  const result = await enriched.listThreads();
  assert.equal(result.data.filter((thread) => thread.id === "fork").length, 1);
  assert.equal(result.data.find((thread) => thread.id === "fork").name, "Desktop fork title");
  assert.equal(result.data.find((thread) => thread.id === "fork").recencyAt, 50);
});

test("works from the state database without a Desktop catalog and keeps optimistic threads", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-state-only-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, preview TEXT, rollout_path TEXT, archived INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER,
      cwd TEXT, title TEXT, source TEXT, thread_source TEXT
    );
    INSERT INTO threads VALUES
      ('state-only', 'State only preview', NULL, 0, 1000, 2000, 3000,
       '/tmp/state', 'State only', 'cli', 'user');
  `);
  state.close();

  const localState = new LocalCodexState({
    catalogPath: path.join(directory, "missing-catalog.sqlite"),
    statePath,
    desktopStatePath: null,
  });
  t.after(() => localState.close());
  localState.rememberThread({ id: "fresh", cwd: "/tmp/fresh", preview: "Fresh fork" }, {
    permission: "dangerFullAccess",
  });
  const result = await localState.listThreads();
  assert.deepEqual(new Set(result.data.map((thread) => thread.id)), new Set(["fresh", "state-only"]));
  assert.equal(result.data.find((thread) => thread.id === "state-only").recencyAt, 3);
  assert.equal(result.data.find((thread) => thread.id === "fresh").permission, "dangerFullAccess");
});

test("requires a live writer lock before reporting an unfinished rollout as active", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-pocket-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, "catalog.sqlite");
  const statePath = path.join(directory, "state.sqlite");
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const pocketStatePath = path.join(directory, "codex-pocket-state.json");
  const writerLockDirectory = path.join(directory, "thread-writer-locks");
  await mkdir(writerLockDirectory);

  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT PRIMARY KEY, display_title TEXT, source_created_at INTEGER,
      source_updated_at INTEGER, source_recency_at INTEGER, cwd TEXT,
      source_kind TEXT, host_id TEXT, missing_candidate INTEGER
    );
    INSERT INTO local_thread_catalog VALUES
      ('thread-active', 'Active', 1, 1, 1, '/tmp', 'vscode', 'local', 0);
  `);
  catalog.close();
  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, preview TEXT, rollout_path TEXT, archived INTEGER,
      updated_at_ms INTEGER, source TEXT, thread_source TEXT
    )
  `);
  state.prepare("INSERT INTO threads VALUES ('thread-active', 'Active', ?, 0, 1000, 'vscode', 'user')")
    .run(rolloutPath);
  state.close();
  const startedLine = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } });
  const longRunningTurn = "{}\n".repeat(1_500_000);
  await writeFile(rolloutPath, `${startedLine}\n${longRunningTurn}`);

  const localState = new LocalCodexState({
    catalogPath,
    statePath,
    desktopStatePath: null,
    pocketStatePath,
    writerLockDirectory,
  });
  t.after(() => localState.close());
  const activityBaseline = Math.floor(Date.now() / 1_000) - 10;
  await localState.initializeActivityTracking(activityBaseline);
  assert.equal((await localState.getThreadMetadata("thread-active")).status.type, "idle");

  await writeFile(path.join(writerLockDirectory, "thread-active.lock"), "");
  assert.equal((await localState.getThreadMetadata("thread-active")).status.type, "active");

  const baselineCompletedLine = JSON.stringify({
    timestamp: new Date(activityBaseline * 1_000).toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-at-baseline", completed_at: activityBaseline },
  });
  await appendFile(rolloutPath, `${baselineCompletedLine}\n`);
  assert.equal(
    (await localState.getThreadMetadata("thread-active")).hasUnreadActivity,
    false,
    "a completion already present in the initialization second is the read baseline",
  );

  const completedAt = activityBaseline + 5;
  const completedLine = JSON.stringify({
    timestamp: new Date(completedAt * 1_000).toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1", completed_at: completedAt },
  });
  await appendFile(rolloutPath, `${completedLine}\n`);
  const completed = await localState.getThreadMetadata("thread-active");
  assert.equal(completed.status.type, "idle");
  assert.equal(completed.status.completionKey, "turn-1");
  assert.equal(completed.activityCompletionKey, "turn-1");
  assert.equal(completed.hasUnreadActivity, true);

  await localState.markThreadSeen("thread-active", "turn-1", completedAt + 1);
  assert.equal((await localState.getThreadMetadata("thread-active")).hasUnreadActivity, false);

  const rebuilt = new LocalCodexState({
    catalogPath,
    statePath,
    desktopStatePath: null,
    pocketStatePath,
    writerLockDirectory,
  });
  t.after(() => rebuilt.close());
  await rebuilt.initializeActivityTracking();
  assert.equal((await rebuilt.getThreadMetadata("thread-active")).hasUnreadActivity, false);
});
