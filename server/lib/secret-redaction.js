// Best-effort redaction of secrets a command line shows openly, before AgentPier
// stores it (agent SSH rows, chat notes, the Work tab). Only the value goes; the flag,
// header or variable name stays so the command remains readable. Patterns that need
// context (a bare `-p` is a port for ssh, a parent flag for mkdir) only apply to the
// tools that use them for passwords. Applying it twice changes nothing.
export const redactedMark = "•••";

// A value: double- or single-quoted (the quotes stay), else up to a space, quote or
// shell separator.
const value = String.raw`"[^"\n]*"|'[^'\n]*'|[^\s'";&|]+`;
const keep = (match) =>
  /^["']/.test(match) ? `${match[0]}${redactedMark}${match[0]}` : redactedMark;

const rules = [
  // --password=x, --token x, --client-secret 'x' …
  new RegExp(
    String.raw`((?<![\w-])--(?:password|passwd|pass|token|api-?key|secret|client-secret|access-token|auth-token)(?:=|[ \t]+))(${value})`,
    "giu",
  ),
  // mysql -pX, mysqldump -pX (attached value only: a bare -p prompts).
  new RegExp(
    String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n;&|]*?[ \t]-p)(${value})`,
    "gu",
  ),
  // sshpass -p X / -pX.
  new RegExp(String.raw`(\bsshpass\b[^\n;&|]*?[ \t]-p[ \t]*)(${value})`, "gu"),
  // Authorization: Bearer X, Proxy-Authorization: Basic X.
  /((?:proxy-)?authorization[ \t]*:[ \t]*(?:[a-z][\w-]*[ \t]+)?)([^\s'"]+)/giu,
  // X-Api-Key: X, X-Auth-Token: X, Private-Token: X.
  /((?:x-api-key|x-auth-token|x-access-token|api-key|private-token)[ \t]*:[ \t]*)([^\s'"]+)/giu,
  // scheme://user:password@host
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:)([^\s/@'"]+)(?=@)/giu,
  // DB_PASSWORD=x, GITHUB_TOKEN='x', AWS_SECRET_ACCESS_KEY=x (name ends in the word).
  new RegExp(
    String.raw`((?<![\w-])[A-Za-z0-9_]*?(?:PASSWORD|PASSWD|SECRET|SECRET_KEY|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)=)(${value})`,
    "giu",
  ),
];
// Whole tokens: JWTs and well-known key prefixes.
const tokens =
  /(?<![\w-])(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?![\w-])/gu;

/** The command with recognisable secret values replaced by •••. */
export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const rule of rules)
    out = out.replace(rule, (_, name, secret) => name + keep(secret));
  return out.replace(tokens, redactedMark);
}
