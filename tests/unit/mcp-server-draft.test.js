import test from "node:test";
import assert from "node:assert/strict";
import {
  constraintLines,
  draftFrom,
  dropsStoredHeaders,
  keepPackageValues,
  requestBody,
} from "../../web/features/mcp-servers/mcp-server-draft.js";

const http = {
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.com/v1",
  headerNames: ["Authorization", "X-Team"],
  envNames: [],
  revision: 4,
};

test("an unchanged edit sends only the revision and never the redacted address", () => {
  assert.deepEqual(requestBody(draftFrom(http), http), { revision: 4 });
});

test("stored entries are replaced or removed by name and never carry a value", () => {
  const draft = draftFrom(http);
  assert.ok(draft.headers.every((row) => row.stored && row.value === ""));
  draft.headers[0].value = "Bearer new";
  draft.headers[1].removed = true;
  draft.headers.push({ key: "n", name: "X-New", value: "1" });
  assert.deepEqual(requestBody(draft, http), {
    revision: 4,
    headers: { Authorization: "Bearer new", "X-Team": null, "X-New": "1" },
  });
});

test("a stdio create body splits arguments by line and omits empty fields", () => {
  const draft = { ...draftFrom(null), transport: "stdio", name: " local " };
  draft.command = " npx ";
  draft.args = "-y\n\nserver";
  assert.deepEqual(requestBody(draft, null), {
    name: "local",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
  });
});

test("an OAuth create sends the scope and never the typed headers", () => {
  const draft = { ...draftFrom(null), name: "docs", url: " https://mcp.example.com " };
  draft.headers = [{ key: "n", name: "Authorization", value: "Bearer typed" }];
  draft.auth = "oauth";
  draft.oauthScope = "  read write ";
  assert.deepEqual(requestBody(draft, null), {
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com",
    auth: "oauth",
    oauthScope: "read write",
  });
  assert.equal(dropsStoredHeaders(draft, null), false);
});

test("switching a header server to OAuth drops headers and is confirmed first", () => {
  const draft = draftFrom(http);
  draft.headers[0].value = "Bearer ignored";
  draft.auth = "oauth";
  assert.equal(dropsStoredHeaders(draft, http), true);
  assert.deepEqual(requestBody(draft, http), {
    revision: 4,
    auth: "oauth",
    oauthScope: "",
  });
  assert.equal(dropsStoredHeaders(draftFrom({ ...http, headerNames: [] }), http), false);
});

test("an OAuth server edit sends a changed scope and a switch back to headers", () => {
  const oauth = { ...http, headerNames: [], auth: "oauth", oauthScope: "read" };
  const draft = draftFrom(oauth);
  assert.equal(draft.auth, "oauth");
  assert.deepEqual(requestBody(draft, oauth), { revision: 4 });
  draft.oauthScope = "";
  assert.deepEqual(requestBody(draft, oauth), { revision: 4, oauthScope: "" });
  draft.auth = "headers";
  draft.headers = [{ key: "n", name: "Authorization", value: "Bearer t" }];
  assert.deepEqual(requestBody(draft, oauth), {
    revision: 4,
    auth: "headers",
    headers: { Authorization: "Bearer t" },
  });
});

test("a new packaged server sends its source and no command", () => {
  const draft = {
    ...draftFrom(null),
    transport: "stdio",
    name: "pkg",
    source: "package",
    registry: "npm",
    packageName: "server-x",
    packageVersion: "1.0.0",
    args: "--owner",
  };
  assert.deepEqual(requestBody(draft, null), {
    name: "pkg",
    transport: "stdio",
    args: ["--owner"],
    source: { registry: "npm", name: "server-x", version: "1.0.0", allowScripts: false },
  });
});

test("a PyPI source sends its constraint lines; npm sends none", () => {
  const draft = {
    ...draftFrom(null),
    transport: "stdio",
    name: "pkg",
    source: "package",
    registry: "pypi",
    packageName: "srv-x",
    packageVersion: "1.0",
    packageConstraints: " fastmcp<4 \n\n  httpx>=0.27,<1\n",
  };
  assert.deepEqual(requestBody(draft, null).source, {
    registry: "pypi",
    name: "srv-x",
    version: "1.0",
    allowScripts: false,
    constraints: ["fastmcp<4", "httpx>=0.27,<1"],
  });
  assert.equal(
    requestBody({ ...draft, registry: "npm" }, null).source.constraints,
    undefined,
  );
  assert.deepEqual(constraintLines(" a<1 \n\n b>2 "), ["a<1", "b>2"]);
  const stored = { source: { registry: "pypi", constraints: ["fastmcp<4", "a<1"] } };
  assert.equal(draftFrom(stored).packageConstraints, "fastmcp<4\na<1");
  assert.equal(draftFrom(null).packageConstraints, "");
});

