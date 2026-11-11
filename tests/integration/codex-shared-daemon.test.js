import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { cliDriver } from "../../server/features/clis/drivers.js";

const launchScript = fileURLToPath(
  new URL("../../server/features/requests/codex-launch.js", import.meta.url),
);

/**
 * Codex 0.157 and later attach an interactive TUI to a shared background app server
 * ("daemon") when one runs for the same CODEX_HOME. That server runs the tools, so a
 * sandboxed TUI attached to a daemon outside the sandbox would run them unconfined
 * (nono's Codex guide recommends `codex --no-daemon`). AgentPier's sessions never
 * look for it: the launch wrapper starts an app server of its own, as its child and
 * so inside the same sandbox, and names it to the TUI with `--remote`. Codex refuses
 * `--no-daemon` together with `--remote`, so the flag must not be passed either.
 */
test("a Codex session runs its own app server and names it to the TUI", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-codex-daemon-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "codex.cjs");
  const record = path.join(dir, "argv");
  await fs.writeFile(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const server = process.argv.includes('app-server');
fs.writeFileSync(${JSON.stringify(record)} + (server ? '.server' : '.tui'),
  JSON.stringify({ argv: process.argv.slice(2), parent: process.ppid }));
if (server) setInterval(() => {}, 1000);
else setInterval(() => { if (fs.existsSync(${JSON.stringify(record)} + '.server')) process.exit(0); }, 10);
`,
    { mode: 0o700 },
  );
  const launch = path.join(dir, "launch.json");
  await fs.writeFile(
    launch,
    JSON.stringify({
      token: "fixture",
      command: cli,
      args: ["--yolo"],
      cwd: dir,
      socketPath: path.join(dir, "absent.sock"),
    }),
  );
  const wrapper = spawn(process.execPath, [launchScript, launch], {
    env: {
      PATH: process.env.PATH,
      CODEX_HOME: dir,
      AGENTPIER_REQUEST_FILE: launch,
      AGENTPIER_REQUEST_TOKEN: "fixture",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => wrapper.kill("SIGKILL"));
  await once(wrapper, "close");
  const read = async (kind) => JSON.parse(await fs.readFile(`${record}.${kind}`, "utf8"));
  const server = await read("server");
  const tui = await read("tui");
  // The app server is a foreground one on stdio, not the daemon's management.
  assert.deepEqual(server.argv.slice(-2), ["app-server", "--stdio"]);
  assert.equal(server.argv.includes("daemon"), false);
  // The TUI is told where its server is, so it does not look for a shared one.
  const remote = tui.argv[tui.argv.indexOf("--remote") + 1];
  assert.match(remote, /^ws:\/\/127\.0\.0\.1:\d+/);
  assert.equal(tui.parent, wrapper.pid, "the TUI is the wrapper's child");
  for (const { argv } of [server, tui]) assert.equal(argv.includes("--no-daemon"), false);
});

test("every Codex session with native requests starts through that wrapper", async () => {
  const grants = [];
  const prepared = await cliDriver("codex").prepareRequests(
    { file: "/data/requests/one/one.launch.json", args: ["--yolo"], env: {}, grants },
    { command: "/bin/codex", args: ["--yolo"], env: {} },
  );
  assert.equal(prepared.command, process.execPath);
  assert.deepEqual(prepared.args, [launchScript, "/data/requests/one/one.launch.json"]);
});
