import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { alphaSuffixes, ratchet, rules, webSources } from "../helpers/ui-guide-scan.js";

// docs/ui-guide.md#enforcement: existing offenders are listed in
// tests/fixtures/ui-guide-allowlist.json. The list only shrinks: a new offender fails,
// and so does a fixed one until its allowance is lowered or removed.
const allowlist = JSON.parse(
  await readFile(new URL("../fixtures/ui-guide-allowlist.json", import.meta.url), "utf8"),
);
const sources = await webSources();

const hints = {
  hexColours: "use a semantic colour token from web/styles/base.css",
  smallFontSizes: "use --font-size-xs (11px) or larger",
  mediaWidths: "use the breakpoints of web/lib/breakpoints.js (700, 1150, 1500)",
  focusOutlines: "use outline: var(--focus-ring)",
  nativeDialogs: "use the app's confirmation dialog instead of a browser dialog",
};

test("the allowlist names exactly the enforced rules", () => {
  assert.deepEqual(Object.keys(allowlist).sort(), Object.keys(rules).sort());
});

for (const [name, rule] of Object.entries(rules))
  test(`UI rule ${name}: no new offenders, fixed ones leave the allowlist`, () => {
    assert.deepEqual(ratchet(rule(sources), allowlist[name]), [], hints[name]);
  });

test("custom properties never take a glued alpha suffix such as var(--accent)33", () => {
  assert.deepEqual(alphaSuffixes(sources), {});
});

test("the ratchet reports new, grown and shrunk offenders", () => {
  assert.deepEqual(ratchet({ "a.css": 1 }, {}), ["a.css: 1 (allowed 0)"]);
  assert.deepEqual(ratchet({ "a.css": 3 }, { "a.css": 2 }), ["a.css: 3 (allowed 2)"]);
  assert.deepEqual(ratchet({ "a.css": 1 }, { "a.css": 2 }), [
    "a.css: 1 left, lower its allowance from 2 to 1",
  ]);
  assert.deepEqual(ratchet({}, { "a.css": 2 }), [
    "a.css: 0 left, lower its allowance from 2 by removing it",
  ]);
  assert.deepEqual(ratchet({ "a.css": 2 }, { "a.css": 2 }), []);
});

test("the scanners recognise each kind of offender", () => {
  const scan = (file, text) => [{ file, text }];
  assert.deepEqual(rules.hexColours(scan("web/x.css", "a{color:#fff;b:#12345678}")), {
    "web/x.css": 2,
  });
  assert.deepEqual(rules.hexColours(scan("web/styles/base.css", "a{color:#fff}")), {});
  assert.deepEqual(
    rules.smallFontSizes(
      scan("web/x.css", "a{font-size:10px}b{font-size:0.75rem}c{font-size:11px}"),
    ),
    { "web/x.css": 2 },
  );
  assert.deepEqual(
    rules.mediaWidths(
      scan("web/x.css", "@media (max-width: 700px){}@media (max-width: 600px){}"),
    ),
    { "web/x.css": 1 },
  );
  assert.deepEqual(
    rules.mediaWidths(scan("web/x.js", 'matchMedia("(max-width: 900px)")')),
    { "web/x.js": 1 },
  );
  assert.deepEqual(
    rules.focusOutlines(
      scan(
        "web/x.css",
        "a:focus-visible{outline:2px solid red}b:focus{outline:none}" +
          "c:focus-visible{outline:var(--focus-ring)}",
      ),
    ),
    { "web/x.css": 1 },
  );
  assert.deepEqual(
    rules.nativeDialogs(scan("web/x.js", "if (window.confirm(text)) alert(1);")),
    { "web/x.js": 1 },
  );
});
