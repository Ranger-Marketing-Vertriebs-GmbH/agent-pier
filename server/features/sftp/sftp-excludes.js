import { randomBytes } from "node:crypto";
import { sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";
import { unsafeName } from "./sftp-remote-paths.js";

// Git internals and environment files (`.env`, `.env.local`, `.env.production`) hold
// credentials; these defaults match any case, since a case-insensitive file system
// serves `.ENV` as `.env`.
export const defaultExcludes = Object.freeze([".git", ".env", ".env.*"]);
const caseless = new Set(defaultExcludes);
const partFile = /^\..+\.agentpier-part-[0-9a-f]+$/;

/** A temporary file a transfer writes before renaming it into place. */
export function isPartFile(name) {
  return partFile.test(name);
}

const NAME_BYTES = 255;

/**
 * A fresh temporary name for `name`: `.<name>.agentpier-part-<16 hex>`, with `name`
 * shortened (on a character boundary) so the result fits a 255-byte file name; the
 * random part keeps it unique.
 */
export function partName(name) {
  const suffix = `.agentpier-part-${randomBytes(8).toString("hex")}`;
  const room = NAME_BYTES - 1 - Buffer.byteLength(suffix);
  let kept = "";
  let bytes = 0;
  for (const char of name) {
    const size = Buffer.byteLength(char);
    if (bytes + size > room) break;
    kept += char;
    bytes += size;
  }
  return `.${kept}${suffix}`;
}
const refused = () => sftpProblem("SFTP_PATH_REFUSED");

function patternValue(raw) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > sftpLimits.excludeChars ||
    unsafeName.test(raw)
  )
    throw refused();
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".."))
    throw refused();
  return raw;
}

/** The validated exclude patterns, after `defaultExcludes` unless `defaults` is off. */
export function excludeList(patterns = [], { defaults = true } = {}) {
  if (!Array.isArray(patterns) || patterns.length > sftpLimits.excludes) throw refused();
  const list = patterns.map(patternValue);
  return [...new Set([...(defaults ? defaultExcludes : []), ...list])];
}

// `*` and `?` within one name, matched greedily with backtracking to the last star:
// O(name × pattern), never exponential.
function segmentMatcher(raw, ignoreCase) {
  const pattern = ignoreCase ? raw.toLowerCase() : raw;
  const literal = !/[*?]/.test(pattern);
  return (value) => {
    const name = ignoreCase ? value.toLowerCase() : value;
    if (literal) return name === pattern;
    let p = 0,
      n = 0,
      star = -1,
      resume = 0;
    while (n < name.length) {
      if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
        p++;
        n++;
      } else if (p < pattern.length && pattern[p] === "*") {
        star = p++;
        resume = n;
      } else if (star >= 0) {
        p = star + 1;
        n = ++resume;
      } else return false;
    }
    while (pattern[p] === "*") p++;
    return p === pattern.length;
  };
}

// A pattern without an inner or leading `/` matches any segment; otherwise it is
// anchored at the transfer root. A match of a parent excludes everything below it.
function compile(pattern) {
  const anchored = pattern.replace(/\/+$/, "").includes("/");
  const parts = pattern.split("/").filter(Boolean);
  const steps = (anchored ? parts : ["**", ...parts]).filter(
    (part, i, all) => part !== "**" || all[i - 1] !== "**",
  );
  const ignoreCase = caseless.has(pattern);
  const matchers = steps.map((part) =>
    part === "**" ? null : segmentMatcher(part, ignoreCase),
  );
  return (names) => {
    // Simulates the pattern as an automaton over the path's names: linear in names.
    const close = (states) => {
      for (const state of [...states])
        if (matchers[state] === null) states.add(state + 1);
      return states;
    };
    let states = close(new Set([0]));
    for (const name of names) {
      const next = new Set();
      for (const state of states) {
        if (state === matchers.length) return true;
        if (matchers[state] === null) next.add(state);
        else if (matchers[state](name)) next.add(state + 1);
      }
      states = close(next);
      if (!states.size) return false;
    }
    return states.has(matchers.length);
  };
}

const compiled = new WeakMap();

/** Whether the relative POSIX path is excluded by any of `patterns`. */
export function excluded(relative, patterns) {
  let tests = compiled.get(patterns);
  if (!tests) {
    tests = patterns.map(compile);
    compiled.set(patterns, tests);
  }
  const names = relative.split("/").filter(Boolean);
  return names.length > 0 && tests.some((matches) => matches(names));
}
