import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { problem } from "../../lib/storage.js";
export function containedFile(root, relative, max = 65536) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.length > 1024 ||
    /[\x00-\x1f\x7f\\]/.test(relative) ||
    path.isAbsolute(relative) ||
    relative.split("/").some((s) => !s || s === "." || s === "..")
  )
    throw problem(serverMessages.pipelines.invalidArtifactPath);
  const base = fs.realpathSync(root);
  let file = base;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink())
      throw problem(serverMessages.pipelines.artifactSymlinksForbidden, 403);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1)
      throw problem(serverMessages.pipelines.artifactNotRegularFile, 403);
    const size = Math.min(st.size, max);
    const buffer = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buffer, 0, size, 0);
    const data = buffer.subarray(0, bytes);
    return {
      data,
      text: data.toString("utf8"),
      size: st.size,
      mtimeMs: st.mtimeMs,
      truncated: st.size > max,
    };
  } finally {
    fs.closeSync(fd);
  }
}
export function parseVerdict(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw problem(serverMessages.pipelines.verdictNotJson);
  }
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw problem(serverMessages.pipelines.verdictNotObject);
  const aliases = Object.assign(Object.create(null), {
    pass: "pass",
    passed: "pass",
    success: "pass",
    successful: "pass",
    fail: "fail",
    failed: "fail",
    failure: "fail",
    unsuccessful: "fail",
  });
  const result =
    typeof value.result === "string" ? aliases[value.result.trim().toLowerCase()] : null;
  if (!result || typeof value.summary !== "string" || !value.summary.trim())
    throw problem(serverMessages.pipelines.verdictResultAndSummary);
  let requiresHuman = value.requiresHuman;
  if (requiresHuman === "true") requiresHuman = true;
  if (requiresHuman === "false") requiresHuman = false;
  if (requiresHuman != null && typeof requiresHuman !== "boolean")
    throw problem(serverMessages.pipelines.verdictRequiresHumanBoolean);
  if (value.findings != null && !Array.isArray(value.findings))
    throw problem(serverMessages.pipelines.verdictFindingsArray);
  const findings = (value.findings || []).map((f) => {
    if (typeof f === "string") f = { title: f };
    if (!f || typeof f !== "object")
      throw problem(serverMessages.pipelines.verdictFindingTitle);
    const title = [f.title, f.summary, f.description, f.name, f.message, f.detail].find(
      (s) => typeof s === "string" && s.trim(),
    );
    if (!title) throw problem(serverMessages.pipelines.verdictFindingTitle);
    const criterion = criterionId(f.criterion);
    return {
      title: title.slice(0, 2000),
      severity: ["low", "medium", "high"].includes(f.severity) ? f.severity : "medium",
      ...(typeof f.detail === "string" ? { detail: f.detail.slice(0, 8000) } : {}),
      ...(criterion ? { criterion } : {}),
    };
  });
  const responses = parseResponses(value.responses);
  const criteria = parseCriteria(value.criteria);
  const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : [])
    .flatMap((a) => {
      if (typeof a === "string") a = { path: a };
      if (!relativePath(a?.path)) return [];
      return [
        {
          path: a.path,
          ...(typeof a.label === "string" &&
          a.label.length <= 120 &&
          !/[\x00-\x1f\x7f]/.test(a.label)
            ? { label: a.label }
            : {}),
          // Only roles the engine knows are kept; "spec" marks the run's contract.
          ...(typeof a.role === "string" && artifactRoles.has(a.role.trim().toLowerCase())
            ? { role: a.role.trim().toLowerCase() }
            : {}),
        },
      ];
    })
    .slice(0, 20);
  // A stage that asks the owner names the question and the files to look at.
  const question =
    typeof value.question === "string" && value.question.trim()
      ? value.question.trim().slice(0, 2000)
      : "";
  const files = (Array.isArray(value.files) ? value.files : [])
    .filter((file) => relativePath(file))
    .slice(0, 50);
  return {
    result,
    summary: value.summary,
    findings,
    artifacts,
    ...(requiresHuman != null ? { requiresHuman } : {}),
    ...(question ? { question } : {}),
    ...(files.length ? { files: [...new Set(files)] } : {}),
    ...(responses.length ? { responses } : {}),
    ...(criteria.length ? { criteria } : {}),
  };
}
const artifactRoles = new Set(["spec"]);
// A repository-relative path a verdict may name.
const relativePath = (file) =>
  typeof file === "string" &&
  file.length > 0 &&
  file.length <= 512 &&
  !/^[\/]|[\x00-\x1f\x7f\\]/.test(file) &&
  !file.split("/").some((p) => !p || p === "." || p === "..");
