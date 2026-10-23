import { sshProblem } from "../ssh/ssh-errors.js";
import { sftpLimits } from "./sftp-limits.js";

// MCP definitions of the coding sessions' `sftp_*` tools and their argument check.
const id = { type: "string", minLength: 1, maxLength: 100 };
const remote = { type: "string", minLength: 1, maxLength: sftpLimits.pathChars };
const local = { type: "string", minLength: 1, maxLength: sftpLimits.pathChars };
const exclude = {
  type: "array",
  maxItems: sftpLimits.excludes,
  items: { type: "string", minLength: 1, maxLength: sftpLimits.excludeChars },
  description: "Extra exclude patterns (gitignore-like wildcards).",
};
const flag = (description) => ({ type: "boolean", description });
const transfer = {
  exclude,
  defaultExcludes: flag("Exclude .git, .env and .env.* (default true)."),
  dryRun: flag("Only plan: report what would change and change nothing."),
};
const tool = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});
const paths =
  "Remote paths are absolute or relative to the host's allowed folder (else its home folder); local paths are relative to the session's launch folder and stay inside it.";

export const sftpTools = [
  tool(
    "sftp_list",
    `List a remote folder on an assigned SFTP host (ssh_list_hosts type "sftp"). ${paths}`,
    { accessId: id, remotePath: remote },
    ["accessId"],
  ),
  tool(
    "sftp_stat",
    "Report one remote entry (a link is reported as a link).",
    { accessId: id, remotePath: remote },
    ["accessId", "remotePath"],
  ),
  tool(
    "sftp_download",
    `Download a remote file or folder (recursive) into the session's launch folder. localPath defaults to the remote name. ${paths}`,
    { accessId: id, remotePath: remote, localPath: local, ...transfer },
    ["accessId", "remotePath"],
  ),
  tool(
    "sftp_upload",
    `Upload a local file or folder (recursive), creating folders and overwriting files. Changes remote state; follow the user's authorization. ${paths}`,
    { accessId: id, localPath: local, remotePath: remote, ...transfer },
    ["accessId", "localPath", "remotePath"],
  ),
  tool(
    "sftp_sync",
    "Copy only new and changed files (size and mtime, or checksum) up to the server or down into the launch folder. deleteExtra deletes target files missing from the source. Use dryRun first.",
    {
      accessId: id,
      direction: { type: "string", enum: ["up", "down"] },
      localPath: local,
      remotePath: remote,
      deleteExtra: flag("Delete target files missing from the source (default false)."),
      checksum: flag("Compare same-size files by SHA-256 instead of mtime."),
      ...transfer,
    },
    ["accessId", "direction", "remotePath"],
  ),
  tool(
    "sftp_mkdir",
    "Create a remote folder; parents also creates missing ancestors.",
    { accessId: id, remotePath: remote, parents: flag("Create missing parents.") },
    ["accessId", "remotePath"],
  ),
  tool(
    "sftp_rename",
    "Rename or move a remote entry; never replaces an existing toPath.",
    { accessId: id, remotePath: remote, toPath: remote },
    ["accessId", "remotePath", "toPath"],
  ),
  tool(
    "sftp_delete",
    "Delete a remote file, link or empty folder; recursive deletes a whole folder. Never the allowed folder itself.",
    { accessId: id, remotePath: remote, recursive: flag("Delete a folder's contents.") },
    ["accessId", "remotePath"],
  ),
  tool(
    "sftp_job",
    "Report a running SFTP job's progress and result; cancel stops it.",
    { jobId: id, cancel: flag("Stop the job.") },
    ["jobId"],
  ),
];

const byName = new Map(sftpTools.map((item) => [item.name, item.inputSchema]));
const invalid = () => sshProblem("SSH_INVALID_ARGUMENT", "Invalid SFTP arguments.");

function valid(schema, value) {
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "string")
    return (
      typeof value === "string" &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Infinity) &&
      (!schema.enum || schema.enum.includes(value))
    );
  return (
    Array.isArray(value) &&
    value.length <= schema.maxItems &&
    value.every((item) => valid(schema.items, item))
  );
}

/** The tool's arguments checked against its schema; `SSH_INVALID_ARGUMENT` else. */
export function sftpArguments(name, input) {
  const schema = byName.get(name);
  if (!schema) throw sshProblem("SSH_INVALID_ARGUMENT", "Unknown SFTP tool.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  for (const [key, value] of Object.entries(input))
    if (!Object.hasOwn(schema.properties, key) || !valid(schema.properties[key], value))
      throw invalid();
  if (schema.required.some((key) => input[key] === undefined)) throw invalid();
  return input;
}
