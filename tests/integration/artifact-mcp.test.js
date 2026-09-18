import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} publishes and lists its own session artifacts through native MCP`, async (t) => {
    const f = await applicationFixture(t);
    const issued = await issue(f, { tool, choices: true });
    await fs.writeFile(path.join(f.home, "report.html"), "<h1>private</h1>");
    const client = await connect(t, f, issued);
    assert.ok(
      (await client.listTools()).tools.some((entry) => entry.name === "artifact_publish"),
    );
    const args = { requestId: randomUUID(), title: "Report", sourcePath: "report.html" };
    const result = await client.callTool({ name: "artifact_publish", arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const published = JSON.parse(result.content[0].text);
    assert.equal(published.sessionId, issued.session.id);
    assert.equal(published.url, `${f.url}/artifacts/view/${published.id}`);
    const again = await client.callTool({ name: "artifact_publish", arguments: args });
    assert.equal(JSON.parse(again.content[0].text).id, published.id);
    const listing = await client.callTool({ name: "artifacts_list", arguments: {} });
    assert.equal(JSON.parse(listing.content[0].text).items.length, 1);
    const forged = await client.callTool({
      name: "artifact_publish",
      arguments: { ...args, sessionId: "foreign" },
    });
    assert.equal(forged.isError, true);
    await f.application.sessions.stop(issued.session.id);
    assert.equal((await f.application.artifacts.get(published.id)).id, published.id);
    await f.application.sessions.remove(issued.session.id);
    await assert.rejects(f.application.artifacts.get(published.id), { status: 404 });
  });
test("artifact discovery and invocation require a full trusted session context", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  const client = await connect(t, f, issued);
  assert.ok(
    !(await client.listTools()).tools.some((entry) => entry.name === "artifact_publish"),
  );
  const grant = { allResources: true, scopes: [] };
  assert.ok(
    !f.application.mcpTools.list(grant).some(([name]) => name === "artifact_publish"),
  );
  await assert.rejects(f.application.mcpTools.call("artifact_publish", {}, grant), {
    status: 403,
  });
});
