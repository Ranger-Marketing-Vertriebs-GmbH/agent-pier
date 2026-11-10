// A conservative reading of a shell command line a coding CLI asks to run. It only
// understands plain commands joined by `;`, `&&`, `||`, `|` and newlines, with
// quoted words and a few redirections that write nothing (`2>&1`, `>/dev/null`).
// Anything it cannot read with certainty — command or process substitution,
// variables, redirections into or out of files, background jobs, subshells,
// groups, glob qualifiers, comments or leading variable assignments — makes it
// return null, so the command is never approved without asking.
//
// The shell expands unquoted `*`, `?`, `[`, `{a,b}` and a leading `~` after this
// reading, so every word keeps a record of which of its characters stood outside
// quotes (`unquotedMarks`); shell-expansion.js judges what they can become.

const separators = new Set([";", "&&", "||", "|", "\n"]);
// Redirections that neither read nor write a file.
const harmless = new Set([">/dev/null", "1>/dev/null", "2>/dev/null"]);
const duplications = new Set(["2>&1", "1>&2", ">&2"]);

const escapable = '$`"\\';

function tokens(command) {
  const out = [];
  // `marks` has one character per character of `word`: "u" unquoted, "q" quoted.
  let word = null,
    marks = "",
    i = 0;
  const push = () => {
    if (word !== null) out.push({ word, marks });
    word = null;
    marks = "";
  };
  const add = (text, mark) => {
    word = (word ?? "") + text;
    marks += mark.repeat(text.length);
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      add(command.slice(i + 1, end), "q");
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
          // Inside double quotes a backslash escapes only a few characters; before
          // a newline both vanish, before anything else the backslash stays.
          const next = command[i + 1];
          if (escapable.includes(next)) value += next;
          else if (next !== "\n") value += d + next;
          i += 2;
          continue;
        }
        value += d;
        i++;
      }
      add(value, "q");
      i++;
    } else if (c === "\\") {
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 >= command.length) return null;
      add(command[i + 1], "q");
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
      marks = "";
      const rest = command.slice(i + 1);
      const target = /^(&[12]|\s*\/dev\/null(?=$|[\s;&|]))/.exec(rest);
      if (!target) return null;
      const text = `${prefix}>${target[1].trim()}`;
      if (!harmless.has(text) && !duplications.has(text)) return null;
      out.push({ redirect: true });
      i += 1 + target[1].length;
    } else if ("{}".includes(c) && word === null) return null;
    // A parenthesis starts a subshell, or inside a word a zsh glob qualifier or a
    // bash extended pattern; both can run code.
    else if (c === "(" || c === ")") return null;
    else if (c === "#" && word === null) return null;
    else {
      add(c, "u");
      i++;
    }
  }
  push();
  return out;
}

const recorded = new WeakMap();
/**
 * For each word of a segment from `shellSegments`, a string as long as the word:
 * "u" where the character stood outside quotes, "q" where it was quoted or escaped.
 * Words from anywhere else count as unquoted throughout, the careful reading.
 */
export const unquotedMarks = (words) =>
  recorded.get(words) ?? words.map((word) => "u".repeat(word.length));

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
  let current = [],
    marks = [];
  const close = () => {
    recorded.set(current, marks);
    segments.push(current);
    current = [];
    marks = [];
  };
  for (const token of list) {
    if (token.redirect) continue;
    if (token.op) {
      if (!separators.has(token.op)) return null;
      if (!current.length) {
        // Blank lines and a trailing `;` are harmless; `a && && b` is not.
        if (token.op === "\n" || (token.op === ";" && segments.length)) continue;
        return null;
      }
      close();
      continue;
    }
    current.push(token.word);
    marks.push(token.marks);
  }
  if (current.length) close();
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
