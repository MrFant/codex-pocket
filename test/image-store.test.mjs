import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageStore, MAX_IMAGE_BYTES } from "../lib/image-store.mjs";

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");

test("images are durable, deduplicated, private, and resolved only from owned IDs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-images-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ImageStore(directory);
  const image = await store.put(png);
  assert.deepEqual(await store.put(png), image);
  const restored = new ImageStore(directory);
  const [filename] = await restored.resolve([image.id]);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(restored.urlForPath(filename), image.url);
  assert.equal(restored.urlForPath(`/tmp/${image.id}`), null);
  assert.deepEqual((await restored.read(image.id)).bytes, png);
  for (const id of ["../config.toml", "/etc/passwd", "a".repeat(64) + ".svg"]) await assert.rejects(restored.resolve([id]), /ID 无效/);
  await assert.rejects(restored.resolve(["a".repeat(64) + ".png"]), /不存在/);
  await assert.rejects(restored.resolve(Array(5).fill(image.id)), /最多/);
  await assert.rejects(store.put(Buffer.from("<svg onload='alert(1)'/>")), /PNG/);
  await assert.rejects(store.put(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /10 MB/);
});

test('cleanup rechecks shared draft references, grace time, sends and legacy images', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pocket-cleanup-'));
  let now = 1000;
  const store = new ImageStore(directory, { now: () => now, graceMs: 100 });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const a = await store.put(png, 'draft-ref-a');
  await store.put(png, 'draft-ref-b');
  await store.release(a.id, 'draft-ref-a'); now += 1000;
  assert.equal((await store.stats()).candidates.length, 0, 'another draft still references the file');
  await store.release(a.id, 'draft-ref-b');
  assert.equal((await store.cleanup([a.id])).removed.length, 0, 'grace period is enforced on cleanup, not just preview');
  now += 101;
  assert.equal((await store.stats()).candidates.length, 1);
  await store.resolve([a.id]);
  assert.deepEqual((await store.cleanup([a.id])).skipped, [a.id], 'a send after preview protects the image');
  const b = await store.put(Buffer.concat([png, Buffer.from('other')]), 'draft-ref-c');
  await store.release(b.id, 'draft-ref-c'); now += 101;
  assert.deepEqual((await store.cleanup([b.id])).removed, [b.id]);
  const legacy = await store.put(Buffer.concat([png, Buffer.from('legacy')]));
  await store.put(Buffer.concat([png, Buffer.from('legacy')]), 'draft-ref-d');
  await store.release(legacy.id, 'draft-ref-d'); now += 101;
  assert.equal((await store.stats()).candidates.length, 0);
  assert.deepEqual((await store.cleanup([legacy.id])).skipped, [legacy.id]);
  assert.deepEqual((await store.read(a.id)).bytes, png);
});
