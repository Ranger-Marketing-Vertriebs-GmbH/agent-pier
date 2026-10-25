import fs from "node:fs";

// Set at launch to the session's secrets file, never to a value (session-secrets.js).
export const SECRETS_FILE_ENV = "AGENTPIER_SECRETS_FILE";

// Single-quoted for sh like the file's values (secret-format.js).
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function secretsReminder(file) {
  return `AgentPier secrets for this session are in ${file}. When a task needs them, load them in the same shell command with \`set -a; . ${quote(file)}; set +a\`. Never print, log, commit or paste their values.`;
}

/**
 * The reminder with a leading space when `file` names an existing file at the time
 * the start hook runs, otherwise "". Kept dependency-light for the hook process.
 */
export function secretsHint(file = process.env[SECRETS_FILE_ENV]) {
  if (typeof file !== "string" || !file) return "";
  try {
    if (!fs.statSync(file).isFile()) return "";
  } catch {
    return "";
  }
  return ` ${secretsReminder(file)}`;
}
