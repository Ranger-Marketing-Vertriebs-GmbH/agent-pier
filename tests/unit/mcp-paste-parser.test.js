import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parsePaste,
  pickServer,
} from "../../web/features/mcp-servers/wizard/paste-parser.js";

const fixture = (name) =>
  fs.readFileSync(new URL(`../fixtures/mcp-paste/${name}`, import.meta.url), "utf8");
const codes = (notes) => notes.map((note) => note.code);
const rows = (list) => list.map(({ name, value }) => [name, value]);
const one = (text, options) => pickServer(parsePaste(text, options), 0);

test("Claude Desktop block: the OPNsense guide becomes an npm package draft", () => {
  const server = one(fixture("opnsense.json"));
  assert.equal(server.name, "opnsense");
  assert.equal(server.draft.path, "package");
  assert.deepEqual(
    [server.draft.registry, server.draft.packageName, server.draft.packageVersion],
    ["npm", "opnsense-mcp-server", ""],
  );
  assert.deepEqual(server.draft.argRows, []);
  assert.deepEqual(rows(server.draft.env), [
    ["OPNSENSE_URL", "https://192.168.1.1"],
    ["OPNSENSE_API_KEY", ""],
    ["OPNSENSE_API_SECRET", ""],
    ["OPNSENSE_VERIFY_SSL", "false"],
    ["OPNSENSE_ALLOW_WRITES", "false"],
  ]);
  assert.deepEqual(server.draft.hints.settings.OPNSENSE_API_KEY, {
    required: true,
    secret: true,
  });
  assert.deepEqual(server.draft.hints.settings.OPNSENSE_URL, {
    required: false,
    secret: false,
  });
  assert.deepEqual(
    server.ignored.map(({ key, code }) => [key, code]),
    [
      ["npx", "runner"],
      ["-y", "yes"],
      ["disabled", "unmanaged"],
      ["autoApprove", "unmanaged"],
    ],
  );
  assert.deepEqual(codes(server.warnings), [
    "placeholder",
    "placeholder",
    "stringified",
    "pinned",
  ]);
  assert.equal(server.draft.origin, "paste");
  assert.deepEqual(server.others, []);
});

test("VS Code block: inputs describe a referenced secret; envFile is not read", () => {
  const result = parsePaste(fixture("vscode.jsonc"));
  assert.equal(result.ok, true);
  const github = pickServer(result, 0);
  assert.equal(github.draft.path, "remote");
  assert.equal(github.draft.transport, "http");
  assert.equal(github.draft.signIn, "headers");
  assert.deepEqual(
    github.draft.headers.map(({ key, name, value, bearer }) => [
      key,
      name,
      value,
      bearer,
    ]),
    [["auth", "Authorization", "", true]],
  );
  assert.deepEqual(github.draft.hints.settings.Authorization, {
    required: true,
    secret: true,
    description: "GitHub personal access token",
  });
  assert.deepEqual(
    github.warnings.find((w) => w.code === "reference"),
    {
      code: "reference",
      name: "Authorization",
      ref: "gh-token",
    },
  );
  assert.deepEqual(github.others, ["fetch"]);
  const fetch = pickServer(result, 1);
  assert.equal(fetch.draft.registry, "pypi");
  assert.deepEqual(
    fetch.ignored.find((n) => n.code === "envFile"),
    { key: "envFile", code: "envFile" },
  );
});

test("OpenCode block: command arrays, environment and remote type", () => {
  const result = parsePaste(fixture("opencode.json"));
  const local = pickServer(result, 0);
  assert.equal(local.name, "local-files");
  assert.equal(local.draft.path, "command");
  assert.equal(local.draft.command, "node");
  assert.deepEqual(local.draft.argRows, ["/srv/files/server.js", "--root", "/srv/data"]);
  assert.deepEqual(rows(local.draft.env), [["FILES_TOKEN", ""]]);
  assert.deepEqual(codes(local.ignored), ["unmanaged"]);
  const docs = pickServer(result, 1);
  assert.equal(docs.draft.transport, "sse");
  assert.deepEqual(codes(docs.warnings), ["guessed"]);
  assert.deepEqual(rows(docs.draft.headers), [["X-Api-Key", "abc123"]]);
  assert.deepEqual(docs.ignored, [{ key: "oauth", code: "oauth" }]);
});

