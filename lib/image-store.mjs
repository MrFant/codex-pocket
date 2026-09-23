import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, access, readdir, stat, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import path from "node:path";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ID = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
const REF = /^[a-zA-Z0-9_-]{8,128}$/;
const types = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }

export class ImageStore {
  constructor(directory, { now = () => Date.now(), graceMs = 24 * 60 * 60 * 1000 } = {}) {
    this.directory = path.resolve(directory); this.now = now; this.graceMs = graceMs; this.queue = Promise.resolve();
  }
  async database() {
    if (!this.db) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = path.join(this.directory, "index.sqlite");
      this.db = new DatabaseSync(filename); chmodSync(filename, 0o600);
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, used INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS refs (image_id TEXT NOT NULL, ref TEXT NOT NULL, released_at INTEGER, PRIMARY KEY (image_id, ref));`);
    }
    return this.db;
  }
  serial(operation) {
    const current = this.queue.catch(() => {}).then(operation); this.queue = current; return current;
  }
  file(id) {
    if (typeof id !== "string" || !ID.test(id)) throw bad("图片 ID 无效");
    return path.join(this.directory, id);
  }
  urlForPath(filename) {
    if (typeof filename !== "string") return null;
    const id = path.basename(filename);
    return ID.test(id) && filename === path.join(this.directory, id) ? `/api/images/${id}` : null;
  }
  put(bytes, ref = null) {
    return this.serial(async () => {
      if (ref !== null && !REF.test(ref)) throw bad("图片引用编号无效");
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw bad("每张图片需小于 10 MB", 413);
      const extension = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
      if (!extension) throw bad("请选择 PNG、JPEG 或 WebP 图片", 415);
      const id = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
      const db = await this.database();
      const exists = await access(this.file(id)).then(() => true, () => false);
      const indexed = db.prepare("SELECT used FROM images WHERE id = ?").get(id);
      // Existing files and uploads from older clients have unknown references.
      // Protect them permanently instead of guessing that they are unused.
      const protectedImage = !ref || (exists && !indexed);
      db.prepare("INSERT OR IGNORE INTO images VALUES (?, ?, ?)").run(id, protectedImage ? 1 : 0, this.now());
      if (protectedImage) db.prepare("UPDATE images SET used = 1 WHERE id = ?").run(id);
      if (ref) db.prepare("INSERT INTO refs VALUES (?, ?, NULL) ON CONFLICT(image_id, ref) DO UPDATE SET released_at = NULL").run(id, ref);
      const temporary = path.join(this.directory, `.upload-${randomUUID()}`);
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, this.file(id));
      return { id, url: `/api/images/${id}`, size: bytes.length, type: types[extension], tracked: Boolean(ref) };
    });
  }
  async read(id) { return { bytes: await readFile(this.file(id)), type: types[id.split(".").at(-1)] }; }
  resolve(ids = []) {
    return this.serial(async () => {
      if (!Array.isArray(ids) || ids.length > 4) throw bad("每条消息最多附带 4 张图片");
      const files = [];
      for (const id of ids) {
        const filename = this.file(id);
        try { await access(filename); } catch { throw bad("图片不存在，请重新上传", 400); }
        files.push(filename);
      }
      if (ids.length) {
        const db = await this.database();
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const id of ids) db.prepare("INSERT INTO images VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET used = 1").run(id, this.now());
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      return files;
    });
  }
  release(id, ref) {
    return this.serial(async () => {
      this.file(id);
      if (!REF.test(ref || "")) throw bad("图片引用编号无效");
      const db = await this.database();
      db.prepare("UPDATE refs SET released_at = COALESCE(released_at, ?) WHERE image_id = ? AND ref = ?").run(this.now(), id, ref);
      return { ok: true };
    });
  }
  candidates(db) {
    return db.prepare(`SELECT images.id FROM images JOIN refs ON refs.image_id = images.id
      WHERE images.used = 0 GROUP BY images.id
      HAVING COUNT(*) = COUNT(refs.released_at) AND MAX(refs.released_at) <= ?`).all(this.now() - this.graceMs).map((row) => row.id);
  }
  stats() {
    return this.serial(async () => {
      const db = await this.database();
      const candidates = new Set(this.candidates(db));
      const result = { count: 0, bytes: 0, candidates: [], graceHours: this.graceMs / 3600000 };
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !ID.test(entry.name)) continue;
        const info = await stat(this.file(entry.name));
        result.count += 1; result.bytes += info.size;
        if (candidates.has(entry.name)) result.candidates.push({ id: entry.name, bytes: info.size });
      }
      return result;
    });
  }
  cleanup(ids) {
    return this.serial(async () => {
      if (!Array.isArray(ids) || ids.length > 100) throw bad("一次最多清理 100 张图片");
      for (const id of ids) this.file(id);
      const db = await this.database();
      const candidates = new Set(this.candidates(db));
      const removed = [], skipped = [];
      for (const id of new Set(ids)) {
        if (!candidates.has(id)) { skipped.push(id); continue; }
        await unlink(this.file(id)).catch((error) => { if (error.code !== "ENOENT") throw error; });
        db.prepare("DELETE FROM refs WHERE image_id = ?").run(id);
        db.prepare("DELETE FROM images WHERE id = ?").run(id);
        removed.push(id);
      }
      return { removed, skipped };
    });
  }
  async close() { await this.queue.catch(() => {}); this.db?.close(); }
}
