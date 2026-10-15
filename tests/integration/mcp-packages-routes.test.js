import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { packageProblem } from "../../server/features/mcp-packages/package-errors.js";
import { STDIO_CONFIRMATION_REQUIRED } from "../../server/features/mcp-servers/stdio-confirmation.js";
import { packageService, ref } from "../helpers/mcp-packages-service.js";

const source = { registry: "npm", name: "x", version: "1.0.0" };
const packagedServer = { id: "s1", name: "pkg", transport: "stdio", source };

async function app(t, extra = {}) {
  const audit = [];
  const updates = [];
  const services = {
    mcpServerChanges: {
      list: () => [],
      update: async (id, input, options) => {
        updates.push({ id, input, options });
        return { server: { id, transport: "stdio" }, cliChange: null };
      },
      remove: async () => ({ transport: "stdio" }),
    },
    mcpServers: { get: () => packagedServer },
    audit: { append: (entry) => audit.push(entry) },
    ...extra,
  };
  const application = express();
  application.use(express.json());
  application.use("/api", mcpServerRoutes(services));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const s = application.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { request, audit, updates };
}

test("creating a packaged server needs the install confirmation", async (t) => {
  const seen = [];
  const { request } = await app(t, {
    mcpPackages: {
      createServer: async (input, options) => {
        seen.push({ input, options });
        return { ...packagedServer, source: { ...source, status: "installing" } };
      },
    },
  });
  const body = { name: "pkg", transport: "stdio", source, previewId: "p" };
  const refused = await request("POST", "/api/mcp-servers", body);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  assert.equal(refused.body.messageKey, "mcpPackages.confirmationRequired");
  assert.equal(seen.length, 0);
  const accepted = await request("POST", "/api/mcp-servers", {
    ...body,
    confirmInstall: true,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(seen[0].options, { previewId: "p", program: undefined });
  assert.equal(seen[0].input.confirmInstall, undefined);
  assert.equal(seen[0].input.previewId, undefined);
});

test("package errors keep their stable code in responses", async (t) => {
  const { request } = await app(t, {
    mcpPackages: {
      versions: async () => {
        throw packageProblem("MCP_PACKAGE_NOT_FOUND", 404);
      },
      reinstall: () => {
        throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
      },
      updatePackage: async () => {
        throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
      },
    },
  });
  const missing = await request(
    "GET",
    "/api/mcp-packages/versions?registry=npm&name=nope",
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "MCP_PACKAGE_NOT_FOUND");
  const integrity = await request("POST", "/api/mcp-servers/s1/package/reinstall", {});
  assert.equal(integrity.status, 502);
  assert.equal(integrity.body.code, "MCP_PACKAGE_INTEGRITY_MISMATCH");
  const toolchain = await request("POST", "/api/mcp-servers/s1/package/update", {
    version: "2.0.0",
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(toolchain.status, 503);
  assert.equal(toolchain.body.code, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE");
});

test("the audit records package name and version, never env or args", async (t) => {
  const { request, audit } = await app(t, {
    mcpPackages: {
      createServer: async () => ({
        ...packagedServer,
        source: { ...source, status: "installing" },
      }),
    },
  });
  await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    args: ["--secret-arg"],
    env: { TOKEN: "abc" },
    source: { ...source, allowScripts: true },
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(audit.at(-1).action, "package.installed");
  assert.deepEqual(audit.at(-1).details, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    allowScripts: true,
    constraints: [],
  });
  assert.doesNotMatch(JSON.stringify(audit), /secret-arg|abc/);
});

test("an own-command server switches to a package only with the confirmation (D1)", async (t) => {
  const attached = [];
  const { request, updates, audit } = await app(t, {
    mcpPackages: {
      isPackaged: () => false,
      attach: async (id, options, beforeInstall) => {
        attached.push({ id, options });
        await beforeInstall?.();
        return { ...packagedServer, source: { ...source, status: "installing" } };
      },
    },
  });
  const body = { revision: 3, source, previewId: "p", args: ["--x"] };
  const refused = await request("PUT", "/api/mcp-servers/s1", body);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  const command = await request("PUT", "/api/mcp-servers/s1", {
    ...body,
    command: "/bin/sh",
    confirmInstall: true,
  });
  assert.equal(command.status, 400);
  assert.equal(command.body.code, "MCP_PACKAGE_INVALID");
  assert.equal(attached.length, 0);
  const accepted = await request("PUT", "/api/mcp-servers/s1", {
    ...body,
    confirmInstall: true,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(attached[0], {
    id: "s1",
    options: { source, previewId: "p", program: undefined },
  });
  // The other edits go through the normal update first, confirmed by the install.
  assert.deepEqual(updates, [
    { id: "s1", input: { revision: 3, args: ["--x"] }, options: { confirmStdio: true } },
  ]);
  assert.equal(audit.at(-1).action, "package.installed");
});

test("a packaged server refuses a new source and detaches only to an own command", async (t) => {
  const detached = [];
  const { request, updates, audit } = await app(t, {
    mcpPackages: {
      isPackaged: () => true,
      ownerArgs: () => [],
      detach: async (id, update) => {
        await update();
        detached.push(id);
      },
    },
  });
  const again = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source,
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "MCP_PACKAGE_INVALID");
  const bare = await request("PUT", "/api/mcp-servers/s1", { revision: 3, source: null });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, "MCP_PACKAGE_INVALID");
  const own = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source: null,
    command: "/bin/sh",
    confirmStdio: true,
  });
  assert.equal(own.status, 200);
  assert.deepEqual(detached, ["s1"]);
  assert.deepEqual(updates, [
    {
      id: "s1",
      input: { revision: 3, command: "/bin/sh", args: [] },
      options: { confirmStdio: true },
    },
  ]);
  assert.equal(audit.at(-1).action, "package.detached");
});

test("an edit of a packaged server goes through prepareUpdate; delete prunes", async (t) => {
  let pruned = 0;
  const { request, updates } = await app(t, {
    mcpPackages: {
      cancel: async () => false,
      prepareUpdate: (_id, input) => ({
        ...input,
        args: ["/gen/index.js", ...input.args],
      }),
      prune: async () => {
        pruned += 1;
      },
    },
  });
  const edited = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    args: ["--owner"],
    confirmStdio: true,
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(updates[0].input, { revision: 3, args: ["/gen/index.js", "--owner"] });
  const removed = await request("DELETE", "/api/mcp-servers/s1");
  assert.equal(removed.status, 204);
  assert.equal(pruned, 1);
});

test("a detach without args keeps only the owner's args", async (t) => {
  const { request, updates } = await app(t, {
    mcpPackages: {
      isPackaged: () => true,
      ownerArgs: () => ["--owner"],
      detach: async (_id, update) => update(),
    },
  });
  const kept = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source: null,
    command: "/bin/sh",
    confirmStdio: true,
  });
  assert.equal(kept.status, 200);
  assert.deepEqual(updates[0].input, {
    revision: 3,
    command: "/bin/sh",
    args: ["--owner"],
  });
  const replaced = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source: null,
    command: "/bin/sh",
    args: ["--new"],
    confirmStdio: true,
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual(updates[1].input.args, ["--new"]);
});

