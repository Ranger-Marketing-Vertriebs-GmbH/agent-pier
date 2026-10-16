# MCP Server Wizard – PR 2: Paste Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner paste the JSON block (or a single `npx`/`uvx`/`pipx` command line) from an install guide into the MCP wizard and get a pre-filled server draft with every dropped key, reference and placeholder named, plus a "This looks like a package" banner on the own-command step.

**Architecture:** A pure, deterministic browser parser (`paste-json.js` → `paste-parser.js` → `paste-entry.js` + `command-mapper.js` + `paste-placeholders.js`) turns untrusted text into wizard drafts without network, `eval` or HTML. The Paste screen is a new wizard step; the wizard state learns a `via: "paste"` entry so the step order becomes Source → Paste → set-up → Settings → …. Only the package name is looked up (`GET /mcp-packages/versions`); values stay in React memory until the normal save.

**Tech Stack:** JavaScript ES modules, React 18 JSX, `node:test` + `node:assert/strict`, fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-mcp-wizard-design.md` – sections "Paste parser" (accepted shapes, mapping rules, ignored keys, references and placeholders, edge cases, untrusted input limits), "User flows → Paste" and "Set up – own command", rollout stage 1b.

**Depends on:** PR 1 (`docs/superpowers/plans/2026-10-16-mcp-wizard-1-core.md`) merged to `main`. Branch `feat/mcp-wizard-paste` from `origin/main`.

## Global Constraints

- Platform: macOS or Linux, Node.js 22.13+. JavaScript ES modules, React JSX.
- Prettier: two-space indentation, double quotes, semicolons, trailing commas, 90-column target. Run `npm run format` and `npm run lint` before each commit.
- Every source and test file stays at or below 600 lines (`npm run check:structure`).
- All UI copy in `web/lib/i18n/en/mcp-wizard.js` and `web/lib/i18n/de/mcp-wizard.js` with identical keys and interpolation arguments, imported from `web/lib/i18n/messages/mcp-wizard.js`; no hardcoded copy; `tests/unit/i18n-catalogs.test.js` passes. Guide text (server names, descriptions from VS Code `inputs`) stays in its original language.
- The parser is pure: no network, no `eval`, no `Function`, no DOM, no `Date.now()`/random in its output (row keys use a counter passed in or created per call). Same input → same output.
- Untrusted input limits (spec): input ≤ 64 KiB, nesting depth ≤ 16, ≤ 20 servers, per server ≤ 100 args and ≤ 100 env/header entries, values ≤ 16 KiB; keys `__proto__`, `constructor`, `prototype` dropped; objects are `Object.create(null)` maps; control characters except tab rejected in values; everything rendered as text.
- References (`${…}`, `{env:…}`, `{file:…}`) are refused through PR 1's `wizard/value-references.js` (kept equal to the server by its contract test); a refused value becomes an empty, required field and is named only by its variable name.
- The pasted text is never logged, never sent, never stored outside the wizard reducer; it is dropped when the wizard closes. Only the package name goes to `GET /mcp-packages/versions`.
- Values are write-only after the save (Q3); masking uses the name heuristic and VS Code `password: true`.
- Not parsed (Q10): Codex TOML and `claude mcp add …` get the "This is not JSON…" state.
- Tests: `node:test` + strict assertions, fast-check properties, Playwright desktop plus a phone describe block (`viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true`); desktop-only behaviour `test.skip(isMobile, …)`. Isolated `page.route` fixtures only.
- No change to `cli-reconciler.js`, `cli-bindings.js`, `program-select.js`, `mcp-packages.js`, `package-install-job.js`, `mcp-server-draft.js`.
- Docs in the same PR (`docs/mcp.md`); PR description lists docs checked; screenshots via the `agent-pier-assets` repository.
- Commits `feat:`/`fix:`/`chore:`/`docs:` in English, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Linear history.
- Before opening the PR, delete this plan file; the spec and plans 3–4 stay (unfinished, tracked).

## Review Focus

1. **A guide block with a JSON comment or a trailing comma after the last server** (VS Code style) must parse; a comma inside a string value (`"--flag,other"`) must survive untouched. Pinned in Task 1.
2. **A fragment copied without the outer braces that ends in a comma** (`"opnsense": { … },`) must still be read. Pinned in Task 4.
3. **`npx -y @scope/pkg@latest --port 3000`**: the scope's `@` is not a version separator, `latest` pins to newest stable with the note, `--port 3000` stays as arguments. Pinned in Task 3.
4. **A secret value that looks real (`ghp_…`) in `args`** must stay (the owner may want it) but warn "Put tokens in settings or headers"; the same value under an unknown key must never appear in the result. Pinned in Task 4 (property).
5. **Pasting, choosing server 2 of 3, finishing it, then "Add another server"** must offer the remaining servers without pasting again; closing the wizard drops them. Pinned in Task 5 (unit) and Task 6 (browser).

## File Structure

Create:

| File                                                                                                                                                            | Responsibility                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `web/features/mcp-servers/wizard/paste-json.js`                                                                                                                 | `parseRelaxedJson(text)` – JSON + comments + trailing commas, depth cap, null-prototype objects, duplicate-key list, line/column errors. |
| `web/features/mcp-servers/wizard/paste-placeholders.js`                                                                                                         | `isPlaceholder(value)`, `looksLikeToken(value)`.                                                                                         |
| `web/features/mcp-servers/wizard/command-mapper.js`                                                                                                             | `splitCommandLine(text)`, `mapCommand(command, args)`, `npmSpec`, `pypiSpec`.                                                            |
| `web/features/mcp-servers/wizard/paste-entry.js`                                                                                                                | `mapEntry(key, entry, ctx)` – one server entry → draft + notes.                                                                          |
| `web/features/mcp-servers/wizard/paste-parser.js`                                                                                                               | `parsePaste(text, { taken })`, `pickServer(result, index)` – shape detection, limits, orchestration.                                     |
| `web/features/mcp-servers/wizard/PasteStep.jsx`                                                                                                                 | Paste screen: textarea, Read setup, result card, chooser.                                                                                |
| `web/features/mcp-servers/wizard/PasteNotes.jsx`                                                                                                                | Renders ignored/warning notes from codes.                                                                                                |
| `tests/unit/mcp-paste-json.test.js`, `mcp-paste-placeholders.test.js`, `mcp-command-mapper.test.js`, `mcp-paste-parser.test.js`, `mcp-paste-properties.test.js` | Unit and property tests.                                                                                                                 |
| `tests/fixtures/mcp-paste/` (`opnsense.json`, `vscode.jsonc`, `opencode.json`, `zed.json`, `several.json`)                                                      | Realistic guide blocks.                                                                                                                  |
| `tests/browser/mcp-wizard-paste.spec.js`                                                                                                                        | Browser coverage.                                                                                                                        |

Modify: `web/features/mcp-servers/wizard/wizard-state.js` (`via`, `paste`, actions), `SourceStep.jsx` (paste row), `OwnCommandStep.jsx` (banner, Docker note), `InstallStep.jsx` (`defaultProgram`), `DoneStep.jsx` (next pasted server), `McpWizard.jsx` (`screens.paste`), `mcp-wizard.css`, `web/lib/i18n/{en,de}/mcp-wizard.js`, `tests/unit/mcp-wizard-state.test.js`, `docs/mcp.md`.

## Parallel Groups

- **Group A (parallel):** Tasks 1, 2, 3, 7 (Task 7 owns the catalog additions).
- **Task 4** after 1–3 (parser uses all three).
- **Task 5** after 4 and 7 (wizard state + Paste screen).
- **Task 6** after 5 (own-command banner; touches `OwnCommandStep.jsx` only, but its browser test uses the paste fixture of Task 5).
- **Task 8** last.

---

### Task 1: Relaxed JSON reader

**Files:**

- Create: `web/features/mcp-servers/wizard/paste-json.js`
- Test: `tests/unit/mcp-paste-json.test.js`

**Interfaces:**

- Produces: `maxDepth = 16`; `class PasteJsonError extends Error { code: "invalidJson"|"tooDeep"; line; column }`; `parseRelaxedJson(text) → { value, duplicates: string[] }` where objects have a null prototype and never hold `__proto__`, `constructor` or `prototype` keys.

- [ ] **Step 1: Write the failing test**

`tests/unit/mcp-paste-json.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  maxDepth,
  parseRelaxedJson,
  PasteJsonError,
} from "../../web/features/mcp-servers/wizard/paste-json.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("strict JSON reads as JSON.parse does", () => {
  const text = '{"a":[1,-2.5e3,true,false,null,"x\\n\\u00e4"],"b":{}}';
  assert.deepEqual(plain(parseRelaxedJson(text).value), JSON.parse(text));
});

test("comments and trailing commas are allowed outside strings only", () => {
  const text = `{
    // a line comment
    "args": ["--flag,other", "// not a comment", "/* nor this */",], /* block */
  }`;
  assert.deepEqual(plain(parseRelaxedJson(text).value), {
    args: ["--flag,other", "// not a comment", "/* nor this */"],
  });
});

test("objects have no prototype and dangerous keys are dropped", () => {
  const { value } = parseRelaxedJson(
    '{"__proto__":{"x":1},"constructor":2,"prototype":3,"ok":4}',
  );
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(Object.keys(value), ["ok"]);
  assert.equal({}.x, undefined);
});

test("duplicate keys keep the last value and are reported", () => {
  const { value, duplicates } = parseRelaxedJson('{"a":1,"a":2,"b":{"c":1,"c":3}}');
  assert.equal(value.a, 2);
  assert.equal(value.b.c, 3);
  assert.deepEqual(duplicates, ["a", "c"]);
});

test("errors carry a line and column; depth is capped", () => {
  assert.throws(
    () => parseRelaxedJson('{\n  "a": 1\n  "b": 2\n}'),
    (error) =>
      error instanceof PasteJsonError &&
      error.code === "invalidJson" &&
      error.line === 3 &&
      error.column === 3,
  );
  for (const bad of [
    "",
    "{",
    '{"a":}',
    "[1 2]",
    "{'a':1}",
    '{"a":1}x',
    '"\u0001"',
    "{,}",
    "/* open",
  ])
    assert.throws(() => parseRelaxedJson(bad), PasteJsonError, JSON.stringify(bad));
  const deep = "[".repeat(maxDepth + 2) + "]".repeat(maxDepth + 2);
  assert.throws(
    () => parseRelaxedJson(deep),
    (error) => error.code === "tooDeep",
  );
  const ok = "[".repeat(maxDepth + 1) + "]".repeat(maxDepth + 1);
  assert.doesNotThrow(() => parseRelaxedJson(ok));
});

