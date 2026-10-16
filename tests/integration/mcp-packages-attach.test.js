import test from "node:test";
import assert from "node:assert/strict";
import { mcpServerConfig } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { packageService, preview, ref } from "../helpers/mcp-packages-service.js";

/** What the CLIs and the agents get for server `name` right now. */
function projected(s, name) {
  s.reconciler.reconcile("claude");
  const definition = s.servers.definitions().find((d) => d.name === name);
  return {
    cli: s.entries("claude")[name],
    agent: mcpServerConfig(definition, s.servers.secrets(definition.id)),
  };
}

async function ownServer(s) {
  const command = s.executable("own");
  const server = await s.changes.create(
    { name: "own", transport: "stdio", command, args: ["--x"] },
    { confirmStdio: true, clis: ["claude"] },
  );
  return { command, server };
}

test("an own-command server keeps running its command while its package installs", async (t) => {
  const s = await packageService(t);
  const { command, server } = await ownServer(s);
  const confirmed = await preview(s);
  const held = s.hold();
  await s.packages.attach(server.id, { source: ref(), previewId: confirmed.previewId });
  await held.reached;
  // Any other reconciliation while npm runs (another server saved, a CLI session).
  const during = projected(s, "own");
  held.release();
  await s.packages.jobs.idle();
  assert.equal(during.cli?.command, command);
  assert.equal(during.agent?.command, command);
  assert.equal(s.servers.get(server.id).source.status, "ready");
  assert.notEqual(projected(s, "own").cli.command, command);
});

test("a failed switch to a package leaves the own command running", async (t) => {
  const s = await packageService(t);
  const { command, server } = await ownServer(s);
  const confirmed = await preview(s);
  const original = s.packages.execute;
  s.packages.execute = async (file, args, options) => {
    if (args.includes("ci"))
      throw Object.assign(Error("npm ci failed"), { stdout: "", stderr: "" });
    return original(file, args, options);
  };
  await s.packages.attach(server.id, { source: ref(), previewId: confirmed.previewId });
  await s.packages.jobs.idle();
  const stored = s.servers.get(server.id);
  assert.equal(stored.source.status, "failed");
  assert.equal(stored.command, command);
  const after = projected(s, "own");
  assert.equal(after.cli?.command, command);
  assert.deepEqual(after.cli?.args, ["--x"]);
  assert.equal(after.agent?.command, command);
});
