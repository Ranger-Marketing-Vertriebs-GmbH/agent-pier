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
// flags neither write a file (`w`) nor run the pattern space (`e`).
const printScript =
  /^\s*(?:(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)(?:\s*,\s*(?:\d+|\$|\+\d+|\/(?:[^/\\]|\\.)*\/))?\s*!?\s*[pdq=]?\s*;?\s*)+$/;
const substitution = /^s\/(?:[^/\\]|\\.)*\/(?:[^/\\]|\\.)*\/[gpI0-9]*$/;
const safeScript = (script) => printScript.test(script) || substitution.test(script);

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
