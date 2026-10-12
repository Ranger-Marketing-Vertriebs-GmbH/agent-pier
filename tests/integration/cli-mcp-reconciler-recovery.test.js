import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clis, entryHash } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, http, stdio } from "../helpers/cli-mcp.js";

/** Plays Claude Code rewriting ~/.claude.json with a changed counter. */
const touch = (f, value) => {
  const data = fs.existsSync(f.file("claude")) ? JSON.parse(f.text("claude")) : {};
  fs.writeFileSync(
    f.file("claude"),
    JSON.stringify({ ...data, numStartups: value }, null, 2),
  );
};

test("a file changed between read and write is read again and written", (t) => {
  let calls = 0;
  let f = null;
  f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const result = read(locations);
      if (++calls === 2) touch(f, 7);
      return result;
    },
  });
  f.write("claude", {});
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.equal(JSON.parse(f.text("claude")).numStartups, 7);
  assert.ok(f.entries("claude").docs);
  assert.ok(calls >= 4);
});

test("a file that keeps changing is given up after three attempts, untouched", (t) => {
  let calls = 0;
  let f = null;
  f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const result = read(locations);
      touch(f, ++calls);
      return result;
    },
  });
  f.write("claude", {});
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  const result = f.reconciler.reconcile("claude");
  assert.equal(result.error, "changed");
  assert.deepEqual(result.statuses[server.id], { status: "error", reason: "changed" });
  assert.equal(f.entries("claude").docs, undefined);
  assert.equal(JSON.parse(f.text("claude")).numStartups, calls);
});

test("a write recorded but not yet in the file is finished by the next run", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  const want = f.reconciler.desired("codex").get(server.id);
  f.servers.cliEntries.intend(server.id, "codex", "docs", want.hash);
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  assert.equal(entryHash(f.entries("codex").docs), want.hash);
  assert.equal(f.servers.cliEntries.get(server.id, "codex").pendingHash, null);
});

test("a write in the file but not yet settled is recognised as AgentPier's", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  const want = f.reconciler.desired("codex").get(server.id);
  f.servers.cliEntries.intend(server.id, "codex", "docs", want.hash);
  f.write("codex", { docs: want.entry });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  const row = f.servers.cliEntries.get(server.id, "codex");
  assert.deepEqual([row.hash, row.pendingHash], [want.hash, null]);
});

test("a deleted server's entry waits for a readable file, then goes", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  const good = f.text("claude");
  f.raw("claude", "{ broken");
  f.servers.remove(server.id);
  assert.equal(f.reconciler.reconcile("claude").error, "unreadable");
  assert.equal(f.servers.cliEntries.list("claude").length, 1);
  f.raw("claude", good);
  f.reconciler.reconcile("claude");
  assert.deepEqual(f.entries("claude"), {});
  assert.deepEqual(f.servers.cliEntries.list("claude"), []);
});

// Review Focus 1
test("a file the CLI re-serialized keeps AgentPier's entries managed", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), {
    bind: [
      ["cli", "claude"],
      ["cli", "codex"],
    ],
  });
  f.reconciler.reconcile("claude");
  f.reconciler.reconcile("codex");
  const docs = f.entries("claude").docs;
  const reordered = Object.fromEntries(Object.entries(docs).reverse());
  fs.writeFileSync(
    f.file("claude"),
    JSON.stringify({ numStartups: 3, mcpServers: { docs: reordered } }),
  );
  const codex = f.entries("codex").docs;
  fs.writeFileSync(
    f.file("codex"),
    `[mcp_servers.docs]\nhttp_headers = { Authorization = ${JSON.stringify(codex.http_headers.Authorization)} }\nurl = ${JSON.stringify(codex.url)}\n`,
  );
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
});

// Review Focus 2
test("renaming a bound server replaces its entry and leaves no find", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  f.reconciler.reconcile("opencode");
  f.servers.update(server.id, { revision: 1, name: "docs2" });
  const result = f.reconciler.reconcile("opencode");
  assert.deepEqual(Object.keys(f.entries("opencode")), ["docs2"]);
  assert.deepEqual(result.statuses[server.id], { status: "written" });
  assert.deepEqual(result.finds, []);
  assert.equal(f.servers.cliEntries.get(server.id, "opencode").name, "docs2");
});

// Review Focus 3
test("a new header value rewrites AgentPier's entry and is no conflict", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  f.servers.update(server.id, {
    revision: 1,
    headers: { Authorization: "Bearer rotated-secret" },
  });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.entries("claude").docs.headers.Authorization, "Bearer rotated-secret");
});

test("a renamed server whose old entry was edited by hand drops its old record", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  const edited = { ...f.entries("claude").docs, url: "https://edited.example.test/mcp" };
  const owner = { type: "http", url: "https://owner.example.test/mcp" };
  f.write("claude", { docs: edited, docs2: owner });
  f.servers.update(server.id, { revision: 1, name: "docs2" });
  const result = f.reconciler.reconcile("claude");
  assert.deepEqual(result.statuses[server.id], { status: "name-taken" });
  assert.deepEqual(f.entries("claude"), { docs: edited, docs2: owner });
  assert.equal(f.servers.cliEntries.get(server.id, "claude"), null);
  assert.deepEqual(
    result.finds.map((find) => find.name),
    ["docs"],
  );
});

const kinds = {
  http: () => http(),
  oauth: () => http({ name: "signin", auth: "oauth", headers: {}, oauthScope: "read" }),
  bare: () => http({ name: "bare", headers: {} }),
  stdio: () => stdio({ env: {} }),
  cwd: () => stdio({ name: "rooted", cwd: "/tmp" }),
};
for (const cli of clis)
  test(`${cli}: a second run changes nothing and the owner's entry keeps its value`, (t) => {
    const f = cliMcpFixture(t);
    const owner = {
      claude: { type: "stdio", command: "/bin/owner", args: [], env: {} },
      codex: { command: "/bin/owner", args: ["-v"], env: { A: "1" } },
      opencode: { type: "local", command: ["/bin/owner"], enabled: true },
    }[cli];
    f.write(cli, { mine: owner });
    const ids = Object.values(kinds).map(
      (make) => f.servers.create(make(), { bind: [["cli", cli]] }).id,
    );
    f.reconciler.reconcile(cli);
    const second = f.reconciler.reconcile(cli);
    assert.deepEqual(second.actions, []);
    for (const id of ids)
      assert.equal(
        second.statuses[id].status,
        second.statuses[id].reason ? "error" : "written",
      );
    assert.deepEqual(f.entries(cli).mine, owner);
    assert.deepEqual(
      second.finds.map((find) => find.name),
      ["mine"],
    );
  });
