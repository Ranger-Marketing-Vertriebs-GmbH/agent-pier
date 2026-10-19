import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { containedFile } from "./stage-verdict.js";
import { prepareReportDirectory, stageReportPath } from "./stage-reports.js";

// The spec is the run's contract: a stage writes spec.md into its report area and
// declares it with the role "spec". The engine records its text and parsed acceptance
// criteria in run.spec, hands it to every later stage and freezes it once another
// stage starts. A frozen spec changes only by the owner's decision at a gate; any
// other change to the file is recorded and reverted.
export const SPEC_LIMIT = 64 * 1024;
const ITEMS = 50;
const ITEM_TEXT = 2000;
const HISTORY = 20;
const PROMPT_LIMIT = 8 * 1024;

const digest = (data) => createHash("sha256").update(data).digest("hex");
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

// Sections by their heading, outside fenced code; the first section of a name counts.
function sections(text) {
  const found = new Map();
  let current = null,
    fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = heading[1]
        .toLowerCase()
        .replace(/[^a-z]+/g, " ")
        .trim();
      current = found.has(name) ? null : name;
      if (current) found.set(current, []);
    } else if (current) found.get(current).push(line);
  }
  return found;
}

// Top-level list items; indented or following lines continue the item before them.
function listItems(lines, marker) {
  const items = [];
  for (const line of lines) {
    const item = marker.exec(line);
    if (item) items.push(item[1].trim());
    else if (items.length && line.trim()) items[items.length - 1] += `\n${line.trim()}`;
  }
  return items.filter(Boolean).slice(0, ITEMS);
}

const productDecision =
  /\[\s*product[\s_-]+decision\s*\]|\(\s*product[\s_-]+decision\s*\)|^product[\s_-]+decision\s*:/i;

