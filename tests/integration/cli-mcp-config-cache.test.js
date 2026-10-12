import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { configParses } from "../../server/features/extensions/config-edit.js";
import { cliMcpFixture, http } from "../helpers/cli-mcp.js";

const owner = { mine: { type: "stdio", command: "/bin/owner", args: [], env: {} } };
/** Parses since `before`: full reads of a file and tree parses of a known text for an edit. */
const since = (before) => ({
  reads: configParses.reads - before.reads,
  edits: configParses.edits - before.edits,
});
const snapshot = () => ({ ...configParses });

test("an unchanged file is parsed once across reconcile and finds", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", owner, { projects: { "/fixture": { history: ["x"] } } });
  f.servers.create(http(), { bind: [["cli", "claude"]] });
  const before = snapshot();
  const result = f.reconciler.reconcile("claude");
  assert.equal(result.statuses[Object.keys(result.statuses)[0]].status, "written");
  f.reconciler.inspect("claude");
  f.reconciler.reconcile("claude");
  f.extensions.list("local-claude");
  // One read; AgentPier's own write needs no second read, and the edit reuses the
  // read's tree. The written result is verified separately.
  assert.deepEqual(since(before), { reads: 1, edits: 0 });
  assert.deepEqual(Object.keys(f.entries("claude")), ["mine", "docs"]);
});

test("a changed modification time or size makes the file parsed again", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", owner);
  const before = snapshot();
  f.reconciler.inspect("claude");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f.file("claude"), later, later);
  f.reconciler.inspect("claude");
  assert.deepEqual(since(before), { reads: 2, edits: 0 });
  // Same size, another entry name: the content must be read again, not the cache.
  f.write("claude", { mind: owner.mine });
  const finds = f.reconciler.inspect("claude").finds.map((find) => find.name);
  assert.deepEqual(finds, ["mind"]);
  f.write("claude", { longer: owner.mine });
  assert.deepEqual(
    f.reconciler.inspect("claude").finds.map((find) => find.name),
    ["longer"],
  );
  assert.equal(since(before).reads, 4);
});

test("a file that grows past the limit between read and write reports too-large", (t) => {
  let calls = 0;
  const f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const configs = read(locations);
      // The edit's own read: the file grows before AgentPier writes it.
      if (++calls === 2) fs.truncateSync(locations.files.at(-1), 64 * 1024 * 1024 + 1);
      return configs;
    },
  });
  f.write("claude", owner);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  const result = f.reconciler.reconcile("claude");
  assert.equal(result.error, "too-large");
  assert.deepEqual(result.statuses[server.id], { status: "error", reason: "too-large" });
  assert.equal(fs.statSync(f.file("claude")).size, 64 * 1024 * 1024 + 1);
  assert.doesNotMatch(
    fs.readFileSync(f.file("claude"), "utf8").replace(/\0+$/, ""),
    /header-secret/,
  );
});

test("the extensions view names a configuration above the limit as too large", (t) => {
  const f = cliMcpFixture(t);
  f.raw("claude", "{}");
  fs.truncateSync(f.file("claude"), 64 * 1024 * 1024 + 1);
  assert.throws(() => f.extensions.list("local-claude"), {
    status: 409,
    message: serverMessages.extensions.cliConfigTooLarge,
  });
});