test("a detach to an unconfirmed own command asks for the stdio confirmation", async (t) => {
  const { request, audit } = await app(t, {
    mcpServerChanges: {
      update: async () => {
        throw Object.assign(Error("confirm"), { code: STDIO_CONFIRMATION_REQUIRED });
      },
    },
    mcpPackages: {
      isPackaged: () => true,
      ownerArgs: () => [],
      detach: async (_id, update) => update(),
    },
  });
  const response = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source: null,
    command: "/bin/sh",
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, STDIO_CONFIRMATION_REQUIRED);
  assert.equal(audit.length, 0);
});

test("updates and reinstalls answer 202 with the job and audit the package only", async (t) => {
  const job = { kind: "update", state: "running", code: null, log: "" };
  const seen = [];
  const { request, audit } = await app(t, {
    mcpServers: {
      get: () => ({ ...packagedServer, source: { ...source, program: "x" } }),
    },
    mcpPackages: {
      updatePackage: async (id, body) => {
        seen.push({ id, body });
        return { job };
      },
      reinstall: () => ({ job: { ...job, kind: "reinstall" } }),
      status: () => ({ source, job, error: null }),
    },
  });
  const updated = await request("POST", "/api/mcp-servers/s1/package/update", {
    version: "2.0.0",
    allowScripts: true,
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(updated.status, 202);
  assert.deepEqual(updated.body, { job });
  assert.equal(seen[0].body.version, "2.0.0");
  const unconfirmed = await request("POST", "/api/mcp-servers/s1/package/update", {
    version: "2.0.0",
    previewId: "p",
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  assert.equal(seen.length, 1);
  const reinstalled = await request("POST", "/api/mcp-servers/s1/package/reinstall");
  assert.equal(reinstalled.status, 202);
  assert.equal(reinstalled.body.job.kind, "reinstall");
  const status = await request("GET", "/api/mcp-servers/s1/package");
  assert.deepEqual(status.body, { source, job, error: null });
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.details]),
    [
      [
        "package.updated",
        {
          registry: "npm",
          name: "x",
          version: "2.0.0",
          allowScripts: true,
          constraints: [],
        },
      ],
      [
        "package.reinstalled",
        {
          registry: "npm",
          name: "x",
          version: "1.0.0",
          allowScripts: false,
          constraints: [],
        },
      ],
    ],
  );
});

test("an update audits the constraints it installs: edited or kept", async (t) => {
  const pypi = { registry: "pypi", name: "srv-x", version: "1.0", constraints: ["a<1"] };
  const { request, audit } = await app(t, {
    mcpServers: { get: () => ({ ...packagedServer, source: pypi }) },
    mcpPackages: { updatePackage: async () => ({ job: null }) },
  });
  for (const extra of [{ constraints: ["FastMCP < 4"] }, {}])
    await request("POST", "/api/mcp-servers/s1/package/update", {
      version: "1.1",
      previewId: "p",
      confirmInstall: true,
      ...extra,
    });
  assert.deepEqual(
    audit.map((entry) => entry.details.constraints),
    [["fastmcp<4"], ["a<1"]],
  );
});

test("preview, create and status responses never name the data directory", async (t) => {
  const s = await packageService(t);
  const { request } = await app(t, {
    mcpServerChanges: s.changes,
    mcpServers: s.servers,
    mcpPackages: s.packages,
  });
  const versions = await request(
    "GET",
    "/api/mcp-packages/versions?registry=npm&name=server-x",
  );
  assert.equal(versions.status, 200);
  assert.equal(versions.body.latest, "2.0.0");
  const preview = await request("POST", "/api/mcp-packages/preview", ref());
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dependencyCount, 2);
  const created = await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    source: ref(),
    previewId: preview.body.previewId,
    confirmInstall: true,
  });
  assert.equal(created.status, 202);
  await s.packages.jobs.idle();
  const status = await request("GET", `/api/mcp-servers/${created.body.id}/package`);
  assert.equal(status.status, 200);
  assert.equal(status.body.source.status, "ready");
  assert.equal(status.body.job.state, "done");
  const real = fs.realpathSync(s.root);
  for (const response of [versions, preview, created, status]) {
    const text = JSON.stringify(response.body);
    assert.ok(!text.includes(s.root) && !text.includes(real), text);
    assert.doesNotMatch(text, /toolchains|node_modules|lockfileVersion|"lock"/);
  }
});

