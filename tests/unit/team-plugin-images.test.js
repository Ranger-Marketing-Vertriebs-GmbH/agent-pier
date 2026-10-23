import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../../server/features/assistants/team-plugin/index.js";
import { png } from "../helpers/image-bytes.js";

// The workspace tool as the Gateway creates it, with the bridge answering `answer`.
function workspaceTool(t, answer) {
  const factories = [];
  plugin.register({
    pluginConfig: { url: "http://bridge", token: "test" },
    registerTool: (f) => factories.push(f),
    on() {},
  });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const body = url.endsWith("/prepare") ? { ticket: "ticket" } : answer;
    return { ok: true, json: async () => body };
  });
  const context = {
    agentId: "agent",
    sessionKey: "session",
    assertInvocationCurrent() {},
  };
  const tool = factories
    .map((f) => f.create(context))
    .find((created) => created?.name === "agentpier_workspace");
  return { tool, bodies };
}

test("image_view reaches the model as an image block with a line naming the file", async (t) => {
  const data = png.toString("base64");
  const { tool, bodies } = workspaceTool(t, {
    projectId: "p1",
    access: "read",
    path: "shots/home.png",
    mimeType: "image/png",
    bytes: png.length,
    data,
  });
  assert.ok(tool.parameters.properties.action.enum.includes("image_view"));
  assert.match(tool.description, /image_view/);
  const result = await tool.execute("call-1", {
    action: "image_view",
    projectId: "p1",
    path: "shots/home.png",
  });
  assert.equal(bodies.at(-1).input.action, "image_view");
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /shots\/home\.png/);
  assert.match(result.content[0].text, /image\/png/);
  assert.doesNotMatch(result.content[0].text, new RegExp(data.slice(0, 40)));
  assert.deepEqual(result.content[1], { type: "image", data, mimeType: "image/png" });
});

test("other workspace results stay one JSON text block", async (t) => {
  const answer = { projectId: "p1", access: "read", path: "a.md", content: "# A" };
  const { tool } = workspaceTool(t, answer);
  const result = await tool.execute("call-2", {
    action: "file_read",
    projectId: "p1",
    path: "a.md",
  });
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(answer) }]);
});
