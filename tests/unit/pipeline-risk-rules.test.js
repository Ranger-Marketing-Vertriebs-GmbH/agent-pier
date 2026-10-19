import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  DEFAULT_RISK,
  globMatcher,
  ruleMatcher,
  validateRisk,
} from "../../server/features/pipelines/risk-rules.js";
import {
  addedDependencies,
  dependencyManifest,
} from "../../server/features/pipelines/risk-dependencies.js";
import { riskItems, riskKey } from "../../server/features/pipelines/risk-gate.js";

const matches = (glob, file) => globMatcher(glob)(file);
const matchingGlob = (globs, file) => ruleMatcher(globs)(file);

test("globs match at any depth unless anchored, and * never crosses a folder", () => {
  assert.ok(matches("package.json", "package.json"));
  assert.ok(matches("package.json", "apps/web/package.json"));
  assert.ok(!matches("package.json", "package.json.bak"));
  assert.ok(matches("auth/**", "auth/token.js"));
  assert.ok(matches("auth/**", "server/features/auth/session/token.js"));
  assert.ok(!matches("auth/**", "server/oauth/token.js"));
  assert.ok(matches("/.github/**", ".github/workflows/ci.yml"));
  assert.ok(!matches("/.github/**", "docs/.github/notes.md"));
  assert.ok(matches("/scripts/", "scripts/release.sh"));
  assert.ok(matches("*.sql", "db/schema.sql"));
  assert.ok(matches("src/*.js", "lib/src/a.js"));
  assert.ok(!matches("/src/*.js", "src/nested/a.js"));
  assert.ok(matches("/src/**/*.js", "src/a.js"));
  assert.ok(matches("/src/**/*.js", "src/nested/deep/a.js"));
  assert.ok(matches("requirements*.txt", "requirements-dev.txt"));
  assert.ok(matches("Dockerfile*", "deploy/Dockerfile.prod"));
  assert.ok(matches("file?.md", "file1.md"));
  assert.ok(!matches("file?.md", "file12.md"));
  assert.ok(matches("*.{yml,yaml}", "config/app.yaml"));
  // Case is ignored, also for a file system that ignores it.
  assert.ok(matches("migrations/**", "db/Migrations/001_init.sql"));
  // Expression characters in a glob are literal.
  assert.ok(matches("a+b(c).txt", "x/a+b(c).txt"));
  assert.ok(!matches("a.b", "axb"));
});

test("property: a file below an unanchored folder glob matches at every depth", () => {
  const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
  fc.assert(
    fc.property(
      fc.array(segment, { maxLength: 4 }),
      segment,
      fc.array(segment, { minLength: 1, maxLength: 4 }),
      (prefix, folder, rest) => {
        const parts = [...prefix, folder, ...rest];
        const file = parts.join("/");
        assert.ok(matches(`${folder}/**`, file));
        // An anchored glob matches when the path starts with the folder, which may
        // also be a prefix segment of the same name (`_/_/a` starts with `_`).
        assert.equal(matches(`/${folder}/**`, file), parts[0] === folder);
        // A single star stays within one folder.
        assert.equal(
          matches(`/${folder}/*`, file),
          parts[0] === folder && parts.length === 2,
        );
      },
    ),
    { numRuns: 1000 },
  );
  // The counterexample that showed the property's own expectation was too narrow.
  assert.ok(matches("/_/**", "_/_/a"));
  assert.ok(!matches("/_/*", "_/_/a"));
});

test("the first matching glob names the rule; validation trims, dedupes and refuses junk", () => {
  assert.equal(matchingGlob(DEFAULT_RISK.globs, "web/package.json"), "package.json");
  assert.equal(
    matchingGlob(DEFAULT_RISK.globs, ".github/workflows/ci.yml"),
    "/.github/**",
  );
  assert.equal(matchingGlob(DEFAULT_RISK.globs, "db/migrations/1.sql"), "migrations/**");
  assert.equal(matchingGlob(DEFAULT_RISK.globs, "server/auth/login.js"), "auth/**");
  assert.equal(matchingGlob(DEFAULT_RISK.globs, "web/app/App.jsx"), null);
  assert.deepEqual(
    validateRisk({ globs: [" a/** ", "a/**", "*.sql"], newDependency: false }),
    { globs: ["a/**", "*.sql"], newDependency: false, enabled: true },
  );
  for (const body of [
    null,
    { globs: "a", newDependency: true },
    { globs: [], newDependency: "yes" },
    { globs: Array.from({ length: 101 }, (_, i) => `f${i}`), newDependency: true },
    { globs: [""], newDependency: true },
    { globs: ["../x"], newDependency: true },
    { globs: ["a\\b"], newDependency: true },
    { globs: ["a\nb"], newDependency: true },
    { globs: [7], newDependency: true },
  ])
    assert.throws(() => validateRisk(body), { status: 400 });
});

