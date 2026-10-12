import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decide, listTree, shellGateway } from "../helpers/assistant-shell-gateway.js";

// docs/assistant-shell-qualification.md, fact (d): which environment exec children
// get, and how they can run with the owner's HOME and login PATH while the Gateway
// keeps its private state. The owner's HOME and login PATH are simulated inside the
// test directory; the developer's own HOME is never used.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: 300000,
};
const execTools = ["session_status", "exec", "process"];

const withoutShell = ({ SHELL: _shell, ...env }) => env;

// Starts a Gateway whose environment `shape(env, paths, fixture)` derives from
// AgentPier's own (which carries the exec shell wrapper for the simulated owner).
async function ownerGateway(t, prefix, shape) {
  const fixture = {};
  const gw = await shellGateway(t, installed, {
    prefix,
    environment: (env, paths) => shape(env, paths, fixture),
    setup: (runtime, dataDir, owner) => {
      Object.assign(fixture, owner);
      fixture.tree = listTree(fixture.home);
    },
  });
  await gw.configure({ tools: { allow: execTools, exec: { mode: "full" } } });
  return { gw, owner: fixture };
}

// What an exec child sees: HOME, PATH, where `gh` resolves, what it reads, and the
// names (never the values) of the OPENCLAW_* variables. Only the fixture's fake `gh`
// is run: the host's system PATH may hold a real one (/usr/bin/gh on GitHub's Ubuntu
// runners, /opt/homebrew/bin/gh on its macOS runners), which must never run here.
async function probe(gw, label, extra = {}) {
  const out = path.join(gw.dataDir, `${label}.txt`);
  const command =
    `{ printf 'HOME=%s\\n' "$HOME"; printf 'PATH=%s\\n' "$PATH"; ` +
    `gh="$(command -v gh)"; printf 'GH=%s\\n' "$gh"; ` +
    `case "$gh" in '${gw.owner.bin}/'*) "$gh" 2>/dev/null ;; esac; ` +
    `env | cut -d= -f1 | grep '^OPENCLAW' | sort; } > ${out} 2>&1`;
  const { result } = await gw.turn(label, { command, ...extra });
  if (!fs.existsSync(out)) return { result };
  const lines = fs.readFileSync(out, "utf8").trim().split("\n");
  const value = (key) =>
    lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
  const seen = {
    home: value("HOME"),
    path: value("PATH").split(":"),
    gh: value("GH"),
    ghOutput: lines.find((l) => l.startsWith("fake-gh")),
    names: lines.filter((l) => /^OPENCLAW[A-Z0-9_]*$/.test(l)),
  };
  return { result, seen };
}