test("a failing audit append never turns a finished install into an error", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const { request } = await app(t, {
    audit: {
      append: () => {
        throw Object.assign(new Error("Ungültige Audit-Aktion."), { status: 400 });
      },
    },
    mcpPackages: {
      createServer: async () => ({
        ...packagedServer,
        source: { ...source, status: "installing" },
      }),
    },
  });
  const created = await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    env: { TOKEN: "abc" },
    source,
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.id, "s1");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /package\.installed/);
  assert.doesNotMatch(logged[0], /abc/);
});

test("deleting a server cancels its running install before pruning", async (t) => {
  const calls = [];
  const { request } = await app(t, {
    mcpPackages: {
      cancel: (id) => {
        calls.push(["cancel", id]);
        return Promise.resolve(true);
      },
      prune: () => calls.push(["prune"]),
    },
  });
  const response = await request("DELETE", "/api/mcp-servers/s1");
  assert.equal(response.status, 204);
  assert.deepEqual(calls, [["cancel", "s1"], ["prune"]]);
});

test("choosing a program answers 202 with the job and audits the activation", async (t) => {
  const seen = [];
  const { request, audit } = await app(t, {
    mcpPackages: {
      chooseProgram: (id, program) => {
        seen.push([id, program]);
        return { kind: "activate", state: "running", code: null, log: "" };
      },
    },
  });
  // No install confirmation: the owner confirmed the build; this picks one of its programs.
  const response = await request("POST", "/api/mcp-servers/s1/package/program", {
    program: "b-server",
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.job.state, "running");
  assert.deepEqual(seen, [["s1", "b-server"]]);
  assert.equal(audit.at(-1).action, "package.activated");
  assert.deepEqual(audit.at(-1).details, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    allowScripts: false,
    constraints: [],
  });
});