const packaged = (status, extra = {}) => ({
  id: "s2",
  name: "pkg",
  transport: "stdio",
  command: "/data/toolchains/node/bin/node",
  args: ["/data/mcp-packages/installs/i/node_modules/x/index.js", "--owner"],
  source: { registry: "npm", name: "x", version: "1.0.0", status, leadingArgs: 1 },
  headerNames: [],
  envNames: [],
  revision: 3,
  ...extra,
});

test("a ready packaged server shows only the owner's arguments", () => {
  const draft = draftFrom(packaged("ready"));
  assert.equal(draft.source, "package");
  assert.equal(draft.packageName, "x");
  assert.equal(draft.packageVersion, "1.0.0");
  assert.equal(draft.args, "--owner");
});

test("a missing or failed packaged server still hides its generated argument", () => {
  for (const status of ["missing", "failed"])
    assert.equal(draftFrom(packaged(status)).args, "--owner", status);
});

test("an own-command server switched to a package sends its source, never a command", () => {
  const server = {
    id: "s1",
    name: "own",
    transport: "stdio",
    command: "/bin/sh",
    args: ["--x"],
    headerNames: [],
    envNames: [],
    revision: 4,
  };
  const draft = {
    ...draftFrom(server),
    source: "package",
    registry: "npm",
    packageName: "server-x",
    packageVersion: "1.0.0",
  };
  assert.deepEqual(requestBody(draft, server), {
    revision: 4,
    source: { registry: "npm", name: "server-x", version: "1.0.0", allowScripts: false },
  });
});

test("an edit of a packaged server sends owner arguments only, never a command or source", () => {
  const server = packaged("ready");
  const draft = { ...draftFrom(server), args: "--owner\n--more" };
  assert.deepEqual(requestBody(draft, server), {
    revision: 3,
    args: ["--owner", "--more"],
  });
});

test("a packaged server switched to its own command detaches with command and args", () => {
  const server = packaged("failed");
  const draft = { ...draftFrom(server), source: "command", command: " /usr/bin/srv " };
  // Unchanged owner args are still sent: the generated ones must not survive the detach.
  assert.deepEqual(requestBody(draft, server), {
    revision: 3,
    source: null,
    command: "/usr/bin/srv",
    args: ["--owner"],
  });
});

test("keeping the package restores the stored command and owner args", () => {
  const server = {
    transport: "stdio",
    command: "/data/node",
    args: ["/data/installs/i/x.js", "--owner"],
    source: { registry: "npm", leadingArgs: 1 },
  };
  assert.deepEqual(keepPackageValues(server), {
    source: "package",
    command: "",
    args: "--owner",
  });
});

test("a switch to a package that has not installed yet keeps the own command", () => {
  for (const status of ["installing", "failed", "choosing"]) {
    const server = {
      ...packaged(status),
      command: "/usr/bin/own",
      args: ["--owner"],
      source: { ...packaged(status).source, leadingArgs: 0 },
    };
    assert.equal(draftFrom(server).command, "/usr/bin/own", status);
    assert.equal(keepPackageValues(server).command, "/usr/bin/own", status);
    // Use own command: the detach sends the command it still runs.
    const draft = { ...draftFrom(server), source: "command" };
    assert.equal(requestBody(draft, server).command, "/usr/bin/own", status);
  }
  assert.equal(draftFrom(packaged("ready")).command, "");
  assert.equal(draftFrom(packaged("missing")).command, "");
});

test("timeouts are sent as whole seconds on create and only when changed on edit", () => {
  const draft = { ...draftFrom(null), name: "docs", url: "https://x.test/mcp" };
  assert.deepEqual([draft.startupTimeout, draft.toolTimeout], ["", ""]);
  assert.equal(Object.hasOwn(requestBody(draft), "toolTimeoutSec"), false);
  assert.deepEqual(
    requestBody({ ...draft, startupTimeout: " 30 ", toolTimeout: "450" }),
    {
      name: "docs",
      transport: "http",
      url: "https://x.test/mcp",
      startupTimeoutSec: 30,
      toolTimeoutSec: 450,
    },
  );
  const server = { ...http, startupTimeoutSec: 30, toolTimeoutSec: 450 };
  const stored = draftFrom(server);
  assert.deepEqual([stored.startupTimeout, stored.toolTimeout], ["30", "450"]);
  assert.deepEqual(requestBody(stored, server), { revision: 4 });
  assert.deepEqual(
    requestBody({ ...stored, toolTimeout: "", startupTimeout: "60" }, server),
    {
      revision: 4,
      startupTimeoutSec: 60,
      toolTimeoutSec: null,
    },
  );
  // A value that is no whole number goes as typed: the server refuses it at its field.
  assert.equal(
    requestBody({ ...stored, toolTimeout: "1.5" }, server).toolTimeoutSec,
    "1.5",
  );
});