test(
  "without the wrapper exec children inherit the Gateway's private HOME",
  options,
  async (t) => {
    // Before AGENTPIER-25 the Gateway also passed OPENCLAW_GATEWAY_TOKEN, which
    // every child saw; AgentPier no longer puts it into the environment.
    const { gw, owner } = await ownerGateway(t, "shell-env-today-", withoutShell);
    const { seen } = await probe(gw, "today");
    t.diagnostic(`today=${JSON.stringify(seen)}`);
    assert.equal(seen.home, gw.runtime.paths.home);
    // OpenClaw merges a system login PATH (/bin/sh -l with the private HOME), so a
    // `gh` the host installed system-wide may resolve; the owner's never does.
    assert.equal(
      seen.path.includes(owner.bin),
      false,
      "the owner's login profile is not read",
    );
    assert.notEqual(seen.gh, path.join(owner.bin, "gh"));
    assert.equal(seen.ghOutput, undefined);
    assert.equal(seen.names.includes("OPENCLAW_GATEWAY_TOKEN"), false);
    for (const name of ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_SHELL"])
      assert.ok(seen.names.includes(name), name);

    // A per-call HOME is refused for host execution; there is no exec env setting.
    const refused = await gw.turn("per-call", {
      command: "true",
      env: { HOME: owner.home },
    });
    assert.match(
      refused.result,
      /Security Violation: Environment variable 'HOME' is forbidden during host execution/,
    );
    const exec = await gw.client.call("config.schema.lookup", { path: "tools.exec" });
    const children = exec.children.map((c) => c.key ?? c.path ?? c);
    t.diagnostic(`tools.exec children=${JSON.stringify(children)}`);
    assert.ok(children.includes("pathPrepend"));
    assert.equal(children.includes("env"), false);
    const env = await gw.client.call("config.schema.lookup", { path: "env" });
    assert.equal(env.reloadKind, "restart");

    // tools.exec.pathPrepend reaches the child's PATH (hot) but not its HOME.
    await gw.configure({ tools: { exec: { pathPrepend: [owner.bin] } } });
    const prepended = await probe(gw, "prepend");
    assert.equal(prepended.seen.gh, path.join(owner.bin, "gh"));
    assert.equal(prepended.seen.home, gw.runtime.paths.home);
    assert.equal(
      prepended.seen.ghOutput,
      "fake-gh ",
      "gh finds no login in the private HOME",
    );
    assert.deepEqual(listTree(owner.home), owner.tree);
  },
);

test(
  "candidate: the Gateway on the owner's HOME with OPENCLAW_HOME private",
  options,
  async (t) => {
    const { gw, owner } = await ownerGateway(t, "shell-env-home-", (env, paths, fx) => ({
      ...env,
      HOME: fx.home,
      OPENCLAW_HOME: paths.home,
      SHELL: "/bin/sh",
    }));
    const { seen } = await probe(gw, "owner-home");
    t.diagnostic(`owner-home=${JSON.stringify(seen)}`);
    assert.equal(seen.home, owner.home);
    assert.ok(seen.path.includes(owner.bin), "the owner's login PATH is merged");
    assert.equal(seen.gh, path.join(owner.bin, "gh"));
    assert.equal(seen.ghOutput, "fake-gh   user: fixture");
    assert.equal(seen.names.includes("OPENCLAW_GATEWAY_TOKEN"), false);
    // Configuration and approvals stay in the private state directory ...
    const approvals = await (await gw.approver()).call("exec.approvals.get", {});
    assert.ok(approvals.path.startsWith(gw.runtime.paths.state + path.sep));
    // ... but the Gateway itself writes caches into the owner's HOME.
    const written = listTree(owner.home).filter((f) => !owner.tree.includes(f));
    t.diagnostic(`written into the owner's HOME=${JSON.stringify(written)}`);
    t.diagnostic(`private home=${JSON.stringify(listTree(gw.runtime.paths.home))}`);
    if (process.platform === "darwin")
      assert.ok(written.includes("Library/Caches/openclaw"));
  },
);

test(
  "AgentPier's environment: HOME through the exec shell wrapper, PATH through pathPrepend",
  options,
  async (t) => {
    const { gw, owner } = await ownerGateway(t, "shell-env-wrapper-", (env) => env);
    // RuntimeSupervisor's own wrapper, read-only for the owner.
    const wrapper = path.join(gw.runtime.paths.root, "exec-shell", "sh");
    assert.equal(fs.statSync(wrapper).mode & 0o777, 0o500);
    // The Gateway starts with its token only in gateway.auth.token.
    assert.equal(gw.runtime.status().availability, "ready");
    await gw.configure({ tools: { exec: { pathPrepend: [owner.bin] } } });
    const { seen } = await probe(gw, "wrapper");
    t.diagnostic(`wrapper=${JSON.stringify(seen)}`);
    assert.equal(seen.home, owner.home);
    assert.equal(
      seen.path[1],
      owner.bin,
      "pathPrepend follows OpenClaw's agent-cli shim",
    );
    assert.equal(seen.gh, path.join(owner.bin, "gh"));
    assert.equal(seen.ghOutput, "fake-gh   user: fixture");
    assert.equal(seen.names.includes("OPENCLAW_GATEWAY_TOKEN"), false);
    assert.equal(seen.names.includes("OPENCLAW_HOME"), false);

    // Approved runs take the same shell, so they see the owner's HOME as well.
    await gw.configure({ tools: { exec: { mode: "ask" } } });
    const approver = await gw.approver();
    const out = path.join(gw.dataDir, "approved");
    const approved = await decide(
      gw,
      approver,
      await gw.send("approved", `homeprobe ${out}`),
      "allow-once",
    );
    t.diagnostic(`approval request=${JSON.stringify(approved.request.request)}`);
    assert.equal(
      approved.request.request.resolvedPath,
      path.join(owner.bin, "homeprobe"),
    );
    // A user-owned executable is never offered allow-always on macOS (fact a).
    const { allowedDecisions } = approved.request.request;
    t.diagnostic(
      `${process.platform} allowedDecisions=${JSON.stringify(allowedDecisions)}`,
    );
    if (process.platform === "darwin")
      assert.deepEqual(allowedDecisions, ["allow-once", "deny"]);
    assert.equal(fs.readFileSync(out, "utf8").trim(), owner.home);
    // The owner's HOME is untouched; the Gateway's own files stay private.
    assert.deepEqual(listTree(owner.home), owner.tree);
    const approvals = await approver.call("exec.approvals.get", {});
    assert.ok(approvals.path.startsWith(gw.runtime.paths.state + path.sep));
    t.diagnostic(`private home=${JSON.stringify(listTree(gw.runtime.paths.home))}`);
  },
);
