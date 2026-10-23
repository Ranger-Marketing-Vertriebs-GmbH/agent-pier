import { sftpLimits } from "../sftp/sftp-limits.js";
import { assistantProblem } from "./assistant-validation.js";

// The SFTP actions of `agentpier_ssh` (team-plugin/ssh-tool.js) and their parameters
// within the limits of the coding sessions' sftp_* tools (sftp-tool-schemas.js).
const transfer = ["exclude", "defaultExcludes", "dryRun", "projectId"];
const fields = {
  list: { required: ["accessId"], optional: ["remotePath"] },
  stat: { required: ["accessId", "remotePath"], optional: [] },
  download: {
    required: ["accessId", "remotePath"],
    optional: ["localPath", ...transfer],
  },
  upload: { required: ["accessId", "localPath", "remotePath"], optional: transfer },
  sync: {
    required: ["accessId", "direction", "remotePath"],
    optional: ["localPath", "deleteExtra", "checksum", ...transfer],
  },
  mkdir: { required: ["accessId", "remotePath"], optional: ["parents"] },
  rename: { required: ["accessId", "remotePath", "toPath"], optional: [] },
  delete: { required: ["accessId", "remotePath"], optional: ["recursive"] },
  job: { required: ["jobId"], optional: [] },
  cancel: { required: ["jobId"], optional: [] },
};
export const sftpActions = new Set(Object.keys(fields));

const id = (value) =>
  typeof value === "string" && value.length >= 1 && value.length <= 100;
const text = (value) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= sftpLimits.pathChars &&
  !value.includes("\0");
const checks = {
  accessId: id,
  jobId: id,
  projectId: id,
  remotePath: text,
  toPath: text,
  localPath: text,
  direction: (value) => value === "up" || value === "down",
  exclude: (value) =>
    Array.isArray(value) &&
    value.length <= sftpLimits.excludes &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length >= 1 &&
        item.length <= sftpLimits.excludeChars &&
        !item.includes("\0"),
    ),
};
const defaults = {
  list: { remotePath: "." },
  download: { exclude: [], defaultExcludes: true, dryRun: false },
  upload: { exclude: [], defaultExcludes: true, dryRun: false },
  sync: {
    exclude: [],
    defaultExcludes: true,
    dryRun: false,
    deleteExtra: false,
    checksum: false,
  },
  mkdir: { parents: false },
  delete: { recursive: false },
};

/** One SFTP action's parameters with their defaults, or a 400 `invalid`. */
export function sftpInput(input) {
  const invalid = () => assistantProblem("invalid");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const spec = Object.hasOwn(fields, input.action) ? fields[input.action] : null;
  if (!spec) throw invalid();
  const allowed = new Set(["action", ...spec.required, ...spec.optional]);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw invalid();
    if (key === "action") continue;
    const valid = checks[key] ?? ((v) => typeof v === "boolean");
    if (!valid(value)) throw invalid();
  }
  if (spec.required.some((key) => input[key] === undefined)) throw invalid();
  const normalized = { ...defaults[input.action], ...input };
  // A sync that deletes local files names its folder; never the whole local root.
  if (
    normalized.action === "sync" &&
    normalized.direction === "down" &&
    normalized.deleteExtra &&
    normalized.localPath === undefined
  )
    throw invalid();
  return normalized;
}
