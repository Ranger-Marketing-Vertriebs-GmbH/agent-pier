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
    throw problem("Invalid artifact path.");
  const base = fs.realpathSync(root);
  let file = base;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw problem("Artifact symlinks are not allowed.", 403);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1)
      throw problem("Artifact is not a regular file.", 403);
    const size = Math.min(st.size, max);
    const buffer = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buffer, 0, size, 0);
    return {
      text: buffer.subarray(0, bytes).toString("utf8"),
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
    throw problem("Verdict is not valid JSON.");
  }
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw problem("Verdict must be an object.");
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
    throw problem("Verdict requires a pass/fail result and a summary.");
  let requiresHuman = value.requiresHuman;
  if (requiresHuman === "true") requiresHuman = true;
  if (requiresHuman === "false") requiresHuman = false;
  if (requiresHuman != null && typeof requiresHuman !== "boolean")
    throw problem("Verdict requiresHuman must be a boolean.");
  if (value.findings != null && !Array.isArray(value.findings))
    throw problem("Verdict findings must be an array.");
  const findings = (value.findings || []).map((f) => {
    if (typeof f === "string") f = { title: f };
    if (!f || typeof f !== "object") throw problem("Verdict finding needs a title.");
    const title = [f.title, f.summary, f.description, f.name, f.message, f.detail].find(
      (s) => typeof s === "string" && s.trim(),
    );
    if (!title) throw problem("Verdict finding needs a title.");
    return {
      title: title.slice(0, 2000),
      severity: ["low", "medium", "high"].includes(f.severity) ? f.severity : "medium",
      ...(typeof f.detail === "string" ? { detail: f.detail.slice(0, 8000) } : {}),
    };
  });
  const artifacts = (Array.isArray(value.artifacts) ? value.artifacts : [])
    .flatMap((a) => {
      if (typeof a === "string") a = { path: a };
      if (
        !a ||
        typeof a.path !== "string" ||
        a.path.length > 512 ||
        !a.path ||
        /^[\/]|[\x00-\x1f\x7f\\]/.test(a.path) ||
        a.path.split("/").some((p) => !p || p === "." || p === "..")
      )
        return [];
      return [
        {
          path: a.path,
          ...(typeof a.label === "string" &&
          a.label.length <= 120 &&
          !/[\x00-\x1f\x7f]/.test(a.label)
            ? { label: a.label }
            : {}),
        },
      ];
    })
    .slice(0, 20);
  return {
    result,
    summary: value.summary,
    findings,
    artifacts,
    ...(requiresHuman != null ? { requiresHuman } : {}),
  };
}
export function readVerdict(run, attempt) {
  try {
    if (!attempt?.verdictPath) return { present: false };
    const file = containedFile(run.workingDir, attempt.verdictPath);
    if (file.truncated) return { invalid: true, reason: "Verdict exceeds 64 KiB." };
    if (attempt && file.mtimeMs < Date.parse(attempt.startedAt))
      return { present: false };
    return { present: true, verdict: parseVerdict(file.text) };
  } catch (e) {
    if (e.code === "ENOENT") return { present: false };
    return {
      present: false,
      invalid: true,
      reason: e.status ? e.message : "Verdict could not be read safely.",
    };
  }
}
export function clearVerdict(cwd, turnId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(turnId)) throw problem("Invalid pipeline turn.");
  let directory = cwd;
  for (const part of [".pipeline", "turns", turnId]) {
    directory = path.join(directory, part);
    try {
      const st = fs.lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw problem("Unsafe pipeline verdict directory.", 409);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(directory, { mode: 0o700 });
    }
  }
}
