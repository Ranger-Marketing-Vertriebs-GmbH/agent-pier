// A conservative reading of a shell command line a coding CLI asks to run. It only
// understands plain commands joined by `;`, `&&`, `||`, `|` and newlines, with
// quoted words and a few redirections that write nothing (`2>&1`, `>/dev/null`).
// Anything it cannot read with certainty — command or process substitution,
// variables, redirections into or out of files, background jobs, subshells,
// groups, comments or leading variable assignments — makes it return null, so the
// command is never approved without asking.

const separators = new Set([";", "&&", "||", "|", "\n"]);
// Redirections that neither read nor write a file.
const harmless = new Set([">/dev/null", "1>/dev/null", "2>/dev/null"]);
const duplications = new Set(["2>&1", "1>&2", ">&2"]);

function tokens(command) {
  const out = [];
  let word = null,
    i = 0;
  const push = () => {
    if (word !== null) out.push({ word });
    word = null;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= command.length) return null;
        const d = command[i];
        if (d === '"') break;
        if (d === "$" || d === "`") return null;
        if (d === "\\" && i + 1 < command.length) {
          value += command[i + 1];
          i += 2;
          continue;
        }
        value += d;
        i++;
      }
      word = (word ?? "") + value;
      i++;
    } else if (c === "\\") {
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 >= command.length) return null;
      word = (word ?? "") + command[i + 1];
      i += 2;
    } else if (c === "$" || c === "`") return null;
    else if (c === " " || c === "\t") {
      push();
      i++;
    } else if (c === "\n" || c === ";") {
      push();
      out.push({ op: c });
      i++;
    } else if (c === "&" || c === "|") {
      const pair = command.slice(i, i + 2);
      if (pair === "&&" || pair === "||") {
        push();
        out.push({ op: pair });
        i += 2;
      } else if (c === "|" && pair !== "|&") {
        push();
        out.push({ op: "|" });
        i++;
      } else if (pair === "&>") {
        push();
        const target = /^\s*\/dev\/null(?=$|[\s;&|])/.exec(command.slice(i + 2));
        if (!target) return null;
        out.push({ redirect: true });
        i += 2 + target[0].length;
      } else return null;
    } else if (c === ">" || c === "<") {
      // A redirection: digits just before it belong to it (`2>`), its target follows.
      if (c === "<") return null;
      const prefix = word !== null && /^[12]$/.test(word) ? word : "";
      if (word !== null && !prefix) push();
      word = null;
      const rest = command.slice(i + 1);
      const target = /^(&[12]|\s*\/dev\/null(?=$|[\s;&|]))/.exec(rest);
      if (!target) return null;
      const text = `${prefix}>${target[1].trim()}`;
      if (!harmless.has(text) && !duplications.has(text)) return null;
      out.push({ redirect: true });
      i += 1 + target[1].length;
    } else if ("(){}".includes(c) && word === null) return null;
    else if (c === "#" && word === null) return null;
    else {
      word = (word ?? "") + c;
      i++;
    }
  }
  push();
  return out;
}

/**
 * The command's simple commands as word lists, or null when it is not plain enough
 * to judge. Harmless redirections are dropped; they write nothing.
 */
export function shellSegments(command) {
  if (typeof command !== "string" || !command.trim() || command.length > 8000)
    return null;
  const list = tokens(command);
  if (!list) return null;
  const segments = [];
  let current = [];
  for (const token of list) {
    if (token.redirect) continue;
    if (token.op) {
      if (!separators.has(token.op)) return null;
      if (!current.length) {
        // Blank lines and a trailing `;` are harmless; `a && && b` is not.
        if (token.op === "\n" || (token.op === ";" && segments.length)) continue;
        return null;
      }
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token.word);
  }
  if (current.length) segments.push(current);
  if (!segments.length) return null;
  // `NAME=value cmd` changes the program's environment (PAGER, GIT_SSH, …).
  if (segments.some((words) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) return null;
  return segments;
}

// Programs whose first argument chooses what they do; a remembered approval names
// both (`git push`), so allowing one subcommand never allows another.
const subcommandPrograms = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "gh",
  "pip",
  "pip3",
  "brew",
]);

/** The words after git's `-C <dir>` options, which only change its folder. */
export function gitWords(words) {
  let i = 1;
  while (words[i] === "-C" && words[i + 1] !== undefined) i += 2;
  return words.slice(i);
}

/** How a remembered approval names a simple command: `rm`, `git push`, `npm run`. */
export function programKey(words) {
  const program = words[0];
  if (!subcommandPrograms.has(program)) return program;
  const rest = program === "git" ? gitWords(words) : words.slice(1);
  const sub = rest.find((word) => !word.startsWith("-"));
  return sub ? `${program} ${sub}` : program;
}
