import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { capabilityDirectory } from "../../server/features/mcp/session-capability.js";

for (const legacy of [false, true])
  test(`${legacy ? "legacy expired" : "new"} session grants publish artifacts after a month and a web restart`, async (t) => {
    const f = await applicationFixture(t);
    const issued = await issue(f, { choices: true });
    const client = await connect(t, f, issued);
    const file = path.join(
      capabilityDirectory(f.dataDir, issued.session.id),
      "active.json",
    );
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(Object.hasOwn(record, "expiresAt"), false);
    assert.equal(Object.hasOwn(issued.session.agentpierTools, "expiresAt"), false);
    if (legacy) {
      const expiresAt = Date.now() - 60_000;
      await fs.writeFile(file, JSON.stringify({ ...record, expiresAt }));
      await f.application.sessions.save({
        ...issued.session,
        agentpierTools: { ...issued.session.agentpierTools, expiresAt },
      });
    }
    await fs.writeFile(path.join(f.project, "report.html"), "<h1>Session report</h1>");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(30 * 24 * 60 * 60_000);
    const input = {
      requestId: "long-session-report",
      title: "Session report",
      sourcePath: "report.html",
    };
    const published = await client.callTool({
      name: "artifact_publish",
      arguments: input,
    });
    assert.notEqual(published.isError, true, JSON.stringify(published));
    await f.restart();
    const repeated = await client.callTool({
      name: "artifact_publish",
      arguments: input,
    });
    assert.deepEqual(repeated.structuredContent, {
      ...published.structuredContent,
      url: `${f.url}/artifacts/view/${published.structuredContent.id}`,
    });
    assert.equal(
      (await f.application.sessionMcp.verify(issued.token)).sessionId,
      issued.session.id,
    );
    // A long-lived or previously expired credential still loses access on revocation.
    await f.application.sessionMcp.revoke(issued.session.id);
    await assert.rejects(client.listTools());
    await f.restart();
    await assert.rejects(client.listTools());
    t.mock.timers.reset();
  });
