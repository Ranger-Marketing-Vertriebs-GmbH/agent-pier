import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  headingText,
  keyValue,
  listItemText,
  tableName,
  withoutComment,
  withoutTail,
} from "../../server/features/pipelines/line-scan.js";
import { parseSpec } from "../../server/features/pipelines/spec-parse.js";
import {
  addedDependencies,
  dependencyNames,
} from "../../server/features/pipelines/risk-dependencies.js";
import { criterionId } from "../../server/features/pipelines/stage-verdict.js";
// The parsers as they were before their expressions became scanners. They take cubic
// time on crafted lines, so every generated line here stays short.
import { parseSpec as legacyParseSpec } from "../fixtures/pipeline-legacy-parsers/spec-parse.js";
import * as legacy from "../fixtures/pipeline-legacy-parsers/risk-dependencies.js";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

// Characters and words the replaced expressions treat specially: every kind of
// whitespace, the line terminators `.` refuses, and each format's punctuation.
const pieces = [
  ...[" ", "  ", "\t", "\r", LS, PS, " ", "﻿", "\v"],
  ...["#", "##", "#######", "[", "]", "=", ".", '"', "'", "-", "*", "+", "(", ")", ":"],
  ...["1", "12", "123", "1234", "0", "a", "B", "z9", "_", "x", "é", "—", "–", "@", "/"],
  ...["{", "}", ",", "egg=", "#egg=", "verify:", "Verification :", "how to verify"],
  ...["[product decision]", "(product-decision)", "product decision:", "git", "path ="],
];
const piece = fc.oneof(
  { weight: 12, arbitrary: fc.constantFrom(...pieces) },
  { weight: 1, arbitrary: fc.string({ maxLength: 3 }) },
);
const hostile = fc.array(piece, { maxLength: 14 }).map((parts) => parts.join(""));
const starting = (...starts) =>
  fc.tuple(fc.constantFrom(...starts), hostile).map(([start, rest]) => start + rest);
const runs = { numRuns: 3000 };

test("a heading scans to what its expression matched", () => {
  const expression = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
  const line = fc.oneof(
    hostile,
    starting("# ", "## ", "   ###\t", "    # ", "###### ", "####### ", "#", "#\r"),
  );
  fc.assert(
    fc.property(line, (text) => {
      assert.equal(headingText(text), expression.exec(text)?.[1] ?? null);
    }),
    runs,
  );
});

test("a list item scans to what its expression matched", () => {
  const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/;
  const any = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
  const line = fc.oneof(
    hostile,
    starting("1. ", " 12) ", "\t123.\t", "1234. ", "1.", "- ", "  * ", "+\t", "-", "1 "),
  );
  fc.assert(
    fc.property(line, (text) => {
      assert.equal(listItemText(text), numbered.exec(text)?.[1] ?? null);
      assert.equal(listItemText(text, true), any.exec(text)?.[1] ?? null);
    }),
    runs,
  );
});

