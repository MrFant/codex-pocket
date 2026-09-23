import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "pocket-browser-"));
const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    POCKET_HOST: "127.0.0.1", POCKET_PORT: "3219",
    POCKET_STATE_PATH: path.join(directory, "missing-state.sqlite"),
    POCKET_CATALOG_PATH: path.join(directory, "missing-catalog.sqlite"),
    POCKET_DESKTOP_STATE_PATH: "none",
    POCKET_OVERLAY_PATH: path.join(directory, "pocket.json"),
    POCKET_IMAGE_DIRECTORY: path.join(directory, "images"),
    POCKET_REQUEST_DB_PATH: path.join(directory, "requests.sqlite"),
    POCKET_APP_SERVER_FIXTURE: path.join(root, "test/fixtures/fake-app-server.mjs"),
  },
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGTERM"));
child.on("exit", async (code) => {
  await rm(directory, { recursive: true, force: true });
  process.exit(code || 0);
});
