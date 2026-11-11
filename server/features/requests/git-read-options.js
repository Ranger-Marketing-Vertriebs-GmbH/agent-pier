// The options the default list accepts for its git subcommands. Git takes any
// unique abbreviation of a long option (`--upl` for `--upload-pack`), so naming the
// dangerous ones cannot work: an argument that starts with `-` passes only when it
// is exactly an option listed here, or `--name=value` for one that takes a value.
// Everything else asks, including abbreviations of listed options. The lists hold
// options that only choose what is read or how it is printed; none writes a file
// (`--output`), runs a program (`--upload-pack`, `--ext-diff`, `--textconv`,
// `--show-signature`) or changes configuration (`--set-upstream`).

const set = (text) => new Set(text.split(/\s+/).filter(Boolean));
const union = (...sets) => new Set(sets.flatMap((one) => [...one]));

// How a diff is computed and printed (log, show and diff).
const diffFlags = set(`
  --patch --no-patch --stat --shortstat --numstat --summary --compact-summary
  --patch-with-stat --patch-with-raw --name-only --name-status --raw --minimal
  --patience --histogram --color --no-color --word-diff --color-words --color-moved
  --no-color-moved --no-color-moved-ws --renames --no-renames --find-renames
  --find-copies --find-copies-harder --rename-empty --no-rename-empty
  --irreversible-delete --break-rewrites --pickaxe-all --pickaxe-regex --full-index
  --binary --text --abbrev --no-abbrev --ignore-cr-at-eol --ignore-space-at-eol
  --ignore-space-change --ignore-all-space --ignore-blank-lines --function-context
  --no-ext-diff --no-textconv --no-prefix --default-prefix --exit-code --quiet
  --check --cc --combined-all-paths --indent-heuristic --no-indent-heuristic
  --relative --no-relative --dirstat --cumulative --unified --submodule
  --ignore-submodules --no-diff-merges --remerge-diff --dd --follow
  --ita-invisible-in-index --ita-visible-in-index
`);
const diffValues = set(`
  --stat --stat-width --stat-name-width --stat-count --stat-graph-width --unified
  --inter-hunk-context --diff-algorithm --anchored --color --word-diff
  --word-diff-regex --color-words --color-moved --color-moved-ws --find-renames
  --find-copies --break-rewrites --diff-filter --abbrev --relative --src-prefix
  --dst-prefix --line-prefix --dirstat --submodule --ignore-submodules
  --ws-error-highlight --diff-merges --ignore-matching-lines --find-object
  --rotate-to --skip-to
`);
const diffLetters = "puswbzRWatrqD";
const diffShort = [/^-[BMC]\d*%?$/, /^-U\d+$/, /^-l\d+$/, /^-[SGIO]/, /^-X[\w,]*$/];

// Which commits are walked and how they are printed (log and show).
const walkFlags = set(`
  --oneline --graph --no-graph --decorate --no-decorate --clear-decorations --all
  --branches --tags --remotes --reflog --walk-reflogs --reverse --merges --no-merges
  --first-parent --exclude-first-parent-only --abbrev-commit --no-abbrev-commit
  --date-order --topo-order --author-date-order --cherry-pick --cherry-mark --cherry
  --left-right --left-only --right-only --full-history --simplify-merges
  --simplify-by-decoration --ancestry-path --show-pulls --dense --sparse
  --remove-empty --source --relative-date --parents --children --boundary --no-walk
  --do-walk --notes --no-notes --show-notes --no-standard-notes --mailmap
  --use-mailmap --no-mailmap --regexp-ignore-case --basic-regexp --extended-regexp
  --fixed-strings --perl-regexp --all-match --invert-grep --not --no-max-parents
  --no-min-parents --expand-tabs --no-expand-tabs --full-diff --log-size --bisect
  --merge --pretty --show-linear-break --single-worktree --ignore-missing
  --since-as-filter
`);
const walkValues = set(`
  --format --pretty --since --after --until --before --since-as-filter --author
  --committer --grep --grep-reflog --max-count --skip --date --decorate
  --decorate-refs --decorate-refs-exclude --branches --tags --remotes --glob
  --exclude --exclude-hidden --min-parents --max-parents --min-age --max-age
  --encoding --notes --expand-tabs --ancestry-path --show-linear-break --no-walk
`);
const walkLetters = `${diffLetters}iEFPgm`;
const walkShort = [...diffShort, /^-n\d*$/, /^-\d+$/, /^-L/];

const walk = {
  flags: union(diffFlags, walkFlags),
  values: union(diffValues, walkValues),
  letters: walkLetters,
  short: walkShort,
  paths: true,
};

