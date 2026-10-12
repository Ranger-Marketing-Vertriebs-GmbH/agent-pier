import fs from "node:fs";
import path from "node:path";

// When OpenClaw withholds allow-always, AgentPier's "Always allow" writes one
// program-path entry (`{ id, pattern: <program> }`, any arguments) per program of
// the command, so the same command, and each program alone, run without asking.
// For an interpreter, shell or launcher such an entry would allow any code, and an
// inline script is code given on the command line: those requests, and commands
// whose programs AgentPier cannot pin to a path, are allowed once only.

// Interpreters, shells, launchers and wrappers: a superset of the sets OpenClaw
// 2026.9.8 itself uses for inline evaluation, safe bins, command carriers, shell
// and dispatch wrappers, package managers and script runners
// (tests/integration/assistant-shell-contract.test.js checks it against the
// installed dist), plus AgentPier's own additions.
export const interpreterNames = new Set([
  // OpenClaw inline-evaluation interpreters.
  ...["python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "bun", "deno"],
  ...["awk", "gawk", "mawk", "nawk", "ruby", "perl", "php", "r", "rscript", "julia"],
  ...["elixir", "iex", "guile", "groovy", "scala", "scala-cli", "clojure", "clj"],
  ...["raku", "perl6", "ghc", "ghci", "erl", "werl", "gdb", "expect", "lua"],
  ...["osascript", "find", "make", "gmake", "sed", "gsed", "xargs"],
  // OpenClaw interpreter-like safe bins and shell wrappers.
  ...["ash", "bash", "busybox", "toybox", "cmd", "cscript", "wscript", "dash", "fish"],
  ...["ksh", "mksh", "csh", "tcsh", "osh", "elvish", "nu", "xonsh", "yash", "sh", "zsh"],
  ...["powershell", "pwsh"],
  // OpenClaw command carriers, source builtins and dispatch wrappers.
  ...["sudo", "doas", "env", "command", "builtin", ".", "source", "arch", "caffeinate"],
  ...["bwrap", "catchsegv", "chrt", "chroot", "cpulimit", "eatmydata", "firejail"],
  ...["flock", "gosu", "ionice", "linux32", "linux64", "nice", "nsenter", "nohup"],
  ...["numactl", "pkexec", "proot", "proxychains", "proxychains4", "runuser"],
  ...["sandbox-exec", "script", "setarch", "setsid", "setpriv", "stdbuf", "su"],
  ...["systemd-run", "taskset", "time", "timeout", "torify", "torsocks", "unbuffer"],
  ...["unshare", "watch", "xcrun", "xvfb-run"],
  // OpenClaw package managers and mutable script runners.
  ...["corepack", "npm", "npx", "pnpm", "yarn", "esno", "jiti", "ts-node"],
  ...["ts-node-esm", "tsx", "vite-node"],
  // AgentPier's additions: more runners, launchers, debuggers and editors.
  ...["bunx", "pnpx", "uv", "uvx", "pipx", "luajit", "lldb", "gtimeout", "exec", "eval"],
  ...["parallel", "java", "jshell", "kotlin", "swift", "go", "cargo", "dotnet"],
  ...["tclsh", "wish", "vim", "nvim", "vi", "ex", "emacs", "ssh", "tmux", "screen"],
  // Package managers and build drivers: they run scripts from what they install
  // or build.
  ...["brew", "pip", "gem", "bundle", "bundler", "cmake", "gradle", "gradlew", "mvn"],
  ...["mvnw", "composer", "poetry", "conda", "mamba", "micromamba", "pythonw"],
  // Launchers that start other programs: macOS openers and schedulers, job
  // schedulers, containers and VMs, Nix, remote copy that can name its transport
  // program, and database shells with a shell escape.
  ...["open", "launchctl", "shortcuts", "automator", "crontab", "at", "batch"],
  ...["systemctl", "docker", "docker-compose", "podman", "podman-compose", "nerdctl"],
  ...["kubectl", "colima", "lima", "limactl", "orbctl", "vagrant", "multipass"],
  ...["nix", "nix-shell", "nix-build", "nix-env", "scp", "sftp", "mosh"],
  ...["sqlite", "sqlite3", "duckdb", "psql", "mysql"],
]);
// OpenClaw's version suffix (`-?\d+(\.\d+)*`), so python3.12, node22 and perl-5.36
// match their base names; an architecture suffix (python3-intel64) is stripped
// first.
const versionSuffix = /-?\d+(?:\.\d+)*$/;
const archSuffix =
  /-(?:intel64|intel|arm64|aarch64|x86_64|x86-64|amd64|i386|universal2?)$/;
const basename = (value) =>
  String(value || "")
    .split("/")
    .pop();
export function isInterpreter(file) {
  const name = basename(file)
    .toLowerCase()
    .replace(/\.exe$/, "");
  const bare = name.replace(archSuffix, "");
  return [name, bare, bare.replace(versionSuffix, "")].some(
    (candidate) => candidate.length > 0 && interpreterNames.has(candidate),
  );
}
// Flags that make an interpreter run code given on the command line.
const inlineFlag = /^(?:-[A-Za-z]*[ceEp]|--eval|--print|--command|--exec)(?:=|$)/;

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

// The Gateway's login PATH on top of the owner's (docs/assistant-shell-
// qualification.md (d)); used only to pin programs named without a path.
const systemPath = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The real path of an executable file, or null. */
export function resolveProgram(name, { cwd, pathDirs = [] } = {}) {
  const candidates = name.includes("/")
    ? [path.resolve(cwd || "/", name)]
    : [...pathDirs, ...systemPath]
        .filter((d) => path.isAbsolute(d))
        .map((d) => path.join(d, name));
  for (const candidate of candidates)
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch {}
  return null;
}

/** Whether AgentPier's user (the owner) can change or replace the program. */
export function ownerWritable(file) {
  for (const target of [file, path.dirname(file)])
    try {
      fs.accessSync(target, fs.constants.W_OK);
      return true;
    } catch {}
  return false;
}

/**
 * How "Always allow" is answered for a request whose allow-always OpenClaw
 * withheld: `{ kind: "paths", paths, writable }` writes one program-path entry per
 * program (`writable`: those the owner can change or replace);
 * `{ kind: "once", reason, program? }` resolves allow-once only, with reason
 * `inline`, `interpreter`, `unresolved` or `complex`.
 */
export function allowAlwaysPlan(
  payload,
  { pathDirs = [], resolve = resolveProgram, writable = ownerWritable } = {},
) {
  const command = typeof payload?.command === "string" ? payload.command.trim() : "";
  const risks = Array.isArray(payload?.riskKinds) ? payload.riskKinds : [];
  if (risks.includes("inline-eval") || /inline-eval/.test(payload?.warningText || ""))
    return { kind: "once", reason: "inline" };
  if (!command) return { kind: "once", reason: "unresolved" };
  const argvs = splitCommand(command);
  if (!argvs) return { kind: "once", reason: "complex" };
  for (const [program, ...args] of argvs) {
    if (!isInterpreter(program)) continue;
    return {
      kind: "once",
      reason: args.some((a) => inlineFlag.test(a)) ? "inline" : "interpreter",
      program: program.slice(0, 300),
    };
  }
  const paths = [];
  for (const [n, [program]] of argvs.entries()) {
    const real = resolve(program, { cwd: payload.cwd, pathDirs });
    if (!real)
      return { kind: "once", reason: "unresolved", program: program.slice(0, 300) };
    if (isInterpreter(real))
      return { kind: "once", reason: "interpreter", program: program.slice(0, 300) };
    // The first program must be the one OpenClaw resolved, or the PATH differs.
    if (n === 0 && payload.resolvedPath && real !== payload.resolvedPath) {
      let reported = null;
      try {
        reported = fs.realpathSync(payload.resolvedPath);
      } catch {}
      if (real !== reported)
        return { kind: "once", reason: "unresolved", program: program.slice(0, 300) };
    }
    if (!paths.includes(real)) paths.push(real);
  }
  return { kind: "paths", paths, writable: paths.filter((p) => writable(p)) };
}
