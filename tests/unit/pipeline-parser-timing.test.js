import test from "node:test";
import assert from "node:assert/strict";
import { parseSpec, SPEC_LIMIT } from "../../server/features/pipelines/run-spec.js";
import { dependencyNames } from "../../server/features/pipelines/risk-dependencies.js";

// Specs and manifests come from agents and repositories, and the server
// parses them on its event loop. Each line below is the worst case of one expression
// these parsers used to run, at the size limit of its file: quadratic ones took
// seconds to minutes there, cubic ones never finished. The scanners take a few
// milliseconds on a developer machine; the bound leaves a slow runner a factor of
// more than a hundred and still fails for anything worse than linear.
const BOUND = 1000;
const MANIFEST_LIMIT = 1024 * 1024;
const LS = String.fromCharCode(0x2028);
const spaces = (count) => " ".repeat(count);
const padded = (limit, line) => line(limit - line(0).length);

function timed(name, rounds, run) {
  const started = performance.now();
  let result;
  for (let round = 0; round < rounds; round++) result = run();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < BOUND, `${name}: ${Math.round(elapsed)} ms`);
  return result;
}

test("a spec of the size limit parses in linear time, whatever its lines", () => {
  const half = SPEC_LIMIT / 2;
  const cases = {
    // `\s+(.*?)\s*#*\s*$` over a heading whose text cannot reach the end of the line.
    heading: [padded(SPEC_LIMIT, (n) => `#${spaces(n)}x\ry`), [], []],
    // `[\s(—–-]+$` over a criterion whose text has a long gap before "verify:".
    "verify tail": [
      padded(SPEC_LIMIT, (n) => `# Acceptance criteria\n1. a${spaces(n)}b verify: x`),
      [{ id: "AC1", text: `a${spaces(2000 - 1)}…`, verify: "x" }],
      [],
    ],
    // `\s+(.*)$` over an item whose text holds a line separator.
    "numbered item": [
      `# Acceptance criteria\n1.${spaces(half)}${"x".repeat(half - 30)}${LS}`,
      [],
      [],
    ],
    "bullet item": [
      `# Assumptions\n-${spaces(half)}${"x".repeat(half - 30)}${LS}`,
      [],
      [],
    ],
  };
  for (const [name, [text, criteria, assumptions]] of Object.entries(cases)) {
    assert.ok(Buffer.byteLength(text) <= SPEC_LIMIT, name);
    assert.ok(Buffer.byteLength(text) > SPEC_LIMIT - 64, name);
    assert.deepEqual(
      timed(name, 5, () => parseSpec(text)),
      { criteria, assumptions },
      name,
    );
  }
});

test("a manifest of the size limit parses in linear time, whatever its lines", () => {
  const half = MANIFEST_LIMIT / 2;
  const pinned = 'serde = { version = "1" } # pinned\n';
  const lines = Math.floor((MANIFEST_LIMIT - 15) / pinned.length);
  const cases = [
    // `(?:^|\s+)#` over a requirement with a long gap and no comment.
    [
      "comment",
      "requirements.txt",
      padded(MANIFEST_LIMIT, (n) => `a${spaces(n)}b`),
      ["a"],
    ],
    // `^\[\s*([^\]]+?)\s*\]$` over a table header that never closes.
    ["table header", "Cargo.toml", padded(MANIFEST_LIMIT, (n) => `[${spaces(n)}a`), []],
    ["table header", "Pipfile", padded(MANIFEST_LIMIT, (n) => `[${spaces(n)}a`), []],
    [
      "table header",
      "pyproject.toml",
      padded(MANIFEST_LIMIT, (n) => `[${spaces(n)}a`),
      [],
    ],
    // `=\s*(.*)$` over a value that holds a line separator.
    [
      "key value",
      "Cargo.toml",
      `[dependencies]\na=${spaces(half)}${"x".repeat(half - 30)}${LS}y`,
      [],
    ],
    // Many short lines stay as cheap as one long line.
    [
      "many lines",
      "Cargo.toml",
      `[dependencies]\n${pinned.repeat(lines)}`,
      Array(lines).fill("serde"),
    ],
  ];
  for (const [name, file, text, names] of cases) {
    const label = `${name} in ${file}`;
    assert.ok(Buffer.byteLength(text) <= MANIFEST_LIMIT, label);
    assert.ok(Buffer.byteLength(text) > MANIFEST_LIMIT - 64, label);
    assert.deepEqual(
      timed(label, 1, () => dependencyNames(file, text)),
      names,
      label,
    );
  }
});

test("the corner cases of the replaced expressions keep their result", () => {
  // A closing run of hashes, a section named twice, and a heading inside a fence.
  assert.deepEqual(
    parseSpec(
      [
        "## Acceptance criteria ##  ",
        "1. First (verify: run it)",
        "",
        "```",
        "## Assumptions",
        "```",
        "#######  Assumptions",
        "## Assumptions #",
        "- [product decision] Free",
        "## Assumptions",
        "- ignored",
      ].join("\n"),
    ),
    {
      criteria: [{ id: "AC1", text: "First", verify: "run it)" }],
      assumptions: [{ id: "A1", text: "Free", productDecision: true }],
    },
  );
  assert.deepEqual(
    dependencyNames(
      "requirements.txt",
      "a # one\n#two\nb#three\ngit+https://x/c.git#egg=C_c # four\n d  #egg=e",
    ),
    ["a", "b", "c-c@git+https://x/c.git#egg=C_c", "d"],
  );
  assert.deepEqual(
    dependencyNames(
      "Cargo.toml",
      '[ dependencies ]\n"a" = "1"\nb.workspace = true\nc .d = 1\n[ ]\ne = 1\n[dependencies.f]',
    ),
    ["a", "b", "c", "f"],
  );
});
