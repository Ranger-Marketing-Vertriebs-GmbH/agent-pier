import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoRestartResume,
  restartResumeSites,
} from "../helpers/restart-resume-guard.js";
import { applyBundlePatches } from "../../server/features/assistants/runtimes/openclaw/runtime-bundle-patches.js";

const recovery = "dist/main-session-restart-recovery-DekokRXp.mjs";
// The shape of 2026.11.3's recovery module: the resume's definition and its one call.
const shipped = [
  "async function resumeMainSession(params) {",
  "\treturn await runWithMainSessionRecoveryAdmission(params);",
  "}",
  "async function recoverStore(params) {",
  "\t\t\tconst resumeResult = await resumeMainSession({",
  "\t\t\t\t...target,",
  "\t\t\t\tentry",
  "\t\t\t});",
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
  "dist/openclaw-state-lease-heartbeat-shared-BczGehzh.mjs":
    "const LEASE_CONTENTION_RETRY_TIMEOUT_MS = 2e3;\n",
  "dist/base-url-Baro1bPi.mjs": 'const OPENAI_CODEX_CLIENT_VERSION = "0.164.0";\n',
  "dist/extensions/openai/.setup/provider-policy-api-BhWaBu5H.mjs":
    'const OPENAI_CODEX_CLIENT_VERSION = "0.164.0";\n',
  "dist/agent-database-startup-DQZqWc4z.mjs":
    "if (!(error instanceof AgentDatabaseStartupSupersededError) || attempt >= 4) throw error;\n",
};

test("the shipped recovery module resumes and fails the guard", (t) => {
  const dir = packageDir(t, { [recovery]: shipped });
  assert.deepEqual(restartResumeSites(dir), [
    { file: recovery, defines: true, calls: 1 },
  ]);
  assert.throws(
    () => assertNoRestartResume(dir),
    /DekokRXp\.mjs \(1\).*no-restart-resume/,
  );
});

test("the pinned version's patches leave no resume call", (t) => {
  const dir = packageDir(t, { ...others, [recovery]: shipped });
  applyBundlePatches(dir, "2026.11.3");
  assert.deepEqual(assertNoRestartResume(dir), [
    { file: recovery, defines: true, calls: 0 },
  ]);
});

test("a call in another file fails too", (t) => {
  const dir = packageDir(t, { ...others, [recovery]: shipped });
  applyBundlePatches(dir, "2026.11.3");
  fs.writeFileSync(
    path.join(dir, "dist/chat-retry.mjs"),
    "await resumeMainSession({ entry });\n",
  );
  assert.throws(() => assertNoRestartResume(dir), /chat-retry\.mjs \(1\)/);
});

test("a package without the resume fails instead of passing silently", (t) => {
  const dir = packageDir(t, { "dist/other.mjs": "export const x = 1;\n" });
  assert.throws(() => assertNoRestartResume(dir), /No resumeMainSession/);
});