const subcommands = {
  log: walk,
  show: walk,
  diff: {
    flags: union(
      diffFlags,
      // No `--no-index`: it compares any two files or folders, not the repository.
      set("--cached --staged --merge-base --base --ours --theirs"),
    ),
    values: diffValues,
    letters: diffLetters,
    short: [...diffShort, /^-[0-3]$/],
    paths: true,
  },
  status: {
    flags: set(`
      --short --branch --show-stash --porcelain --long --verbose --untracked-files
      --ignored --ignore-submodules --column --no-column --ahead-behind
      --no-ahead-behind --renames --no-renames --find-renames
    `),
    values: set(
      "--porcelain --untracked-files --ignored --ignore-submodules --column --find-renames",
    ),
    letters: "sbvz",
    short: [/^-[sbvz]*u(no|normal|all)?$/],
    paths: true,
  },
  "rev-parse": {
    flags: set(`
      -- --show-toplevel --abbrev-ref --short --verify --quiet --git-dir
      --absolute-git-dir --git-common-dir --is-inside-work-tree --is-inside-git-dir
      --is-bare-repository --is-shallow-repository --show-cdup --show-prefix
      --show-superproject-working-tree --shared-index-path --symbolic
      --symbolic-full-name --all --branches --tags --remotes --not --revs-only
      --no-revs --flags --no-flags --sq --local-env-vars --show-object-format
      --show-ref-format --end-of-options --git-path --resolve-git-dir --default
      --prefix
    `),
    values: set(`
      --abbrev-ref --short --branches --tags --remotes --glob --exclude
      --exclude-hidden --path-format --show-object-format --since --after --until
      --before --disambiguate
    `),
    letters: "q",
    short: [],
    paths: false,
  },
  // Options that leave which refs a fetch updates as configured: no `--force`,
  // `--refmap`, `--prune-tags`, shallow or filter options.
  fetch: {
    flags: set(`
      --all --no-all --prune --no-prune --tags --no-tags --verbose --quiet --dry-run
      --atomic --progress --no-progress --no-auto-gc --no-auto-maintenance
      --show-forced-updates --no-show-forced-updates --no-recurse-submodules
      --write-fetch-head --no-write-fetch-head --no-write-commit-graph --ipv4
      --ipv6 --porcelain
    `),
    values: set("--jobs"),
    // A value must be attached (`--jobs=4`, `-j4`): written apart, the next word
    // could be read as the repository here and as the value by git.
    attached: true,
    letters: "ptnvq46",
    short: [/^-j\d+$/],
    paths: true,
  },
};

/** Whether `-…` is an option the subcommand's list holds. */
function listed(option, list) {
  if (option.startsWith("--")) {
    const equals = option.indexOf("=");
    if (equals < 0)
      return list.flags.has(option) || (!list.attached && list.values.has(option));
    return list.values.has(option.slice(0, equals));
  }
  if (option.length < 2) return false;
  if ([...option.slice(1)].every((letter) => list.letters.includes(letter))) return true;
  return list.short.some((shape) => shape.test(option));
}

// `git branch` only lists: no names, no -d/-m/-c.
const branchListing = set(
  "-a -r -v -vv -l --all --remotes --list --verbose --show-current --no-color --color",
);

// A remote by its configured name, and branches by theirs. A path or URL makes git
// run the upload program at that place; a refspec (`a:b`, `+a`, `refs/…`, `*`)
// writes refs other than the remote-tracking ones.
const remoteName = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const branchName = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const plainBranch = (name) =>
  branchName.test(name) && !name.includes("..") && !name.startsWith("refs/");

/** The arguments of a git subcommand that are not options. */
export function gitPositionals(sub, args) {
  const paths = subcommands[sub]?.paths;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (paths && args[i] === "--") return [...out, ...args.slice(i + 1)];
    if (!args[i].startsWith("-")) out.push(args[i]);
  }
  return out;
}

/**
 * Whether the arguments after a default git subcommand only read: every option is
 * on the subcommand's list, no format asks for a signature check (`%G…` starts a
 * program, like `--show-signature`), `git branch` only lists, and `git fetch`
 * names a remote and at most plain branches.
 */
export function readOnlyGitArguments(sub, args) {
  if (sub === "branch") return args.every((arg) => branchListing.has(arg));
  const list = subcommands[sub];
  if (!list) return false;
  if (args.some((arg) => arg.includes("%G"))) return false;
  for (const arg of args) {
    if (list.paths && arg === "--") break;
    if (arg.startsWith("-") && !listed(arg, list)) return false;
  }
  if (sub !== "fetch") return true;
  const [remote, ...branches] = gitPositionals(sub, args);
  if (remote === undefined) return true;
  return remoteName.test(remote) && !remote.includes("..") && branches.every(plainBranch);
}
