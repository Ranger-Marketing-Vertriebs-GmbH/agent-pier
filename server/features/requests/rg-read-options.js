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
