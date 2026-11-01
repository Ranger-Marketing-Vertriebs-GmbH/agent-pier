// AgentPier reads the programs of a shell command off its text: the exec allowlist
// links (exec-allowlist-links.js) and the "Always allow" plan of the OpenClaw adapter
// (runtimes/openclaw/exec-allowlist-policy.js) both split commands this way.

const reservedWords = new Set([
  ...["if", "then", "else", "elif", "fi", "for", "while", "until", "case", "esac"],
  ...["do", "done", "in", "function", "select", "coproc", "!", "[[", "]]", "{", "}"],
]);

/**
 * Splits a shell command into its simple commands (argv lists) at `|`, `||`,
 * `&&`, `;`, `|&` and newlines, honouring quotes and backslashes and dropping
 * redirections (`> file`, `2>&1`, `< in`). Returns null for syntax whose programs
 * cannot be read off the text: substitutions, subshells, groups, background jobs,
 * here-documents, process substitution, environment assignments, reserved
 * words, redirection-only segments, or a variable or glob in a program name.
 */
export function splitCommand(command) {
  const segments = [];
  let words = [],
    word = null,
    quotedWord = false,
    redirect = false;
  const endWord = () => {
    if (word === null) return;
    if (redirect) redirect = false;
    else words.push({ text: word, quoted: quotedWord });
    word = null;
    quotedWord = false;
  };
  let redirected = false;
  const endSegment = () => {
    endWord();
    // A dangling operator, or a segment of redirections only, is not a command.
    if (redirect || (redirected && !words.length)) return false;
    if (words.length) segments.push(words);
    words = [];
    redirected = false;
    return true;
  };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + s.slice(i + 1, end);
      quotedWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1,
        text = "";
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "`" || (s[j] === "$" && s[j + 1] === "(")) return null;
        if (s[j] === "\\" && j + 1 < s.length) text += s[++j];
        else text += s[j];
      }
      if (j >= s.length) return null;
      word = (word ?? "") + text;
      quotedWord = true;
      i = j;
    } else if (c === "\\") {
      if (s[i + 1] === "\n") i++;
      else if (i + 1 < s.length) word = (word ?? "") + s[++i];
    } else if (c === " " || c === "\t") endWord();
    else if (c === "\n" || c === ";") {
      if (!endSegment()) return null;
    } else if (c === "|") {
      if (s[i + 1] === "|" || s[i + 1] === "&") i++;
      if (!endSegment()) return null;
    } else if (c === "&") {
      if (s[i + 1] === "&") {
        i++;
        if (!endSegment()) return null;
      } else if (s[i + 1] === ">") {
        endWord();
        if (!words.length) return null;
        i += s[i + 2] === ">" ? 2 : 1;
        redirect = redirected = true;
      } else return null;
    } else if (c === ">" || c === "<") {
      if (s[i + 1] === "(" || (c === "<" && s[i + 1] === "<")) return null;
      // A redirection before the program leaves no clear program word.
      if (!words.length && (word === null || (/^\d+$/.test(word) && !quotedWord)))
        return null;
      // A file descriptor number written against the operator belongs to it.
      if (word !== null && /^\d+$/.test(word) && !quotedWord) word = null;
      else endWord();
      redirected = true;
      if (s[i + 1] === ">" || s[i + 1] === "|") i++;
      if (s[i + 1] === "&") {
        i++;
        // `>&2` and `>&-` name a descriptor; `>& file` a file, as `&>` does.
        if (/[\d-]/.test(s[i + 1] || "")) {
          while (/[\d-]/.test(s[i + 1] || "")) i++;
          continue;
        }
      }
      redirect = true;
    } else if (c === "(" || c === ")" || c === "`" || c === "{" || c === "}") return null;
    else if (c === "$" && s[i + 1] === "(") return null;
    else word = (word ?? "") + c;
  }
  if (!endSegment()) return null;
  const argvs = [];
  for (const segment of segments) {
    const [program] = segment;
    // An assignment (`PATH=… cmd`) can change which program runs or what it
    // loads; a variable or glob hides the program; a reserved word starts shell
    // syntax rather than a program.
    if (
      (!program.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(program.text)) ||
      program.text.includes("$") ||
      (!program.quoted && /[*?[~]/.test(program.text)) ||
      (!program.quoted && reservedWords.has(program.text))
    )
      return null;
    argvs.push(segment.map((w) => w.text));
  }
  return argvs.length ? argvs : null;
}