// Acceptance criteria ids as the spec numbers them (AC1); "ac-1", "#AC 1", a bare
// number and the integer 1 are the same criterion. Anything else is no criterion.
export function criterionId(value) {
  if (Number.isInteger(value)) value = String(value);
  if (typeof value !== "string") return "";
  const match = /^#?\s*(?:ac)?[\s\-\u2010-\u2015\u2212]*0*([1-9]\d{0,2})$/i.exec(
    value.trim(),
  );
  return match ? `AC${match[1]}` : "";
}
const criterionStatuses = Object.assign(Object.create(null), {
  met: "met",
  "not-met": "not-met",
  "not met": "not-met",
  not_met: "not-met",
  unmet: "not-met",
});
// Per-criterion results: one entry per acceptance criterion, each with evidence.
function parseCriteria(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw problem(serverMessages.pipelines.verdictCriteriaArray);
  const entries = new Map();
  for (const entry of value.slice(0, 200)) {
    const criterion = criterionId(entry?.criterion);
    if (!criterion) throw problem(serverMessages.pipelines.verdictCriterionId);
    const status =
      typeof entry.status === "string"
        ? criterionStatuses[entry.status.trim().toLowerCase()]
        : null;
    if (!status) throw problem(serverMessages.pipelines.verdictCriterionStatus);
    if (typeof entry.evidence !== "string" || !entry.evidence.trim())
      throw problem(serverMessages.pipelines.verdictCriterionEvidence);
    entries.delete(criterion);
    entries.set(criterion, {
      criterion,
      status,
      evidence: entry.evidence.slice(0, 2000),
    });
  }
  return [...entries.values()];
}
// A repair turn answers each finding of the round it repaired; other turns omit this.
const responseStatuses = Object.assign(Object.create(null), {
  fixed: "fixed",
  "not-fixed": "not-fixed",
  "not fixed": "not-fixed",
  not_fixed: "not-fixed",
  disputed: "disputed",
});
// Finding ids as the engine writes them (R2-1): case, a leading # and dash variants a
// model may produce do not matter.
export const findingId = (value) =>
  value
    .trim()
    .replace(/^#/, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toUpperCase();
function parseResponses(value) {
  if (value == null) return [];
  if (!Array.isArray(value))
    throw problem(serverMessages.pipelines.verdictResponsesArray);
  // A finding answered twice keeps its last answer.
  const answers = new Map();
  for (const r of value.slice(0, 200)) {
    const finding = typeof r?.finding === "string" ? findingId(r.finding) : "";
    if (!finding || finding.length > 100)
      throw problem(serverMessages.pipelines.verdictResponseFinding);
    const status =
      typeof r.status === "string"
        ? responseStatuses[r.status.trim().toLowerCase()]
        : null;
    if (!status) throw problem(serverMessages.pipelines.verdictResponseStatus);
    const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason : "";
    if (status !== "fixed" && !reason)
      throw problem(serverMessages.pipelines.verdictResponseReason);
    answers.delete(finding);
    answers.set(finding, {
      finding,
      status,
      ...(reason ? { reason: reason.slice(0, 2000) } : {}),
    });
  }
  return [...answers.values()];
}
export function readVerdict(run, attempt) {
  try {
    if (!attempt?.verdictPath) return { present: false };
    const file = containedFile(run.workingDir, attempt.verdictPath);
    if (file.truncated)
      return { invalid: true, reason: serverMessages.pipelines.verdictTooLarge };
    if (attempt && file.mtimeMs < Date.parse(attempt.startedAt))
      return { present: false };
    return { present: true, verdict: parseVerdict(file.text) };
  } catch (e) {
    if (e.code === "ENOENT") return { present: false };
    return {
      present: false,
      invalid: true,
      reason: e.status ? e.message : serverMessages.pipelines.verdictUnreadable,
    };
  }
}
export function clearVerdict(cwd, turnId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(turnId))
    throw problem(serverMessages.pipelines.invalidTurn);
  let directory = cwd;
  for (const part of [".pipeline", "turns", turnId]) {
    directory = path.join(directory, part);
    try {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw problem(serverMessages.pipelines.unsafeVerdictDirectory, 409);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(directory, { mode: 0o700 });
    }
  }
}
