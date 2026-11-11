// The ripgrep options the default list accepts: those that choose what is
// searched and how matches are printed. Everything else asks, among it `--pre` and
// `--pre-glob` (run a program for every file), `--hostname-bin` (runs one for
// links), `-z`/`--search-zip` (starts decompressors) and `-f`/`--file`.

const set = (text) => new Set(text.split(/\s+/).filter(Boolean));

const flags = set(`
  --files --hidden --no-hidden --no-ignore --no-ignore-vcs --no-ignore-parent
  --no-ignore-dot --no-ignore-global --no-ignore-exclude --no-ignore-files
  --no-require-git --unrestricted --follow --no-follow --one-file-system --json
  --heading --no-heading --line-number --no-line-number --column --no-column
  --count --count-matches --include-zero --multiline --multiline-dotall --pcre2
  --no-pcre2 --fixed-strings --ignore-case --smart-case --case-sensitive
  --word-regexp --line-regexp --files-with-matches --files-without-match
  --only-matching --invert-match --text --binary --trim --no-trim --no-messages
  --null --null-data --stats --with-filename --no-filename --vimgrep --pretty
  --passthru --crlf --no-crlf --glob-case-insensitive --no-config --no-unicode
  --byte-offset --quiet --type-list --max-columns-preview --no-mmap --mmap
  --line-buffered --block-buffered --sort-files --no-sort-files
`);
const values = set(`
  --glob --iglob --type --type-not --type-add --after-context --before-context
  --context --max-count --max-depth --maxdepth --max-columns --max-filesize --color
  --colors --sort --sortr --regexp --encoding --threads --replace --engine
  --context-separator --field-match-separator --field-context-separator
  --path-separator --dfa-size-limit --regex-size-limit
`);
// Short options without a value, and those whose value follows (attached or as
// the next word).
const letters = "niSswlcoFUPuHINLabxvqhp.0";
const valued = "egtTABCmdjMEr";
const short = new RegExp(`^-[${letters}]*([${valued}].*)?$`);

/** Whether `-…` is a ripgrep option of the list. */
function listed(option) {
  if (!option.startsWith("--")) return option.length > 1 && short.test(option);
  const equals = option.indexOf("=");
  if (equals < 0) return flags.has(option) || values.has(option);
  return values.has(option.slice(0, equals));
}

/** Whether every option of an `rg` command (its words) only searches and prints. */
export function readOnlyRg(words) {
  for (const word of words.slice(1)) {
    if (word === "--") return true;
    if (word.startsWith("-") && word !== "-" && !listed(word)) return false;
  }
  return true;
}

// What makes ripgrep search files it skips by default: hidden ones and those an
// ignore file names. The default list asks for these (search-reach.js).
const lifting = (option) =>
  option === "--hidden" ||
  option === "--unrestricted" ||
  option.startsWith("--no-ignore");
// Options whose value chooses files by name: a glob or a type that holds dot names
// searches those files without `--hidden`.
const globbing = new Set(["--glob", "--iglob", "-g"]);
const typing = new Set(["--type", "-t"]);
// Without a pattern word: the pattern comes from an option, or none is needed.
const patterned = new Set(["--regexp", "-e", "--files", "--type-list"]);

/**
 * How an `rg` command (its words, options from the list above) searches: `lifted`
 * when an option includes hidden or ignored files, `targets` the paths it names,
 * `globs` and `types` the values that choose files by name, and `typeAdded` when
 * the command defines a type of its own.
 */
export function rgSearch(words) {
  const found = { lifted: false, targets: [], globs: [], types: [], typeAdded: false };
  const positionals = [];
  let pattern = true;
  const option = (name, value) => {
    if (patterned.has(name)) pattern = false;
    if (lifting(name)) found.lifted = true;
    if (name === "--type-add") found.typeAdded = true;
    if (globbing.has(name)) found.globs.push(value ?? "");
    if (typing.has(name)) found.types.push(value ?? "");
  };
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") positionals.push(word);
    else if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      if (equals >= 0) option(word.slice(0, equals), word.slice(equals + 1));
      else option(word, values.has(word) ? words[++i] : undefined);
    } else
      for (let j = 1; j < word.length; j++) {
        const letter = word[j];
        if (!valued.includes(letter)) {
          if (letter === "u" || letter === ".") found.lifted = true;
          continue;
        }
        option(`-${letter}`, j + 1 < word.length ? word.slice(j + 1) : words[++i]);
        break;
      }
  }
  found.targets = pattern ? positionals.slice(1) : positionals;
  return found;
}
