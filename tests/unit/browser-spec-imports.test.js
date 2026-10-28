import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// Every browser spec takes `test` from tests/helpers/browser-test.js, whose fixture
// stubs the live socket (/api/live) for each page (docs/testing.md#live-socket-stub).
// A spec that imported Playwright's own `test` would talk to the test server's real
// live channel instead of its own REST mocks.
const folder = new URL("../browser/", import.meta.url);
const specs = (await readdir(folder)).filter((name) => name.endsWith(".spec.js")).sort();
const sources = await Promise.all(
  specs.map(async (name) => [name, await readFile(new URL(name, folder), "utf8")]),
);
const imports = (source, from) =>
  [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)]
    .filter((match) => match[2] === from)
    .flatMap((match) => match[1].split(",").map((name) => name.trim().split(/\s+/)[0]));

test("there are browser specs to check", () => {
  assert.ok(specs.length > 300, `only ${specs.length} specs found`);
});

test("every browser spec imports test from ../helpers/browser-test.js", () => {
  const offenders = sources
    .filter(
      ([, source]) => !imports(source, "../helpers/browser-test.js").includes("test"),
    )
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});

test("no browser spec imports test or expect from @playwright/test", () => {
  const offenders = sources
    .filter(([, source]) =>
      imports(source, "@playwright/test").some((name) =>
        ["test", "expect"].includes(name),
      ),
    )
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});

// A context of the spec's own gets no stub from the fixture: its pages would read the
// test server's live channel and skip the spec's context.route mocks. A spec that
// wants the real channel says why in a "// Real live channel: <reason>" comment.
const unstubbedContext = (source) =>
  /\bnewContext\(/.test(source) &&
  !/\bstubContext\(/.test(source) &&
  !/\/\/ Real live channel: \S/.test(source);

test("every spec that makes a browser context stubs it or says why not", () => {
  const offenders = sources
    .filter(([, source]) => unstubbedContext(source))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});

test("the context guard tells stubbed, justified and bare contexts apart", () => {
  const made = "const context = await browser.newContext({ hasTouch: true });\n";
  assert.equal(unstubbedContext(made), true);
  assert.equal(unstubbedContext(made + "await stubContext(context);\n"), false);
  assert.equal(unstubbedContext("// Real live channel: own server.\n" + made), false);
  assert.equal(unstubbedContext("// Real live channel:\n" + made), true);
  assert.equal(unstubbedContext("const page = await context.newPage();\n"), false);
});
