import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  documents,
  profileLocation,
} from "../../server/features/cli-profiles/configuration.js";
import { applicationFixture } from "../helpers/application.js";

test("starting a session writes the bound servers into its CLI, managed accounts included", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  app.accounts.command = () => ({
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    env: { HOME: f.home, PATH: "/usr/bin:/bin" },
  });
  const account = app.accounts.create({ name: "Managed", tool: "claude" });
  const server = app.mcpServers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
  });
  app.mcpServers.setClis(server.id, ["claude"]);
  assert.equal(fs.existsSync(path.join(f.home, ".claude.json")), false);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: account.id, cwd: f.home },
  });
  assert.equal(response.status, 201);
  const expected = { type: "http", url: "https://mcp.example.test/mcp" };
  const canonical = JSON.parse(
    fs.readFileSync(path.join(f.home, ".claude.json"), "utf8"),
  );
  assert.deepEqual(canonical.mcpServers.docs, expected);
  // The projection of this very launch carried it into the managed account.
  const managed = documents(profileLocation(app.accounts, account.id))[0].file;
  assert.deepEqual(
    JSON.parse(fs.readFileSync(managed, "utf8")).mcpServers.docs,
    expected,
  );
});
