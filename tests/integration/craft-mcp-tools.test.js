import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { agentText } from "../../server/lib/i18n/agent-text.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const data = (result) => JSON.parse(result.content[0].text);
const names = (f, grant, context) =>
  f.application.mcpTools
    .list(grant, context)
    .map(([name]) => name)
    .filter((name) => name.startsWith("craft_"));

/** The real application with Craft Anything "installed" and a recording supervisor. */
async function craftApp(t, { installed = true } = {}) {
  const f = await applicationFixture(t);
  const calls = [];
  const rebuilds = new Map();
  const real = { craft: f.application.craft, rebuilds: f.application.craftRebuilds };
  t.after(() => {
    f.application.craft = real.craft;
    f.application.craftRebuilds = real.rebuilds;
  });
  f.application.craft = { state: () => ({ installed }), close: async () => {} };
  f.application.craftRebuilds = {
    close: async () => {},
    start: async (input, options) => {
      calls.push({ input, options });
      if (input.request === "refuse")
        throw Object.assign(new Error(serverMessages.craft.notInstalled), {
          status: 409,
        });
      const key = `${options.source}\n${input.requestId}`;
      if (!rebuilds.has(key))
        rebuilds.set(key, {
          id: `r${rebuilds.size + 1}`,
          projectId: "p1",
          name: "clone",
          folder: "/projects/clone",
          status: "building",
          statusLabel: "Building",
          step: "study",
          note: "Reading",
          questions: [
            { id: "q1", title: "Secret?", detail: "rm -rf /", action: "rm -rf /" },
          ],
        });
      return rebuilds.get(key);
    },
    get: (id) => [...rebuilds.values()].find((item) => item.id === id) ?? null,
  };
  return { f, calls };
}

test("rebuild tools are offered only to a full session grant with Craft Anything installed", async (t) => {
  const { f } = await craftApp(t);
  const context = { sessionId: "s1", revalidate() {} };
  const full = { allResources: true, scopes: [] };
  assert.deepEqual(names(f, full, context), [
    "craft_rebuild_start",
    "craft_rebuild_status",
  ]);
  assert.deepEqual(names(f, full), []);
  assert.deepEqual(names(f, { allResources: false, scopes: [] }, context), []);
  await assert.rejects(
    f.application.mcpTools.call("craft_rebuild_status", { id: "x" }, full),
    { status: 403 },
  );
  const bare = await craftApp(t, { installed: false });
  assert.deepEqual(names(bare.f, full, context), []);
});

test("a session starts a rebuild, repeats it by requestId and reads its status", async (t) => {
  const { f, calls } = await craftApp(t);
  const issued = await issue(f, { choices: true });
  const client = await connect(t, f, issued);
  assert.ok(client.getInstructions().includes("craft_rebuild_status"));
  const tool = (await client.listTools()).tools.find(
    (entry) => entry.name === "craft_rebuild_start",
  );
  assert.equal(tool.annotations.idempotentHint, true);
  const args = { request: "Clone it", target: "https://example.com", requestId: "a" };
  const first = data(
    await client.callTool({ name: "craft_rebuild_start", arguments: args }),
  );
  const again = data(
    await client.callTool({ name: "craft_rebuild_start", arguments: args }),
  );
  assert.deepEqual(again, first);
  assert.equal(first.id, "r1");
  assert.equal(first.link, "/craft/r1");
  assert.equal(calls[0].options.source, "session");
  const status = data(
    await client.callTool({ name: "craft_rebuild_status", arguments: { id: "r1" } }),
  );
  assert.deepEqual(status, {
    id: "r1",
    name: "clone",
    status: "building",
    statusLabel: "Building",
    step: "study",
    note: "Reading",
    projectId: "p1",
    folder: "/projects/clone",
    openQuestions: 1,
    link: "/craft/r1",
  });
});

test("owner-only fields are refused and errors carry stable codes", async (t) => {
  const { f, calls } = await craftApp(t);
  const client = await connect(t, f, await issue(f, { choices: true }));
  const fields = await client
    .callTool({
      name: "craft_rebuild_start",
      arguments: { request: "x", requestId: "a", autoMode: true, accountId: "z" },
    })
    .catch((error) => ({ isError: true, error }));
  assert.equal(fields.isError, true);
  assert.equal(calls.length, 0);
  const noId = await client.callTool({
    name: "craft_rebuild_start",
    arguments: { request: "x" },
  });
  assert.equal(noId.isError, true);
  const refused = await client.callTool({
    name: "craft_rebuild_start",
    arguments: { request: "refuse", requestId: "b" },
  });
  assert.equal(data(refused).code, "CRAFT_REBUILD_REFUSED");
  assert.equal(data(refused).status, 409);
  const missing = await client.callTool({
    name: "craft_rebuild_status",
    arguments: { id: "nope" },
  });
  assert.equal(data(missing).code, "CRAFT_REBUILD_NOT_FOUND");
  assert.equal(data(missing).status, 404);
});

test("a revoked grant refuses the next call", async (t) => {
  const { f, calls } = await craftApp(t);
  const issued = await issue(f, { choices: true });
  await f.application.sessionMcp.revoke(issued.session.id);
  const grant = { allResources: true, scopes: [] };
  const context = { sessionId: issued.session.id, revalidate() {} };
  await assert.rejects(
    f.application.mcpTools.call(
      "craft_rebuild_start",
      { request: "x", requestId: "a" },
      grant,
      undefined,
      context,
    ),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "CRAFT_REBUILD_UNAVAILABLE");
      assert.equal(
        agentText(error.message),
        "AgentPier access revoked or session unavailable.",
      );
      return true;
    },
  );
  assert.equal(calls.length, 0);
});
