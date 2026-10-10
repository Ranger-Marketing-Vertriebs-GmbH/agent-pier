import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { prepareRequests } from "../../server/features/requests/request-launch.js";
import { ADAPTER_URL_PLACEHOLDER } from "../../server/features/providers/adapter-launch.js";
import { KEY, TOKEN, validAdapterConfig } from "../helpers/adapter-fixture.js";

const launcher = fileURLToPath(
  new URL("../../server/terminal-launcher.js", import.meta.url),
);

// Regression: Codex on an adapter route is started by codex-launch.js from the request
// file, not from the launcher payload. Both Codex processes (owned app-server and TUI)
// must receive the bound adapter origin, never the placeholder. The fake TUI waits for
// the backend's record because the keeper spawns the app-server asynchronously and the
// TUI's exit tears the backend group down.
test("Codex adapter launches reach both Codex processes with the bound adapter URL", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-codex-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = path.join(dir, "requests");
  fs.mkdirSync(requests, { mode: 0o700 });
  const record = path.join(dir, "argv");
  const cli = path.join(dir, "codex.cjs");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const backend = process.argv.includes('app-server');
fs.writeFileSync(${JSON.stringify(record)} + (backend ? '.backend' : '.tui'), JSON.stringify(process.argv.slice(2)));
if (backend) setInterval(() => {}, 1000);
else {
  // The owned app-server starts asynchronously; exiting first tears it down unrecorded.
  const deadline = Date.now() + 10000;
  const wait = () =>
    fs.statSync(${JSON.stringify(record)} + '.backend', { throwIfNoEntry: false })?.size ||
    Date.now() > deadline
      ? process.exit(0)
      : setTimeout(wait, 10);
  wait();
}
`,
    { mode: 0o700 },
  );
  const broker = {
    directory: requests,
    socketPath: path.join(requests, "absent.sock"),
    file: (id) => path.join(requests, `${id}.launch.json`),
  };
  const adapter = validAdapterConfig({ clientProtocol: "responses" });
  const prepared = await prepareRequests(broker, {
    id: "session-1",
    account: { id: "acct", tool: "codex" },
    cwd: dir,
    launch: {
      command: cli,
      args: [
        "-c",
        `model_providers={ep={base_url="${ADAPTER_URL_PLACEHOLDER}/v1",env_key="K"}}`,
      ],
      cwd: dir,
      env: { PATH: process.env.PATH, CODEX_HOME: dir, K: TOKEN },
      adapter,
    },
  });
  const payload = path.join(dir, "s.launch.json");
  fs.writeFileSync(
    payload,
    JSON.stringify({
      command: prepared.command,
      args: prepared.args,
      cwd: dir,
      env: prepared.env,
      adapter: prepared.adapter,
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [launcher, payload], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  for (const name of ["backend", "tui"]) {
    const argv = fs.readFileSync(`${record}.${name}`, "utf8");
    assert.equal(argv.includes(ADAPTER_URL_PLACEHOLDER), false, `${name}: ${argv}`);
    assert.match(argv, /base_url=\\"http:\/\/127\.0\.0\.1:\d+\/v1\\"/, name);
    assert.equal(argv.includes(KEY), false);
  }
});
