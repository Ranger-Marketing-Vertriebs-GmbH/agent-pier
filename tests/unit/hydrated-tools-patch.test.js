import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyBundlePatches,
  runtimeBundlePatches,
} from "../../server/features/assistants/runtimes/openclaw/runtime-bundle-patches.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import {
  assertHydratedToolsKept,
  hydratedToolsSites,
} from "../helpers/hydrated-tools-guard.js";

const pinned = runtimeManifest.version;
const file = "dist/tool-send-receipts-oBTeJUW8.mjs";
// OpenClaw 2026.11.6's next-turn preparation (src/agents/sessions/sdk.ts, minified):
// `u` is the session agent, `c` the loop's turn input, `s` the tool list it saw last.
// `createAgentSession` stands for the session's agent options, which wire the deferred
// tool resolver next to it.
const shipped = `
const sameTools = (e, t) => e.length === t.length && e.every((e, n) => e === t[n]);
export function createAgentSession(e, p) {
\treturn {
\t\tresolveDeferredTool: e.resolveDeferredTool,
\t\tprepareNextTurnWithContext: createSessionPrepareNextTurnWithContext(() => p),
\t};
}
function createSessionPrepareNextTurnWithContext(e) {
\tlet t;
\tlet s = [];
\treturn async (c) => {
\t\tconst u = e();
\t\tconst d = t !== c.newMessages;
\t\tif (d) t = c.newMessages;
\t\tconst m = u.state.tools;
\t\tconst v = d || !sameTools(m, s);
\t\ts = m.slice();
\t\treturn { context: { ...c.context, tools: v ? m.slice() : c.context.tools?.slice() } };
\t};
}
`;

function packageDir(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrated-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, file), text);
  return dir;
}
const load = (text) =>
  import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
const names = (tools) => tools.map((tool) => tool.name);

test("the shipped next turn drops a hydrated tool and fails the guard", async (t) => {
  const dir = packageDir(t, shipped);
  assert.deepEqual(hydratedToolsSites(dir), [{ file, resets: true, keeps: false }]);
  assert.throws(() => assertHydratedToolsKept(dir), /hydrated-tools-kept/);
  const session = { state: { tools: [{ name: "read" }] } };
  const next = (await load(shipped)).createAgentSession(
    {},
    session,
  ).prepareNextTurnWithContext;
  const turn = {
    newMessages: [],
    context: { tools: [{ name: "read" }, { name: "ask" }] },
  };
  assert.deepEqual(names((await next(turn)).context.tools), ["read"]);
});

test("the patched next turn keeps hydrated tools while the session's list holds", async (t) => {
  const dir = packageDir(t, shipped);
  const one = {
    [pinned]: runtimeBundlePatches[pinned].filter((p) => p.file === file),
  };
  applyBundlePatches(dir, pinned, one);
  assert.deepEqual(assertHydratedToolsKept(dir), [{ file, resets: false, keeps: true }]);
  const read = { name: "read" };
  const session = { state: { tools: [read] } };
  const ask = { name: "ask" };
  const options = (
    await load(fs.readFileSync(path.join(dir, file), "utf8"))
  ).createAgentSession({ resolveDeferredTool: async () => ask }, session);
  const next = options.prepareNextTurnWithContext;
  // The run hydrates `ask` through the session's resolver (agent-core).
  assert.equal(await options.resolveDeferredTool({ toolCall: { name: "ask" } }), ask);
  const messages = [];
  const hydrated = { newMessages: messages, context: { tools: [read, ask] } };
  // The first turn after the hydrating call keeps the tool, a later one too.
  assert.deepEqual(names((await next(hydrated)).context.tools), ["read", "ask"]);
  assert.deepEqual(names((await next(hydrated)).context.tools), ["read", "ask"]);
  // A changed session tool list (policy) drops it; a new call hydrates it again.
  session.state.tools = [read, { name: "write" }];
  assert.deepEqual(names((await next(hydrated)).context.tools), ["read", "write"]);
});

test("the patched next turn keeps only tools the deferred resolver returned", async (t) => {
  const dir = packageDir(t, shipped);
  applyBundlePatches(dir, pinned, {
    [pinned]: runtimeBundlePatches[pinned].filter((p) => p.file === file),
  });
  const read = { name: "read" };
  const ask = { name: "ask" };
  const session = { state: { tools: [read] } };
  const options = (
    await load(fs.readFileSync(path.join(dir, file), "utf8"))
  ).createAgentSession({ resolveDeferredTool: async () => ask }, session);
  await options.resolveDeferredTool({ toolCall: { name: "ask" } });
  // The first turn (no tool list seen yet) carries a stale context tool the resolver
  // never returned, and a same-named copy of the hydrated one: only `ask` stays.
  const turn = {
    newMessages: [],
    context: { tools: [read, { name: "stale" }, ask, { name: "ask" }] },
  };
  assert.deepEqual(
    names((await options.prepareNextTurnWithContext(turn)).context.tools),
    ["read", "ask"],
  );
  // Without a resolver the session keeps its own tools only (tools of its own, as
  // the record is by identity).
  const plain = (
    await load(fs.readFileSync(path.join(dir, file), "utf8"))
  ).createAgentSession({}, { state: { tools: [read] } });
  assert.equal(plain.resolveDeferredTool, undefined);
  const own = { newMessages: [], context: { tools: [read, { name: "ask" }] } };
  assert.deepEqual(names((await plain.prepareNextTurnWithContext(own)).context.tools), [
    "read",
  ]);
});
