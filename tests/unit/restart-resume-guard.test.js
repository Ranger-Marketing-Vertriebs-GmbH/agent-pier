import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoRestartResume,
  restartResumeSites,
} from "../helpers/restart-resume-guard.js";
import {
  applyBundlePatches,
  runtimeBundlePatches,
} from "../../server/features/assistants/runtimes/openclaw/runtime-bundle-patches.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";

const pinned = runtimeManifest.version;
const resume = "dist/session-restart-resume-BzRgzT_h.mjs";
// The shape of 2026.11.6's startup resume (src/gateway/session-restart-resume.ts,
// minified): its entry point, the orphan withdrawal that spares the queued messages
// a marker reserved, and the marker adoption.
const shipped = [
  "async function resumeMarkedSessions(e) {",
  "\tawait resumeAgentSessions(e, [], new Set());",
  "}",
  "async function resumeAgentSessions(e, t, n) {",
  "\tconst o = performance.timeOrigin;",
  "\tfor (const e of l) {",
  "\t\tconst t = await listOrphanedSessionPendingInputTargets(e, s.flatMap(({ entry: e }) => e.resumeAfterRestart?.queuedInputIds ?? []));",
  "\t\tfor (const { sessionKey: t, entry: n } of s) {",
  '\t\t\tconst r = n.resumeAfterRestart ?? (n.mainRestartRecovery && n.abortedLastRun === true && n.status === "interrupted" && n.updatedAt <= o && n.updatedAt >= o - LEGACY_RESTART_RESUME_WINDOW_MS ? { queuedInputIds: [] } : void 0);',
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

// A package whose dist holds `files` ({ relative path: text }).
function packageDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

// The other files the pinned version's patches touch, unpatched.
const others = {
  "dist/openclaw-state-lease-storage-BBSi-Imk.mjs":
    "const o = n + (a ? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS : LEASE_CONTENTION_RETRY_TIMEOUT_MS);\n",
  "dist/tool-send-receipts-oBTeJUW8.mjs":
    "const v = d || !sameTools(m, s);\ntools: v ? m.slice() : c.context.tools?.slice()\n",
};

test("the shipped startup resume adopts markers and fails the guard", (t) => {
  const dir = packageDir(t, { [resume]: shipped });
  assert.deepEqual(restartResumeSites(dir), [{ file: resume, adopts: 1, reserves: 1 }]);
  assert.throws(() => assertNoRestartResume(dir), /BzRgzT_h\.mjs.*no-restart-resume/);
});

test("the pinned version's patches leave no marker adoption or reservation", (t) => {
  const patches = runtimeBundlePatches[pinned];
  assert.deepEqual(
    patches.filter((patch) => patch.file === resume).map((patch) => patch.id),
    ["no-restart-resume", "no-restart-resume-inputs"],
  );
  const dir = packageDir(t, { ...others, [resume]: shipped });
  applyBundlePatches(dir, pinned);
  assert.deepEqual(assertNoRestartResume(dir), [
    { file: resume, adopts: 0, reserves: 0 },
  ]);
});

test("either patch alone still fails the guard", (t) => {
  for (const id of ["no-restart-resume", "no-restart-resume-inputs"]) {
    const dir = packageDir(t, { ...others, [resume]: shipped });
    const one = { [pinned]: runtimeBundlePatches[pinned].filter((p) => p.id === id) };
    applyBundlePatches(dir, pinned, one);
    assert.throws(() => assertNoRestartResume(dir), /no-restart-resume/, id);
  }
});

test("a package without the startup resume fails instead of passing silently", (t) => {
  const dir = packageDir(t, { "dist/other.mjs": "export const x = 1;\n" });
  assert.throws(() => assertNoRestartResume(dir), /No resumeMarkedSessions/);
});