test("a criterion's text loses the tail its expression removed", () => {
  fc.assert(
    fc.property(hostile, (text) => {
      assert.equal(withoutTail(text, "(—–-"), text.replace(/[\s(—–-]+$/, ""));
    }),
    runs,
  );
});

test("a manifest line loses the comment its expression removed", () => {
  const line = fc.oneof(
    hostile,
    starting("#", " #", "a #", "a#", "#egg=", "x  #egg=b #"),
  );
  fc.assert(
    fc.property(line, (text) => {
      assert.equal(withoutComment(text), text.replace(/(?:^|\s+)#(?!egg=).*$/, ""));
    }),
    runs,
  );
});

test("a table header scans to what its expression matched", () => {
  const expression = /^\[\s*([^\]]+?)\s*\]$/;
  const line = fc.oneof(
    hostile,
    hostile.map((text) => `[${text}]`),
    fc.constantFrom("[]", "[ ]", "[\t \r]", "[a]", "[ a b ]", "[a]]", "[[a]]", "[a] "),
  );
  fc.assert(
    fc.property(line, (text) => {
      assert.equal(tableName(text), expression.exec(text)?.[1] ?? null);
    }),
    runs,
  );
});

test("a key line scans to what its expression matched", () => {
  const expression = /^"?([A-Za-z0-9_.-]+?)"?\s*(?:\.[A-Za-z0-9_-]+\s*)?=\s*(.*)$/;
  const key = fc
    .array(fc.constantFrom("a", "B", "9", "_", "-", ".", "..", '"', " ", "\t", "\r"), {
      maxLength: 8,
    })
    .map((parts) => parts.join(""));
  const line = fc.oneof(
    hostile,
    fc.tuple(key, fc.constantFrom("=", " = ", "", "=="), hostile).map((p) => p.join("")),
  );
  fc.assert(
    fc.property(line, (text) => {
      const match = expression.exec(text);
      assert.deepEqual(keyValue(text), match ? [match[1], match[2]] : null);
    }),
    runs,
  );
});

test("a criterion id is read as its earlier expression read it", () => {
  const expression = /^#?\s*(?:ac)?[\s\-‐-―−]*0*([1-9]\d{0,2})$/i;
  const part = fc.constantFrom(
    ...["#", " ", "\t", "ac", "AC", "Ac", "a", "c", "-", "‐", "−", "—"],
    ...["0", "00", "1", "7", "42", "100", "1000", "x", " "],
  );
  const id = fc.array(part, { maxLength: 10 }).map((parts) => parts.join(""));
  fc.assert(
    fc.property(fc.oneof(id, hostile), (text) => {
      const match = expression.exec(text.trim());
      assert.equal(criterionId(text), match ? `AC${match[1]}` : "");
    }),
    runs,
  );
});

const documentOf = (line) =>
  fc
    .tuple(fc.array(line, { maxLength: 30 }), fc.constantFrom("\n", "\r\n"))
    .map(([lines, end]) => lines.join(end));
const mixed = (realistic) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom(...realistic) },
    { weight: 2, arbitrary: hostile },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom(...realistic), hostile, fc.boolean())
        .map(([line, extra, before]) => (before ? extra + line : line + extra)),
    },
  );

const specLines = [
  ...[
    "# Spec",
    "## Acceptance criteria",
    "## Acceptance Criteria (AC) ##",
    "## Assumptions",
  ],
  ...[
    "### assumptions:",
    "   # Acceptance criteria   ",
    "#Acceptance criteria",
    "## Notes",
  ],
  ...["```", "~~~", "", "  ", "Closing prose.", "    indented continuation"],
  ...["1. The page loads. Verify: open it", "2) Saves on blur (how to verify: npm test)"],
  ...["3. Third criterion — verification: curl -s localhost", "  1. nested item"],
  ...["10. Tenth", "1234. no item", "- An assumption", "* [product decision] Free tier"],
  ...["+ (Product_Decision) quotas", "- product decision: prices in EUR", "1. numbered"],
  ...["  - nested bullet", "-no item", "1.no item", "verify: alone"],
];

test("a spec parses to what the earlier parser read", () => {
  fc.assert(
    fc.property(documentOf(mixed(specLines)), (text) => {
      assert.deepEqual(parseSpec(text), legacyParseSpec(text));
    }),
    runs,
  );
});

