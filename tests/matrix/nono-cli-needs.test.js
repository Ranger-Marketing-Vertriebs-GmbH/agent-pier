// test-runner-timeout-ms: 300000
// Starts real sandboxes and child processes: its own timeout class under load
// (scripts/test-runner.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  wrapWithNono,
  INSTALLATION_ROOT,
} from "../../server/features/nono/nono-launch.js";
import { cliDriver } from "../../server/features/clis/drivers.js";

/**
 * What a coding CLI itself needs inside a sandbox (`<id>/sandbox.js`), run through a
 * real nono: the unit tests pin the flags, this file asks
 * the kernel. Skipped without the binary, like nono-confinement.test.js.
 */
function nonoExecutable() {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean))
    try {
      const candidate = path.join(directory, "nono");
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  return null;
}
const executable = nonoExecutable();
const reason = !executable
  ? "nono is not installed"
  : !["darwin", "linux"].includes(process.platform)
    ? `nono does not support ${process.platform}`
    : null;
const options = reason ? { skip: reason } : {};
const macOnly =
  reason || process.platform === "darwin" ? options : { skip: "macOS trust store only" };

// Grants nothing of its own beyond what lets a binary start. On macOS it also drops
// the group that makes the shared temporary folder writable, like a tight profile of
// an operator, so a socket can only be bound where AgentPier granted it.
const restrictive = {
  meta: { name: "agentpier-cli-needs" },
  groups: {
    include: ["system_read_macos", "system_read_linux_core"],
    exclude: process.platform === "darwin" ? ["system_write_macos"] : [],
  },
  workdir: { access: "readwrite" },
  filesystem: { allow: [], read: [], write: [], deny: [] },
  network: { block: false },
};

// Outside every grant AgentPier composes (see nono-confinement.test.js).
function workspace(t) {
  const scratch = path.join(INSTALLATION_ROOT, ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "nono-cli-needs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "work"));
  const profile = path.join(root, "profile.json");
  fs.writeFileSync(profile, JSON.stringify(restrictive));
  return { root, profile, cwd: path.join(root, "work") };
}

function run({ launch, profile, cwd }) {
  const wrapped = wrapWithNono({ launch, executable, profile });
  try {
    return execFileSync(wrapped.command, ["wrap", "-s", ...wrapped.args.slice(1)], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NONO_THEME: "minimal", ...(wrapped.env || {}) },
    });
  } catch (error) {
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

const bindScript = `
const net = require("node:net"), path = require("node:path");
const file = path.join(process.argv[1], process.pid + ".sock");
const server = net.createServer();
server.once("error", (error) => console.log("BIND:" + error.code));
server.listen(file, () => { console.log("BIND:ok"); server.close(); });
`;

test(
  "a sandboxed Claude Code may bind its socket only with the folder AgentPier grants",
  options,
  (t) => {
    const { profile, cwd } = workspace(t);
    // Short, like the /tmp the CLI uses: a socket address holds about 100 bytes.
    const temporary = fs.realpathSync(fs.mkdtempSync("/tmp/apcn-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const directory = path.join(temporary, "cc-socks");
    const launch = {
      command: process.execPath,
      args: ["-e", bindScript, directory],
      env: { CLAUDE_CODE_TMPDIR: temporary },
    };
    const prepared = cliDriver("claude").sandboxLaunch(launch);
    assert.deepEqual(prepared.sandboxGrants, [
      { access: "socket-dir-bind", path: directory },
    ]);
    assert.match(run({ launch: prepared, profile, cwd }), /BIND:ok/);
    // The control: the same folder, already created, without the grant.
    if (process.platform === "darwin")
      assert.match(run({ launch, profile, cwd }), /BIND:E(PERM|ACCES)/);
  },
);

test("a sandboxed Codex can read the CA bundle its launch names", macOnly, (t) => {
  const { profile, cwd } = workspace(t);
  const launch = cliDriver("codex").sandboxLaunch({
    command: "/bin/sh",
    args: ["-c", 'grep -c "BEGIN CERTIFICATE" "$SSL_CERT_FILE"'],
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(launch.env.SSL_CERT_FILE, "/etc/ssl/cert.pem");
  const output = run({ launch, profile, cwd });
  assert.ok(Number(output.trim().split("\n").at(-1)) > 10, output);
});
