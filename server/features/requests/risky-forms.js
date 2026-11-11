import { passedWords } from "./cli-approval-defaults.js";
import { abbreviates, placeOf } from "./search-reach.js";
import { gitWords } from "./shell-command.js";

// Forms of a command that a remembered program does not cover. A remembered
// approval names a program with its subcommand (`git branch`, `rm`) and covers its
// arguments. That holds for everyday use, not for the few forms that lose data,
// write outside the project or choose what git runs: those ask again, and their card
// remembers exactly that command, as for a command that names a secret
// (request-approvals.js).
//
// The list is short on purpose. It holds what cannot be taken back or reaches
// beyond the project; everything else a program does stays covered by its key,
// `npm run` with every script among it: the scripts are the repository's own.
// Options are read as git reads them, any unique abbreviation included
// (git-read-options.js explains why naming dangerous options cannot make a command
// safe; here a missed form only keeps the remembered approval as broad as it was).

const longName = (arg) => (arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg);
/** Whether an argument is the long option, or an abbreviation of at least `min` characters. */
const long = (args, option, min = option.length) =>
  args.some((arg) => arg.startsWith("--") && abbreviates(longName(arg), option, min));
/** Whether a group of short options (`-fd`) holds one of the letters. */
const short = (args, letters) =>
  args.some(
    (arg) =>
      arg.length > 1 &&
      arg[0] === "-" &&
      arg[1] !== "-" &&
      [...arg.slice(1)].some((letter) => letters.includes(letter)),
  );
const force = (args) =>
  long(args, "--force", 6) || args.some((arg) => arg.startsWith("--force-"));
/** The arguments that are not options; after `--` all of them. */
function positionals(args) {
  const end = args.indexOf("--");
  const before = end < 0 ? args : args.slice(0, end);
  return [
    ...before.filter((arg) => !arg.startsWith("-")),
    ...(end < 0 ? [] : args.slice(end + 1)),
  ];
}

// A pathspec for the whole work tree.
const everything = new Set([".", "./", ":/", "*", ":/*"]);
const wholeTree = (args) => positionals(args).some((arg) => everything.has(arg));

// `git config` forms that only read.
const configReads = [
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "--list",
  "-l",
];
const configWrites = [
  "--unset",
  "--unset-all",
  "--add",
  "--replace-all",
  "--edit",
  "-e",
  "--rename-section",
  "--remove-section",
];
function configWrite(args) {
  const [first, ...more] = positionals(args);
  if (first === "get" || first === "list") return false;
  const names = args.map(longName);
  if (names.some((name) => configWrites.includes(name))) return true;
  if (names.some((name) => configReads.includes(name))) return false;
  // `git config <name>` prints a value; `git config <name> <value>` sets it.
  return first === undefined || more.length > 0;
}

// Options before the subcommand that change nothing about what runs or where.
const plainGlobals = new Set([
  "--no-pager",
  "--no-optional-locks",
  "--literal-pathspecs",
]);

const git = {
  branch: (args) => short(args, "dDMCf") || long(args, "--delete", 5) || force(args),
  tag: (args) => short(args, "df") || long(args, "--delete", 5) || force(args),
  // A file written wherever the option says.
  log: (args) => long(args, "--output", 4),
  show: (args) => long(args, "--output", 4),
  diff: (args) => long(args, "--output", 4),
  push: (args) =>
    short(args, "fd") ||
    force(args) ||
    long(args, "--delete", 5) ||
    long(args, "--mirror", 4) ||
    long(args, "--prune", 5) ||
    // `+ref` overwrites the remote branch, `:ref` deletes it.
    positionals(args).some((arg) => arg.startsWith("+") || arg.startsWith(":")),
  reset: (args) => long(args, "--hard", 4),
  clean: (args) => short(args, "f") || force(args),
  checkout: (args) => short(args, "f") || force(args) || wholeTree(args),
  // `--staged` alone only takes changes out of the index.
  restore: (args) =>
    wholeTree(args) &&
    (!(short(args, "S") || long(args, "--staged", 4)) ||
      short(args, "W") ||
      long(args, "--worktree", 3)),
  switch: (args) => short(args, "f") || force(args) || long(args, "--discard-changes", 5),
  stash: (args) => ["drop", "clear"].includes(positionals(args)[0]),
  worktree: (args) =>
    positionals(args)[0] === "remove" && (short(args, "f") || force(args)),
  clone: (args) => short(args, "u"),
  config: configWrite,
};
// A program the option names, for the subcommands that talk to a remote.
const remotePrograms = (args) =>
  long(args, "--upload-pack", 5) ||
  long(args, "--receive-pack", 6) ||
  long(args, "--exec", 4);

function riskyGit(words) {
  const rest = gitWords(words);
  const at = rest.findIndex((word) => !word.startsWith("-"));
  // An option before the subcommand can choose the repository, its configuration
  // or the folder git's own programs come from.
  const globals = at < 0 ? rest : rest.slice(0, at);
  if (globals.some((option) => !plainGlobals.has(option))) return true;
  if (at < 0) return false;
  const args = rest.slice(at + 1);
  return remotePrograms(args) || Boolean(git[rest[at]]?.(args));
}

function riskyRm(words, verdicts, at) {
  const end = words.indexOf("--");
  const options = words
    .slice(1, end < 0 ? undefined : end)
    .filter((word) => word.startsWith("-") && word.length > 1);
  if (short(options, "rR") || long(options, "--recursive", 3)) return true;
  return words.some((word, i) => {
    if (i === 0 || i === end) return false;
    if ((end < 0 || i < end) && word.startsWith("-") && word.length > 1) return false;
    return placeOf(at, word, verdicts[i]) === null;
  });
}

/**
 * Whether a simple command (its words as written) is a form a remembered program
 * does not cover, when it runs at `at` (approval-place.js).
 */
export function riskyForm(written, at) {
  if (written[0] !== "git" && written[0] !== "rm") return false;
  const passed = passedWords(written);
  if (!passed) return true;
  const { words, verdicts } = passed;
  if (words[0] === "git") return riskyGit(words);
  return words[0] === "rm" && riskyRm(words, verdicts, at);
}
