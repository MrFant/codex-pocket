import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadStaticAssets } from "../lib/static-assets.mjs";

test("build fingerprint covers every asset and renders matching imports, precache and session keys", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL("../public/", import.meta.url), directory, { recursive: true });
  const first = await loadStaticAssets(directory);
  assert.equal((await loadStaticAssets(directory)).version, first.version);
  for (const [name, bytes] of first.files) {
    const source = bytes.toString();
    assert.equal(source.includes("__BUILD__"), false, name);
    assert.equal(source.includes("__STATIC_FILES__"), false, name);
    for (const version of source.matchAll(/\?v=([a-f0-9]+)/g)) assert.equal(version[1], first.version, name);
    if (name !== "/sw.js") assert.ok(first.precache.includes(`${name}?v=${first.version}`), name);
  }
  assert.ok(first.files.get("/app.js").toString().includes(`codex-pocket-thread-v${first.version}:`));
  await writeFile(path.join(directory, "styles.css"), "body { color: red; }");
  const next = await loadStaticAssets(directory);
  assert.notEqual(first.version, next.version);
  assert.notDeepEqual(first.files.get("/app.js"), next.files.get("/app.js"));
  assert.notDeepEqual(first.files.get("/sw.js"), next.files.get("/sw.js"));
  await writeFile(path.join(directory, "extra.js"), "export const extra = 1;");
  const added = await loadStaticAssets(directory);
  assert.ok(added.precache.includes(`/extra.js?v=${added.version}`));
});