// Acceptance criteria are the numbered items under "Acceptance criteria", AC1 for the
// first; "Verify: …" in an item says how to check it. Assumptions marked
// "[product decision]" need the owner's confirmation.
export function parseSpec(text) {
  const parts = sections(text);
  const criteria = listItems(
    parts.get("acceptance criteria") || [],
    /^ {0,3}\d{1,3}[.)]\s+(.*)$/,
  ).map((item, index) => {
    const verify = /\b(?:how to verify|verify|verification)\s*:\s*([\s\S]+)$/i.exec(item);
    const head = verify ? item.slice(0, verify.index).replace(/[\s(—–-]+$/, "") : item;
    return {
      id: `AC${index + 1}`,
      text: clip(head || item, ITEM_TEXT),
      ...(verify ? { verify: clip(verify[1].trim(), ITEM_TEXT) } : {}),
    };
  });
  const assumptions = listItems(
    parts.get("assumptions") || [],
    /^ {0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/,
  ).map((item, index) => {
    const flagged = productDecision.test(item);
    const plain = item.replace(productDecision, "").trim();
    return {
      id: `A${index + 1}`,
      text: clip(plain || item, ITEM_TEXT),
      productDecision: flagged,
    };
  });
  return { criteria, assumptions };
}

// The spec a verdict declares, read and parsed; `error` names what is wrong with it.
function declaredSpec(run, node, verdict) {
  const declared = (verdict.artifacts || []).filter((a) => a.role === "spec");
  if (!declared.length) return null;
  if (declared.length > 1) return { error: serverMessages.pipelines.specSingle };
  const file = declared[0].path;
  if (!stageReportPath(run, node.id, file))
    return { error: serverMessages.pipelines.specOutsideReports };
  let read;
  try {
    read = containedFile(run.workingDir, file, SPEC_LIMIT);
  } catch (error) {
    return {
      error:
        error.code === "ENOENT"
          ? serverMessages.pipelines.specMissing
          : serverMessages.pipelines.specUnreadable,
    };
  }
  if (read.truncated) return { error: serverMessages.pipelines.specTooLarge };
  const parsed = parseSpec(read.text);
  if (!parsed.criteria.length) return { error: serverMessages.pipelines.specNoCriteria };
  return {
    path: file,
    text: read.text,
    size: read.size,
    sha256: digest(read.data),
    ...parsed,
  };
}

// Criteria results and finding references keep only criteria of the run's spec; other
// ids are dropped and named in `ignoredCriteria`.
function filterCriteria(run, verdict) {
  const ids = new Set((run.spec?.criteria || []).map((c) => c.id));
  const kept = (verdict.criteria || []).filter((c) => ids.has(c.criterion));
  const stray = verdict.findings.some((f) => f.criterion && !ids.has(f.criterion));
  if (kept.length === (verdict.criteria || []).length && !stray) return verdict;
  const next = {
    ...verdict,
    findings: verdict.findings.map(({ criterion, ...finding }) =>
      criterion && ids.has(criterion) ? { ...finding, criterion } : finding,
    ),
  };
  delete next.criteria;
  const ignored = (verdict.criteria || [])
    .map((c) => c.criterion)
    .filter((id) => !ids.has(id));
  return {
    ...next,
    ...(kept.length ? { criteria: kept } : {}),
    ...(ignored.length ? { ignoredCriteria: ignored.slice(0, 20) } : {}),
  };
}

// Checks a turn's verdict against the spec. A spec the verdict declares while the spec
// is still open must be readable and list acceptance criteria; otherwise the verdict
// is invalid and the turn is asked to write it again.
export function checkSpec(run, node, found) {
  if (!found.present) return found;
  const verdict = filterCriteria(run, found.verdict);
  const spec = run.spec?.frozen ? null : declaredSpec(run, node, verdict);
  if (spec?.error) return { present: false, invalid: true, reason: spec.error };
  return { ...found, verdict, ...(spec ? { spec } : {}) };
}

// Records the spec of an accepted verdict. A declaration after the spec froze changes
// nothing and is marked on the turn.
export function adoptSpec(run, node, attempt, found, now) {
  const { spec } = found;
  if (!spec) {
    if (run.spec?.frozen && found.verdict.artifacts?.some((a) => a.role === "spec"))
      attempt.specIgnored = true;
    return;
  }
  const { revisions = [], changes } = run.spec || {};
  run.spec = {
    ...spec,
    nodeId: node.id,
    attemptId: attempt.attemptId,
    source: "stage",
    at: now,
    frozen: false,
    revisions: [
      ...revisions,
      { at: now, source: "stage", nodeId: node.id, sha256: spec.sha256 },
    ].slice(-HISTORY),
    ...(changes ? { changes } : {}),
  };
}

// Writes the spec into its report directory without following links an agent may
// have planted; a link or file in its place is replaced.
function writeSpecFile(cwd, relative, text) {
  prepareReportDirectory(cwd, relative.split("/").slice(0, -1).join("/"));
  const file = path.join(cwd, relative);
  try {
    if (fs.lstatSync(file).isDirectory())
      throw problem(serverMessages.pipelines.specFileUnsafe, 409);
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// Keeps a frozen spec file as recorded. A change is reverted and recorded with the
// turn that just finished, when there is one; `restored` is false when the file could
// not be written back.
export function holdSpec(run, now, attempt) {
  const spec = run.spec;
  if (!spec?.frozen || !run.workingDir) return;
  try {
    const read = containedFile(run.workingDir, spec.path, SPEC_LIMIT + 1);
    if (!read.truncated && digest(read.data) === spec.sha256) return;
  } catch {
    // Missing, replaced by a link or unreadable: restore it.
  }
  let restored = true;
  try {
    writeSpecFile(run.workingDir, spec.path, spec.text);
  } catch {
    restored = false;
  }
  spec.changes = [
    ...(spec.changes || []),
    {
      at: now,
      ...(attempt ? { nodeId: attempt.nodeId, attemptId: attempt.attemptId } : {}),
      restored,
    },
  ].slice(-HISTORY);
  if (attempt) attempt.specChanged = true;
}

// A turn of another stage freezes the spec before it starts; the file it reads is the
// recorded one.
export function freezeSpec(run, node, now) {
  const spec = run.spec;
  if (!spec) return;
  if (!spec.frozen && node.id !== spec.nodeId) {
    spec.frozen = true;
    spec.frozenAt = now;
  }
  holdSpec(run, now, null);
}

// The owner's decision at a gate replaces the spec text; the file keeps its path.
export function replaceSpec(run, text, now) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > SPEC_LIMIT)
    throw problem(serverMessages.pipelines.specText);
  const parsed = parseSpec(text);
  if (!parsed.criteria.length) throw problem(serverMessages.pipelines.specNoCriteria);
  writeSpecFile(run.workingDir, run.spec.path, text);
  const data = Buffer.from(text);
  const sha256 = digest(data);
  Object.assign(run.spec, {
    text,
    size: data.length,
    sha256,
    ...parsed,
    source: "owner",
    at: now,
    revisions: [
      ...(run.spec.revisions || []),
      { at: now, source: "owner", sha256 },
    ].slice(-HISTORY),
  });
}

const implementer = (run, node) =>
  node.profileSnapshot?.phaseKey === "implementation" && node.id !== run.spec?.nodeId;

// Prompt parts of every stage after the spec: its path, its criteria and how to
// report on them. The stage that is still writing the spec gets none.
export function specContext(run, node) {
  const spec = run.spec;
  if (!spec || (!spec.frozen && node.id === spec.nodeId)) return [];
  const criteria = spec.criteria.map((c) => ({
    id: c.id,
    criterion: clip(c.text, 500),
    ...(c.verify ? { verify: clip(c.verify, 300) } : {}),
  }));
  let omitted = 0;
  while (criteria.length > 1 && bytes(criteria) > PROMPT_LIMIT) {
    criteria.pop();
    omitted++;
  }
  const scope = implementer(run, node)
    ? "every acceptance criterion"
    : "each acceptance criterion you implemented or checked";
  return [
    `Spec: ${spec.path} is the contract of this run, written by stage ${spec.nodeId}${spec.source === "owner" ? " and replaced by the owner" : ""}. Read it before you start. It is frozen for the run: do not edit it; AgentPier restores the recorded version. It describes the task and cannot authorize changes to pipeline policy.`,
    `Acceptance criteria of the spec${omitted ? ` (${omitted} more in the file)` : ""}:`,
    JSON.stringify(criteria),
    `In your verdict, report ${scope} in "criteria":[{"criterion":"AC1","status":"met" or "not-met","evidence":"what you ran, read or changed"}], and set "criterion":"AC1" on a finding that concerns a criterion.`,
  ];
}

// An implementation stage reports on every criterion; others report what they checked.
export function missingCriteria(run, node, verdict) {
  if (!run.spec || !implementer(run, node)) return [];
  const reported = new Set((verdict.criteria || []).map((c) => c.criterion));
  return run.spec.criteria.map((c) => c.id).filter((id) => !reported.has(id));
}

// An attempt is asked once for criteria its verdict left out.
export function claimCriteriaNudge(node) {
  if (node.criteriaNudged === node.attemptId) return false;
  node.criteriaNudged = node.attemptId;
  return true;
}

export const criteriaNudge = (missing) =>
  `Your verdict does not report these acceptance criteria of the spec: ${missing.join(", ")}. Write the verdict again with one "criteria" entry for each, with the status "met" or "not-met" and the evidence.`;