test("Zed block: command object with path, args and env", () => {
  const server = one(fixture("zed.json"));
  assert.equal(server.draft.registry, "pypi");
  assert.equal(server.draft.packageName, "mcp-server-postgres");
  assert.deepEqual(server.draft.argRows, ["postgresql://localhost/db"]);
  assert.deepEqual(rows(server.draft.env), [["PGPASSWORD", ""]]);
  assert.deepEqual(codes(server.ignored), ["runner", "unknown"]);
});

test("several servers: one at a time, Docker stays an own command", () => {
  const result = parsePaste(fixture("several.json"));
  assert.deepEqual(
    result.servers.map((s) => s.name),
    ["filesystem", "github", "fetch"],
  );
  const files = pickServer(result, 0);
  assert.equal(files.draft.packageVersion, "2025.8.21");
  assert.deepEqual(files.draft.argRows, ["/Users/me/Documents"]);
  assert.deepEqual(files.others, ["github", "fetch"]);
  // Servers already set up are no longer named as waiting.
  assert.deepEqual(pickServer(result, 2, [0]).others, ["github"]);
  const github = pickServer(result, 1);
  assert.equal(github.draft.path, "command");
  assert.equal(github.draft.command, "docker");
  assert.ok(codes(github.warnings).includes("docker"));
  assert.ok(codes(github.warnings).includes("reference"));
  assert.deepEqual(pickServer(result, 2).ignored, [
    { key: "uvx", code: "runner" },
    { key: "timeout", code: "unmanaged" },
  ]);
});

test("a single entry, a fragment and a command line", () => {
  const entry = one('{ "command": "uvx", "args": ["mcp-server-time"] }');
  assert.equal(entry.name, "");
  assert.equal(entry.draft.packageName, "mcp-server-time");
  const fragment = one(
    '"opnsense": { "command": "npx", "args": ["-y", "opnsense-mcp-server"] },',
  );
  assert.equal(fragment.name, "opnsense");
  const block = one(
    '"mcpServers": { "time": { "command": "uvx", "args": ["mcp-server-time"] } }',
  );
  assert.equal(block.name, "time");
  const line = one("pipx run mcp-server-time --local-timezone Europe/Berlin");
  assert.deepEqual(
    [line.draft.registry, line.draft.packageName, line.draft.argRows],
    ["pypi", "mcp-server-time", ["--local-timezone", "Europe/Berlin"]],
  );
});

test("remote entries: serverUrl, streamable types, Bearer header, token in the query", () => {
  const remote = one(
    '{"mcpServers":{"x":{"serverUrl":"https://x.test/mcp?api_key=1","type":"streamableHttp"}}}',
  );
  assert.equal(remote.draft.transport, "http");
  assert.deepEqual(codes(remote.warnings), ["tokenInQuery"]);
  assert.deepEqual(codes(remote.ignored), []);
  const bearer = one(
    '{"mcpServers":{"x":{"url":"https://x.test/mcp","headers":{"Authorization":"Bearer abc"}}}}',
  );
  assert.deepEqual(
    bearer.draft.headers.map(({ key, value, bearer: b }) => [key, value, b]),
    [["auth", "abc", true]],
  );
  const ref = one('{"mcpServers":{"x":{"url":"https://${HOST}/mcp"}}}');
  assert.equal(ref.draft.url, "");
  assert.deepEqual(ref.warnings[0], { code: "reference", field: "url", ref: "HOST" });
});

test("names are sanitised and kept unique against existing servers", () => {
  const server = one('{"mcpServers":{"my.server":{"command":"node","args":[]}}}', {
    taken: ["my-server"],
  });
  assert.equal(server.name, "my-server-2");
  assert.deepEqual(codes(server.warnings), ["nameChanged", "nameTaken"]);
});

