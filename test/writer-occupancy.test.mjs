import assert from "node:assert/strict";
import test from "node:test";
import { inspectWriterOccupancy, parseOpenWriterLocks } from "../lib/writer-occupancy.mjs";

const directory = "/tmp/pocket-writer-locks";
const handles = [
  "p101", "ccodex", "f12", `n${directory}/desktop-thread.lock`,
  "f13", `n${directory}/pocket-thread.lock`,
  "p202", "ccodex", "f30", `n${directory}/external-thread.lock`,
  "p303", "ccodex", "f40", `n${directory}/pocket-thread.lock`,
  "f41", `n${directory}/.coordination.lock`,
  "f42", "n/tmp/other/another-thread.lock",
].join("\n");

test("only opened writer files in the expected directory count as possible owners", () => {
  const owners = parseOpenWriterLocks(handles, directory);
  assert.deepEqual([...owners.keys()], ["desktop-thread", "pocket-thread", "external-thread"]);
  assert.deepEqual([...owners.get("pocket-thread")], [101, 303]);
  assert.equal(owners.has("stale-on-disk"), false);
});

test("distinguishes Pocket's writer from Desktop and unclassified external clients", async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === "lsof") return { stdout: handles };
    return { stdout: args[1] === "101"
      ? "/Applications/ChatGPT.app/Contents/Resources/codex\n"
      : "/home/test/.local/bin/codex\n" };
  };
  assert.deepEqual(await inspectWriterOccupancy(directory, { "pocket-thread": 303 }, execute), {
    "desktop-thread": "desktop", "pocket-thread": "pocket", "external-thread": "external",
  });
  assert.equal(calls[0][0], "lsof");
  assert.equal(calls.some(([command]) => command === "ps"), true);
});

test("a failed lock scan never claims that unknown writers are free", async () => {
  const occupancy = await inspectWriterOccupancy(directory, { ours: 77 }, async () => {
    throw Object.assign(new Error("lsof unavailable"), { code: "ENOENT" });
  });
  assert.deepEqual(occupancy, { ours: "pocket" });
});