test("property: valid JSON round-trips; any text either parses or throws PasteJsonError", () => {
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 8 }), (value) => {
      const text = JSON.stringify(value);
      const expected = JSON.parse(text, (key, item) =>
        ["__proto__", "constructor", "prototype"].includes(key) ? undefined : item,
      );
      assert.deepEqual(plain(parseRelaxedJson(text).value), plain(expected));
    }),
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (text) => {
      try {
        parseRelaxedJson(text);
      } catch (error) {
        assert.ok(error instanceof PasteJsonError);
      }
    }),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/mcp-paste-json.test.js`
Expected: FAIL – module not found.

- [ ] **Step 3: Implement**

`web/features/mcp-servers/wizard/paste-json.js`:

```js
// A JSON reader for pasted setup blocks. It accepts exactly JSON plus what VS Code
// allows (// and /* */ comments, trailing commas) and nothing else. Objects are
// null-prototype maps without __proto__, constructor or prototype keys; nesting is
// capped. Nothing is evaluated.
export const maxDepth = 16;
const dropped = new Set(["__proto__", "constructor", "prototype"]);
const escapes = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function position(text, index) {
  let line = 1;
  let column = 1;
  for (let at = 0; at < index && at < text.length; at += 1)
    if (text[at] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  return { line, column };
}

export class PasteJsonError extends Error {
  constructor(code, index, text) {
    super(code);
    this.code = code;
    Object.assign(this, position(text, index));
  }
}

export function parseRelaxedJson(text) {
  let at = 0;
  const duplicates = [];
  const fail = (code = "invalidJson") => {
    throw new PasteJsonError(code, at, text);
  };
  const skip = () => {
    for (;;) {
      const char = text[at];
      if (
        char === " " ||
        char === "\t" ||
        char === "\n" ||
        char === "\r" ||
        char === "﻿"
      ) {
        at += 1;
      } else if (char === "/" && text[at + 1] === "/") {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end;
      } else if (char === "/" && text[at + 1] === "*") {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) fail();
        at = end + 2;
      } else return;
    }
  };
  const string = () => {
    let out = "";
    at += 1;
    for (;;) {
      if (at >= text.length) fail();
      const char = text[at];
      if (char === '"') {
        at += 1;
        return out;
      }
      if (char === "\\") {
        const escape = text[at + 1];
        if (escape === "u") {
          const hex = text.slice(at + 2, at + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          at += 6;
          continue;
        }
        if (!Object.hasOwn(escapes, escape ?? "")) fail();
        out += escapes[escape];
        at += 2;
        continue;
      }
      // Raw control characters are not JSON.
      if (char < " ") fail();
      out += char;
      at += 1;
    }
  };
  const number = () => {
    const match = numberPattern.exec(text.slice(at, at + 400));
    if (!match) fail();
    at += match[0].length;
    return Number(match[0]);
  };
  const list = (close, depth, item) => {
    at += 1;
    skip();
    if (text[at] === close) {
      at += 1;
      return;
    }
    for (;;) {
      item(depth + 1);
      skip();
      if (text[at] === ",") {
        at += 1;
        skip();
        if (text[at] === close) {
          at += 1;
          return;
        }
        continue;
      }
      if (text[at] === close) {
        at += 1;
        return;
      }
      fail();
    }
  };
  const value = (depth) => {
    if (depth > maxDepth) fail("tooDeep");
    skip();
    const char = text[at];
    if (char === "{") {
      const out = Object.create(null);
      const seen = new Set();
      list("}", depth, (inner) => {
        skip();
        if (text[at] !== '"') fail();
        const key = string();
        skip();
        if (text[at] !== ":") fail();
        at += 1;
        const item = value(inner);
        if (dropped.has(key)) return;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
        out[key] = item;
      });
      return out;
    }
    if (char === "[") {
      const out = [];
      list("]", depth, (inner) => out.push(value(inner)));
      return out;
    }
    if (char === '"') return string();
    if (char === "-" || (char >= "0" && char <= "9")) return number();
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ])
      if (text.startsWith(word, at)) {
        at += word.length;
        return result;
      }
    return fail();
  };
  const result = value(0);
  skip();
  if (at < text.length) fail();
  return { value: result, duplicates };
}
```

Note on depth: the root is depth 0, so `maxDepth + 1` nested arrays (depth 0…16) parse and `maxDepth + 2` fail, as the test states.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-paste-json.test.js`
Expected: PASS. (Duplicates are reported in reading order: the second `"a"` is read before `"b"`'s inner `"c"`.)

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard/paste-json.js tests/unit/mcp-paste-json.test.js
git commit -m "feat: read pasted MCP setup blocks as safe, relaxed JSON

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Placeholders and token-looking values

**Files:**

- Create: `web/features/mcp-servers/wizard/paste-placeholders.js`
- Test: `tests/unit/mcp-paste-placeholders.test.js`

**Interfaces:**

- Produces: `isPlaceholder(value): boolean`, `looksLikeToken(value): boolean`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlaceholder,
  looksLikeToken,
} from "../../web/features/mcp-servers/wizard/paste-placeholders.js";

test("obvious placeholders from guides are recognised", () => {
  for (const value of [
    "",
    "  ",
    "…",
    "...",
    "<your-token>",
    "<API_KEY>",
    "YOUR_API_KEY",
    "your_api_key",
    "your-api-key-here",
    "your token here",
    "xxx",
    "XXXXXXXX",
    "changeme",
    "TODO",
  ])
    assert.equal(isPlaceholder(value), true, JSON.stringify(value));
  for (const value of [
    "https://192.168.1.1",
    "false",
    "abc123",
    "x",
    "my-token",
    "todo-list",
  ])
    assert.equal(isPlaceholder(value), false, value);
  assert.equal(isPlaceholder(5), false);
});

