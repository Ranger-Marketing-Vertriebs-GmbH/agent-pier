// Best-effort redaction of secrets a command line shows openly, before AgentPier
// stores it (agent SSH rows, chat notes, the Work tab, Telegram approval texts). Only
// the value goes; the flag, header or variable name stays so the command remains
// readable. Patterns that need context (a bare `-p` is a port for ssh, a parent flag
// for mkdir) only apply to the tools that use them for passwords, within 300
// characters of the tool's name. Shell references ($PW, ${PW}, $(cat f)) are no
// secrets and stay. Applying it twice changes nothing. Every rule runs in linear
// time: commands come from agents and are redacted on each chat read of old rows.
// Known limits (docs/assistant-gateway.md#agent-ssh-access-2026-10-16): secrets fed
// through stdin (`echo pw | sudo -S`), here-documents such as a .netrc, positional
// arguments and any other form these rules do not name stay as they are.
export const redactedMark = "•••";

// A shell word: double-quoted (with escapes), single-quoted, a command substitution
// or plain characters up to a space, quote or separator, in any sequence.
const word = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\$\([^()\n$]*\)|[^\s'";&|])+`;
const reference = /^(["']?)\$(?:\{?\w+\}?|\([^()]*\))\1$/u;
// The quotes of a value that is one quoted string stay; a reference stays whole.
function hide(secret) {
  if (reference.test(secret)) return secret;
  return /^"(?:[^"\\]|\\.)*"$|^'[^']*'$/u.test(secret)
    ? `${secret[0]}${redactedMark}${secret[0]}`
    : redactedMark;
}
// A flag after a tool's name on the same command, e.g. `mysql … -p`.
const after = (tools, flag) => String.raw`(\b(?:${tools})\b[^\n;&|]{0,300}?[ \t]${flag})`;

const rules = [
  // --password=x, --token x, --client-secret 'x' …
  [
    String.raw`((?<![\w-])--(?:password|passwd|pass|token|api-?key|secret|client-secret|access-token|auth-token)(?:=|[ \t]+))(${word})`,
    "giu",
  ],
  // mysql -pX (attached only: a bare -p prompts), sshpass -p X, redis-cli -a X,
  // docker login -p X.
  [
    String.raw`${after("mysql|mysqldump|mysqladmin|mariadb|mariadb-dump", "-p")}(${word})`,
    "gu",
  ],
  [String.raw`${after("sshpass", "-p[ \\t]*")}(${word})`, "gu"],
  [String.raw`${after("redis-cli", "-a[ \\t]+")}(${word})`, "gu"],
  [String.raw`${after("docker[ \\t]+login", "-p[ \\t]*")}(${word})`, "gu"],
  // curl -u user:pass / --user=user:pass, smbclient -U user%pass.
  [
    String.raw`${after("curl", "(?:-u|--user)(?:[ \\t]*|=)[\"']?[^\\s:'\"]+:")}([^\s'"]+)`,
    "gu",
  ],
  [
    String.raw`${after("smbclient", "(?:-U|--user)(?:[ \\t]*|=)[\"']?[^\\s%'\"]+%")}([^\s'"]+)`,
    "gu",
  ],
  // openssl … -pass pass:X, -passin pass:X, -passout pass:X.
  [String.raw`((?<![\w-])-pass(?:in|out)?[ \t]+["']?pass:)([^\s'"]+)`, "gu"],
  // Authorization: Bearer X, Proxy-Authorization: Basic X.
  [
    String.raw`((?:proxy-)?authorization[ \t]*:[ \t]*(?:[a-z][\w-]*[ \t]+)?)([^\s'"\\]+)`,
    "giu",
  ],
  // X-Api-Key: X, X-Auth-Token: X, Private-Token: X.
  [
    String.raw`((?:x-api-key|x-auth-token|x-access-token|api-key|private-token)[ \t]*:[ \t]*)([^\s'"\\]+)`,
    "giu",
  ],
  // JSON: "password": "X", "Authorization": "Bearer X", also with escaped quotes.
  [
    String.raw`(\\?"(?:authorization|password|passwd|secret|token|api_?key|apikey|access_token|client_secret|private_key)\\?"[ \t]*:[ \t]*\\?"(?:(?:bearer|basic|token)[ \t]+)?)([^"\\\n]+)`,
    "giu",
  ],
  // scheme://user:password@host; the password runs to the last @ before the host.
  [
    String.raw`((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:)([^\s/'"]+)(?=@)`,
    "giu",
  ],
  // DB_PASSWORD=x, GITHUB_TOKEN='x', MYSQL_PWD=x (the name ends in the word).
  [
    String.raw`((?<![\w-])[A-Za-z0-9_]*?(?:PASSWORD|PASSWD|SECRET|SECRET_KEY|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|MYSQL_PWD)=)(${word})`,
    "giu",
  ],
].map(([source, flags]) => new RegExp(source, flags));
// A PEM private key: the markers stay, the body goes (also when it is cut short).
const pem =
  /(-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----)[^-]*(-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/gu;
// Whole tokens: JWTs and well-known key prefixes.
const tokens =
  /(?<![\w-])(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?![\w-])/gu;

/** The command with recognisable secret values replaced by •••. */
export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text.replace(pem, (_, begin, end) =>
    `${begin}\n${redactedMark}\n${end}`.trimEnd(),
  );
  for (const rule of rules)
    out = out.replace(rule, (_, name, secret) => name + hide(secret));
  return out.replace(tokens, redactedMark);
}