test("added dependencies compare manifests before and after; versions do not count", () => {
  const pkg = (deps, dev = {}) =>
    JSON.stringify({ name: "x", dependencies: deps, devDependencies: dev });
  assert.deepEqual(
    addedDependencies(
      "package.json",
      pkg({ react: "^18" }),
      pkg({ react: "^19", zod: "^3" }, { vitest: "1" }),
    ),
    ["vitest", "zod"],
  );
  assert.deepEqual(addedDependencies("package.json", null, pkg({ a: "1" })), ["a"]);
  assert.deepEqual(addedDependencies("package.json", pkg({ a: "1" }), null), []);
  // An unreadable manifest afterwards cannot rule out a new dependency.
  assert.deepEqual(addedDependencies("package.json", pkg({}), "{broken"), [""]);
  assert.deepEqual(
    addedDependencies(
      "requirements-dev.txt",
      "Flask==2\n# c\n",
      "flask==3\nRequests>=2\n-r base.txt\n",
    ),
    // Another requirements file it now includes is new as well.
    ["-r base.txt", "requests"],
  );
  assert.deepEqual(
    addedDependencies(
      "go.mod",
      "module m\nrequire a.io/x v1\n",
      "module m\nrequire a.io/x v2\nrequire (\n\tb.io/y v1 // indirect\n)\n",
    ),
    ["b.io/y"],
  );
  assert.deepEqual(
    addedDependencies(
      "Cargo.toml",
      '[package]\nname = "app"\n[dependencies]\nserde = "1"\n',
      '[package]\nname = "app"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies.proptest]\nversion = "1"\n',
    ),
    ["proptest", "tokio"],
  );
  assert.deepEqual(
    addedDependencies(
      "Gemfile",
      "gem 'rails'\n",
      "gem 'rails'\ngem \"devise\", '~> 4'\n",
    ),
    ["devise"],
  );
  assert.deepEqual(
    addedDependencies(
      "composer.json",
      '{"require":{"php":">=8"}}',
      '{"require":{"php":">=8"},"require-dev":{"phpunit/phpunit":"10"}}',
    ),
    ["phpunit/phpunit"],
  );
  assert.ok(dependencyManifest("apps/web/package.json"));
  assert.ok(dependencyManifest("requirements.txt"));
  assert.ok(!dependencyManifest("package-lock.json"));
});

test("risk items cover renames from and to, deletes, and added dependencies", async () => {
  const files = {
    "from:package.json": JSON.stringify({ dependencies: { a: "1" } }),
    "to:package.json": JSON.stringify({ dependencies: { a: "2", b: "1" } }),
    "to:web/package.json": JSON.stringify({ dependencies: { c: "1" } }),
  };
  const read = async (side, file) => files[`${side}:${file}`] ?? null;
  const rules = {
    globs: ["auth/**", "migrations/**", "package.json"],
    newDependency: true,
  };
  const items = await riskItems(
    [
      { status: "R", from: "src/auth/login.js", path: "src/session/login.js" },
      { status: "R", from: "src/util.js", path: "src/auth/util.js" },
      { status: "D", path: "db/migrations/001.sql" },
      { status: "M", path: "package.json" },
      { status: "A", path: "web/package.json" },
      { status: "M", path: "web/App.jsx" },
    ],
    rules,
    read,
  );
  assert.deepEqual(
    items.map((item) => [item.path, item.status, item.rule ?? `+${item.dependency}`]),
    [
      ["src/auth/login.js", "R", "auth/**"],
      ["src/auth/util.js", "R", "auth/**"],
      ["db/migrations/001.sql", "D", "migrations/**"],
      ["package.json", "M", "package.json"],
      ["package.json", "M", "+b"],
      ["web/package.json", "A", "package.json"],
      ["web/package.json", "A", "+c"],
    ],
  );
  // Each side of a rename names the other side once.
  assert.equal(items[0].renamedTo, "src/session/login.js");
  assert.equal(items[1].renamedFrom, "src/util.js");
  assert.equal(riskKey(items[4]), "dependency:package.json:b");
  // The dependency rule alone still flags an added dependency.
  const deps = await riskItems(
    [{ status: "M", path: "package.json" }],
    {
      globs: [],
      newDependency: true,
    },
    read,
  );
  assert.deepEqual(
    deps.map((item) => item.dependency),
    ["b"],
  );
  assert.deepEqual(
    await riskItems(
      [{ status: "M", path: "package.json" }],
      { globs: [], newDependency: false },
      read,
    ),
    [],
  );
});

