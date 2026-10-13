import path from "node:path";
import ts from "typescript";

// A static dependency graph over the files of one repository snapshot. Edges come
// from ES module imports (static, re-exports and dynamic imports of string
// literals) and from path references in the source text, such as a test that
// spawns `tests/fixtures/fake-codex-mcp.mjs` or reads `docs/screenshots/x.png`.
// Path references keep subprocess and fixture dependencies, which no import
// shows, inside the graph.

export const codeFile = /\.(?:m?js|cjs|jsx)$/;
const resolvable = ["", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const indexes = ["index.js", "index.jsx", "index.mjs"];
// A path-like token: segments of word characters, dots, @ and dashes, joined by
// slashes. It must contain a slash or end in a file extension to count.
const pathToken = /[\w@.-]+(?:\/[\w@.-]+)*\/?/g;
const extension = /\.[a-z][a-z0-9]{0,9}$/i;
// Bare file names this common resolve to too many files to mean one of them.
const maxBasenameMatches = 3;
// A directory reference adds an edge to every file below it, but only below
// directories this small: a mention of "server/" is not a dependency on it all.
const maxDirectoryFiles = 60;

// Module specifiers of one file: static imports, re-exports, dynamic imports
// and require calls of string literals. TypeScript's scanner reads JSX as well.
export function moduleSpecifiers(text) {
  return ts.preProcessFile(text, true, true).importedFiles.map((entry) => entry.fileName);
}

// The first syntax error of a module, or null.
export function syntaxError(file, text) {
  const { diagnostics } = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  });
  return diagnostics.length
    ? ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")
    : null;
}

export function pathTokens(text) {
  const tokens = new Set();
  for (const [token] of text.matchAll(pathToken))
    if (token.includes("/") || extension.test(token)) tokens.add(token);
  return tokens;
}

// Builds the graph for `files` (repository-relative paths, POSIX separators).
// `read(file)` returns the text of a code file. Returns the known files and
// `dependents(file)`, the files that import or name `file` directly.
export function buildGraph(files, read) {
  const known = new Set(files);
  const byBasename = new Map();
  const byDirectory = new Map();
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  for (const file of files) {
    add(byBasename, path.posix.basename(file), file);
    for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir))
      add(byDirectory, dir, file);
  }
  const reverse = new Map();
  const edge = (from, to) => {
    if (from !== to) add(reverse, to, from);
  };

  const resolveModule = (from, specifier) => {
    let base;
    if (specifier.startsWith("./") || specifier.startsWith("../"))
      base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    else if (specifier.startsWith("/")) base = specifier.slice(1);
    else return [];
    base = base.replace(/[?#].*$/, "");
    for (const suffix of resolvable) if (known.has(base + suffix)) return [base + suffix];
    for (const index of indexes)
      if (known.has(`${base}/${index}`)) return [`${base}/${index}`];
    // Unresolved: keep edges to the paths it could name, so deleting the
    // imported file still reaches its importers.
    return resolvable.map((suffix) => base + suffix);
  };

  // `loose` (for tests) also accepts root-relative paths, bare file names and
  // path tails; application code counts only paths relative to itself, since it
  // names files of user projects ("AGENTS.md") as often as its own.
  const resolveToken = (from, token, loose) => {
    const relative = token.startsWith("./") || token.startsWith("../");
    if (!loose && !relative) return [];
    const clean = token.replace(/^\.?\//, "").replace(/\/$/, "");
    const candidates = new Set();
    if (relative)
      candidates.add(
        path.posix.normalize(path.posix.join(path.posix.dirname(from), token)),
      );
    if (loose) candidates.add(path.posix.normalize(clean));
    const targets = [];
    for (const candidate of candidates) {
      if (candidate.startsWith("..")) continue;
      if (known.has(candidate)) targets.push(candidate);
      else if (byDirectory.has(candidate) && candidate.includes("/")) {
        const below = byDirectory.get(candidate);
        if (below.size <= maxDirectoryFiles) targets.push(...below);
      }
    }
    if (targets.length || !loose) return targets;
    if (!clean.includes("/")) {
      const matches = [...(byBasename.get(clean) || [])];
      return matches.length <= maxBasenameMatches ? matches : [];
    }
    // A path below some prefix, such as "features/agentbus/agentbus-opencode.js"
    // joined to a feature directory at run time.
    const suffixed = clean.split("/").length >= 2 && extension.test(clean);
    if (!suffixed) return [];
    const matches = [...(byBasename.get(path.posix.basename(clean)) || [])].filter(
      (file) => file.endsWith(`/${clean}`),
    );
    return matches.length <= maxBasenameMatches ? matches : [];
  };

  for (const file of files) {
    const text = codeFile.test(file) ? read(file) : null;
    if (typeof text !== "string") continue;
    for (const specifier of moduleSpecifiers(text))
      for (const target of resolveModule(file, specifier)) edge(file, target);
    // Tests name the fixtures and scripts they run. Application code also names
    // files, in messages and release manifests, so its references count only
    // for data files, not for code it would otherwise appear to depend on.
    const fromTests = file.startsWith("tests/");
    for (const token of pathTokens(text))
      for (const target of resolveToken(file, token, fromTests))
        if (fromTests || !codeFile.test(target)) edge(file, target);
  }
  return { files: known, dependents: (file) => reverse.get(file) || new Set() };
}

// Every file that reaches one of `starts` through the reverse graph. Files that
// match `skip` are neither entered nor walked through. Cycles end because each
// file is visited once.
export function reachingFiles(graph, starts, skip = null) {
  const seen = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    const file = queue.shift();
    for (const dependent of graph.dependents(file))
      if (!seen.has(dependent) && !skip?.test(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
  }
  return seen;
}
