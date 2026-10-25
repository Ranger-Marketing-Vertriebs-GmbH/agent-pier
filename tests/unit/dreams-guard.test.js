import test from "node:test";
import assert from "node:assert/strict";
import { registerToolGuard } from "../../server/features/assistants/team-plugin/tool-guard.js";

// Runs the registered before_tool_call hooks for a tool, as OpenClaw does.
function guard() {
  const hooks = [];
  registerToolGuard({
    pluginConfig: { workspaces: "/w", url: "http://127.0.0.1:1", token: "t" },
    on: (name, fn, opts) => hooks.push({ name, fn, opts }),
  });
  return async (toolName, params) => {
    for (const h of hooks) {
      if (h.name !== "before_tool_call" || !h.opts.matcher?.includes(toolName)) continue;
      if (h.fn.length === 0) continue;
      const r = await h.fn({ toolName, params }, { agentId: "ap-a1", sessionKey: "k" });
      if (r?.block && /dreaming corpus/.test(r.blockReason)) return r;
    }
    return undefined;
  };
}
const corpus = "memory/.dreams/session-corpus/2026-10-25.txt";
test("an agent's file tools never reach its dreaming corpus", async () => {
  const run = guard();
  for (const tool of ["read", "memory_get", "write", "edit"])
    for (const path of [
      corpus,
      `memory/../${corpus}`,
      `memory/../memory/.dreams/session-corpus/2026-10-25.txt`,
      `./memory/./.dreams/x`,
      `/w/a1/${corpus}`,
      "memory\\.dreams\\x",
      "memory/.DREAMS",
    ])
      for (const key of ["path", "file_path", "filePath"])
        assert.equal((await run(tool, { [key]: path }))?.block, true, `${tool} ${path}`);
  const patch = (p) => `*** Begin Patch\n*** Add File: ${p}\n+x\n*** End Patch`;
  assert.equal((await run("apply_patch", { input: patch(corpus) }))?.block, true);
  assert.equal(
    (await run("apply_patch", { input: patch("memory/dreaming/../.dreams/x") }))?.block,
    true,
  );
});
test("dream notes and other memory files stay readable", async () => {
  const run = guard();
  for (const path of [
    "memory/dreaming/light/2026-10-25.md",
    "DREAMS.md",
    "memory/dreams.md",
    "memory/.dreamsy/x",
  ])
    assert.equal(await run("read", { path }), undefined, path);
  assert.equal(
    await run("memory_get", { path: "memory/dreaming/rem/2026-10-25.md" }),
    undefined,
  );
});