test("token-looking values: known prefixes and long mixed strings", () => {
  for (const value of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11AAAAAAA0abcdefghij",
    "sk-proj-abcdefghijklmnop",
    "xoxb-123456789012-abcdefghijkl",
    "glpat-abcdefghijklmnop",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "d41d8cd98f00b204e9800998ecf8427e",
    "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123",
  ])
    assert.equal(looksLikeToken(value), true, value);
  for (const value of [
    "--port",
    "3000",
    "/usr/local/bin/server",
    "opnsense-mcp-server",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])
    assert.equal(looksLikeToken(value), false, value);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/mcp-paste-placeholders.test.js`
Expected: FAIL – module not found.

- [ ] **Step 3: Implement**

`web/features/mcp-servers/wizard/paste-placeholders.js`:

```js
// What install guides put where the owner's value belongs, and values that look like
// real credentials. Both only decide notes and empty required fields; nothing here
// decides security.
const placeholders = [
  /^$/,
  /^(?:…|\.\.\.)$/,
  /^<[^<>]+>$/,
  /^your[-_ ]/i,
  /[-_ ]here$/i,
  /^x{3,}$/i,
  /^changeme$/i,
  /^todo$/i,
];
const prefixes = /^(?:gh[pousr]_|github_pat_|sk-|sk_live_|xox[abprs]-|glpat-|AKIA)/;

export const isPlaceholder = (value) =>
  typeof value === "string" && placeholders.some((pattern) => pattern.test(value.trim()));

export function looksLikeToken(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^bearer\s+/i, "");
  if (prefixes.test(text) && text.length >= 16) return true;
  return /^[A-Za-z0-9+/=_-]{32,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-paste-placeholders.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard/paste-placeholders.js tests/unit/mcp-paste-placeholders.test.js
git commit -m "feat: recognise guide placeholders and token-looking values

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Command mapper

**Files:**

- Create: `web/features/mcp-servers/wizard/command-mapper.js`
- Test: `tests/unit/mcp-command-mapper.test.js`

**Interfaces:**

- Produces:
  - `splitCommandLine(text) → string[] | null` – words of one line with simple `"`/`'` quoting; `null` for empty, multi-line, unbalanced quotes or shell operators (`| & ; < > \``, `$(`).
  - `mapCommand(command, args) → Mapped`, `Mapped = { kind: "npm"|"pypi"|"command", command?, packageName?, version: string, program: string|null, args: string[], ignored: { key, code }[], warnings: { code }[] }`. Codes: ignored `runner`, `yes`, `cmdWrapper`, `resolverFlag`, `unknownFlag`; warnings `pinned`, `extras`, `docker`.
  - `npmSpec(spec) → { name, version }`, `pypiSpec(spec) → { name, version, extras }`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  mapCommand,
  npmSpec,
  pypiSpec,
  splitCommandLine,
} from "../../web/features/mcp-servers/wizard/command-mapper.js";

const codes = (notes) => notes.map((note) => note.code);

test("npx, bunx, pnpm dlx and yarn dlx become npm packages", () => {
  const npx = mapCommand("npx", ["-y", "@scope/pkg@latest", "--port", "3000"]);
  assert.equal(npx.kind, "npm");
  assert.equal(npx.packageName, "@scope/pkg");
  assert.equal(npx.version, "");
  assert.deepEqual(npx.args, ["--port", "3000"]);
  assert.deepEqual(codes(npx.ignored), ["runner", "yes"]);
  assert.deepEqual(codes(npx.warnings), ["pinned"]);
  const exact = mapCommand("bunx", ["server-x@1.2.3"]);
  assert.equal(exact.version, "1.2.3");
  assert.deepEqual(exact.warnings, []);
  assert.equal(mapCommand("pnpm", ["dlx", "server-x"]).kind, "npm");
  assert.equal(mapCommand("yarn", ["dlx", "server-x@^1"]).version, "");
  const program = mapCommand("npx", ["-p", "@scope/tools@2.0.0", "tool-a", "--x"]);
  assert.deepEqual(
    [program.packageName, program.version, program.program, program.args],
    ["@scope/tools", "2.0.0", "tool-a", ["--x"]],
  );
  assert.equal(mapCommand("npx", ["--package=server-x", "serve"]).program, "serve");
  assert.equal(mapCommand("/usr/local/bin/npx", ["-q", "server-x"]).kind, "npm");
});

test("uvx, uv tool run and pipx run become PyPI packages", () => {
  const uvx = mapCommand("uvx", ["mcp-server-fetch==2025.4.7", "--ignore-robots-txt"]);
  assert.deepEqual(
    [uvx.kind, uvx.packageName, uvx.version, uvx.args],
    ["pypi", "mcp-server-fetch", "2025.4.7", ["--ignore-robots-txt"]],
  );
  assert.equal(mapCommand("uvx", ["pkg@1.0"]).version, "1.0");
  assert.equal(mapCommand("uvx", ["pkg>=1.0"]).version, "");
  const from = mapCommand("uvx", ["--from", "pkg==0.4.1", "prog", "--flag"]);
  assert.deepEqual(
    [from.packageName, from.version, from.program, from.args],
    ["pkg", "0.4.1", "prog", ["--flag"]],
  );
  const resolver = mapCommand("uvx", ["--with", "extra", "--python", "3.12", "pkg"]);
  assert.deepEqual(codes(resolver.ignored), ["runner", "resolverFlag", "resolverFlag"]);
  const extras = mapCommand("uvx", ["pkg[cli]==1.0"]);
  assert.equal(extras.packageName, "pkg");
  assert.deepEqual(codes(extras.warnings), ["extras"]);
  assert.equal(mapCommand("uv", ["tool", "run", "pkg"]).kind, "pypi");
  assert.equal(mapCommand("pipx", ["run", "pkg"]).packageName, "pkg");
  const spec = mapCommand("pipx", ["run", "--spec", "pkg==1.0", "prog"]);
  assert.deepEqual([spec.packageName, spec.program], ["pkg", "prog"]);
});

test("cmd /c is unwrapped; docker stays an own command with a warning", () => {
  const wrapped = mapCommand("cmd", ["/c", "npx", "-y", "server-x"]);
  assert.equal(wrapped.kind, "npm");
  assert.deepEqual(codes(wrapped.ignored), ["cmdWrapper", "runner", "yes"]);
  const docker = mapCommand("docker", ["run", "-i", "--rm", "mcp/fetch"]);
  assert.deepEqual(
    [docker.kind, docker.command, docker.args],
    ["command", "docker", ["run", "-i", "--rm", "mcp/fetch"]],
  );
  assert.deepEqual(codes(docker.warnings), ["docker"]);
  assert.equal(mapCommand("podman", ["run"]).warnings[0].code, "docker");
  const own = mapCommand("node", ["/srv/server.js"]);
  assert.deepEqual(
    [own.kind, own.command, own.args],
    ["command", "node", ["/srv/server.js"]],
  );
});

test("a runner without a valid package name stays an own command", () => {
  for (const args of [[], ["-y"], ["Not A Name!"], ["../evil"]]) {
    const mapped = mapCommand("npx", args);
    assert.equal(mapped.kind, "command", JSON.stringify(args));
    assert.equal(mapped.command, "npx");
    assert.deepEqual(mapped.args, args);
  }
});

test("package specs keep a scope's @ and split PEP 440 versions", () => {
  assert.deepEqual(npmSpec("@a/b@1.0.0"), { name: "@a/b", version: "1.0.0" });
  assert.deepEqual(npmSpec("@a/b"), { name: "@a/b", version: "" });
  assert.deepEqual(pypiSpec("pkg[x,y] == 1.0"), {
    name: "pkg",
    version: "1.0",
    extras: true,
  });
  assert.deepEqual(pypiSpec("pkg~=1.0"), {
    name: "pkg",
    version: "~=1.0",
    extras: false,
  });
});

test("command lines split on spaces with quotes; shell operators are refused", () => {
  assert.deepEqual(splitCommandLine("npx -y \"my pkg\" 'a b'"), [
    "npx",
    "-y",
    "my pkg",
    "a b",
  ]);
  assert.deepEqual(splitCommandLine('uvx pkg ""'), ["uvx", "pkg", ""]);
  for (const line of [
    "",
    "a | b",
    "a && b",
    "a; b",
    "a > f",
    "echo `x`",
    "a $(b)",
    'a "open',
    "a\nb",
  ])
    assert.equal(splitCommandLine(line), null, line);
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (text) => {
      const words = splitCommandLine(text);
      assert.ok(words === null || words.every((word) => typeof word === "string"));
    }),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/mcp-command-mapper.test.js`
Expected: FAIL – module not found.

- [ ] **Step 3: Implement**

`web/features/mcp-servers/wizard/command-mapper.js`:

```js
// Turns a guide's command (npx …, uvx …, pipx run …) into a package AgentPier installs
// itself, pinned and hash-checked, instead of a download at every start. Anything else
// stays an own command.
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const exactPep440 = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i;
const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const pypiName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const quietFlags = ["-y", "--yes", "-q", "--quiet"];
const resolverFlags = ["--with", "--python", "-p", "--with-requirements"];
const shellOperators = /[|&;<>`]|\$\(/;

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

/** "pkg@1.2.3" or "@scope/pkg@1.2.3"; a scope's leading @ is not a separator. */
export function npmSpec(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0
    ? { name: spec.slice(0, at), version: spec.slice(at + 1) }
    : { name: spec, version: "" };
}

/** "pkg==1.0", "pkg@1.0", "pkg[extra]>=1"; extras are reported, not kept. */
export function pypiSpec(spec) {
  const extras = /\[[^\]]*\]/.test(spec);
  const clean = spec.replace(/\[[^\]]*\]/, "").trim();
  const pinned = /^([^=<>!~@\s]+)\s*(?:==|@)\s*(\S+)$/.exec(clean);
  if (pinned) return { name: pinned[1], version: pinned[2], extras };
  const range = /^([^=<>!~@\s]+)\s*([=<>!~].*)$/.exec(clean);
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
    if (quietFlags.includes(arg)) ignored.push({ key: arg, code: "yes" });
    else if (arg === "-p" || arg === "--package") pkg = args[(index += 1)] ?? "";
    else if (arg.startsWith("--package=")) pkg = arg.slice("--package=".length);
    else if (arg.startsWith("-")) ignored.push({ key: arg, code: "unknownFlag" });
    else break;
  }
  const first = args[index];
  const { name, version } = npmSpec(pkg ?? first ?? "");
  if (!npmName.test(name)) return own(command, original.args, notes.ignored);
  const exact = exactSemver.test(version);
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
  if (!pypiName.test(name)) return own(command, original.args, notes.ignored);
  const exact = exactPep440.test(version);
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
  if (name === "cmd" && /^\/c$/i.test(rest[0] ?? "")) {
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-command-mapper.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/mcp-servers/wizard/command-mapper.js tests/unit/mcp-command-mapper.test.js
git commit -m "feat: turn npx, uvx and pipx commands into installable MCP packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Paste parser (shapes, mapping, notes, limits)

**Files:**

- Create: `web/features/mcp-servers/wizard/paste-entry.js`, `web/features/mcp-servers/wizard/paste-parser.js`, `tests/fixtures/mcp-paste/opnsense.json`, `vscode.jsonc`, `opencode.json`, `zed.json`, `several.json`
- Test: `tests/unit/mcp-paste-parser.test.js`, `tests/unit/mcp-paste-properties.test.js`

**Interfaces:**

- Consumes: `parseRelaxedJson`, `PasteJsonError` (Task 1); `isPlaceholder`, `looksLikeToken` (Task 2); `mapCommand`, `splitCommandLine` (Task 3); PR 1's `sanitiseName`, `uniqueName`, `hasReference`, `referenceName`, `isSecretName`, `addressWarnings`, `guessTransport`.
- Produces:
  - `pasteLimit = 65536`, `serverLimit = 20`, `entryLimits = { args: 100, entries: 100, value: 16384 }`.
  - `parsePaste(text, { taken = [] }) → { ok: false, error: { code: "tooLong"|"invalidJson"|"tooDeep"|"noServer"|"notJson", line?, column? } } | { ok: true, servers: Parsed[], warnings: Note[] }`.
  - `Parsed = { key, name, draft?, refused?: "invalidArgs"|"noCommand", ignored: { key, code }[], warnings: { code, name?, ref?, to? }[] }`. `draft` holds wizard draft fields: `path` (`"package"|"remote"|"command"`), `name`, `transport`, `url`, `signIn`, `headers`, `command`, `argRows`, `cwd`, `env`, `source`, `registry`, `packageName`, `packageVersion`, `origin: "paste"`, `hints: { settings, program? }`. Rows are `{ key, name, value, fixed: true, bearer? }`; the sign-in header row has `key: "auth"`.
  - `pickServer(result, index) → Parsed & { others: string[] }` with block warnings merged.
  - Note codes (rendered by Task 5): ignored `runner`, `yes`, `cmdWrapper`, `resolverFlag`, `unknownFlag`, `unmanaged`, `consumed`, `envFile`, `oauth`, `unknown`, `invalidName`, `notString`; warnings `pinned`, `extras`, `docker`, `reference`, `placeholder`, `tokenInArgs`, `tokenInQuery`, `stringified`, `cwdRelative`, `guessed`, `duplicateKey`, `nameChanged`, `nameTaken`, `tooMany`, `controlChars`, `tooLongValue`, `tooManyServers`.

- [ ] **Step 1: Add the fixtures**

`tests/fixtures/mcp-paste/opnsense.json`:

```json
{
  "mcpServers": {
    "opnsense": {
      "command": "npx",
      "args": ["-y", "opnsense-mcp-server"],
      "env": {
        "OPNSENSE_URL": "https://192.168.1.1",
        "OPNSENSE_API_KEY": "your-api-key-here",
        "OPNSENSE_API_SECRET": "your-api-secret-here",
        "OPNSENSE_VERIFY_SSL": false,
        "OPNSENSE_ALLOW_WRITES": "false"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`tests/fixtures/mcp-paste/vscode.jsonc`:

```jsonc
{
  // VS Code mcp.json
  "inputs": [
    {
      "type": "promptString",
      "id": "gh-token",
      "description": "GitHub personal access token",
      "password": true,
    },
  ],
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${input:gh-token}" },
    },
    "fetch": {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "envFile": "${workspaceFolder}/.env",
    },
  },
}
```

`tests/fixtures/mcp-paste/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "local-files": {
      "type": "local",
      "command": ["node", "/srv/files/server.js", "--root", "/srv/data"],
      "environment": { "FILES_TOKEN": "{env:FILES_TOKEN}" },
      "enabled": true
    },
    "docs": {
      "type": "remote",
      "url": "https://docs.example.test/sse",
      "headers": { "X-Api-Key": "abc123" },
      "oauth": false
    }
  }
}
```

`tests/fixtures/mcp-paste/zed.json`:

```json
{
  "context_servers": {
    "postgres": {
      "command": {
        "path": "uvx",
        "args": ["mcp-server-postgres", "postgresql://localhost/db"],
        "env": { "PGPASSWORD": "<password>" }
      },
      "settings": {}
    }
  }
}
```

`tests/fixtures/mcp-paste/several.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem@2025.8.21",
        "/Users/me/Documents"
      ]
    },
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"], "timeout": 60 }
  }
}
```

- [ ] **Step 2: Write the failing table tests**

`tests/unit/mcp-paste-parser.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parsePaste,
  pickServer,
} from "../../web/features/mcp-servers/wizard/paste-parser.js";

const fixture = (name) =>
  fs.readFileSync(new URL(`../fixtures/mcp-paste/${name}`, import.meta.url), "utf8");
const codes = (notes) => notes.map((note) => note.code);
const rows = (list) => list.map(({ name, value }) => [name, value]);
const one = (text, options) => pickServer(parsePaste(text, options), 0);

test("Claude Desktop block: the OPNsense guide becomes an npm package draft", () => {
  const server = one(fixture("opnsense.json"));
  assert.equal(server.name, "opnsense");
  assert.equal(server.draft.path, "package");
  assert.deepEqual(
    [server.draft.registry, server.draft.packageName, server.draft.packageVersion],
    ["npm", "opnsense-mcp-server", ""],
  );
  assert.deepEqual(server.draft.argRows, []);
  assert.deepEqual(rows(server.draft.env), [
    ["OPNSENSE_URL", "https://192.168.1.1"],
    ["OPNSENSE_API_KEY", ""],
    ["OPNSENSE_API_SECRET", ""],
    ["OPNSENSE_VERIFY_SSL", "false"],
    ["OPNSENSE_ALLOW_WRITES", "false"],
  ]);
  assert.deepEqual(server.draft.hints.settings.OPNSENSE_API_KEY, {
    required: true,
    secret: true,
  });
  assert.deepEqual(server.draft.hints.settings.OPNSENSE_URL, {
    required: false,
    secret: false,
  });
  assert.deepEqual(
    server.ignored.map(({ key, code }) => [key, code]),
    [
      ["npx", "runner"],
      ["-y", "yes"],
      ["disabled", "unmanaged"],
      ["autoApprove", "unmanaged"],
    ],
  );
  assert.deepEqual(codes(server.warnings), [
    "placeholder",
    "placeholder",
    "stringified",
    "pinned",
  ]);
  assert.equal(server.draft.origin, "paste");
  assert.deepEqual(server.others, []);
});

test("VS Code block: inputs describe a referenced secret; envFile is not read", () => {
  const result = parsePaste(fixture("vscode.jsonc"));
  assert.equal(result.ok, true);
  const github = pickServer(result, 0);
  assert.equal(github.draft.path, "remote");
  assert.equal(github.draft.transport, "http");
  assert.equal(github.draft.signIn, "headers");
  assert.deepEqual(
    github.draft.headers.map(({ key, name, value, bearer }) => [
      key,
      name,
      value,
      bearer,
    ]),
    [["auth", "Authorization", "", true]],
  );
  assert.deepEqual(github.draft.hints.settings.Authorization, {
    required: true,
    secret: true,
    description: "GitHub personal access token",
  });
  assert.deepEqual(
    github.warnings.find((w) => w.code === "reference"),
    {
      code: "reference",
      name: "Authorization",
      ref: "gh-token",
    },
  );
  assert.deepEqual(github.others, ["fetch"]);
  const fetch = pickServer(result, 1);
  assert.equal(fetch.draft.registry, "pypi");
  assert.deepEqual(
    fetch.ignored.find((n) => n.code === "envFile"),
    { key: "envFile", code: "envFile" },
  );
});

test("OpenCode block: command arrays, environment and remote type", () => {
  const result = parsePaste(fixture("opencode.json"));
  const local = pickServer(result, 0);
  assert.equal(local.name, "local-files");
  assert.equal(local.draft.path, "command");
  assert.equal(local.draft.command, "node");
  assert.deepEqual(local.draft.argRows, ["/srv/files/server.js", "--root", "/srv/data"]);
  assert.deepEqual(rows(local.draft.env), [["FILES_TOKEN", ""]]);
  assert.deepEqual(codes(local.ignored), ["unmanaged"]);
  const docs = pickServer(result, 1);
  assert.equal(docs.draft.transport, "sse");
  assert.deepEqual(codes(docs.warnings), ["guessed"]);
  assert.deepEqual(rows(docs.draft.headers), [["X-Api-Key", "abc123"]]);
  assert.deepEqual(docs.ignored, [{ key: "oauth", code: "oauth" }]);
});

test("Zed block: command object with path, args and env", () => {
  const server = one(fixture("zed.json"));
  assert.equal(server.draft.registry, "pypi");
  assert.equal(server.draft.packageName, "mcp-server-postgres");
  assert.deepEqual(server.draft.argRows, ["postgresql://localhost/db"]);
  assert.deepEqual(rows(server.draft.env), [["PGPASSWORD", ""]]);
  assert.deepEqual(codes(server.ignored), ["runner", "unknown"]);
});

test("several servers: one at a time, Docker stays an own command", () => {
  const result = parsePaste(fixture("several.json"));
  assert.deepEqual(
    result.servers.map((s) => s.name),
    ["filesystem", "github", "fetch"],
  );
  const files = pickServer(result, 0);
  assert.equal(files.draft.packageVersion, "2025.8.21");
  assert.deepEqual(files.draft.argRows, ["/Users/me/Documents"]);
  assert.deepEqual(files.others, ["github", "fetch"]);
  const github = pickServer(result, 1);
  assert.equal(github.draft.path, "command");
  assert.equal(github.draft.command, "docker");
  assert.ok(codes(github.warnings).includes("docker"));
  assert.ok(codes(github.warnings).includes("reference"));
  assert.deepEqual(pickServer(result, 2).ignored, [
    { key: "uvx", code: "runner" },
    { key: "timeout", code: "unmanaged" },
  ]);
});

test("a single entry, a fragment and a command line", () => {
  const entry = one('{ "command": "uvx", "args": ["mcp-server-time"] }');
  assert.equal(entry.name, "");
  assert.equal(entry.draft.packageName, "mcp-server-time");
  const fragment = one(
    '"opnsense": { "command": "npx", "args": ["-y", "opnsense-mcp-server"] },',
  );
  assert.equal(fragment.name, "opnsense");
  const block = one(
    '"mcpServers": { "time": { "command": "uvx", "args": ["mcp-server-time"] } }',
  );
  assert.equal(block.name, "time");
  const line = one("pipx run mcp-server-time --local-timezone Europe/Berlin");
  assert.deepEqual(
    [line.draft.registry, line.draft.packageName, line.draft.argRows],
    ["pypi", "mcp-server-time", ["--local-timezone", "Europe/Berlin"]],
  );
});

test("remote entries: serverUrl, streamable types, Bearer header, token in the query", () => {
  const remote = one(
    '{"mcpServers":{"x":{"serverUrl":"https://x.test/mcp?api_key=1","type":"streamableHttp"}}}',
  );
  assert.equal(remote.draft.transport, "http");
  assert.deepEqual(codes(remote.warnings), ["tokenInQuery"]);
  assert.deepEqual(codes(remote.ignored), []);
  const bearer = one(
    '{"mcpServers":{"x":{"url":"https://x.test/mcp","headers":{"Authorization":"Bearer abc"}}}}',
  );
  assert.deepEqual(
    bearer.draft.headers.map(({ key, value, bearer: b }) => [key, value, b]),
    [["auth", "abc", true]],
  );
  const ref = one('{"mcpServers":{"x":{"url":"https://${HOST}/mcp"}}}');
  assert.equal(ref.draft.url, "");
  assert.deepEqual(ref.warnings[0], { code: "reference", name: "url", ref: "HOST" });
});

test("names are sanitised and kept unique against existing servers", () => {
  const server = one('{"mcpServers":{"my.server":{"command":"node","args":[]}}}', {
    taken: ["my-server"],
  });
  assert.equal(server.name, "my-server-2");
  assert.deepEqual(codes(server.warnings), ["nameChanged", "nameTaken"]);
});

test("bad values: non-string args refuse the entry; cwd must be absolute; caps hold", () => {
  const refused = parsePaste('{"mcpServers":{"x":{"command":"node","args":[1]}}}')
    .servers[0];
  assert.equal(refused.refused, "invalidArgs");
  assert.equal(refused.draft, undefined);
  const cwd = one('{"mcpServers":{"x":{"command":"node","cwd":"./here"}}}');
  assert.equal(cwd.draft.cwd, "");
  assert.deepEqual(codes(cwd.warnings), ["cwdRelative"]);
  const many = Array.from({ length: 150 }, (_, i) => `"a${i}"`).join(",");
  const capped = one(`{"mcpServers":{"x":{"command":"node","args":[${many}]}}}`);
  assert.equal(capped.draft.argRows.length, 100);
  assert.ok(codes(capped.warnings).includes("tooMany"));
  const control = one(
    '{"mcpServers":{"x":{"command":"node","env":{"A":"x\\u0007y","B":"t\\tab"}}}}',
  );
  assert.deepEqual(rows(control.draft.env), [
    ["A", ""],
    ["B", "t\tab"],
  ]);
  const servers = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`s${i}`, { command: "node" }]),
  );
  const wide = parsePaste(JSON.stringify({ mcpServers: servers }));
  assert.equal(wide.servers.length, 20);
  assert.deepEqual(codes(wide.warnings), ["tooManyServers"]);
  const token = one(
    '{"mcpServers":{"x":{"command":"node","args":["--token","ghp_abcdefghijklmnopqrstuvwxyz0123"]}}}',
  );
  assert.ok(codes(token.warnings).includes("tokenInArgs"));
});

test("errors: too long, invalid JSON with position, no server, TOML, claude mcp add", () => {
  assert.deepEqual(parsePaste("x".repeat(65537)), {
    ok: false,
    error: { code: "tooLong" },
  });
  assert.deepEqual(parsePaste('{\n "mcpServers": {\n  "a": { "command": "x" \n}'), {
    ok: false,
    error: { code: "invalidJson", line: 4, column: 2 },
  });
  assert.equal(parsePaste('{"theme":"dark"}').error.code, "noServer");
  assert.equal(parsePaste("").error.code, "noServer");
  assert.equal(parsePaste('[mcp_servers.fetch]\ncommand = "uvx"').error.code, "notJson");
  assert.equal(
    parsePaste("claude mcp add fetch -- uvx mcp-server-fetch").error.code,
    "notJson",
  );
  assert.equal(parsePaste("npx a | sh").error.code, "notJson");
  const deep = `{"mcpServers":${"[".repeat(20)}${"]".repeat(20)}}`;
  assert.equal(parsePaste(deep).error.code, "tooDeep");
  const dup = parsePaste(
    '{"mcpServers":{"a":{"command":"node"},"a":{"command":"uvx","args":["p"]}}}',
  );
  assert.equal(dup.servers.length, 1);
  assert.deepEqual(dup.warnings, [{ code: "duplicateKey", name: "a" }]);
});
```

`tests/unit/mcp-paste-properties.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { parsePaste } from "../../web/features/mcp-servers/wizard/paste-parser.js";
import { hasReference } from "../../web/features/mcp-servers/wizard/value-references.js";

const strings = (draft) =>
  [
    draft.url,
    draft.command,
    draft.cwd,
    ...(draft.argRows ?? []),
    ...(draft.env ?? []).map((row) => row.value),
    ...(draft.headers ?? []).map((row) => row.value),
  ].filter((value) => typeof value === "string");

const valueArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom(
    "${A}",
    "${env:B}",
    "{env:C}",
    "{file:/x}",
    "${input:id}",
    "your-key-here",
    "<token>",
  ),
  fc.integer(),
  fc.boolean(),
);
const entryArb = fc.record(
  {
    command: fc.oneof(
      fc.constantFrom("npx", "uvx", "node", "docker", "pipx"),
      fc.string({ maxLength: 12 }),
    ),
    args: fc.array(
      fc.oneof(fc.string({ maxLength: 20 }), fc.constantFrom("-y", "pkg@1.0.0", "${X}")),
      { maxLength: 6 },
    ),
    env: fc.dictionary(fc.string({ maxLength: 12 }), valueArb, { maxKeys: 6 }),
    url: fc.constantFrom("https://x.test/mcp", "http://h/sse", "${URL}"),
    headers: fc.dictionary(fc.string({ maxLength: 12 }), valueArb, { maxKeys: 4 }),
    cwd: fc.constantFrom("/abs", "rel", "${HOME}"),
  },
  { requiredKeys: [] },
);

test("never throws and stays inside its limits for any text", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 2000 }), (text) => {
      const result = parsePaste(text);
      assert.equal(typeof result.ok, "boolean");
    }),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 20 }), entryArb, { maxKeys: 25 }),
      (servers) => {
        const result = parsePaste(JSON.stringify({ mcpServers: servers }));
        if (!result.ok) return;
        assert.ok(result.servers.length <= 20);
        for (const server of result.servers) {
          assert.ok(
            server.name === "" || /^[A-Za-z][A-Za-z0-9_-]{0,29}$/.test(server.name),
          );
          if (!server.draft) continue;
          assert.ok(server.draft.argRows.length <= 100);
          assert.ok((server.draft.env ?? []).length <= 100);
          for (const value of strings(server.draft))
            assert.equal(hasReference(value), false, value);
        }
      },
    ),
  );
});

test("unknown keys are named, their values never appear", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 12 }), fc.uuid(), (key, secret) => {
      fc.pre(
        ![
          "command",
          "args",
          "env",
          "environment",
          "url",
          "serverUrl",
          "headers",
          "cwd",
          "type",
          "transport",
          "transportType",
        ].includes(key),
      );
      const text = JSON.stringify({
        mcpServers: { x: { command: "node", [key]: `SECRET-${secret}` } },
      });
      const result = parsePaste(text);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`SECRET-${secret}`));
    }),
  );
});

test("the same text always gives the same result", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 10 }), entryArb, { maxKeys: 4 }),
      (servers) => {
        const text = JSON.stringify({ mcpServers: servers });
        assert.deepEqual(
          JSON.parse(JSON.stringify(parsePaste(text))),
          JSON.parse(JSON.stringify(parsePaste(text))),
        );
      },
    ),
  );
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/unit/mcp-paste-parser.test.js tests/unit/mcp-paste-properties.test.js`
Expected: FAIL – modules not found.

- [ ] **Step 4: Implement the entry mapper**

`web/features/mcp-servers/wizard/paste-entry.js`:

```js
import { mapCommand } from "./command-mapper.js";
import { isPlaceholder, looksLikeToken } from "./paste-placeholders.js";
import { sanitiseName, uniqueName } from "./server-name.js";
import { addressWarnings, isSecretName } from "./setting-hints.js";
import { hasReference, referenceName } from "./value-references.js";
import { guessTransport } from "./wizard-state.js";

// One server entry from a guide → a wizard draft with every dropped key, reference
// and placeholder named. Values are taken as literals or left empty and required.
export const entryLimits = { args: 100, entries: 100, value: 16384 };
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const control = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const unmanaged = new Set([
  "disabled",
  "enabled",
  "autoApprove",
  "alwaysAllow",
  "timeout",
  "trust",
  "includeTools",
  "excludeTools",
]);
const handled = new Set([
  "command",
  "args",
  "env",
  "environment",
  "cwd",
  "url",
  "serverUrl",
  "headers",
  "type",
  "transport",
  "transportType",
]);
const remoteTypes = {
  http: "http",
  "streamable-http": "http",
  streamableHttp: "http",
  sse: "sse",
};
const stdioTypes = new Set(["stdio", "local"]);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shown = (key) => String(key).slice(0, 60);
const refuse = (code) => Object.assign(new Error(code), { code });

/** A literal value, or empty + required with the reason; null drops the setting. */
function literal(name, raw, { notes, inputs, header }) {
  let value = raw;
  if (typeof value === "number" || typeof value === "boolean") {
    notes.warnings.push({ code: "stringified", name });
    value = String(value);
  }
  if (typeof value !== "string") {
    notes.ignored.push({ key: shown(name), code: "notString" });
    return null;
  }
  if (value.length > entryLimits.value) {
    notes.warnings.push({ code: "tooLongValue", name });
    return { value: "", required: true };
  }
  if (control.test(value)) {
    notes.warnings.push({ code: "controlChars", name });
    return { value: "", required: true };
  }
  if (hasReference(value)) {
    const input = /\$\{input:([^}]+)\}/.exec(value)?.[1];
    notes.warnings.push({ code: "reference", name, ref: referenceName(value) });
    const described = input && inputs[input];
    return {
      value: "",
      required: true,
      ...(described
        ? { description: described.description, secret: described.password === true }
        : {}),
    };
  }
  if (isPlaceholder(header ? value.replace(/^bearer\s+/i, "") : value)) {
    notes.warnings.push({ code: "placeholder", name });
    return { value: "", required: true };
  }
  return { value };
}

function settingRows(map, kind, context) {
  const rows = [];
  const settings = {};
  if (map === undefined) return { rows, settings };
  if (!isRecord(map)) {
    context.notes.ignored.push({
      key: kind === "header" ? "headers" : "env",
      code: "notString",
    });
    return { rows, settings };
  }
  const names = Object.keys(map);
  if (names.length > entryLimits.entries)
    context.notes.warnings.push({ code: "tooMany" });
  for (const name of names.slice(0, entryLimits.entries)) {
    if (!(kind === "header" ? headerName : envName).test(name)) {
      context.notes.ignored.push({ key: shown(name), code: "invalidName" });
      continue;
    }
    const raw = map[name];
    const result = literal(name, raw, { ...context, header: kind === "header" });
    if (!result) continue;
    const bearer =
      kind === "header" &&
      /^authorization$/i.test(name) &&
      /^bearer\s+/i.test(String(raw));
    rows.push({
      key: bearer ? "auth" : context.nextKey(),
      name,
      value: bearer ? result.value.replace(/^bearer\s+/i, "") : result.value,
      fixed: true,
      ...(bearer ? { bearer: true } : {}),
    });
    settings[name] = {
      required: result.required === true,
      secret: result.secret === true || isSecretName(name),
      ...(result.description
        ? { description: String(result.description).slice(0, 500) }
        : {}),
    };
  }
  return { rows, settings };
}

function argumentRows(list, { notes }) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string"))
    throw refuse("invalidArgs");
  if (list.length > entryLimits.args) notes.warnings.push({ code: "tooMany" });
  return list.slice(0, entryLimits.args).map((arg) => {
    if (arg.length > entryLimits.value || control.test(arg)) {
      notes.warnings.push({ code: "controlChars", name: "args" });
      return "";
    }
    if (hasReference(arg)) {
      notes.warnings.push({ code: "reference", name: "args", ref: referenceName(arg) });
      return "";
    }
    if (looksLikeToken(arg)) notes.warnings.push({ code: "tokenInArgs" });
    return arg;
  });
}

function remoteDraft(url, entry, type, context) {
  const { notes } = context;
  let transport = remoteTypes[type];
  if (!transport) {
    transport = guessTransport(url);
    if (transport === "sse") notes.warnings.push({ code: "guessed" });
  }
  let address = url;
  if (hasReference(url)) {
    notes.warnings.push({ code: "reference", name: "url", ref: referenceName(url) });
    address = "";
  } else if (addressWarnings(url).includes("tokenInQuery"))
    notes.warnings.push({ code: "tokenInQuery" });
  const { rows, settings } = settingRows(entry.headers, "header", context);
  return {
    path: "remote",
    transport,
    source: "command",
    url: address,
    signIn: rows.length ? "headers" : "none",
    headers: rows,
    hints: { settings },
  };
}

function stdioDraft(entry, context) {
  const { notes } = context;
  let command = entry.command;
  let args = entry.args;
  let env = entry.env ?? entry.environment;
  if (Array.isArray(command)) {
    if (!command.length || command.some((item) => typeof item !== "string"))
      throw refuse("invalidArgs");
    args = [...command.slice(1), ...(Array.isArray(entry.args) ? entry.args : [])];
    command = command[0];
  } else if (isRecord(command)) {
    // Zed: { path, args, env }.
    args = command.args;
    env = command.env ?? env;
    command = command.path;
  }
  if (typeof command !== "string" || !command.trim() || control.test(command))
    throw refuse("noCommand");
  const list = argumentRows(args, context);
  // A command that refers to another setting is not taken over either.
  const commandReference = hasReference(command);
  if (commandReference)
    notes.warnings.push({
      code: "reference",
      name: "command",
      ref: referenceName(command),
    });
  const { rows, settings } = settingRows(env, "env", context);
  let cwd = "";
  if (entry.cwd !== undefined) {
    if (
      typeof entry.cwd === "string" &&
      entry.cwd.startsWith("/") &&
      !hasReference(entry.cwd)
    )
      cwd = entry.cwd;
    else notes.warnings.push({ code: "cwdRelative" });
  }
  const mapped = commandReference
    ? {
        kind: "command",
        command: "",
        args: list,
        ignored: [],
        warnings: [],
        program: null,
      }
    : mapCommand(command.trim(), list);
  notes.ignored.push(...mapped.ignored);
  notes.warnings.push(...mapped.warnings);
  const common = {
    transport: "stdio",
    env: rows,
    argRows: mapped.args,
    cwd,
    hints: { settings, ...(mapped.program ? { program: mapped.program } : {}) },
  };
  if (mapped.kind === "command")
    return { ...common, path: "command", source: "command", command: mapped.command };
  return {
    ...common,
    path: "package",
    source: "package",
    registry: mapped.kind,
    packageName: mapped.packageName,
    packageVersion: mapped.version,
  };
}

/**
 * `key` is the entry's name in the block ("" for a single entry). `nextKey` makes the
 * row keys; the parser gives each server its own counter so results are deterministic.
 */
export function mapEntry(key, entry, { taken = [], inputs = {}, nextKey }) {
  const notes = { ignored: [], warnings: [] };
  const base = sanitiseName(key);
  const name = base ? uniqueName(base, taken) : "";
  if (base && base !== key)
    notes.warnings.push({ code: "nameChanged", name: shown(key), to: base });
  if (name !== base) notes.warnings.push({ code: "nameTaken", name: base, to: name });
  const context = { notes, inputs, nextKey };
  const type = [entry.type, entry.transport, entry.transportType].find(
    (value) => typeof value === "string",
  );
  const url = [entry.url, entry.serverUrl].find((value) => typeof value === "string");
  let draft;
  try {
    draft =
      url !== undefined && !stdioTypes.has(type)
        ? remoteDraft(url, entry, type, context)
        : stdioDraft(entry, context);
  } catch (error) {
    if (!error.code) throw error;
    return { key: shown(key), name, refused: error.code, ...notes };
  }
  if (entry.transportType !== undefined)
    notes.ignored.push({ key: "transportType", code: "consumed" });
  for (const field of Object.keys(entry)) {
    if (handled.has(field)) continue;
    const code = unmanaged.has(field)
      ? "unmanaged"
      : field === "envFile"
        ? "envFile"
        : field === "oauth"
          ? "oauth"
          : "unknown";
    notes.ignored.push({ key: shown(field), code });
  }
  return { key: shown(key), name, draft: { ...draft, name, origin: "paste" }, ...notes };
}
```

- [ ] **Step 5: Implement the parser**

`web/features/mcp-servers/wizard/paste-parser.js`:

```js
import { splitCommandLine } from "./command-mapper.js";
import { mapEntry } from "./paste-entry.js";
import { parseRelaxedJson, PasteJsonError } from "./paste-json.js";

// Reads a guide's setup block in this browser: no network, no eval, deterministic.
export const pasteLimit = 64 * 1024;
export const serverLimit = 20;
const blocks = ["mcpServers", "servers", "mcp", "context_servers"];
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isEntry = (value) =>
  isRecord(value) &&
  (value.command !== undefined ||
    typeof value.url === "string" ||
    typeof value.serverUrl === "string");
const failure = (code, extra = {}) => ({ ok: false, error: { code, ...extra } });

function readJson(text) {
  try {
    return parseRelaxedJson(text);
  } catch (error) {
    const trimmed = text.trim();
    if (!(error instanceof PasteJsonError) || /^[{[]/.test(trimmed)) throw error;
    // A fragment such as "mcpServers": {…} or "opnsense": {…}, (outer braces missing).
    try {
      return parseRelaxedJson(`{${trimmed.replace(/,\s*$/, "")}}`);
    } catch {
      throw error;
    }
  }
}

function entriesOf(root) {
  if (!isRecord(root)) return [];
  for (const block of blocks)
    if (isRecord(root[block])) {
      const list = Object.entries(root[block]).filter(([, value]) => isRecord(value));
      if (list.length) return list;
    }
  if (isEntry(root)) return [["", root]];
  return Object.entries(root).filter(([, value]) => isEntry(value));
}

function inputsOf(root) {
  if (!isRecord(root) || !Array.isArray(root.inputs)) return {};
  const inputs = Object.create(null);
  for (const input of root.inputs)
    if (isRecord(input) && typeof input.id === "string")
      inputs[input.id] = {
        description: typeof input.description === "string" ? input.description : "",
        password: input.password === true,
      };
  return inputs;
}

function finish(entries, { duplicates = [], taken, inputs = {} }) {
  const used = [...taken];
  const servers = entries.slice(0, serverLimit).map(([key, entry], index) => {
    let n = 0;
    const server = mapEntry(key, entry, {
      taken: used,
      inputs,
      nextKey: () => `paste-${index}-${++n}`,
    });
    if (server.name) used.push(server.name);
    return server;
  });
  return {
    ok: true,
    servers,
    warnings: [
      ...(entries.length > serverLimit ? [{ code: "tooManyServers" }] : []),
      ...duplicates.map((name) => ({
        code: "duplicateKey",
        name: String(name).slice(0, 60),
      })),
    ],
  };
}

/** The servers in a pasted block, or why none could be read. */
export function parsePaste(text, { taken = [] } = {}) {
  if (typeof text !== "string") return failure("noServer");
  if (text.length > pasteLimit) return failure("tooLong");
  const trimmed = text.trim();
  if (!trimmed) return failure("noServer");
  // Codex TOML and `claude mcp add` are a follow-up (decision Q10).
  if (/^\s*\[\[?mcp_servers/m.test(trimmed) || /^claude\s+mcp\s+add\b/.test(trimmed))
    return failure("notJson");
  if (!/^[{["]/.test(trimmed)) {
    const words = splitCommandLine(trimmed);
    if (!words?.length) return failure("notJson");
    return finish([["", { command: words[0], args: words.slice(1) }]], { taken });
  }
  let parsed;
  try {
    parsed = readJson(text);
  } catch (error) {
    if (error instanceof PasteJsonError)
      return failure(
        error.code,
        error.code === "invalidJson" ? { line: error.line, column: error.column } : {},
      );
    throw error;
  }
  const entries = entriesOf(parsed.value);
  if (!entries.length) return failure("noServer");
  return finish(entries, {
    duplicates: parsed.duplicates,
    taken,
    inputs: inputsOf(parsed.value),
  });
}

/** One server of a result with the block's warnings, and the other servers' names. */
export function pickServer(result, index = 0) {
  const server = result.servers[index];
  return {
    ...server,
    warnings: [...result.warnings, ...server.warnings],
    others: result.servers
      .filter((_, at) => at !== index)
      .map((item) => item.name || item.key),
  };
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `node --test tests/unit/mcp-paste-parser.test.js tests/unit/mcp-paste-properties.test.js`
Expected: PASS. If an expected note order differs, check the order rules: command-mapper notes come after value notes for the same entry (env/args are read before `mapCommand`), and unknown/unmanaged keys come last in the order of the entry's keys. Fix the implementation, not the test, unless the test contradicts these rules.

- [ ] **Step 7: Commit**

```bash
git add web/features/mcp-servers/wizard/paste-entry.js web/features/mcp-servers/wizard/paste-parser.js tests/fixtures/mcp-paste tests/unit/mcp-paste-parser.test.js tests/unit/mcp-paste-properties.test.js
git commit -m "feat: parse MCP setup blocks from install guides in the browser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Paste screen and wizard entry

**Files:**

- Create: `web/features/mcp-servers/wizard/PasteStep.jsx`, `web/features/mcp-servers/wizard/PasteNotes.jsx`, `tests/browser/mcp-wizard-paste.spec.js`
- Modify: `web/features/mcp-servers/wizard/wizard-state.js`, `SourceStep.jsx`, `InstallStep.jsx`, `DoneStep.jsx`, `McpWizard.jsx`, `mcp-wizard.css`, `tests/unit/mcp-wizard-state.test.js`

**Interfaces:**

- Consumes: `parsePaste`, `pickServer` (Task 4); copy from Task 7; `useMcpPackageVersions`, `newestStable`; PR 1 StepProps.
- Produces (wizard state):
  - State gains `via: null|"paste"` and `paste: { text: string, result: ParseResult|null, index: number }`.
  - `stepOrder(path, via)`: with `via === "paste"` → `["source", "paste", …stepOrder(path).slice(1)]`; with no path yet → `["source", "paste"]`. All PR 1 callers pass `state.via`.
  - Actions: `via { via }`, `pasteText { text }`, `pasteResult { result, index }`, `pasted { draft }` (sets `path = draft.path`, merges the draft over the initial draft and the path values, visits `paste`, the set-up step and `settings`), `reset { keepPaste? }`.
  - `isDirty(state)` is also true while paste text is typed.

- [ ] **Step 1: Unit tests for the state**

Append to `tests/unit/mcp-wizard-state.test.js`:

```js
test("paste is its own entry: Source → Paste → set-up → Settings", () => {
  const typed = run([
    { type: "via", via: "paste" },
    { type: "pasteText", text: "{}" },
  ]);
  assert.deepEqual(stepOrder(null, "paste"), ["source", "paste"]);
  assert.equal(reachable(typed, "paste"), true);
  assert.equal(isDirty(typed), true);
  const pasted = run(
    [
      {
        type: "pasted",
        draft: {
          path: "package",
          name: "opnsense",
          packageName: "opnsense-mcp-server",
          origin: "paste",
        },
      },
    ],
    typed,
  );
  assert.deepEqual(stepOrder(pasted.path, pasted.via), [
    "source",
    "paste",
    "package",
    "settings",
    "install",
    "connect",
    "done",
  ]);
  assert.equal(pasted.draft.transport, "stdio");
  assert.equal(pasted.draft.packageName, "opnsense-mcp-server");
  assert.equal(pasted.draft.origin, "paste");
  assert.equal(reachable(pasted, "settings"), true);
  assert.equal(previousStep(pasted, "settings"), "package");
  assert.equal(previousStep(pasted, "package"), "paste");
  assert.equal(run([{ type: "choose", path: "remote" }], pasted).via, null);
});

test("Add another server keeps the pasted block when asked", () => {
  const result = { ok: true, servers: [{ name: "a" }, { name: "b" }], warnings: [] };
  const state = run([
    { type: "via", via: "paste" },
    { type: "pasteText", text: "x" },
    { type: "pasteResult", result, index: 0 },
  ]);
  const kept = run([{ type: "reset", keepPaste: true }], state);
  assert.deepEqual(kept.paste, { text: "x", result, index: 0 });
  assert.equal(kept.via, "paste");
  assert.equal(reachable(kept, "paste"), true);
  assert.deepEqual(run([{ type: "reset" }], state).paste, {
    text: "",
    result: null,
    index: 0,
  });
});
```

Run: `node --test tests/unit/mcp-wizard-state.test.js`
Expected: FAIL.

- [ ] **Step 2: Implement the state changes**

In `wizard-state.js`:

```js
export const stepOrder = (path, via = null) => {
  const order = orders[path] ?? ["source"];
  if (via !== "paste") return order;
  return path ? ["source", "paste", ...order.slice(1)] : ["source", "paste"];
};
```

Replace every `stepOrder(state.path)` in `reachable`, `fallbackStep`, `nextStep` and `previousStep` with `stepOrder(state.path, state.via)`. In `initialWizard()` add `via: null` and `paste: { text: "", result: null, index: 0 }`. New and changed cases:

```js
    case "choose":
      return {
        ...state,
        path: action.path,
        via: null,
        visited: ["source", action.path],
        draft: { ...state.draft, ...pathValues[action.path] },
        fieldError: null,
      };
    case "via":
      return { ...state, via: action.via, path: null, visited: ["source", action.via] };
    case "pasteText":
      return { ...state, paste: { ...state.paste, text: action.text } };
    case "pasteResult":
      return { ...state, paste: { ...state.paste, result: action.result, index: action.index } };
    case "pasted": {
      const { path, ...values } = action.draft;
      return {
        ...state,
        path,
        visited: ["source", "paste", path, "settings"],
        draft: { ...initialWizard().draft, ...pathValues[path], ...values },
        fieldError: null,
      };
    }
    case "reset":
      return action.keepPaste && state.paste.result
        ? { ...initialWizard(), via: "paste", visited: ["source", "paste"], paste: state.paste }
        : initialWizard();
```

and replace `isDirty`:

```js
export const isDirty = (state) =>
  (Boolean(state.path) || Boolean(state.paste?.text)) && !state.serverId;
```

Run: `node --test tests/unit/mcp-wizard-state.test.js`
Expected: PASS.

- [ ] **Step 3: Write the failing browser spec**

`tests/browser/mcp-wizard-paste.spec.js`:

```js
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { fits, openWizard, phone, primary, wizardSetup } from "./mcp-wizard-fixture.js";

const fixture = (name) =>
  fs.readFileSync(new URL(`../fixtures/mcp-paste/${name}`, import.meta.url), "utf8");

async function paste(page, text) {
  const wizard = await openWizard(page);
  await wizard.getByRole("button", { name: "Paste setup from a guide" }).click();
  await expect(
    wizard.getByRole("heading", { level: 1, name: "Paste the setup" }),
  ).toBeFocused();
  await wizard.getByLabel("Setup from the guide").fill(text);
  await wizard.getByRole("button", { name: "Read setup" }).click();
  return wizard;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the OPNsense guide becomes a package with named gaps, nothing sent", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await paste(page, fixture("opnsense.json"));
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByLabel("Name", { exact: true })).toHaveValue("opnsense");
      await expect(card.getByText("npm package opnsense-mcp-server")).toBeVisible();
      await expect(
        card.getByText("Pinned to an exact version when you install."),
      ).toBeVisible();
      await expect(
        card.getByText("The guide shows a placeholder for OPNSENSE_API_KEY."),
      ).toBeVisible();
      const dropped = card.getByRole("list", { name: "Not taken over" });
      await expect(
        dropped.getByText(/npx – AgentPier installs the package itself/),
      ).toBeVisible();
      await expect(dropped.getByText("-y – Only needed for npx.")).toBeVisible();
      await expect(dropped.getByText(/autoApprove/)).toBeVisible();
      await expect(card.getByText(/Published by Jane Doe, jdoe/)).toBeVisible();
      await expect(
        card.getByText(
          "All values are stored on this computer only and are never shown again.",
        ),
      ).toBeVisible();
      const sent = state.requests.filter(
        (r) => r.path !== "/api/mcp-servers" && r.path !== "/api/mcp-servers/cli-finds",
      );
      expect([...new Set(sent.map((r) => r.path))]).toEqual([
        "/api/mcp-packages/versions",
      ]);
      expect(JSON.stringify(state.requests)).not.toContain("192.168.1.1");
      await fits(page);
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for opnsense" }),
      ).toBeVisible();
      const key = wizard.locator(".mcp-setting", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("Required")).toBeVisible();
      await expect(key.getByText("Secret")).toBeVisible();
      await expect(
        wizard
          .locator(".mcp-setting", { hasText: "OPNSENSE_ALLOW_WRITES" })
          .getByText(/decides whether the server may change things/),
      ).toBeVisible();
      await primary(wizard).click();
      await expect(key.getByRole("alert")).toHaveText("Needed to start the server.");
      await key.getByLabel("Value", { exact: true }).fill("k");
      await wizard
        .locator(".mcp-setting", { hasText: "OPNSENSE_API_SECRET" })
        .getByLabel("Value", { exact: true })
        .fill("s");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=install/);
      await page.goBack();
      await expect(page).toHaveURL(/step=settings/);
      await wizard.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/step=package/);
      await expect(wizard.getByLabel("Package", { exact: true })).toHaveValue(
        "opnsense-mcp-server",
      );
    });

    test("several servers are set up one at a time", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await paste(page, fixture("several.json"));
      await expect(
        wizard.getByText(
          "2 more servers in this block: github, fetch – set them up one at a time",
        ),
      ).toBeVisible();
      await wizard.getByRole("radio", { name: "github" }).check();
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByText("Own command docker")).toBeVisible();
      await expect(card.getByText(/Docker is not supported as a package/)).toBeVisible();
      await expect(
        card.getByText(
          /GITHUB_PERSONAL_ACCESS_TOKEN points to another setting \(GITHUB_TOKEN\)/,
        ),
      ).toBeVisible();
    });

    test("invalid JSON names line and column; TOML and shell lines are not understood", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await paste(
        page,
        '{\n "mcpServers": {\n  "a": { "command": "x" \n}',
      );
      await expect(wizard.getByRole("alert")).toHaveText(
        "This is not valid JSON. Copy the whole block including the braces { }. Line 4, column 2.",
      );
      await wizard
        .getByLabel("Setup from the guide")
        .fill('[mcp_servers.fetch]\ncommand = "uvx"');
      await wizard.getByRole("button", { name: "Read setup" }).click();
      await expect(wizard.getByRole("alert")).toHaveText(
        "This is not JSON. Paste the JSON variant from the guide, or set the server up by hand.",
      );
    });

    test("a single command line becomes a PyPI package", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await paste(page, "uvx mcp-server-fetch --ignore-robots-txt");
      const card = wizard.getByRole("region", { name: "Here is what we found" });
      await expect(card.getByText("PyPI package mcp-server-fetch")).toBeVisible();
      await expect(card.getByText("--ignore-robots-txt")).toBeVisible();
      await expect(card.getByText(/Published by/)).toBeVisible();
      await card.getByLabel("Name", { exact: true }).fill("fetch");
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for fetch" }),
      ).toBeVisible();
    });
  });
}
```

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-paste.spec.js`
Expected: FAIL – no "Paste setup from a guide" button.

- [ ] **Step 4: Source row**

In `SourceStep.jsx`, below the `fieldset`, add:

```jsx
      <button
        type="button"
        className="button secondary mcp-wizard-paste-row"
        onClick={() => {
          dispatch({ type: "via", via: "paste" });
          go("paste");
        }}
      >
        {copy.source.paste}
      </button>
      <small className="mcp-hint">{copy.source.pasteHint}</small>
```

- [ ] **Step 5: Notes renderer**

`web/features/mcp-servers/wizard/PasteNotes.jsx`:

```jsx
import React from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";

/** A warning as one sentence; its parts are names from the guide, shown as text. */
export const warningText = (note) => {
  const render = copy.paste.warnings[note.code];
  return typeof render === "function"
    ? render(note.name ?? "", note.ref ?? "", note.to ?? "")
    : render;
};

export function PasteWarnings({ warnings }) {
  if (!warnings.length) return null;
  return (
    <ul className="mcp-wizard-notes" aria-label={copy.paste.warningsTitle}>
      {warnings.map((note, index) => (
        <li key={index} className="mcp-warning">
          {warningText(note)}
        </li>
      ))}
    </ul>
  );
}

/** "Not taken over": every dropped key by name with its reason; never a value. */
export function PasteIgnored({ ignored }) {
  if (!ignored.length) return null;
  return (
    <section aria-labelledby="mcp-paste-ignored">
      <h3 id="mcp-paste-ignored" className="mcp-wizard-subtitle">
        {copy.paste.notTaken}
      </h3>
      <ul className="mcp-wizard-notes" aria-label={copy.paste.notTaken}>
        {ignored.map((note, index) => (
          <li key={index}>
            <code className="mcp-wizard-mono">{note.key}</code> –{" "}
            {copy.paste.ignored[note.code]}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: The Paste step**

`web/features/mcp-servers/wizard/PasteStep.jsx`:

```jsx
import React, { useId, useState } from "react";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { newestStable } from "../mcp-package-versions.js";
import useMcpPackageVersions from "../useMcpPackageVersions.js";
import { linkLabel } from "./PackageStep.jsx";
import { PasteIgnored, PasteWarnings } from "./PasteNotes.jsx";
import { parsePaste, pickServer } from "./paste-parser.js";
import WizardStep from "./WizardStep.jsx";

const errorText = (error) =>
  error.code === "invalidJson"
    ? `${copy.paste.errors.invalidJson} ${copy.paste.position(error.line, error.column)}`
    : copy.paste.errors[error.code];

function sourceLine(draft) {
  if (draft.path === "package")
    return draft.registry === "pypi"
      ? copy.paste.sources.pypi(draft.packageName)
      : copy.paste.sources.npm(draft.packageName);
  if (draft.path === "remote")
    return copy.paste.sources.remote(draft.transport.toUpperCase());
  return copy.paste.sources.command(draft.command);
}

function Found({ server, name, setName, versions }) {
  const { draft } = server;
  const rows = draft.path === "remote" ? draft.headers : draft.env;
  return (
    <section className="mcp-wizard-card-block" aria-labelledby="mcp-paste-found">
      <h2 id="mcp-paste-found" className="mcp-wizard-subtitle">
        {copy.paste.foundTitle}
      </h2>
      <label>
        {copy.paste.name}
        <input
          value={name}
          required
          maxLength={30}
          pattern="[A-Za-z][A-Za-z0-9_\-]{0,29}"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <dl className="mcp-details">
        <dt>{copy.paste.source}</dt>
        <dd className="mcp-wizard-mono">{sourceLine(draft)}</dd>
        {draft.argRows?.length > 0 && (
          <>
            <dt>{copy.paste.args}</dt>
            <dd>
              <ul className="mcp-wizard-notes">
                {draft.argRows.map((arg, index) => (
                  <li key={index} className="mcp-wizard-mono">
                    {arg}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>{copy.paste.settings}</dt>
        <dd>
          <ul className="mcp-wizard-notes">
            {rows.map((row) => (
              <li key={row.key}>
                <code className="mcp-wizard-mono">{row.name}</code>
                {" · "}
                {row.value ? copy.paste.valueTaken : copy.paste.valueMissing}
              </li>
            ))}
          </ul>
        </dd>
      </dl>
      <p className="mcp-hint">{copy.paste.secretsNote}</p>
      {draft.path === "package" && versions.publisher && (
        <p className="mcp-hint">
          {copy.package.publishedBy(
            versions.publisher,
            mcpPackageCopy.registries[draft.registry],
          )}
          {versions.repositoryUrl && (
            <>
              {" · "}
              <a href={versions.repositoryUrl} target="_blank" rel="noopener noreferrer">
                {copy.package.sourceLink(linkLabel(versions.repositoryUrl))}
              </a>{" "}
              <small>{copy.package.linkNote}</small>
            </>
          )}
        </p>
      )}
      {draft.path === "package" && <p className="mcp-hint">{copy.paste.reviewNote}</p>}
      <PasteWarnings warnings={server.warnings} />
      <PasteIgnored ignored={server.ignored} />
    </section>
  );
}

/** Paste: the guide's block is read here, in this browser; only a package name is looked up. */
export default function PasteStep({ state, dispatch, go, headingRef, data }) {
  const id = useId();
  const { text, result, index } = state.paste;
  const server = result?.ok ? pickServer(result, index) : null;
  const [name, setName] = useState(server?.name ?? "");
  const draft = server?.draft;
  const versions = useMcpPackageVersions(
    draft?.path === "package" ? draft.registry : "npm",
    draft?.path === "package" ? draft.packageName : "",
  );
  const read = () => {
    const taken = (data.mcpServers || []).map((item) => item.name);
    const next = parsePaste(text, { taken });
    dispatch({ type: "pasteResult", result: next, index: 0 });
    setName(next.ok ? (next.servers[0]?.name ?? "") : "");
  };
  const choose = (next) => {
    dispatch({ type: "pasteResult", result, index: next });
    setName(result.servers[next].name);
  };
  const proceed = () => {
    const values = { ...draft, name: name.trim() };
    // No exact version in the guide: the newest stable one, pinned when installing.
    if (values.path === "package" && !values.packageVersion && versions.versions.length)
      values.packageVersion = newestStable(versions);
    dispatch({ type: "pasted", draft: values });
    go(values.path === "package" && !values.packageVersion ? "package" : "settings");
  };
  const clipboard = typeof navigator !== "undefined" && navigator.clipboard?.readText;
  return (
    <WizardStep
      title={copy.paste.title}
      headingRef={headingRef}
      primary={draft ? { label: copy.continue } : { label: copy.paste.read }}
      secondary={
        draft
          ? {
              label: copy.paste.editText,
              onClick: () => dispatch({ type: "pasteResult", result: null, index: 0 }),
            }
          : undefined
      }
      onSubmit={draft ? proceed : read}
    >
      {!draft && (
        <>
          <p className="mcp-hint" id={`${id}-helper`}>
            {copy.paste.helper}
          </p>
          <label htmlFor={`${id}-text`}>{copy.paste.label}</label>
          <textarea
            id={`${id}-text`}
            className="mcp-wizard-mono mcp-paste-text"
            rows={12}
            value={text}
            maxLength={65536}
            spellCheck={false}
            autoCapitalize="none"
            aria-describedby={`${id}-helper`}
            onChange={(event) =>
              dispatch({ type: "pasteText", text: event.target.value })
            }
          />
          {clipboard && (
            <button
              type="button"
              className="button secondary"
              onClick={async () => {
                try {
                  dispatch({
                    type: "pasteText",
                    text: await navigator.clipboard.readText(),
                  });
                } catch {
                  /* The browser refused; the owner pastes by hand. */
                }
              }}
            >
              {copy.paste.pasteButton}
            </button>
          )}
          {result && !result.ok && (
            <p role="alert" className="mcp-field-error">
              {errorText(result.error)}
            </p>
          )}
        </>
      )}
      {result?.ok && result.servers.length > 1 && (
        <fieldset className="mcp-wizard-cards">
          <legend>
            {copy.paste.others(server.others.join(", "), server.others.length)}
          </legend>
          {result.servers.map((item, at) => (
            <label key={at} className="mcp-wizard-card">
              <input
                type="radio"
                name={`${id}-server`}
                checked={at === index}
                onChange={() => choose(at)}
              />
              <span className="mcp-wizard-card-title">{item.name || item.key}</span>
            </label>
          ))}
        </fieldset>
      )}
      {server?.refused && (
        <p role="alert" className="mcp-field-error">
          {copy.paste.errors[server.refused]}
        </p>
      )}
      {draft && (
        <Found server={server} name={name} setName={setName} versions={versions} />
      )}
    </WizardStep>
  );
}
```

The single-server case shows no chooser; the "N more servers" sentence is the chooser's legend. Register `paste: PasteStep` in `screens`. CSS: `.mcp-paste-text { width: 100%; min-height: 12rem; font-family: var(--font-mono, monospace); }`, `.mcp-wizard-notes { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }`.

- [ ] **Step 7: Program preference and the next pasted server**

`InstallStep.jsx`: pass `defaultProgram={draft.hints.program}` to the inline `McpPackageConfirmation`.

`DoneStep.jsx`: the secondary action keeps the rest of a pasted block:

```jsx
        onClick: () => {
          const rest = state.paste.result?.ok && state.paste.result.servers.length > 1;
          dispatch({ type: "reset", keepPaste: rest });
          navigate(itemRoute("mcp-servers", "new", rest ? "paste" : undefined));
        },
```

Add to the describe of `mcp-wizard-paste.spec.js`:

```js
test("the rest of a pasted block waits for Add another server", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "One full flow per viewport is covered above.");
  await wizardSetup(page);
  const wizard = await paste(page, fixture("several.json"));
  const card = wizard.getByRole("region", { name: "Here is what we found" });
  await expect(card.getByText(/Published by/)).toBeVisible();
  await primary(wizard).click();
  await primary(wizard).click();
  await wizard
    .getByRole("region", { name: "Install this package?" })
    .getByRole("button", { name: "Install" })
    .click();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await wizard.getByRole("button", { name: "Skip for now" }).click();
  await wizard.getByRole("button", { name: "Add another server" }).click();
  await expect(page).toHaveURL(/step=paste/);
  await expect(wizard.getByRole("radio", { name: "github" })).toBeVisible();
  await wizard.getByRole("radio", { name: "github" }).check();
  await expect(card.getByText("Own command docker")).toBeVisible();
});
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-wizard-paste.spec.js tests/browser/mcp-wizard-frame.spec.js && node --test tests/unit/mcp-wizard-state.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/features/mcp-servers/wizard tests/unit/mcp-wizard-state.test.js tests/browser/mcp-wizard-paste.spec.js
git commit -m "feat: set up an MCP server by pasting the guide's setup block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: "This looks like a package" on the own-command step

**Files:**

- Modify: `web/features/mcp-servers/wizard/OwnCommandStep.jsx`, `web/features/mcp-servers/wizard/wizard-state.js` (`switchToPackage`), `tests/unit/mcp-wizard-state.test.js`
- Test: `tests/browser/mcp-wizard-command.spec.js` (extend)

**Interfaces:**

- Consumes: `splitCommandLine`, `mapCommand` (Task 3); copy `command.looksLikePackage`, `command.switchToPackage`, `command.docker` (Task 7).
- Produces: action `switchToPackage { values }` → `path: "package"`, `via: null`, draft merged with the package path values and `values`, visited `["source", "package"]`.

- [ ] **Step 1: Write the failing tests**

Unit (append to `tests/unit/mcp-wizard-state.test.js`):

```js
test("an own command switches to the package it names", () => {
  const state = run([
    { type: "choose", path: "command" },
    { type: "set", key: "name", value: "everything" },
    {
      type: "switchToPackage",
      values: {
        registry: "npm",
        packageName: "@modelcontextprotocol/server-everything",
        packageVersion: "",
        argRows: [],
      },
    },
  ]);
  assert.equal(state.path, "package");
  assert.equal(state.draft.source, "package");
  assert.equal(state.draft.name, "everything");
  assert.deepEqual(state.visited, ["source", "package"]);
});
```

Browser (append inside the describe of `tests/browser/mcp-wizard-command.spec.js`):

```js
test("an npx command offers to install the package instead", async ({ page }) => {
  await wizardSetup(page);
  const wizard = await openWizard(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Name", { exact: true }).fill("everything");
  await wizard
    .getByLabel("Command")
    .fill("npx -y @modelcontextprotocol/server-everything");
  await expect(
    wizard.getByText("This looks like a package. Let AgentPier install it instead?"),
  ).toBeVisible();
  await wizard.getByRole("button", { name: "Switch to package" }).click();
  await expect(page).toHaveURL(/step=package/);
  await expect(wizard.getByLabel("Package", { exact: true })).toHaveValue(
    "@modelcontextprotocol/server-everything",
  );
  await expect(wizard.getByLabel("Name", { exact: true })).toHaveValue("everything");
});

test("docker is named as an own command with your rights", async ({ page }) => {
  await wizardSetup(page, { commands: { docker: "/usr/local/bin/docker" } });
  const wizard = await openWizard(page);
  await chooseSource(wizard, /Own command/);
  await wizard.getByLabel("Command").fill("docker");
  await expect(
    wizard.getByText(
      "Docker is not supported; it runs as an own command with your user's rights.",
    ),
  ).toBeVisible();
  await expect(wizard.getByRole("button", { name: "Switch to package" })).toHaveCount(0);
});
```

Run: `node --test tests/unit/mcp-wizard-state.test.js && npm run build && npx playwright test tests/browser/mcp-wizard-command.spec.js`
Expected: FAIL.

- [ ] **Step 2: Implement**

`wizard-state.js`:

```js
    case "switchToPackage":
      return {
        ...state,
        path: "package",
        via: null,
        visited: ["source", "package"],
        draft: {
          ...state.draft,
          ...pathValues.package,
          command: "",
          ...action.values,
          hints: { ...state.draft.hints, ...(action.values.hints ?? {}) },
        },
        fieldError: null,
      };
```

`OwnCommandStep.jsx` – compute the mapping from the command field (one word or a whole line) and the argument rows:

```jsx
import { mapCommand, splitCommandLine } from "./command-mapper.js";
```

```jsx
const words = splitCommandLine(draft.command) ?? [];
const mapped = words.length
  ? mapCommand(words[0], [...words.slice(1), ...draft.argRows])
  : null;
const packaged = mapped && mapped.kind !== "command";
const docker = mapped?.warnings.some((note) => note.code === "docker");
```

and render, after `CommandFields`:

```jsx
{
  packaged && (
    <div className="mcp-wizard-notice" role="status">
      <p>{copy.command.looksLikePackage}</p>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          dispatch({
            type: "switchToPackage",
            values: {
              registry: mapped.kind,
              packageName: mapped.packageName,
              packageVersion: mapped.version,
              argRows: mapped.args,
              hints: mapped.program ? { program: mapped.program } : {},
            },
          });
          go("package");
        }}
      >
        {copy.command.switchToPackage}
      </button>
    </div>
  );
}
{
  docker && <p className="mcp-warning">{copy.command.docker}</p>;
}
```

A command line with spaces never resolves on PATH, so **Continue** stays disabled until the owner switches or types the bare command; that is intended.

- [ ] **Step 3: Run to verify it passes**

Run: `node --test tests/unit/mcp-wizard-state.test.js && npm run build && npx playwright test tests/browser/mcp-wizard-command.spec.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/features/mcp-servers/wizard tests/unit/mcp-wizard-state.test.js tests/browser/mcp-wizard-command.spec.js
git commit -m "feat: offer to install an npx or uvx command as a package

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Paste copy in English and German

**Files:**

- Modify: `web/lib/i18n/en/mcp-wizard.js`, `web/lib/i18n/de/mcp-wizard.js`
- Test: `tests/unit/i18n-catalogs.test.js`

**Interfaces:**

- Produces: `source.paste`, `source.pasteHint`, `command.looksLikePackage`, `command.switchToPackage`, `command.docker`, and the `paste` group below (used by Tasks 4–6; note codes match Task 4's list).

- [ ] **Step 1: English**

Add to `source`:

```js
    paste: "Paste setup from a guide",
    pasteHint: "For guides that show a JSON block for Claude Desktop, Cursor or VS Code.",
```

Add to `command`:

```js
    looksLikePackage: "This looks like a package. Let AgentPier install it instead?",
    switchToPackage: "Switch to package",
    docker: "Docker is not supported; it runs as an own command with your user's rights.",
```

Add the group:

```js
  paste: {
    title: "Paste the setup",
    label: "Setup from the guide",
    helper:
      "Paste the JSON block meant for Claude Desktop, Cursor or a similar app. AgentPier reads it in this browser. Only the package name is looked up at npm or PyPI; your values stay on this computer.",
    pasteButton: "Paste",
    read: "Read setup",
    editText: "Edit the text",
    foundTitle: "Here is what we found",
    name: "Name",
    source: "Source",
    sources: {
      npm: (name) => `npm package ${name}`,
      pypi: (name) => `PyPI package ${name}`,
      remote: (kind) => `Online (${kind})`,
      command: (command) => `Own command ${command}`,
    },
    args: "Arguments",
    settings: "Settings",
    valueTaken: "value taken over",
    valueMissing: "needs a value",
    secretsNote: "All values are stored on this computer only and are never shown again.",
    reviewNote: "A guide is not a security review. Check who published the package before you install it.",
    notTaken: "Not taken over",
    warningsTitle: "Notes",
    others: (names, count) =>
      `${count} more ${count === 1 ? "server" : "servers"} in this block: ${names} – set them up one at a time`,
    position: (line, column) => `Line ${line}, column ${column}.`,
    errors: {
      tooLong: "This is too long for a setup block.",
      invalidJson: "This is not valid JSON. Copy the whole block including the braces { }.",
      tooDeep: "This block is nested too deeply to be a setup block.",
      noServer:
        "No server found. AgentPier understands mcpServers, servers, mcp and context_servers blocks.",
      notJson:
        "This is not JSON. Paste the JSON variant from the guide, or set the server up by hand.",
      invalidArgs: "The arguments of this server are not all text, so it cannot be taken over.",
      noCommand: "This server has neither a command nor an address.",
    },
    ignored: {
      runner: "AgentPier installs the package itself instead of downloading it at every start.",
      yes: "Only needed for npx.",
      cmdWrapper: "A Windows command wrapper; not needed here.",
      resolverFlag: "AgentPier resolves dependencies itself.",
      unknownFlag: "This option is not used when AgentPier installs the package.",
      unmanaged: "AgentPier does not manage this setting.",
      consumed: "Used to choose the connection type.",
      envFile: "AgentPier cannot read env files; type the values here.",
      oauth: "Sign-in is chosen on the address step.",
      unknown: "Unknown setting; not taken over.",
      invalidName: "This name is not allowed for a setting.",
      notString: "Only text values are taken over.",
    },
    warnings: {
      pinned: "Pinned to an exact version when you install.",
      extras: "Extras are not installed.",
      docker:
        "Docker is not supported as a package; this runs as an own command with your user's rights.",
      reference: (name, ref) =>
        `${name} points to another setting (${ref}). Type the real value in Settings.`,
      placeholder: (name) => `The guide shows a placeholder for ${name}.`,
      tokenInArgs: "Put tokens in settings or headers; arguments and addresses are shown.",
      tokenInQuery: "Put tokens in settings or headers; arguments and addresses are shown.",
      stringified: (name) => `${name} is taken over as text.`,
      cwdRelative: "The working directory must be an absolute path; it was left empty.",
      guessed: "Guessed from the address; change it if needed.",
      duplicateKey: (name) => `${name} appears twice; the last one is used.`,
      nameChanged: (name, _ref, to) => `The name ${name} was changed to ${to}.`,
      nameTaken: (name, _ref, to) => `${name} is already used; the new server is called ${to}.`,
      tooMany: "Only the first 100 entries are taken over.",
      controlChars: (name) => `${name} contained control characters and was left empty.`,
      tooLongValue: (name) => `${name} is longer than 16 KiB and was left empty.`,
      tooManyServers: "Only the first 20 servers in this block are read.",
    },
  },
```

Every `warnings` function takes `(name, ref, to)` in that order (`PasteNotes` always passes three arguments); unused parameters keep the interpolation arguments equal between languages.

- [ ] **Step 2: German (same keys and arguments)**

```js
    paste: "Einrichtung aus einer Anleitung einfügen",
    pasteHint: "Für Anleitungen mit einem JSON-Block für Claude Desktop, Cursor oder VS Code.",
```

```js
    looksLikePackage: "Das sieht nach einem Paket aus. Soll AgentPier es stattdessen installieren?",
    switchToPackage: "Zum Paket wechseln",
    docker:
      "Docker wird nicht unterstützt; es läuft als eigener Befehl mit deinen Benutzerrechten.",
```

```js
  paste: {
    title: "Einrichtung einfügen",
    label: "Einrichtung aus der Anleitung",
    helper:
      "Füge den JSON-Block für Claude Desktop, Cursor oder eine ähnliche App ein. AgentPier liest ihn in diesem Browser. Nur der Paketname wird bei npm oder PyPI nachgeschlagen; deine Werte bleiben auf diesem Rechner.",
    pasteButton: "Einfügen",
    read: "Einrichtung lesen",
    editText: "Text bearbeiten",
    foundTitle: "Das haben wir gefunden",
    name: "Name",
    source: "Quelle",
    sources: {
      npm: (name) => `npm-Paket ${name}`,
      pypi: (name) => `PyPI-Paket ${name}`,
      remote: (kind) => `Online (${kind})`,
      command: (command) => `Eigener Befehl ${command}`,
    },
    args: "Argumente",
    settings: "Einstellungen",
    valueTaken: "Wert übernommen",
    valueMissing: "braucht einen Wert",
    secretsNote:
      "Alle Werte werden nur auf diesem Rechner gespeichert und nie wieder angezeigt.",
    reviewNote:
      "Eine Anleitung ist keine Sicherheitsprüfung. Prüfe vor der Installation, wer das Paket veröffentlicht hat.",
    notTaken: "Nicht übernommen",
    warningsTitle: "Hinweise",
    others: (names, count) =>
      `${count} ${count === 1 ? "weiterer Server" : "weitere Server"} in diesem Block: ${names} – richte sie nacheinander ein`,
    position: (line, column) => `Zeile ${line}, Spalte ${column}.`,
    errors: {
      tooLong: "Das ist zu lang für einen Einrichtungsblock.",
      invalidJson: "Das ist kein gültiges JSON. Kopiere den ganzen Block samt geschweifter Klammern { }.",
      tooDeep: "Dieser Block ist zu tief verschachtelt für einen Einrichtungsblock.",
      noServer:
        "Kein Server gefunden. AgentPier versteht mcpServers-, servers-, mcp- und context_servers-Blöcke.",
      notJson:
        "Das ist kein JSON. Füge die JSON-Variante aus der Anleitung ein oder richte den Server von Hand ein.",
      invalidArgs: "Die Argumente dieses Servers sind nicht alle Text, deshalb kann er nicht übernommen werden.",
      noCommand: "Dieser Server hat weder einen Befehl noch eine Adresse.",
    },
    ignored: {
      runner: "AgentPier installiert das Paket selbst, statt es bei jedem Start herunterzuladen.",
      yes: "Nur für npx nötig.",
      cmdWrapper: "Ein Windows-Befehlsaufruf; hier nicht nötig.",
      resolverFlag: "AgentPier löst Abhängigkeiten selbst auf.",
      unknownFlag: "Diese Option wird bei der Installation durch AgentPier nicht genutzt.",
      unmanaged: "AgentPier verwaltet diese Einstellung nicht.",
      consumed: "Wurde zur Wahl der Verbindungsart genutzt.",
      envFile: "AgentPier kann keine env-Dateien lesen; trag die Werte hier ein.",
      oauth: "Die Anmeldung wählst du beim Adressschritt.",
      unknown: "Unbekannte Einstellung; nicht übernommen.",
      invalidName: "Dieser Name ist für eine Einstellung nicht erlaubt.",
      notString: "Nur Textwerte werden übernommen.",
    },
    warnings: {
      pinned: "Wird bei der Installation auf eine exakte Version festgelegt.",
      extras: "Extras werden nicht installiert.",
      docker:
        "Docker wird als Paket nicht unterstützt; das läuft als eigener Befehl mit deinen Benutzerrechten.",
      reference: (name, ref) =>
        `${name} verweist auf eine andere Einstellung (${ref}). Trag den echten Wert unter Einstellungen ein.`,
      placeholder: (name) => `Die Anleitung zeigt einen Platzhalter für ${name}.`,
      tokenInArgs:
        "Leg Tokens besser in Einstellungen oder Header; Argumente und Adressen werden angezeigt.",
      tokenInQuery:
        "Leg Tokens besser in Einstellungen oder Header; Argumente und Adressen werden angezeigt.",
      stringified: (name) => `${name} wird als Text übernommen.`,
      cwdRelative: "Der Arbeitsordner muss ein absoluter Pfad sein; er wurde leer gelassen.",
      guessed: "Aus der Adresse geschlossen; ändere das bei Bedarf.",
      duplicateKey: (name) => `${name} kommt doppelt vor; der letzte Eintrag gilt.`,
      nameChanged: (name, _ref, to) => `Der Name ${name} wurde zu ${to} geändert.`,
      nameTaken: (name, _ref, to) => `${name} ist schon vergeben; der neue Server heißt ${to}.`,
      tooMany: "Nur die ersten 100 Einträge werden übernommen.",
      controlChars: (name) => `${name} enthielt Steuerzeichen und wurde leer gelassen.`,
      tooLongValue: (name) => `${name} ist länger als 16 KiB und wurde leer gelassen.`,
      tooManyServers: "Nur die ersten 20 Server in diesem Block werden gelesen.",
    },
  },
```

- [ ] **Step 3: Run the catalog tests**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS. If the parity test compares function `length`, the `(name, _ref, to)` signatures are equal in both languages; keep them that way.

- [ ] **Step 4: Commit**

```bash
git add web/lib/i18n/en/mcp-wizard.js web/lib/i18n/de/mcp-wizard.js
git commit -m "feat: add the paste copy for the MCP wizard in English and German

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation, checks and PR

**Files:**

- Modify: `docs/mcp.md`
- Delete: `docs/superpowers/plans/2026-10-16-mcp-wizard-2-paste.md`

- [ ] **Step 1: Document paste**

In `docs/mcp.md` "Central MCP servers in the coding CLIs", after the wizard paragraph from PR 1, add:

```markdown
**Paste setup from a guide** on the Source step reads a guide's JSON block in the
browser: `mcpServers` (Claude Desktop, Claude Code `.mcp.json`, Cursor, Windsurf,
Cline), `servers` with `inputs` (VS Code), `mcp` (OpenCode), `context_servers` (Zed), a
single entry, a block without its outer braces, or one `npx`/`uvx`/`pipx run` command
line. `npx …`, `uvx …` and `pipx run …` become a package that AgentPier installs and
pins itself; Docker stays an own command. Every key that is not taken over is listed by
name with its reason, never with its value. Values that refer to another setting
(`${…}`, `{env:…}`, `{file:…}`) or that are obvious placeholders become empty, required
settings. Nothing is sent while reading except the package name, which is looked up at
npm or PyPI. Codex TOML and `claude mcp add` lines are not read yet. The own-command step
offers **Switch to package** when its command is such a runner.
```

- [ ] **Step 2: Full verification**

Run: `npm run check && npm run build && npx playwright test tests/browser/mcp-wizard-*.spec.js`
Expected: PASS. Exercise the paste flow in English with `AGENTPIER_DATA_DIR=$(mktemp -d) npm start` using the OPNsense block; take 390 px and desktop screenshots of the result card.

- [ ] **Step 3: Remove the plan, commit, push, open the PR**

```bash
git rm docs/superpowers/plans/2026-10-16-mcp-wizard-2-paste.md
git add docs/mcp.md
git commit -m "docs: describe pasting an MCP setup block into the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git fetch -q origin && git rebase origin/main
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' push -q -u origin feat/mcp-wizard-paste
```

PR title: `feat: read MCP setup blocks pasted from install guides`. The description names AGENTPIER-84, the accepted shapes and limits, that nothing but the package name is sent, validation commands, the docs checked (`docs/mcp.md`, `README.md`, `README.de.md`), screenshots from `agent-pier-assets`, and ends with the Claude Code line from the attribution reminder.

---

## Self-Review

1. **Spec coverage (stage 1b).** Accepted shapes 1–7 (Task 4 tests), comments/trailing commas (Task 1), mapping rules incl. `-p`, `--from`, `--with`/`--python`, extras, `cmd /c`, Docker, args, env/environment, stringified values, cwd, url/serverUrl + types, headers/Bearer, consumed types (Tasks 3–4), ignored list (Task 4), references with VS Code inputs and placeholders (Tasks 2, 4), edge cases (Task 4), untrusted limits (Tasks 1, 4, properties), Paste screen with result card, publisher note, chooser, Edit the text (Task 5), own-command banner and Docker note (Task 6), copy (Task 7), docs (Task 8).
2. **Placeholders.** None.
3. **Type consistency.** Note codes in Task 4's interface equal the `paste.ignored`/`paste.warnings` keys of Task 7; `Parsed.draft` fields equal PR 1's draft fields (`argRows`, `signIn`, `headers` row `key: "auth"`, `hints.settings`).
4. **Deviation to confirm.** The spec says Continue goes to Settings; when the guide names no usable version and the lookup failed, the wizard opens the package step instead, because Install needs an exact version.
