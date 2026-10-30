import { gitWords } from "./shell-command.js";

/**
 * What coding CLIs may do without a card: AgentPier answers these permission
 * requests with "allow once" itself (audited as `allow-default`). Everything else
 * asks, including `rm`, ssh/scp/sftp, git push and other writing git commands,
 * package installs and any command that touches a secret or credentials file;
 * those can only be remembered for a session or project after the owner approved
 * one. A remembered program never covers a secret: such a command is remembered
 * only exactly as approved (request-approvals.js). A shell command qualifies only
 * when every simple command in it (`cd sub && git status`) is on this list or
 * covered by a remembered approval, and it has no substitution, variable, file
 * redirection, background job or subshell (shell-command.js).
 */
export const DEFAULT_ALLOWED = Object.freeze({
  // Claude Code tools by name.
  claudeTools: Object.freeze(["EnterWorktree", "ExitWorktree"]),
  // Read-only git subcommands. `git branch` only lists (no names, no -d/-m/-c).
  gitSubcommands: Object.freeze([
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "rev-parse",
    "fetch",
  ]),
  // Programs that only read files; `sed` only without in-place editing or scripts
  // that write files or run commands.
  readers: Object.freeze(["grep", "rg", "sed", "cat", "head", "tail", "ls", "wc"]),
  // `cd <dir>` alone; in a chain every other part must qualify too.
  navigation: Object.freeze(["cd"]),
  // `npm test`, `npm run test*`, `npm run lint` and `npm run check`.
  npmScripts: Object.freeze([/^test/, /^lint$/, /^check$/]),
});

// Paths and words that name secrets or credentials: any argument that matches
// keeps the command asking.
const secretWords =
  /(^|[/=\s])\.env(\.|$|\/)|\.ssh(\/|$)|id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks|kdbx)$|credential|\.netrc|\.npmrc|\.pypirc|\.aws(\/|$)|\.gnupg|\.kube(\/|$)|secret|token|passw|auth\.json|\.pgpass|keychain/i;

const branchListing = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "-l",
  "--all",
  "--remotes",
  "--list",
  "--verbose",
  "--show-current",
  "--no-color",
  "--color",
]);
// Git options that write files, run programs or reach other repositories' hooks.
const gitDangerous =
  /^(--output|--upload-pack|--receive-pack|--exec|--ext-diff|-o$|--config|-c$)/;

function readOnlyGit(words) {
  const rest = gitWords(words);
  const [sub, ...args] = rest;
  // Only `-C <dir>` may precede the subcommand (gitWords); `-c` and others do not.
  if (!DEFAULT_ALLOWED.gitSubcommands.includes(sub)) return false;
  if (args.some((arg) => gitDangerous.test(arg))) return false;
  if (sub === "branch") return args.every((arg) => branchListing.has(arg));
  return true;
}

// A sed script that only prints or deletes lines, or one plain substitution whose
// flags neither write a file (`w`) nor run the pattern space (`e`). The script comes
// from the CLI, so it is read by a scanner that looks at each character once; a
// regular expression with nested repetition could backtrack for exponential time.
const digit = (c) => c >= "0" && c <= "9";
const space = (c) => c === " " || c === "\t" || c === "\n";

/** The end of a `/…/` regex starting at `i` (escapes kept), or -1. */
function regexEnd(script, i) {
  if (script[i] !== "/") return -1;
  for (let j = i + 1; j < script.length; j++) {
    if (script[j] === "\\") j++;
    else if (script[j] === "/") return j + 1;
  }
  return -1;
}

/** The end of an address at `i`: a line number, `$` or `/regex/` (`+N` as the second). */
function addressEnd(script, i, second) {
  if (script[i] === "$") return i + 1;
  if (script[i] === "/") return regexEnd(script, i);
  let j = second && script[i] === "+" ? i + 1 : i;
  const from = j;
  while (j < script.length && digit(script[j])) j++;
  return j > from ? j : -1;
}

/** Commands of `address[,address][!][p|d|q|=]`, separated by `;` or nothing. */
export function printScript(script) {
  let i = 0;
  const skip = () => {
    while (i < script.length && space(script[i])) i++;
  };
  skip();
  if (i >= script.length) return false;
  while (i < script.length) {
    i = addressEnd(script, i, false);
    if (i < 0) return false;
    skip();
    if (script[i] === ",") {
      i++;
      skip();
      i = addressEnd(script, i, true);
      if (i < 0) return false;
      skip();
    }
    if (script[i] === "!") i++;
    skip();
    if ("pdq=".includes(script[i] ?? "x")) i++;
    skip();
    if (script[i] === ";") i++;
    skip();
  }
  return true;
}

/** `s/regex/replacement/flags` with flags from `gpI` and digits only. */
export function substitution(script) {
  if (script[0] !== "s") return false;
  const pattern = regexEnd(script, 1);
  if (pattern < 0) return false;
  const replacement = regexEnd(script, pattern - 1);
  if (replacement < 0) return false;
  for (let j = replacement; j < script.length; j++)
    if (!("gpI".includes(script[j]) || digit(script[j]))) return false;
  return true;
}
const safeScript = (script) => printScript(script) || substitution(script);

function readOnlySed(words) {
  const scripts = [];
  const files = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "-e" || word === "--expression") {
      if (words[i + 1] === undefined) return false;
      scripts.push(words[++i]);
    } else if (/^-[nEr]+$/.test(word) || ["--quiet", "--silent"].includes(word)) continue;
    else if (word.startsWith("-")) return false;
    else files.push(word);
  }
  if (!scripts.length) {
    if (!files.length) return false;
    scripts.push(files.shift());
  }
  return scripts.every(safeScript);
}

function npmCheck(words) {
  const [, sub, script] = words;
  if (sub === "test" || sub === "t") return true;
  if (sub !== "run" && sub !== "run-script") return false;
  return DEFAULT_ALLOWED.npmScripts.some((pattern) => pattern.test(script ?? ""));
}

/** Whether a command's words (or a tool's path) name a secret or credentials file. */
export const touchesSecret = (words) => words.some((word) => secretWords.test(word));

/** Whether one simple command (its words) is on the default list. */
export function defaultCommand(words) {
  const [program] = words;
  if (!program || program.includes("/")) return false;
  if (touchesSecret(words)) return false;
  if (DEFAULT_ALLOWED.navigation.includes(program)) return words.length <= 2;
  if (program === "git") return readOnlyGit(words);
  if (program === "npm") return npmCheck(words);
  if (!DEFAULT_ALLOWED.readers.includes(program)) return false;
  if (program === "sed") return readOnlySed(words);
  // ripgrep's preprocessor runs a program for every file.
  if (program === "rg") return !words.some((word) => word.startsWith("--pre"));
  return true;
}