test("pathological globs and paths are matched in bounded time", () => {
  const started = performance.now();
  const files = [
    `a/${".".repeat(200)}x`,
    "-".repeat(250),
    "a".repeat(40),
    `${"a/".repeat(500)}b`,
    "x".repeat(4000),
  ];
  // Every pattern from the review that froze the regex version, plus a deep one.
  const globs = [
    "**/*.*.*.*.ts",
    "**-**-**-**.sql",
    "*a*a*a*a*a*a*a*a*a*b",
    "**/**/**/**/**/**/**/**/x",
    "/{a,b,c,d,e,f,g,h,i,j}/**",
  ];
  const match = ruleMatcher(globs);
  for (let i = 0; i < 1000; i++) for (const file of files) match(file);
  assert.ok(performance.now() - started < 3000, "5,000 pathological checks stay fast");
  assert.ok(matches("**/*.*.*.*.ts", "src/a.b.c.d.ts"));
  assert.ok(!matches("**/*.*.*.*.ts", `a/${".".repeat(200)}x`));
  // ** inside a name is a plain star: it never spans folders.
  assert.ok(matches("a**b", "axxb"));
  assert.ok(!matches("/a**b", "a/x/b"));
});

test("validation refuses globs whose expansion or wildcards are unbounded", () => {
  for (const glob of [
    "{a,b}{c,d}",
    "{a,{b,c}}",
    `{${"a,".repeat(10)}a}`,
    "*".repeat(11),
    "a}{b",
  ])
    assert.throws(() => validateRisk({ globs: [glob], newDependency: true }), {
      status: 400,
    });
  assert.deepEqual(
    validateRisk({ globs: ["*.{yml,yaml}"], newDependency: false, enabled: false }),
    { globs: ["*.{yml,yaml}"], newDependency: false, enabled: false },
  );
  assert.ok(DEFAULT_RISK.globs.includes(".gitmodules"));
});

test("new dependencies also count when they come from another source", () => {
  const pkg = (value) => JSON.stringify(value);
  assert.deepEqual(
    addedDependencies(
      "package.json",
      pkg({ dependencies: { a: "^1", b: "^1" } }),
      pkg({
        dependencies: { a: "github:evil/a", b: "file:../b" },
        overrides: { c: "1" },
        resolutions: { d: "1" },
      }),
    ),
    ["a@github:evil/a", "b@file:../b", "c (overrides)", "d (resolutions)"],
  );
  assert.deepEqual(
    addedDependencies(
      "requirements.txt",
      "flask==2\n",
      "flask==3\ngit+https://x.example/pkg.git#egg=pkg\nhttps://x.example/w.whl\n-r extra.txt\nreq @ https://x.example/r.tar.gz\n",
    ),
    [
      "-r extra.txt",
      "https://x.example/w.whl",
      "pkg@git+https://x.example/pkg.git#egg=pkg",
      "req@https://x.example/r.tar.gz",
    ],
  );
  assert.deepEqual(
    addedDependencies(
      "Cargo.toml",
      '[dependencies]\nserde = "1"\n',
      '[dependencies]\nserde.workspace = true\ntokio.version = "1"\nmine = { git = "https://x" }\n',
    ),
    ["mine@git", "tokio"],
  );
  assert.deepEqual(
    addedDependencies(
      "go.mod",
      "module m\nrequire a.io/x v1\n",
      "module m\nrequire a.io/x v1\nreplace a.io/x => ../fork\n",
    ),
    ["replace a.io/x => ../fork"],
  );
  assert.deepEqual(
    addedDependencies(
      "pyproject.toml",
      '[project]\ndependencies = ["requests>=2"]\n',
      '[project]\ndependencies = [\n  "requests>=2",\n  "Django>=5",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13"\n',
    ),
    ["django", "pytest", "rich"],
  );
  assert.deepEqual(
    addedDependencies(
      "Pipfile",
      "[packages]\nflask = '*'\n",
      "[packages]\nflask = '*'\nRequests = '*'\n",
    ),
    ["requests"],
  );
  // A manifest that exists afterwards but cannot be read counts as unknown.
  assert.deepEqual(addedDependencies("package.json", "{}", undefined), [""]);
  assert.ok(dependencyManifest("pyproject.toml"));
  assert.ok(dependencyManifest("app/Pipfile"));
});

test("risk items flag moved submodules and unreadable manifests", async () => {
  const items = await riskItems(
    [
      { status: "M", path: "vendor/lib", submodule: "c".repeat(40) },
      { status: "M", path: "package.json" },
    ],
    { globs: [], newDependency: true },
    async () => {
      throw Error("too large");
    },
  );
  assert.deepEqual(items, [
    { path: "vendor/lib", status: "M", submodule: "c".repeat(40) },
    { path: "package.json", status: "M", dependency: "" },
  ]);
  assert.equal(riskKey(items[0]), `submodule:vendor/lib:${"c".repeat(40)}`);
});
