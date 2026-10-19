import test from "node:test";
import assert from "node:assert/strict";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { CliMcpBindings } from "../../server/features/mcp-servers/cli-bindings.js";
import { cliMcpFixture, stdio } from "../helpers/cli-mcp.js";

const service = (f, options = {}) =>
  new CliMcpBindings({
    servers: f.servers,
    extensions: f.extensions,
    warn: (line) => f.warnings.push(line),
    ...options,
  });
const refused = { status: 400, code: "MCP_CLI_PLACEHOLDER_UNSUPPORTED" };

test("no coding CLI is given a server with agent placeholders", async (t) => {
  const f = cliMcpFixture(t);
  const changes = new CentralMcpChanges({ servers: f.servers });
  const cli = service(f, { changes: () => changes });
  const input = stdio({ env: { BASE: "{agent.workspace}" } });
  // Creating it for a CLI is refused before anything is stored.
  await assert.rejects(
    changes.create(input, { clis: ["codex"], confirmStdio: true }),
    refused,
  );
  assert.deepEqual(f.servers.list(), []);
  // Stored for agents only, it cannot be bound to a CLI later either.
  const server = await changes.create(input, { confirmStdio: true });
  await assert.rejects(
    cli.setClis(server.id, ["opencode"], { confirmStdio: true }),
    refused,
  );
  const [listed] = await cli.decorate(f.servers.list());
  assert.deepEqual(listed.cliSupport.codex, { supported: false, reason: "placeholder" });
  // A bound server cannot take one on: its CLI entry stays as it was.
  const local = f.servers.create(stdio({ name: "bound" }), { bind: [["cli", "codex"]] });
  cli.reconcileAll();
  await assert.rejects(
    changes.update(
      local.id,
      { revision: 1, args: ["--dir={agent.attachments}"] },
      { confirmStdio: true },
    ),
    refused,
  );
  assert.ok(f.entries("codex").bound);
  // Dropping the CLI in the same change is what the form sends instead.
  await changes.update(
    local.id,
    { revision: 1, args: ["--dir={agent.attachments}"] },
    { confirmStdio: true, clis: [] },
  );
  cli.reconcileAll();
  assert.equal(f.entries("codex").bound, undefined);
});
