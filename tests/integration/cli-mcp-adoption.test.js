import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptFinds,
  patchFromNative,
} from "../../server/features/mcp-servers/cli-adoption.js";
import { groupFinds, publicFind } from "../../server/features/mcp-servers/cli-finds.js";
import { centralFromNative, clis } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, http } from "../helpers/cli-mcp.js";

const groups = (f) =>
  groupFinds(
    Object.fromEntries(clis.map((cli) => [cli, f.reconciler.inspect(cli)])),
    f.servers.list().map((server) => server.name),
  );
const adopt = (f, options) =>
  adoptFinds({
    servers: f.servers,
    reconciler: f.reconciler,
    groups: groups(f),
    ...options,
  });
const remote = (url) => ({
  claude: { type: "http", url, headers: { Authorization: "Bearer find-secret" } },
  codex: { url, http_headers: { Authorization: "Bearer find-secret" } },
});

test("identical finds merge across CLIs; other content and invalid or taken names get proposals", (t) => {
  const f = cliMcpFixture(t);
  f.servers.create(http({ name: "taken" }));
  const same = remote("https://same.example.test/mcp");
  f.write("claude", {
    docs: same.claude,
    "my.server": { type: "stdio", command: "/fake/bin/tool" },
    taken: same.claude,
  });
  f.write("codex", { docs: same.codex });
  f.write("opencode", {
    docs: { type: "remote", url: "https://other.example.test/mcp", enabled: true },
  });
  const found = groups(f).map(publicFind);
  assert.deepEqual(
    found.map((group) => [group.name, group.clis, group.proposedName ?? null]),
    [
      ["docs", ["claude", "codex"], null],
      ["my.server", ["claude"], "my-server"],
      ["taken", ["claude"], "taken-2"],
      ["docs", ["opencode"], "docs-2"],
    ],
  );
  assert.deepEqual(found[0].headerNames, ["Authorization"]);
  assert.doesNotMatch(JSON.stringify(found), /find-secret/);
});

test("adopting a merged find binds one server to each CLI and makes the entries AgentPier's", (t) => {
  const f = cliMcpFixture(t);
  const same = remote("https://same.example.test/mcp");
  f.write("claude", { docs: same.claude });
  f.write("codex", { docs: same.codex });
  const { adopted, failed } = adopt(f, { keys: [groups(f)[0].key] });
  assert.deepEqual(failed, []);
  assert.deepEqual(
    adopted.map((server) => [server.name, server.clis]),
    [["docs", ["claude", "codex"]]],
  );
  assert.deepEqual(f.servers.secrets(adopted[0].id).headers, {
    Authorization: "Bearer find-secret",
  });
  for (const cli of ["claude", "codex"]) {
    const result = f.reconciler.reconcile(cli);
    assert.deepEqual(result.statuses[adopted[0].id], { status: "written" });
    assert.deepEqual(result.finds, []);
  }
  assert.deepEqual(f.entries("claude").docs, same.claude);
});

test("adopting under a new name replaces the old entry, only if it is unchanged", (t) => {
  const f = cliMcpFixture(t);
  const entry = { type: "stdio", command: "/fake/bin/tool", args: [], env: {} };
  f.write("claude", { "my.server": entry });
  const stale = groups(f);
  f.write("claude", { "my.server": { ...entry, args: ["changed"] } });
  assert.throws(
    () =>
      adoptFinds({
        servers: f.servers,
        reconciler: f.reconciler,
        groups: groups(f),
        keys: [stale[0].key],
      }),
    { status: 409 },
  );
  assert.deepEqual(f.servers.list(), []);
  const [fresh] = groups(f);
  const { adopted } = adopt(f, { keys: [fresh.key], names: { [fresh.key]: "tool" } });
  assert.equal(adopted[0].name, "tool");
  assert.deepEqual(Object.keys(f.entries("claude")), ["tool"]);
  assert.deepEqual(f.entries("claude").tool.args, ["changed"]);
});

// Review Focus 5
test("adopt all reports an entry whose command is not on PATH and adopts the rest", (t) => {
  const f = cliMcpFixture(t);
  const missing = { command: "missing-tool", args: ["-y", "some-server"] };
  f.write("codex", {
    docs: remote("https://same.example.test/mcp").codex,
    tool: missing,
  });
  const { adopted, failed } = adopt(f, { all: true });
  assert.deepEqual(
    adopted.map((server) => server.name),
    ["docs"],
  );
  assert.deepEqual(
    failed.map((item) => [item.name, item.messageKey]),
    [["tool", "mcpServers.commandNotFound"]],
  );
  assert.deepEqual(f.entries("codex").tool, missing);
  assert.deepEqual(
    f.servers.list().map((server) => server.name),
    ["docs"],
  );
});

