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