test("a refused program choice answers its code and audits nothing", async (t) => {
  const { request, audit } = await app(t, {
    mcpPackages: {
      chooseProgram: () => {
        throw packageProblem("MCP_PACKAGE_PROGRAM_REQUIRED", 400);
      },
    },
  });
  const response = await request("POST", "/api/mcp-servers/s1/package/program", ["x"]);
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "MCP_PACKAGE_PROGRAM_REQUIRED");
  assert.equal(audit.length, 0);
});

test("a source that is not an object, or null on an own-command server, is invalid", async (t) => {
  const s = await packageService(t);
  const { request } = await app(t, {
    mcpServerChanges: s.changes,
    mcpServers: s.servers,
    mcpPackages: s.packages,
  });
  const own = await s.changes.create(
    { name: "own", transport: "stdio", command: s.executable("own") },
    { confirmStdio: true },
  );
  for (const bad of ["x", 7, [], true]) {
    const created = await request("POST", "/api/mcp-servers", {
      name: "pkg",
      transport: "stdio",
      source: bad,
      confirmInstall: true,
    });
    assert.equal(created.status, 400, JSON.stringify(bad));
    assert.equal(created.body.code, "MCP_PACKAGE_INVALID");
    const changed = await request("PUT", `/api/mcp-servers/${own.id}`, {
      revision: own.revision,
      source: bad,
      confirmInstall: true,
    });
    assert.equal(changed.status, 400, JSON.stringify(bad));
    assert.equal(changed.body.code, "MCP_PACKAGE_INVALID");
  }
  // `source: null` detaches a packaged server only; an own-command server has none.
  const detached = await request("PUT", `/api/mcp-servers/${own.id}`, {
    revision: own.revision,
    source: null,
    command: "/bin/x",
  });
  assert.equal(detached.status, 400);
  assert.equal(detached.body.code, "MCP_PACKAGE_INVALID");
  assert.equal(s.servers.list().length, 1);
});

test("an attach without other edits stores nothing but the package", async (t) => {
  const attached = [];
  const { request, updates } = await app(t, {
    mcpPackages: {
      isPackaged: () => false,
      attach: async (id, input, beforeInstall) => {
        attached.push({ id, input, beforeInstall });
        return packagedServer;
      },
    },
  });
  // A stale revision: the attach itself writes only the package record; the later
  // command switch re-reads the current revision (package-install-job.js).
  const response = await request("PUT", "/api/mcp-servers/s1", {
    revision: 1,
    source,
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(response.status, 202);
  assert.equal(attached[0].beforeInstall, undefined);
  assert.equal(updates.length, 0);
});
