import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  attemptKindLabel,
  repairNote,
  repairSessionLabel,
  tokenTotal,
  effectiveNodeStatus,
  failReasonLabel,
  nodeStatusLabel,
  runCodes,
  runStatusLabel,
} from "../../web/features/pipelines/run-codes.js";
import { offeredRunActions } from "../../web/features/pipelines/run-action-request.js";
import { pipelineCopy } from "../../web/lib/i18n/messages/pipelines.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

const engineDir = path.resolve("server/features/pipelines");
const sources = fs
  .readdirSync(engineDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => fs.readFileSync(path.join(engineDir, name), "utf8"))
  .join("\n");
const literals = (text) => [...text.matchAll(/"([a-z]+(?:-[a-z]+)*)"/g)].map((m) => m[1]);
const assigned = (owner, field) =>
  [...sources.matchAll(new RegExp(`\\b${owner}\\.${field} = "([a-z-]+)"`, "g"))].map(
    (m) => m[1],
  );
// The reason codes the engine parks a stage with: every string literal among the
// arguments of park(), including conditional reasons.
const parkReasons = [...sources.matchAll(/\bpark\(([^;]*?)\);/gs)]
  .flatMap((m) => literals(m[1]))
  .filter((code) => !["awaiting-gate", "awaiting-human"].includes(code));
// The reasons a resumed repair turn falls back to a fresh session with.
const fallbackReasons = [
  ...[...sources.matchAll(/\bresumeFallback\(([^;]*?)\);/gs)].flatMap((m) =>
    literals(m[1]),
  ),
  ...[...sources.matchAll(/\bfresh\("([a-z-]+)"\)/g)].map((m) => m[1]),
  ...[...sources.matchAll(/\bfallback: "([a-z-]+)"/g)].map((m) => m[1]),
];
const turnKinds = [...sources.matchAll(/kind: "([a-z]+(?:-[a-z]+)+|kickoff)"/g)].map(
  (m) => m[1],
);

test("every run code the engine writes is known to the pipeline UI", () => {
  const cases = {
    runStatuses: assigned("run", "status"),
    nodeStatuses: assigned("node", "status"),
    failReasons: [
      ...parkReasons,
      ...literals(sources.match(/retryable = \[[^\]]*\]/)[0]),
      ...[...sources.matchAll(/\bresumeFallback\(([^;]*?)\);/gs)].flatMap((m) =>
        literals(m[1]),
      ),
    ],
    attemptKinds: [
      ...turnKinds,
      ...literals(sources.match(/RESUMED_REPAIR = "[^"]+"/)[0]),
    ],
    repairFallbacks: fallbackReasons,
    gateDecisions: [...assigned("node", "gateDecision"), "accepted", "overridden"],
  };
  assert.ok(cases.failReasons.includes("verdict-missing"), "the scan finds reasons");
  assert.ok(cases.attemptKinds.includes("gate-feedback"), "the scan finds turn kinds");
  assert.ok(cases.attemptKinds.includes("resumed-repair"), "the scan finds the repair");
  assert.ok(cases.repairFallbacks.includes("no-session"), "the scan finds fallbacks");
  assert.ok(cases.repairFallbacks.includes("resume-failed"), "the scan finds failures");
  assert.ok(cases.repairFallbacks.includes("retried"), "the scan finds relaunches");
  for (const [list, codes] of Object.entries(cases))
    for (const code of codes)
      assert.ok(runCodes[list].includes(code), `${list} misses engine code ${code}`);
});

test("every run code has a German and an English label", (t) => {
  t.after(() => setLanguage("en"));
  const groups = {
    runStatuses: "statuses",
    nodeStatuses: "nodeStatuses",
    failReasons: "failReasons",
    attemptKinds: "attemptKinds",
    gateDecisions: "gateDecisions",
    repairFallbacks: "repairFallbacks",
  };
  for (const language of ["de", "en"]) {
    setLanguage(language);
    for (const [list, key] of Object.entries(groups))
      for (const code of runCodes[list]) {
        const label = pipelineCopy[key][code];
        assert.equal(typeof label, "string", `${language} ${key}.${code}`);
        assert.notEqual(label, code);
      }
  }
});

test("labels never fall back to a raw code", (t) => {
  t.after(() => setLanguage("en"));
  setLanguage("en");
  assert.equal(failReasonLabel("session-error"), "The session ended with an error");
  assert.equal(failReasonLabel("brand-new-code"), "The stage stopped");
  assert.equal(attemptKindLabel("verdict-nudge"), "Result reminder");
  assert.equal(attemptKindLabel("brand-new-kind"), "Turn");
  assert.equal(runStatusLabel("unheard-of"), "Unavailable");
  assert.equal(nodeStatusLabel("unheard-of"), "Unavailable");
  setLanguage("de");
  assert.equal(failReasonLabel("verdict-missing"), "Kein Ergebnis gemeldet");
  assert.equal(nodeStatusLabel("cancelled"), "Abgebrochen");
});

test("a stage still marked active in an ended run reads as ended", () => {
  const node = { id: "a", status: "awaiting-gate" };
  assert.equal(effectiveNodeStatus({ status: "cancelled" }, node), "cancelled");
  assert.equal(effectiveNodeStatus({ status: "failed" }, node), "failed");
  assert.equal(effectiveNodeStatus({ status: "awaiting-human" }, node), "awaiting-gate");
  assert.equal(
    effectiveNodeStatus({ status: "cancelled" }, { status: "passed" }),
    "passed",
  );
});

test("pull requests are not offered for a repository without a remote", () => {
  const actions = ["delete", "create-pr"];
  assert.deepEqual(offeredRunActions({ actions }), actions);
  assert.deepEqual(
    offeredRunActions({ actions, workspace: { hasRemote: true } }),
    actions,
  );
  assert.deepEqual(offeredRunActions({ actions, workspace: { hasRemote: false } }), [
    "delete",
  ]);
});

test("a repair turn reads as the same or a new session with its fallback", (t) => {
  t.after(() => setLanguage("en"));
  setLanguage("en");
  assert.equal(repairSessionLabel(undefined), "");
  assert.equal(repairSessionLabel({ session: "resumed" }), "Same session");
  assert.equal(repairSessionLabel({ session: "fresh" }), "New session");
  assert.equal(
    repairSessionLabel({ session: "fresh", fallback: "context-exhausted" }),
    "New session (context exhausted)",
  );
  assert.equal(
    repairSessionLabel({ session: "fresh", fallback: "retried" }),
    "New session (started again)",
  );
  assert.equal(
    repairSessionLabel({ session: "fresh", fallback: "brand-new" }),
    "New session (not resumed)",
  );
  // A resumed repair's kind already names its session.
  const repair = { session: "resumed" };
  assert.equal(repairNote({ kind: "resumed-repair", repair }), "");
  assert.equal(
    repairNote({ kind: "kickoff", repair: { session: "fresh", fallback: "no-session" } }),
    "New session (no session to resume)",
  );
  assert.equal(repairNote({ kind: "kickoff" }), "");
  assert.equal(tokenTotal(undefined), null);
  assert.equal(tokenTotal({}), null);
  assert.equal(tokenTotal({ inputTokens: 40, outputTokens: 5 }), 45);
  assert.equal(tokenTotal({ inputTokens: 40, outputTokens: 5, totalTokens: 50 }), 50);
});
