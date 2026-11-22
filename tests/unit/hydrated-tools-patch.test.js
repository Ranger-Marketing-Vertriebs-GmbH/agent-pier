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
const shipped = `
const sameTools = (e, t) => e.length === t.length && e.every((e, n) => e === t[n]);
export function createSessionPrepareNextTurnWithContext(e) {
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
  const next = (await load(shipped)).createSessionPrepareNextTurnWithContext(
    () => session,
  );
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
  const next = (
    await load(fs.readFileSync(path.join(dir, file), "utf8"))
  ).createSessionPrepareNextTurnWithContext(() => session);
  const messages = [];
  const hydrated = { newMessages: messages, context: { tools: [read, { name: "ask" }] } };
  // The first turn after the hydrating call keeps the tool, a later one too.
  assert.deepEqual(names((await next(hydrated)).context.tools), ["read", "ask"]);
  assert.deepEqual(names((await next(hydrated)).context.tools), ["read", "ask"]);
  // A changed session tool list (policy) drops it; a new call hydrates it again.
  session.state.tools = [read, { name: "write" }];
  assert.deepEqual(names((await next(hydrated)).context.tools), ["read", "write"]);
});
