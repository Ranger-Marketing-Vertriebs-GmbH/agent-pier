import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { adoptFinds } from "../../server/features/mcp-servers/cli-adoption.js";
import { groupFinds } from "../../server/features/mcp-servers/cli-finds.js";
import { clis } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture } from "../helpers/cli-mcp.js";

// An adoption under a new name and its undo are one write each: whatever fails, the
// owner's entry (secrets included) is never gone and nothing of AgentPier's is left.
const owner = {
  type: "stdio",
  command: "/fake/bin/tool",
  args: [],
  env: { TOKEN: "owner-secret" },
};
const codexOwner = {
  command: "/fake/bin/tool",
  args: [],
  env: { TOKEN: "owner-secret" },
};
const groupsOf = (f) =>
  groupFinds(Object.fromEntries(clis.map((cli) => [cli, f.reconciler.inspect(cli)])), []);
const adoptRenamed = (f, [group]) =>
  adoptFinds({
    servers: f.servers,
    reconciler: f.reconciler,
    groups: [group],
    keys: [group.key],
    names: { [group.key]: "renamed" },
  });
const nothingLeft = (f, cli) => {
  assert.deepEqual(f.servers.list(), []);
  assert.deepEqual(f.servers.cliEntries.list(cli), []);
};
/** A fixture whose native reads call `hook(cli, f)` after reading. */
const hooked = (t, hook) => {
  let f = null;
  const byKey = { mcpServers: "claude", mcp_servers: "codex", mcp: "opencode" };
  f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const result = read(locations);
      hook(byKey[locations.key], f);
      return result;
    },
  });
  return f;
};
/** Runs `work` with `dir` read-only; the fixture's cleanup needs it writable again. */
const readOnly = (dir, work) => {
  fs.chmodSync(dir, 0o500);
  try {
    return work();
  } finally {
    fs.chmodSync(dir, 0o700);
  }
};

test("a rename adoption that loses its compare-and-swap leaves the file as the owner left it", (t) => {
  let reads = 0;
  const f = hooked(t, (cli, fixture) => {
    // The third read after arming is the write's own: another program writes then.
    if (reads && cli === "claude" && ++reads === 4)
      fixture.write("claude", { tool: owner }, { numStartups: 7 });
  });
  f.write("claude", { tool: owner });
  const groups = groupsOf(f);
  reads = 1;
  assert.throws(() => adoptRenamed(f, groups), { code: "CLI_CONFIG_CHANGED" });
  assert.equal(reads, 5);
  assert.equal(
    f.text("claude"),
    JSON.stringify({ numStartups: 7, mcpServers: { tool: owner } }, null, 2),
  );
  nothingLeft(f, "claude");
});

test("a rename adoption into an unwritable file leaves it byte-identical", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", { tool: owner });
  const before = f.text("claude");
  const groups = groupsOf(f);
  readOnly(f.home, () =>
    assert.throws(() => adoptRenamed(f, groups), { cliReason: "write-failed" }),
  );
  assert.equal(f.text("claude"), before);
  nothingLeft(f, "claude");
});

/** Claude Code is taken over, then Codex changes under adoption: Claude Code is undone. */
const failCodex = (t, onUndo) => {
  let armed = 0;
  let undoing = false;
  const f = hooked(t, (cli, fixture) => {
    if (undoing && cli === "claude") onUndo(fixture, () => (undoing = false));
    if (armed && cli === "codex" && ++armed === 3) {
      fixture.write("codex", { tool: { ...codexOwner, args: ["edited"] } });
      undoing = true;
    }
  });
  f.write("claude", { tool: owner });
  f.write("codex", { tool: codexOwner });
  const groups = groupsOf(f);
  assert.equal(groups.length, 1);
  armed = 1;
  return { f, groups };
};

test("an undo that loses its compare-and-swap once is tried again and restores the entry", (t) => {
  let original = null;
  const { f, groups } = failCodex(t, (fixture, done) => {
    // Another program rewrites the file while the undo reads it.
    done();
    fixture.raw(
      "claude",
      fixture.text("claude").replace(/\n}$/, ',\n  "numStartups": 1\n}'),
    );
  });
  original = f.text("claude");
  assert.throws(() => adoptRenamed(f, groups), { status: 409 });
  // The owner's entry is back byte for byte, beside the other program's change.
  assert.equal(f.text("claude"), original.replace(/\n}$/, ',\n  "numStartups": 1\n}'));
  nothingLeft(f, "claude");
});

test("an undo into an unwritable file keeps the owner's entry and secrets as a find", (t) => {
  const { f, groups } = failCodex(t, (fixture, done) => {
    done();
    fs.chmodSync(fixture.home, 0o500);
  });
  try {
    assert.throws(() => adoptRenamed(f, groups), { status: 409 });
  } finally {
    fs.chmodSync(f.home, 0o700);
  }
  // The takeover wrote the owner's own content under the new name; it stays theirs.
  assert.deepEqual(f.entries("claude"), { renamed: owner });
  nothingLeft(f, "claude");
  assert.deepEqual(
    f.reconciler.reconcile("claude").finds.map((find) => [find.name, find.entry]),
    [["renamed", owner]],
  );
  assert.match(f.warnings.join("\n"), /could not be restored/);
  assert.doesNotMatch(f.warnings.join("\n"), /owner-secret/);
});

test("whichever read another program writes after, the owner's entry is never lost", (t) => {
  for (let at = 2; at <= 8; at++) {
    let reads = 0;
    const f = hooked(t, (cli, fixture) => {
      if (reads && cli === "claude" && ++reads === at)
        fixture.raw("claude", `${fixture.text("claude")}\n`);
    });
    f.write("claude", { tool: owner });
    const groups = groupsOf(f);
    reads = 1;
    let adopted = false;
    try {
      adopted = adoptRenamed(f, groups).adopted.length === 1;
    } catch (error) {
      assert.equal(error.code, "CLI_CONFIG_CHANGED", `read ${at}`);
    }
    const entries = f.entries("claude");
    if (adopted) assert.deepEqual(entries, { renamed: owner }, `read ${at}`);
    else {
      assert.deepEqual(entries, { tool: owner }, `read ${at}`);
      nothingLeft(f, "claude");
    }
  }
});
