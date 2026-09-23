import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

export function parseOpenWriterLocks(output, directory) {
  const owners = new Map();
  let pid = null;
  const prefix = `${path.resolve(directory)}${path.sep}`;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    if (!line.startsWith("n") || !pid) continue;
    const filename = line.slice(1);
    if (!filename.startsWith(prefix)) continue;
    const match = filename.slice(prefix.length).match(/^([^/]+)\.lock$/);
    if (!match || match[1].startsWith(".")) continue;
    if (!owners.has(match[1])) owners.set(match[1], new Set());
    owners.get(match[1]).add(pid);
  }
  return owners;
}

export async function inspectWriterOccupancy(directory, pocketWorkerPids = {}, execute = run) {
  if (!directory) return {};
  let output;
  try {
    ({ stdout: output } = await execute("lsof", ["-nP", "-F", "pcn", "+D", directory], { timeout: 3_000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    // lsof exits 1 when no matching descriptor exists. Other failures are not
    // evidence that a thread is free, so only report Pocket's known workers.
    if (error.code !== 1) return Object.fromEntries(Object.keys(pocketWorkerPids).map((id) => [id, "pocket"]));
    output = error.stdout || "";
  }
  const owners = parseOpenWriterLocks(output, directory);
  const externalPids = [...new Set([...owners.entries()].flatMap(([id, pids]) =>
    [...pids].filter((pid) => Number(pocketWorkerPids[id]) !== pid)))];
  const desktopPids = new Set();
  await Promise.all(externalPids.map(async (pid) => {
    try {
      const { stdout } = await execute("ps", ["-p", String(pid), "-o", "comm="], { timeout: 2_000 });
      if (stdout.includes("/ChatGPT.app/")) desktopPids.add(pid);
    } catch { /* An unclassified process is still an external client. */ }
  }));

  const occupancy = Object.fromEntries(Object.keys(pocketWorkerPids).map((id) => [id, "pocket"]));
  for (const [id, pids] of owners) {
    if (occupancy[id]) continue;
    occupancy[id] = [...pids].some((pid) => desktopPids.has(pid)) ? "desktop" : "external";
  }
  return occupancy;
}
