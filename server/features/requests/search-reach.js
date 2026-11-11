import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderIn } from "./approval-place.js";
import { rgSearch } from "./rg-read-options.js";
import { secretDotNames, secretWords } from "./secret-names.js";
import { globMatchesDotName, secretShaped } from "./shell-expansion.js";

// How far a search on the default list reaches. `cat notes.md` reads the file it
// names, but `grep -r` and `rg` read every file below a folder, so a search without
// a card stays inside the session's project and away from the files a card protects
// when they are named (secret-names.js):
//
// - A place outside the project asks: `~`, an absolute path elsewhere, `..`, or a
//   shell that has left the project. A grep that does not recurse reads the files
//   it names, as `cat` does, and is not judged here.
// - ripgrep skips hidden and ignored files, which is where `.env`, `.npmrc` and
//   `.ssh` are. An option that searches them asks (`-u`, `-.`, `--hidden`,
//   `--no-ignore…`), and so does a glob or type that can match such a name: a glob
//   includes the hidden files it matches (`-g '.env*'`, `-g '*'`, `-g 'src/**'`), the
//   types `sh` and `all` hold `.env`, and `--type-add` defines any type.
// - grep has no such rules. It asks when the folder it searches holds a protected
//   dot name or a key or credentials file directly, or holds the home folder.
//   A subfolder named like one (`secrets/`) does not count; it is not looked into.
//
// What stays: files further down are not looked at (`grep -r KEY .` reads
// `config/.env` when the project root holds no secret itself), nor is `.git/`, and
// ripgrep reads a key file that is neither hidden nor ignored (`server.pem`).

// grep options whose value is always the next word when it is not attached. `-C`
// and `--context` take an optional value in BSD grep; their next word is read as a
// place too, like the value of an option this list does not know.
const valuedLetters = "efABmdD";
const valuedOptions = new Set([
  "--regexp",
  "--file",
  "--after-context",
  "--before-context",
  "--max-count",
  "--include",
  "--exclude",
  "--exclude-from",
  "--exclude-dir",
  "--directories",
  "--devices",
  "--binary-files",
  "--label",
]);
/** Whether `name` is `option` or an abbreviation of it with at least `min` characters. */
export const abbreviates = (name, option, min) =>
  name.length >= min && option.startsWith(name);

/**
 * A `grep` command (its words): whether it searches folders recursively, and the
 * files and folders it names. A word that may be a place counts as one.
 */
export function grepSearch(words) {
  let recursive = false,
    pattern = true;
  const positionals = [];
  const option = (name, value) => {
    if (["-e", "-f", "--regexp", "--file"].includes(name)) pattern = false;
    if ((name === "-d" || abbreviates(name, "--directories", 4)) && value === "recurse")
      recursive = true;
  };
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") positionals.push(word);
    else if (word.startsWith("--")) {
      const equals = word.indexOf("="),
        name = equals < 0 ? word : word.slice(0, equals);
      if (
        abbreviates(name, "--recursive", 4) ||
        abbreviates(name, "--dereference-recursive", 4)
      )
        recursive = true;
      if (equals >= 0) option(name, word.slice(equals + 1));
      else option(name, valuedOptions.has(name) ? words[++i] : undefined);
    } else
      for (let j = 1; j < word.length; j++) {
        const letter = word[j];
        if (letter === "r" || letter === "R") recursive = true;
        if (!valuedLetters.includes(letter)) continue;
        option(`-${letter}`, j + 1 < word.length ? word.slice(j + 1) : words[++i]);
        break;
      }
  }
  return { recursive, targets: pattern ? positionals.slice(1) : positionals };
}

// More entries than any source folder holds are not read; such a folder asks.
const maxEntries = 5000;
const home = () => {
  try {
    return fs.realpathSync.native(os.homedir());
  } catch {
    return null;
  }
};
const holds = (folder, target) =>
  target !== null &&
  (target === folder ||
    target.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep));

const secretNamed = (entry) => !entry.isDirectory() && secretShaped(entry.name);

/** Whether a folder holds the home folder, or a protected name directly. */
function holdsSecret(folder) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(folder);
    if (!fs.statSync(resolved).isDirectory()) return false;
  } catch {
    // Nothing there to search.
    return false;
  }
  if (holds(resolved, home())) return true;
  try {
    const dir = fs.opendirSync(resolved);
    try {
      for (let count = 0, entry; (entry = dir.readSync()); count++) {
        if (count >= maxEntries) return true;
        // A dot name of the secret list, or a file named like a key or credentials
        // file. A folder called `secrets` or `tokens` is as often source code.
        const { name } = entry;
        if (name.startsWith(".") ? secretWords.test(name) : secretNamed(entry))
          return true;
      }
    } finally {
      dir.closeSync();
    }
    return false;
  } catch {
    return true;
  }
}

const wildcard = /[*?[]/;

/**
 * The folder a searched word names when it lies in the project, else null. Of a
 * pattern only the folders before its first wildcard are known.
 */
export function placeOf(at, word, verdict) {
  if (verdict?.home) return null;
  if (verdict?.literal !== false) return folderIn(at, word);
  const parts = word.split("/");
  const first = parts.findIndex((part) => wildcard.test(part));
  if (first < 0) return folderIn(at, word);
  return folderIn(
    at,
    parts.slice(0, first).join("/") || (word.startsWith("/") ? "/" : "."),
  );
}

const hiddenTypes = new Set(["sh", "all"]);

/**
 * Whether a `grep` or `rg` command must ask because of what it searches. `passed`
 * holds its words as the shell passes them with their verdicts (shell-expansion.js),
 * `at` is where it runs (approval-place.js).
 */
export function searchAsks(passed, at) {
  const { words, verdicts } = passed;
  const ripgrep = words[0] === "rg";
  const search = ripgrep ? rgSearch(words) : grepSearch(words);
  if (!ripgrep && !search.recursive) return false;
  if (ripgrep) {
    if (search.lifted || search.typeAdded) return true;
    if (search.types.some((type) => hiddenTypes.has(type))) return true;
    if (
      search.globs.some(
        (glob) => !glob.startsWith("!") && globMatchesDotName(glob, secretDotNames),
      )
    )
      return true;
  }
  // Each target is one of the words; the same text elsewhere has the same verdict
  // unless one is quoted, and then the unquoted reading decides.
  const verdict = (target) => {
    const found = words.flatMap((word, i) => (word === target ? [verdicts[i]] : []));
    return found.find((one) => !one.literal) ?? found[0];
  };
  const targets = search.targets.length ? search.targets : ["."];
  return targets.some((target) => {
    const folder = placeOf(at, target, verdict(target));
    if (folder === null) return true;
    // Without a known folder nothing can be looked up.
    return !ripgrep && at.cwd !== null && holdsSecret(folder);
  });
}