test("an entry with settings AgentPier does not manage cannot be adopted", (t) => {
  const f = cliMcpFixture(t);
  f.write("codex", {
    slow: { url: "https://x.example.test/mcp", startup_timeout_sec: 30 },
  });
  const [find] = groups(f).map(publicFind);
  assert.deepEqual([find.adoptable, find.reason], [false, "unsupported-fields"]);
  assert.throws(() => adopt(f, { keys: [find.key] }), { status: 409 });
  assert.throws(() => adopt(f, { keys: [] }), { status: 400 });
});

test("a find with environment references is skipped by adopt all and refused by key", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", {
    gh: {
      type: "http",
      url: "https://gh.example.test/mcp",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN:-find-secret}" },
    },
    plain: { type: "http", url: "https://plain.example.test/mcp" },
  });
  const found = groups(f).map(publicFind);
  const gh = found.find((find) => find.name === "gh");
  assert.deepEqual(
    [gh.adoptable, gh.reason, gh.referenceNames, gh.messageKey],
    [false, "env-references", ["Authorization"], "mcpServers.cliFindEnvReferences"],
  );
  assert.doesNotMatch(JSON.stringify(found), /find-secret|GITHUB_TOKEN/);
  assert.throws(() => adopt(f, { keys: [gh.key] }), {
    status: 409,
    code: "MCP_CLI_FIND_ENV_REFERENCES",
  });
  const { adopted, failed } = adopt(f, { all: true });
  assert.deepEqual([adopted.map((server) => server.name), failed], [["plain"], []]);
  assert.equal(
    f.entries("claude").gh.headers.Authorization,
    "Bearer ${GITHUB_TOKEN:-find-secret}",
  );
  assert.deepEqual(
    f.servers.list().map((server) => server.name),
    ["plain"],
  );
});

test("adopting a hand edit moves it into the central server for every CLI", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), {
    bind: [
      ["cli", "claude"],
      ["cli", "codex"],
    ],
  });
  f.reconciler.reconcile("claude");
  f.reconciler.reconcile("codex");
  f.write("claude", {
    docs: {
      type: "http",
      url: "https://edited.example.test/mcp",
      headers: { "X-Key": "new-secret" },
    },
  });
  const found = f.reconciler.contested(server.id, "claude");
  const patch = patchFromNative(
    f.servers.get(server.id),
    "claude",
    centralFromNative("claude", found.entry),
  );
  assert.deepEqual(patch, {
    revision: 1,
    url: "https://edited.example.test/mcp",
    auth: "headers",
    headers: { Authorization: null, "X-Key": "new-secret" },
  });
  f.servers.update(server.id, patch);
  f.reconciler.claim(server.id, "claude", found.hash);
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.entries("codex").docs.url, "https://edited.example.test/mcp");
  assert.deepEqual(f.servers.get(server.id).headerNames, ["X-Key"]);
  assert.throws(() => f.reconciler.contested(server.id, "claude"), { status: 409 });
});

test("a taken name can be adopted into the server; an OAuth server stays OAuth", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", { docs: { type: "http", url: "https://owner.example.test/mcp" } });
  const server = f.servers.create(
    {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      auth: "oauth",
    },
    { bind: [["cli", "claude"]] },
  );
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "name-taken",
  });
  const found = f.reconciler.contested(server.id, "claude");
  const patch = patchFromNative(
    f.servers.get(server.id),
    "claude",
    centralFromNative("claude", found.entry),
  );
  assert.deepEqual(patch, {
    revision: 1,
    url: "https://owner.example.test/mcp",
    auth: "oauth",
    oauthScope: "",
  });
  f.servers.update(server.id, patch);
  f.reconciler.claim(server.id, "claude", found.hash);
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.servers.get(server.id).auth, "oauth");
  assert.throws(
    () =>
      patchFromNative(
        f.servers.get(server.id),
        "claude",
        centralFromNative("claude", { type: "stdio", command: "/fake/bin/x" }),
      ),
    { status: 409 },
  );
});

// Task 3 review M1: Claude Code and Codex write an OAuth server like a header-less one.
test("an OAuth server found as header-less in Claude Code and Codex merges and stays OAuth", (t) => {
  const f = cliMcpFixture(t);
  const url = "https://oauth.example.test/mcp";
  f.write("claude", { docs: { type: "http", url } });
  f.write("codex", { docs: { url } });
  f.write("opencode", { docs: { type: "remote", url, oauth: {}, enabled: true } });
  const before = f.text("opencode");
  const found = groups(f).map(publicFind);
  assert.deepEqual(
    found.map((group) => [group.clis, group.auth]),
    [[["claude", "codex", "opencode"], "oauth"]],
  );
  const { adopted, failed } = adopt(f, { keys: [found[0].key] });
  assert.deepEqual(failed, []);
  assert.equal(adopted[0].auth, "oauth");
  for (const cli of clis)
    assert.deepEqual(f.reconciler.reconcile(cli).statuses[adopted[0].id], {
      status: "written",
    });
  assert.equal(f.text("opencode"), before);
  assert.deepEqual(f.entries("codex").docs, { url });
});