test("bad values: non-string args refuse the entry; cwd must be absolute; caps hold", () => {
  const refused = parsePaste('{"mcpServers":{"x":{"command":"node","args":[1]}}}')
    .servers[0];
  assert.equal(refused.refused, "invalidArgs");
  assert.equal(refused.draft, undefined);
  const cwd = one('{"mcpServers":{"x":{"command":"node","cwd":"./here"}}}');
  assert.equal(cwd.draft.cwd, "");
  assert.deepEqual(codes(cwd.warnings), ["cwdRelative"]);
  const many = Array.from({ length: 150 }, (_, i) => `"a${i}"`).join(",");
  const capped = one(`{"mcpServers":{"x":{"command":"node","args":[${many}]}}}`);
  assert.equal(capped.draft.argRows.length, 100);
  assert.ok(codes(capped.warnings).includes("tooMany"));
  const control = one(
    '{"mcpServers":{"x":{"command":"node","env":{"A":"x\\u0007y","B":"t\\tab"}}}}',
  );
  assert.deepEqual(rows(control.draft.env), [
    ["A", ""],
    ["B", "t\tab"],
  ]);
  const servers = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`s${i}`, { command: "node" }]),
  );
  const wide = parsePaste(JSON.stringify({ mcpServers: servers }));
  assert.equal(wide.servers.length, 20);
  assert.deepEqual(codes(wide.warnings), ["tooManyServers"]);
  const token = one(
    '{"mcpServers":{"x":{"command":"node","args":["--token","ghp_abcdefghijklmnopqrstuvwxyz0123"]}}}',
  );
  assert.ok(codes(token.warnings).includes("tokenInArgs"));
});

test("errors: too long, invalid JSON with position, no server, TOML, claude mcp add", () => {
  assert.deepEqual(parsePaste("x".repeat(65537)), {
    ok: false,
    error: { code: "tooLong" },
  });
  assert.deepEqual(parsePaste('{\n "mcpServers": {\n  "a": { "command": "x" \n}'), {
    ok: false,
    error: { code: "invalidJson", line: 4, column: 2 },
  });
  assert.equal(parsePaste('{"theme":"dark"}').error.code, "noServer");
  assert.equal(parsePaste("").error.code, "noServer");
  assert.equal(parsePaste('[mcp_servers.fetch]\ncommand = "uvx"').error.code, "notJson");
  assert.equal(
    parsePaste("claude mcp add fetch -- uvx mcp-server-fetch").error.code,
    "notJson",
  );
  assert.equal(parsePaste("npx a | sh").error.code, "notJson");
  // Only runner lines (Q10): prose or other programs are not read as a command.
  assert.equal(parsePaste("Run the server first").error.code, "notJson");
  assert.equal(parsePaste("node server.js").error.code, "notJson");
  assert.equal(one("bunx some-mcp").draft.packageName, "some-mcp");
  assert.equal(one("uv tool run mcp-server-time").draft.registry, "pypi");
  const deep = `{"mcpServers":${"[".repeat(20)}${"]".repeat(20)}}`;
  assert.equal(parsePaste(deep).error.code, "tooDeep");
  const dup = parsePaste(
    '{"mcpServers":{"a":{"command":"node"},"a":{"command":"uvx","args":["p"]}}}',
  );
  assert.equal(dup.servers.length, 1);
  assert.deepEqual(dup.warnings, [{ code: "duplicateKey", name: "a" }]);
});

test("long references are cut, long and control arguments get their own reasons", () => {
  const long = "A".repeat(500);
  const ref = one(`{"mcpServers":{"x":{"command":"run","args":["\${${long}}"]}}}`);
  assert.equal(ref.warnings.find((w) => w.code === "reference").ref.length, 60);
  const big = one(
    `{"mcpServers":{"x":{"command":"run","args":["${"b".repeat(16385)}"]}}}`,
  );
  assert.deepEqual(big.warnings, [{ code: "tooLongValue", field: "args" }]);
  const ctl = one('{"mcpServers":{"x":{"command":"run","args":["a\\u0001b"]}}}');
  assert.deepEqual(ctl.warnings, [{ code: "controlChars", field: "args" }]);
  // The emptied argument stays a row the owner has to fill.
  assert.deepEqual(ctl.draft.argRows, [""]);
  assert.equal(ctl.draft.hints.argsRequired, true);
  const fine = one('{"mcpServers":{"x":{"command":"run","args":["a"]}}}');
  assert.equal(fine.draft.hints.argsRequired, undefined);
});
