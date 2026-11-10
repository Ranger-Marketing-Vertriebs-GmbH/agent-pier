import { unquotedMarks } from "./shell-command.js";
import { braceWords, judge } from "./shell-expansion.js";
import { gitPositionals, readOnlyGitArguments } from "./git-read-options.js";
import { readOnlyRg } from "./rg-read-options.js";
import {
  folderAt,
  folderIn,
  inProject,
  movedTo,
  ownRepository,
  startPlace,
} from "./approval-place.js";
import { touchesSecret } from "./secret-names.js";

export { touchesSecret };

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
 *
 * Three rules hold for the whole list. Git options come from a list per
 * subcommand, never from a list of dangerous ones (git-read-options.js). `git`,
 * `npm` and `cd` stay inside the session's project (approval-place.js). A word
 * the shell expands (`*`, `{a,b}`, `~`) must not be able to reach a secret
 * (shell-expansion.js).
 */
export const DEFAULT_ALLOWED = Object.freeze({
  // Claude Code tools by name.
  claudeTools: Object.freeze(["EnterWorktree", "ExitWorktree"]),
  // Read-only git subcommands with the options of git-read-options.js, in the
  // project only. `git branch` only lists (no names, no -d/-m/-c); `git fetch`
  // names a remote, never a path or URL.
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
  // that write files or run commands, `rg` with the options of rg-read-options.js.
  readers: Object.freeze(["grep", "rg", "sed", "cat", "head", "tail", "ls", "wc"]),
  // The readers that show names and sizes only: a pattern may match any file.
  listers: Object.freeze(["ls", "wc"]),
  // `cd <dir>` into a folder of the project; in a chain every other part must
  // qualify too.
  navigation: Object.freeze(["cd"]),
  // `npm test`, `npm run test*`, `npm run lint` and `npm run check` in the
  // project, without npm options that choose another folder, shell or configuration.
  npmScripts: Object.freeze([/^test/, /^lint$/, /^check$/]),
});

/**
 * Whether `git [-C <dir>]… <subcommand> <arguments>` only reads, in a repository
 * of the project.
 * Only `-C <dir>` may precede the subcommand; `-c` and other options do not.
 */