test("a header-less entry does not merge with one that has headers or a scope", (t) => {
  const f = cliMcpFixture(t);
  const url = "https://oauth.example.test/mcp";
  f.write("claude", { docs: { type: "http", url } });
  f.write("codex", { docs: { url, scopes: ["read"] } });
  f.write("opencode", {
    docs: { type: "remote", url, headers: { "X-Key": "v" }, enabled: true },
  });
  assert.equal(groups(f).length, 3);
});

// Task 3 review M2: the same address with and without a trailing slash.
test("URLs are compared normalised when finds are grouped", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", { docs: { type: "http", url: "https://slash.example.test" } });
  f.write("codex", { docs: { url: "https://slash.example.test/" } });
  const found = groups(f).map(publicFind);
  assert.deepEqual(
    found.map((group) => [group.clis, group.url]),
    [[["claude", "codex"], "https://slash.example.test/"]],
  );
  const { adopted } = adopt(f, { keys: [found[0].key] });
  for (const cli of ["claude", "codex"])
    assert.deepEqual(f.reconciler.reconcile(cli).statuses[adopted[0].id], {
      status: "written",
    });
});

test("proposals avoid the names of other finds", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", {
    "my.server": { type: "stdio", command: "/fake/bin/a" },
    "my-server": { type: "stdio", command: "/fake/bin/b" },
  });
  assert.deepEqual(
    groups(f)
      .map(publicFind)
      .map((group) => [group.name, group.proposedName ?? null]),
    [
      ["my.server", "my-server-2"],
      ["my-server", null],
    ],
  );
});

// C9: a change between grouping and adopting leaves no server and no edited entry.
test("an entry changed after grouping is not adopted and nothing is left behind", (t) => {
  const f = cliMcpFixture(t);
  const entry = { type: "stdio", command: "/fake/bin/tool" };
  f.write("claude", { tool: entry });
  const stale = groups(f);
  f.write("claude", { tool: { ...entry, args: ["changed"] } });
  const text = f.text("claude");
  assert.throws(
    () =>
      adoptFinds({
        servers: f.servers,
        reconciler: f.reconciler,
        groups: stale,
        keys: [stale[0].key],
      }),
    { status: 409 },
  );
  assert.deepEqual(f.servers.list(), []);
  assert.equal(f.text("claude"), text);
  const failed = adoptFinds({
    servers: f.servers,
    reconciler: f.reconciler,
    groups: stale,
    all: true,
  }).failed;
  assert.deepEqual(
    failed.map((item) => [item.name, item.messageKey]),
    [["tool", "mcpServers.cliFindChanged"]],
  );
  assert.deepEqual(f.servers.list(), []);
  assert.equal(f.text("claude"), text);
});

test("a CLI changed while a merged find is adopted undoes the CLIs already done", (t) => {
  let armed = 0;
  let f = null;
  f = cliMcpFixture(t, {
    configs: (locations, read) => {
      const result = read(locations);
      // The second codex read after arming is adoption's own: change the file after it.
      if (armed && locations.key === "mcp_servers" && ++armed === 3)
        f.write("codex", { tool: { command: "/fake/bin/tool", args: ["edited"] } });
      return result;
    },
  });
  const claude = { type: "stdio", command: "/fake/bin/tool", args: [], env: {} };
  f.write("claude", { tool: claude });
  f.write("codex", { tool: { command: "/fake/bin/tool", args: [], env: {} } });
  const [group] = groups(f);
  assert.deepEqual(
    group.members.map((member) => member.cli),
    ["claude", "codex"],
  );
  armed = 1;
  assert.throws(
    () =>
      adoptFinds({
        servers: f.servers,
        reconciler: f.reconciler,
        groups: [group],
        keys: [group.key],
        names: { [group.key]: "renamed" },
      }),
    { status: 409 },
  );
  assert.ok(armed >= 3);
  assert.deepEqual(f.servers.list(), []);
  assert.deepEqual(f.entries("claude"), { tool: claude });
  assert.deepEqual(f.entries("codex").tool.args, ["edited"]);
  for (const cli of ["claude", "codex"]) {
    assert.deepEqual(f.servers.cliEntries.list(cli), []);
    assert.deepEqual(
      f.reconciler.reconcile(cli).finds.map((find) => find.name),
      ["tool"],
    );
  }
});

test("a change of connection type or an unmanaged setting cannot be adopted", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  assert.throws(
    () =>
      patchFromNative(
        f.servers.get(server.id),
        "codex",
        centralFromNative("codex", { url: "https://x.example.test/mcp", foo: 1 }),
      ),
    { status: 409 },
  );
  assert.throws(
    () =>
      patchFromNative(
        f.servers.get(server.id),
        "codex",
        centralFromNative("codex", { url: "https://x.example.test/${PATH_PART}" }),
      ),
    { status: 409 },
  );
  assert.throws(() => f.reconciler.contested(server.id, "codex"), { status: 409 });
  assert.throws(() => f.reconciler.claim(server.id, "codex", "0".repeat(64)), {
    status: 409,
  });
});
