import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The fake `hermes` and `python` of a Hermes installation. `hermes gateway run`
// takes the home like Hermes does (gateway.lock with its pid and home), records its
// argv and environment, starts a grandchild in its own process group and stays up
// until TERM. `python -I <bridge> <seconds>` emits gateway.ready and answers every
// request with its method. Files in HERMES_HOME change what they do:
// `fake-gateway-exit` (the gateway exits at once), `fake-bridge-silent` (no
// gateway.ready), `fake-bridge-fail` (the bridge exits 2).
const gateway = `
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const home = process.env.HERMES_HOME;
const flag = (name) => fs.existsSync(path.join(home, name));
fs.appendFileSync(path.join(home, "fake-starts.jsonl"), JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid }) + "\\n");
// A home too long for a socket path: Hermes binds in the temporary directory.
const socket = path.join(process.env.TMPDIR, "hermes-gw-0123456789abcdef", "control.sock");
fs.mkdirSync(path.dirname(socket), { recursive: true });
fs.writeFileSync(socket, "");
fs.writeFileSync(path.join(home, "gateway.sock.path"), socket);
if (flag("fake-gateway-exit")) process.exit(3);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(home, "fake-grandchild.pid"), String(child.pid));
// Owning the home last: the bridge reports ready once it sees this.
fs.writeFileSync(path.join(home, "gateway.lock"), JSON.stringify({ pid: process.pid, kind: "hermes-gateway", hermes_home: home }));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
const bridge = `
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const home = process.env.HERMES_HOME;
const flag = (name) => fs.existsSync(path.join(home, name));
fs.appendFileSync(path.join(home, "fake-bridges.jsonl"), JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
if (flag("fake-bridge-fail")) process.exit(2);
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
// Like the real bridge: ready only once a live gateway owns the home.
const owner = () => { try { const { pid } = JSON.parse(fs.readFileSync(path.join(home, "gateway.lock"), "utf8")); process.kill(pid, 0); return true; } catch { return false; } };
const announce = () => owner() ? write({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }) : setTimeout(announce, 20);
if (!flag("fake-bridge-silent")) setTimeout(announce, 50);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  write({ jsonrpc: "2.0", id: request.id, result: { method: request.method } });
}).on("close", () => process.exit(0));
`;

/**
 * A disposable data directory with a fake Hermes installation record (`runtime`),
 * whose executables are Node scripts written as `venv/bin/hermes` and
 * `venv/bin/python`. `home(agentId)` is the agent's HERMES_HOME; `starts(agentId)`
 * the recorded gateway starts.
 */
export function hermesFakeRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-supervisor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const directory = path.join(dataDir, "assistants/hermes/runtimes/fake");
  const bin = path.join(directory, "venv", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = (name, source) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    return file;
  };
  const runtime = {
    version: "fake-hermes",
    directory,
    hermesPath: script("hermes", gateway),
    pythonPath: script("python", bridge),
  };
  const home = (agentId) => path.join(dataDir, "assistants/hermes/state", agentId);
  const lines = (file) =>
    fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
  return {
    root,
    dataDir,
    runtime,
    home,
    starts: (agentId) => lines(path.join(home(agentId), "fake-starts.jsonl")),
    bridges: (agentId) => lines(path.join(home(agentId), "fake-bridges.jsonl")),
    flag: (agentId, name, on = true) =>
      on
        ? fs.writeFileSync(path.join(home(agentId), name), "")
        : fs.rmSync(path.join(home(agentId), name), { force: true }),
    grandchild: (agentId) =>
      Number(fs.readFileSync(path.join(home(agentId), "fake-grandchild.pid"), "utf8")),
  };
}

/** Whether a process (or, with a negative pid, a process group) exists. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Resolves once `check()` is true; rejects after `ms`. */
export async function eventually(check, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
