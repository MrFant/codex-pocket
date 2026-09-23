import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// One immutable snapshot keeps HTML, module imports, worker and session caches
// on the same build, even while files are edited before a service restart.
export async function loadStaticAssets(directory) {
  const sources = new Map();
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) sources.set(`/${name}`, await readFile(path.join(directory, name)));
    }
  }
  await visit();
  const hash = createHash("sha256");
  for (const [name, bytes] of [...sources].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update("\0").update(bytes).update("\0");
  const version = hash.digest("hex").slice(0, 16);
  const precache = [...sources.keys()].filter((name) => name !== "/sw.js").sort().map((name) => `${name}?v=${version}`);
  const files = new Map([...sources].map(([name, bytes]) => [name,
    /\.(html|js|css|webmanifest|svg|json)$/.test(name)
      ? Buffer.from(bytes.toString("utf8").replaceAll("__BUILD__", version).replaceAll("__STATIC_FILES__", JSON.stringify(precache))) : bytes,
  ]));
  return { files, version, precache };
}
