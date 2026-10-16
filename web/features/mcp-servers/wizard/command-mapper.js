// Turns a guide's command (npx …, uvx …, pipx run …) into a package AgentPier installs
// itself, pinned and hash-checked, instead of a download at every start. Anything else
// stays an own command.
// Name and version rules mirror server/features/mcp-packages/package-spec.js, so a
// preselected version or name is one the install route accepts.
const exactSemver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const exactPep440 =
  /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i;
const npmNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const isNpmName = (name) => name.length <= 214 && npmNamePattern.test(name);
const isPypiName = (name) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/.test(name);
const isExactSemver = (version) => version.length <= 256 && exactSemver.test(version);
const isExactPep440 = (version) => version.length <= 128 && exactPep440.test(version);
const quietFlags = ["-y", "--yes", "-q", "--quiet"];
const resolverFlags = ["--with", "--python", "-p", "--with-requirements"];
const shellOperators = /[|&;<>`]|\$\(/;
// Options that point the runner at another registry or index, or run a shell line.
const npmOwnFlags = ["--registry", "-c", "--call"];
const pypiOwnFlags = [
  "--index",
  "--index-url",
  "-i",
  "--extra-index-url",
  "--default-index",
  "--find-links",
  "-f",
];
const hasOwnFlag = (arg, flags) =>
  flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
// A git, file, URL or alias source: not a registry version, range or tag.
const isSource = (text) => /[:/]/.test(text);

const baseName = (command) =>
  String(command ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();

/** Words of one command line; null when it needs a shell or is not one line. */
export function splitCommandLine(text) {
  const line = String(text ?? "").trim();
  if (!line || /[\r\n]/.test(line) || shellOperators.test(line)) return null;
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(current);
  return words;
}

/**
 * "pkg@1.2.3" or "@scope/pkg@1.2.3"; a scope's leading @ is not a separator. A source
 * outside the registry ("pkg@github:u/r", "pkg@file:…", "pkg@npm:other") keeps the whole
 * spec as its name, so it fails the name check and stays an own command.
 */
export function npmSpec(spec) {
  const at = spec.indexOf("@", 1);
  if (at < 0) return { name: spec, version: "" };
  const version = spec.slice(at + 1);
  return isSource(version)
    ? { name: spec, version: "" }
    : { name: spec.slice(0, at), version };
}

/**
 * "pkg==1.0", "pkg@1.0", "pkg[extra]>=1"; extras are reported, not kept. A direct
 * reference ("pkg @ git+https://…") keeps the whole spec as its name, so it fails the
 * name check and stays an own command.
 */
export function pypiSpec(spec) {
  const extras = /\[[^\]]*\]/.test(spec);
  const clean = spec.replace(/\[[^\]]*\]/, "").trim();
  const pinned = /^([^=<>!~@\s]+)\s*(?:==|@)\s*([^\s:/]+)$/.exec(clean);
  if (pinned) return { name: pinned[1], version: pinned[2], extras };
  const range = /^([^=<>!~@\s]+)\s*([=<>!~][^:/]*)$/.exec(clean);
  return range
    ? { name: range[1], version: range[2].replace(/\s+/g, ""), extras }
    : { name: clean, version: "", extras };
}

const own = (command, args, ignored = [], warnings = []) => ({
  kind: "command",
  command,
  version: "",
  program: null,
  args,
  ignored,
  warnings,
});

function npmRunner(runner, command, args, original, notes) {
  const ignored = [...notes.ignored, { key: runner, code: "runner" }];
  let pkg = null;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (hasOwnFlag(arg, npmOwnFlags)) return own(command, original.args, notes.ignored);
    if (quietFlags.includes(arg)) ignored.push({ key: arg, code: "yes" });
    else if (arg === "-p" || arg === "--package") pkg = args[(index += 1)] ?? "";
    else if (arg.startsWith("--package=")) pkg = arg.slice("--package=".length);
    else if (arg.startsWith("-")) ignored.push({ key: arg, code: "unknownFlag" });
    else break;
  }
  const first = args[index];
  const { name, version } = npmSpec(pkg ?? first ?? "");
  if (!isNpmName(name)) return own(command, original.args, notes.ignored);
  const exact = isExactSemver(version);
  return {
    kind: "npm",
    packageName: name,
    version: exact ? version : "",
    program: pkg ? (first ?? null) : null,
    args: args.slice(index + 1),
    ignored,
    warnings: exact ? [] : [{ code: "pinned" }],
  };
}

function pypiRunner(runner, command, args, original, notes, { spec = "--from" } = {}) {
  const ignored = [...notes.ignored, { key: runner, code: "runner" }];
  let from = null;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (hasOwnFlag(arg, pypiOwnFlags)) return own(command, original.args, notes.ignored);
    if (arg === spec) from = args[(index += 1)] ?? "";
    else if (arg.startsWith(`${spec}=`)) from = arg.slice(spec.length + 1);
    else if (resolverFlags.includes(arg)) {
      ignored.push({
        key: `${arg} ${args[index + 1] ?? ""}`.trim(),
        code: "resolverFlag",
      });
      index += 1;
    } else if (resolverFlags.some((flag) => arg.startsWith(`${flag}=`)))
      ignored.push({ key: arg, code: "resolverFlag" });
    else if (arg.startsWith("-")) ignored.push({ key: arg, code: "unknownFlag" });
    else break;
  }
  const first = args[index];
  const { name, version, extras } = pypiSpec(from ?? first ?? "");
  if (!isPypiName(name)) return own(command, original.args, notes.ignored);
  const exact = isExactPep440(version);
  return {
    kind: "pypi",
    packageName: name,
    version: exact ? version : "",
    program: from ? (first ?? null) : null,
    args: args.slice(index + 1),
    ignored,
    warnings: [
      ...(extras ? [{ code: "extras" }] : []),
      ...(exact ? [] : [{ code: "pinned" }]),
    ],
  };
}

/** A command and its arguments as a package, or as an own command. */
export function mapCommand(command, args = []) {
  const original = { command, args };
  const notes = { ignored: [] };
  let name = baseName(command);
  let rest = [...args];
  if (name === "cmd" && rest.length > 1 && /^\/c$/i.test(rest[0])) {
    notes.ignored.push({ key: "cmd /c", code: "cmdWrapper" });
    command = rest[1] ?? "";
    rest = rest.slice(2);
    name = baseName(command);
    original.command = command;
    original.args = rest;
  }
  if ((name === "pnpm" || name === "yarn") && rest[0] === "dlx")
    return npmRunner(`${name} dlx`, command, rest.slice(1), original, notes);
  if (name === "npx" || name === "bunx")
    return npmRunner(name, command, rest, original, notes);
  if (name === "uvx") return pypiRunner("uvx", command, rest, original, notes);
  if (name === "uv" && rest[0] === "tool" && rest[1] === "run")
    return pypiRunner("uv tool run", command, rest.slice(2), original, notes);
  if (name === "pipx" && rest[0] === "run")
    return pypiRunner("pipx run", command, rest.slice(1), original, notes, {
      spec: "--spec",
    });
  if (name === "docker" || name === "podman")
    return own(command, rest, notes.ignored, [{ code: "docker" }]);
  return own(command, rest, notes.ignored);
}
