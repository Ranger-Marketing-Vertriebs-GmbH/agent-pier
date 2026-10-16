import test from "node:test";
import assert from "node:assert/strict";
import {
  previewNewPackage,
  refusedField,
  saveNewServer,
} from "../../web/features/mcp-servers/wizard/wizard-save.js";
import {
  initialWizard,
  wizardReducer,
} from "../../web/features/mcp-servers/wizard/wizard-state.js";
import { mcpWizardCopy } from "../../web/lib/i18n/messages/mcp-wizard.js";

const draftFor = (path, values) => ({
  ...wizardReducer(initialWizard(), { type: "choose", path }).draft,
  ...values,
});
const failure = (extra) => Object.assign(new Error("refused"), extra);

test("refusals are mapped to the field that shows them", () => {
  assert.deepEqual(refusedField(failure({ messageKey: "mcpServers.nameTaken" })), {
    field: "name",
    text: "refused",
  });
  assert.equal(
    refusedField(failure({ messageKey: "mcpServers.commandNotFound" })).field,
    "command",
  );
  assert.equal(
    refusedField(failure({ messageKey: "extensions.invalidMcpUrl" })).field,
    "url",
  );
  assert.equal(
    refusedField(failure({ messageKey: "mcpPackages.versionYanked" }), "npm").field,
    "packageVersion",
  );
  const reference = refusedField(
    failure({ code: "MCP_SERVER_VALUE_REFERENCE", field: "env", names: ["TOKEN"] }),
  );
  assert.equal(reference.field, "env");
  assert.deepEqual(reference.names, ["TOKEN"]);
  assert.equal(refusedField(failure({ messageKey: "http.internalError" })), null);
});

test("an own command saves once with the confirmation, its args and env, no CLIs", async () => {
  const bodies = [];
  const draft = draftFor("command", {
    name: "tool",
    command: "uvx",
    argRows: ["--read-only", ""],
    env: [{ key: "a", name: "API_TOKEN", value: "abc" }],
  });
  const saved = await saveNewServer({
    draft,
    confirmations: { confirmStdio: true },
    saveServer: async (_server, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
  });
  assert.equal(saved.id, "s1");
  assert.deepEqual(bodies, [
    {
      name: "tool",
      transport: "stdio",
      command: "uvx",
      args: ["--read-only"],
      env: { API_TOKEN: "abc" },
      confirmStdio: true,
      origin: "manual",
    },
  ]);
});

test("a package is previewed first, then installed with the preview and program", async () => {
  const draft = draftFor("package", {
    name: "pkg",
    packageName: "server-x",
    packageVersion: "1.1.0",
  });
  const preview = await previewNewPackage({
    draft,
    previewPackage: async (input) => ({ previewId: "p1", ...input }),
  });
  assert.equal(preview.previewId, "p1");
  const bodies = [];
  await saveNewServer({
    draft,
    program: "server-x",
    confirmations: { confirmInstall: true, previewId: "p1" },
    saveServer: async (_server, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
  });
  assert.equal(bodies[0].confirmInstall, true);
  assert.equal(bodies[0].previewId, "p1");
  assert.equal(bodies[0].program, "server-x");
  assert.equal(bodies[0].source.name, "server-x");
  assert.equal(bodies[0].clis, undefined);
});

test("a preview that would save instead refuses with translated copy", async () => {
  const draft = draftFor("remote", { name: "docs", url: "https://docs.example/mcp" });
  await assert.rejects(
    previewNewPackage({ draft, previewPackage: async () => ({ previewId: "p1" }) }),
    (error) => {
      assert.equal(error.message, mcpWizardCopy.install.previewFailed);
      return true;
    },
  );
});

test("a server from the directory saves the entry it came from", async () => {
  const bodies = [];
  const draft = draftFor("remote", {
    name: "files",
    url: "https://acme.files.example/mcp",
    origin: "directory",
    directoryOrigin: { name: "com.example/files", version: "1.2.0" },
  });
  await saveNewServer({
    draft,
    saveServer: async (_server, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
  });
  assert.equal(bodies[0].origin, "directory");
  assert.deepEqual(bodies[0].directoryOrigin, {
    name: "com.example/files",
    version: "1.2.0",
  });
});

test("a server set up by hand sends no directory origin", async () => {
  const bodies = [];
  const draft = draftFor("remote", { name: "docs", url: "https://docs.example/mcp" });
  await saveNewServer({
    draft,
    saveServer: async (_server, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
  });
  assert.equal(bodies[0].directoryOrigin, undefined);
});