function readOnlyGit(words, literal, place) {
  let at = place,
    i = 1;
  for (; words[i] === "-C" && words[i + 1] !== undefined; i += 2) {
    if (!literal(i + 1)) return false;
    at = movedTo(at, words[i + 1]);
  }
  if (!inProject(at) || !ownRepository(at)) return false;
  const sub = words[i],
    args = words.slice(i + 1);
  if (!DEFAULT_ALLOWED.gitSubcommands.includes(sub)) return false;
  if (!readOnlyGitArguments(sub, args)) return false;
  // A remote's name that is also a folder here is read as a path by git.
  const [remote] = sub === "fetch" ? gitPositionals(sub, args) : [];
  return remote === undefined || !folderAt(at, remote);
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

// npm options that change nothing about what runs or where.
const npmQuiet = new Set(["--silent", "-s", "--quiet", "-q", "--if-present"]);

/**
 * `npm test` or `npm run <script>` for a listed script. npm reads its options
 * anywhere before `--`, and `--prefix`, `-C`, `--workspace`, `--script-shell` or
 * `--userconfig` choose another folder, shell or configuration, so only the quiet
 * ones pass; what follows `--` goes to the script.
 */
function npmCheck(words) {
  const [, sub, ...rest] = words;
  if (sub === "run" || sub === "run-script") {
    const script = rest.shift() ?? "";
    if (!DEFAULT_ALLOWED.npmScripts.some((pattern) => pattern.test(script))) return false;
  } else if (sub !== "test" && sub !== "t") return false;
  for (const word of rest) {
    if (word === "--") break;
    if (word.startsWith("-") && !npmQuiet.has(word)) return false;
  }
  return true;
}

/**
 * The words the shell passes for a command's written words, braces expanded, with
 * what the shell still does to each (`judge`); null when that cannot be said.
 */
function passedWords(written) {
  const marks = unquotedMarks(written);
  const words = [],
    verdicts = [];
  for (let i = 0; i < written.length; i++) {
    const results = braceWords(written[i], marks[i]);
    if (!results) return null;
    for (const result of results) {
      words.push(result.word);
      verdicts.push(judge(result.word, result.marks));
    }
  }
  return { words, verdicts };
}

// `git show <rev>:<path>` prints the file: the path after a colon counts as a word.
// A backslash that stays in a word (`"\.env"`) hides no name either.
const namesSecret = (given) => namesSecretAsWritten(given.map(unescaped));
const unescaped = (word) => word.replaceAll("\\", "");
const namesSecretAsWritten = (words) =>
  touchesSecret(words) ||
  (words[0] === "git" &&
    touchesSecret(
      words.flatMap((word) => (word.includes(":") ? word.split(":").slice(1) : [])),
    ));

/**
 * Whether a command names a secret: as written, after brace expansion
 * (`.s{s,}h`), or by a pattern for a dot name or one that writes out part of a key
 * or credentials name (`.e*`, `id_*`, `*.k*`). A remembered program does not cover
 * such a command; it is remembered only exactly. A pattern that merely could match
 * such a file (`dist/*`, `*.json`) stays covered by the remembered program, though
 * the default list asks for it.
 */
export function secretCommand(written) {
  if (namesSecret(written)) return true;
  const passed = passedWords(written);
  return (
    !passed || namesSecret(passed.words) || passed.verdicts.some((word) => word.aimed)
  );
}

const control = /[\x00-\x1f\x7f]/;

// Programs that read options among their arguments: a pattern that starts with a
// wildcard could put a file's name where an option is read.
const optionReaders = new Set(["git", "npm", "rg", "sed"]);
const hidesOption = (words, verdicts) => {
  const end = words.indexOf("--");
  return verdicts.some((word, i) => word.leading && (end < 0 || i < end));
};

/**
 * Whether one simple command (its words) is on the default list when it runs at
 * `place` (approval-place.js; without one, a shell that stands in the project).
 * Every check reads the words the shell passes, braces expanded.
 */
export function defaultCommand(written, place) {
  const at = startPlace(place);
  const passed = passedWords(written);
  if (!passed || namesSecret(written)) return false;
  const { words, verdicts } = passed;
  // A line break or other control character inside a word is passed on as it is,
  // but nothing here reads such a word reliably.
  if (words.some((word) => control.test(word))) return false;
  const [program] = words;
  if (!program || program.includes("/") || !verdicts[0].literal) return false;
  if (namesSecret(words)) return false;
  // `ls` and `wc` print names and sizes, never what a file holds.
  const lists = DEFAULT_ALLOWED.listers.includes(program);
  if (verdicts.some((word) => word.asks || (word.pattern && !lists))) return false;
  if (optionReaders.has(program) && hidesOption(words, verdicts)) return false;
  const literal = (i) => verdicts[i].literal;
  if (DEFAULT_ALLOWED.navigation.includes(program))
    return (
      words.length === 2 &&
      literal(1) &&
      // `-`, `-N` and `+N` name folders the shell remembers.
      !/^[-+]/.test(words[1]) &&
      folderIn(at, words[1]) !== null
    );
  if (program === "git") return readOnlyGit(words, literal, at);
  if (program === "npm") return inProject(at) && npmCheck(words);
  if (!DEFAULT_ALLOWED.readers.includes(program)) return false;
  if (program === "sed") return readOnlySed(words);
  if (program === "rg") return readOnlyRg(words);
  return true;
}

// Shell builtins that change the folder or run text as commands. The default list
// covers none of them; after one that a remembered approval covers, where the next
// part runs is unknown.
const moving = new Set([
  "pushd",
  "popd",
  "chdir",
  "builtin",
  "command",
  "eval",
  "source",
  ".",
  "exec",
]);
// A longer chain is not followed: its `cd`, `git` and `npm` parts ask.
const maxChain = 20;

/**
 * For each simple command of a chain, whether the default list covers it. The place
 * follows the chain: after `cd sub` the next part runs in `sub`, and after a `cd`
 * that leaves the project, or one the classifier cannot follow, `git` and `npm` ask.
 */
export function defaultSegments(segments, place) {
  let at = startPlace(place);
  if (segments.length > maxChain) at = { ...at, strayed: true };
  return segments.map((written) => {
    const covered = defaultCommand(written, at);
    const passed = passedWords(written);
    const program = passed?.words[0];
    if (!passed) at = { ...at, strayed: true };
    else if (DEFAULT_ALLOWED.navigation.includes(program))
      at =
        passed.words.length === 2 &&
        passed.verdicts[1].literal &&
        !/^[-+]/.test(passed.words[1])
          ? movedTo(at, passed.words[1])
          : { ...at, strayed: true };
    else if (moving.has(program)) at = { ...at, strayed: true };
    return covered;
  });
}
