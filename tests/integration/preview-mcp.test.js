import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { send, startUpstream } from "../helpers/preview-proxy-fixture.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { agentText } from "../../server/lib/i18n/agent-text.js";

async function previewApp(t) {
  const range = await freePortRange(4);
  const f = await applicationFixture(t, {
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          previews: {
            enabled: true,
            portRangeStart: range.start,
            portRangeEnd: range.end,
          },
        }),
      );
    },
  });
  await f.application.previews.start();
  return f;
}
const data = (result) => JSON.parse(result.content[0].text);
const instruction =
  "When you start a server for the user to look at or test, call `preview_open` with its port and give the user the returned link instead of a localhost URL. Bind the server to 127.0.0.1 or localhost. Close it with `preview_close` when it is no longer needed.";

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} opens, lists and closes a preview through native MCP`, async (t) => {
    const f = await previewApp(t);
    const upstream = await startUpstream(t);
    const issued = await issue(f, { tool, choices: true });
    const client = await connect(t, f, issued);
    const names = (await client.listTools()).tools.map((entry) => entry.name);
    for (const name of ["preview_open", "preview_close", "preview_list"])
      assert.ok(names.includes(name), name);
    const opened = await client.callTool({
      name: "preview_open",
      arguments: { port: upstream.port, label: "App" },
    });
    assert.notEqual(opened.isError, true, JSON.stringify(opened));
    const preview = data(opened);
    assert.equal(preview.port, upstream.port);
    assert.equal(preview.label, "App");
    const url = new URL(preview.url);
    assert.equal(url.hostname, "127.0.0.1");
    const body = await send(Number(url.port), {
      path: "/page",
      headers: { host: url.host, cookie: f.cookie },
    });
    assert.equal(body.status, 200);
    assert.match(body.body, /GET \/page/);
    const listed = data(await client.callTool({ name: "preview_list", arguments: {} }));
    assert.deepEqual(listed.items, [preview]);
    const closed = await client.callTool({
      name: "preview_close",
      arguments: { id: preview.id },
    });
    assert.notEqual(closed.isError, true, JSON.stringify(closed));
    assert.deepEqual(
      data(await client.callTool({ name: "preview_list", arguments: {} })).items,
      [],
    );
    const reopened = data(
      await client.callTool({ name: "preview_open", arguments: { port: upstream.port } }),
    );
    const byPort = await client.callTool({
      name: "preview_close",
      arguments: { port: upstream.port },
    });
    assert.notEqual(byPort.isError, true, JSON.stringify(byPort));
    assert.equal(f.application.previews.list().length, 0, reopened.id);
    const none = await client.callTool({ name: "preview_close", arguments: {} });
    assert.equal(none.isError, true);
    assert.equal(data(none).code, "PREVIEW_INVALID_INPUT");
  });

test("preview tools are absent without a full session context", async (t) => {
  const f = await applicationFixture(t);
  const grants = [
    { allResources: true, scopes: [] },
    { allResources: false, scopes: ["catalog:read"] },
  ];
  for (const grant of grants) {
    const names = f.application.mcpTools.list(grant).map(([name]) => name);
    assert.ok(!names.some((name) => name.startsWith("preview_")));
    await assert.rejects(
      f.application.mcpTools.call("preview_open", { port: 3000 }, grant),
      { status: 403 },
    );
  }
  const scoped = { allResources: false, scopes: [] };
  const context = { sessionId: "s1", revalidate() {} };
  assert.ok(
    !f.application.mcpTools
      .list(scoped, context)
      .some(([name]) => name === "preview_open"),
  );
});

test("errors carry stable codes for agents", async (t) => {
  const f = await previewApp(t);
  const issued = await issue(f, { choices: true });
  const client = await connect(t, f, issued);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const result = await client.callTool({ name: "preview_open", arguments: { port } });
  assert.equal(result.isError, true);
  const error = data(result);
  assert.equal(error.code, "PREVIEW_NOT_LISTENING");
  assert.equal(error.status, 409);
  assert.match(error.error, /No server is listening/);
  const bad = await client.callTool({ name: "preview_open", arguments: { port: 0 } });
  assert.equal(bad.isError, true);
});

test("server instructions tell sessions to use preview_open instead of localhost URLs", async (t) => {
  const f = await previewApp(t);
  const client = await connect(t, f, await issue(f, { choices: true }));
  assert.ok(client.getInstructions().includes(instruction));
});

test("a revoked grant refuses the next call and closes the preview", async (t) => {
  const f = await previewApp(t);
  const upstream = await startUpstream(t);
  const issued = await issue(f, { choices: true });
  const client = await connect(t, f, issued);
  const opened = await client.callTool({
    name: "preview_open",
    arguments: { port: upstream.port },
  });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  assert.equal(f.application.previews.list().length, 1);
  await f.application.sessionMcp.revoke(issued.session.id);
  assert.equal(f.application.previews.list().length, 0);
  const grant = { allResources: true, scopes: [] };
  const context = { sessionId: issued.session.id, revalidate() {} };
  await assert.rejects(
    f.application.mcpTools.call(
      "preview_open",
      { port: upstream.port },
      grant,
      undefined,
      context,
    ),
    (error) => {
      assert.equal(error.status, 403);
      // Agents read the English catalog text.
      assert.equal(
        agentText(error.message),
        "AgentPier access revoked or session unavailable.",
      );
      return true;
    },
  );
  assert.equal(f.application.previews.list().length, 0);
  const again = await client
    .callTool({ name: "preview_open", arguments: { port: upstream.port } })
    .catch((error) => ({ isError: true, error }));
  assert.equal(again.isError, true);
});

test("a session sees and closes only its own previews", async (t) => {
  const f = await previewApp(t);
  const upstream = await startUpstream(t);
  const a = await connect(t, f, await issue(f, { choices: true }));
  const b = await connect(t, f, await issue(f, { choices: true }));
  const mine = data(
    await a.callTool({ name: "preview_open", arguments: { port: upstream.port } }),
  );
  assert.deepEqual(
    data(await b.callTool({ name: "preview_list", arguments: {} })).items,
    [],
  );
  for (const args of [{ id: mine.id }, { port: upstream.port }]) {
    const result = await b.callTool({ name: "preview_close", arguments: args });
    assert.equal(result.isError, true);
    const error = data(result);
    assert.equal(error.code, "PREVIEW_NOT_FOUND");
    assert.equal(error.status, 404);
    assert.match(error.error, /no longer exists/);
  }
  assert.deepEqual(
    f.application.previews.list().map((entry) => entry.id),
    [mine.id],
  );
});