const manifests = {
  "requirements.txt": [
    ...["requests>=2  # http", "Django==5.0", "# a comment", "  # indented comment", ""],
    ...["pkg @ https://example.com/pkg.zip", "extras[one,two] @ file:///tmp/x # local"],
    ...[
      "git+https://github.com/a/b.git#egg=b",
      "-r other.txt",
      "-e ./local#egg=Local_Pkg",
    ],
    ...[
      "./vendor/thing",
      "Flask_Login>=0.6",
      "name #egg=kept",
      "a#b",
      "numpy;python_version<'3.9'",
    ],
  ],
  "go.mod": [
    ...["module example.com/app", "go 1.22", "require (", ")", "replace (", ""],
    ...["\tgithub.com/a/b v1.2.3 // indirect", "require github.com/c/d v0.1.0"],
    ...["replace github.com/a/b => ../b", "\tgithub.com/x/y => github.com/z/y v1.0.0"],
    ...["// a comment", "require  github.com/e/f v2 # odd", "replace(", "require("],
  ],
  "Cargo.toml": [
    ...[
      "[package]",
      'name = "app"',
      "[dependencies]",
      "[dev-dependencies]",
      "[ dependencies ]",
    ],
    ...[
      "[build-dependencies]",
      "[dependencies.serde]",
      '[target."cfg(unix)".dependencies]',
    ],
    ...['serde = "1"', 'tokio = { version = "1", features = ["full"] }', "[workspace]"],
    ...[
      "serde.workspace = true",
      'tokio.version = "1" # pinned',
      '"quoted-name" = "0.3"',
    ],
    ...['mine = { git = "https://example.com/mine" }', 'local = { path = "../local" }'],
    ...[
      "a.b.c = 1",
      'x ="1"',
      "y= 2",
      "[]",
      "[ ]",
      "# comment",
      "",
      "not a key",
      ".odd = 1",
    ],
  ],
  Pipfile: [
    ...["[[source]]", 'url = "https://pypi.org/simple"', "[packages]", "[dev-packages]"],
    ...['requests = "*"', 'Flask_Login = ">=0.6"', 'mine = {git = "https://x/mine.git"}'],
    ...[
      'local = {path = "./local", editable = true}',
      'wheel = {file = "https://x/w.whl"}',
    ],
    ...["[requires]", 'python_version = "3.12"', "", "# comment", '"dotted.name" = "*"'],
  ],
  "pyproject.toml": [
    ...["[project]", 'name = "app"', 'dependencies = ["requests>=2", "Django>=5"]'],
    ...[
      "dependencies = [",
      '  "rich>=13",',
      "  'typer[all] @ https://x/typer.zip',",
      "]",
    ],
    ...[
      "[project.optional-dependencies]",
      'dev = ["pytest", "ruff"]',
      "docs = [",
      "[build-system]",
    ],
    ...[
      "[tool.poetry.dependencies]",
      'python = "^3.12"',
      'rich = "^13"',
      "[tool.poetry]",
    ],
    ...["[tool.poetry.group.dev.dependencies]", 'mine = { git = "https://x/mine" }'],
    ...['other = { url = "https://x/o.whl" } # direct', "[ project ]", "", "# comment"],
  ],
  Gemfile: [
    ...[
      'source "https://rubygems.org"',
      'gem "rails", "~> 7.1"',
      "gem 'pg'",
      "# comment",
    ],
    ...[
      'gem "mine", git: "https://example.com/mine.git"',
      "gem 'local', path: '../local'",
    ],
    ...[
      'gem "forked", github: "me/forked" # fork',
      'gem  "spaced"',
      "group :test do",
      "end",
    ],
    ...['gem "a" + "b"', "gem rails", ""],
  ],
};
const manifest = fc
  .constantFrom(...Object.keys(manifests))
  .chain((file) =>
    fc.tuple(
      fc.constant(file),
      documentOf(mixed(manifests[file])),
      documentOf(mixed(manifests[file])),
    ),
  );

test("a manifest's dependencies are the ones the earlier parser read", () => {
  fc.assert(
    fc.property(manifest, ([file, before, after]) => {
      assert.deepEqual(dependencyNames(file, after), legacy.dependencyNames(file, after));
      assert.deepEqual(
        addedDependencies(file, before, after),
        legacy.addedDependencies(file, before, after),
      );
    }),
    runs,
  );
});
