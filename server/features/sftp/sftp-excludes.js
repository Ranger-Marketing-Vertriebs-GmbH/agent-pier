import { sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";

export const defaultExcludes = Object.freeze([".git", ".env"]);
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/;
const refused = () => sftpProblem("SFTP_PATH_REFUSED");

function patternValue(raw) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > sftpLimits.excludeChars ||
    unsafe.test(raw)
  )
    throw refused();
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".."))
    throw refused();
  return raw;
}

/** The validated exclude patterns, after `.git` and `.env` unless `defaults` is off. */
export function excludeList(patterns = [], { defaults = true } = {}) {
  if (!Array.isArray(patterns) || patterns.length > sftpLimits.excludes) throw refused();
  const list = patterns.map(patternValue);
  return [...new Set([...(defaults ? defaultExcludes : []), ...list])];
}

// `*` and `?` within one name, matched greedily with backtracking to the last star:
// O(name × pattern), never exponential.
function segmentMatcher(pattern) {
  if (!/[*?]/.test(pattern)) return (name) => name === pattern;
  return (name) => {
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
  const matchers = steps.map((part) => (part === "**" ? null : segmentMatcher(part)));
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
