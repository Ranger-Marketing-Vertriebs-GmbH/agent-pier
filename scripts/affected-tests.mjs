import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { changedFiles, workingTree } from "./affected/repo-source.mjs";
import { defaultThreshold, selectAffected } from "./affected/select.mjs";

// Selects the tests a change can affect, for fast pull request feedback. The
// merge queue and nightly runs still run everything.
//
//   node scripts/affected-tests.mjs --base <ref> [--head <ref>] [--json]
//   node scripts/affected-tests.mjs --files <path>... [--json]
//   node scripts/affected-tests.mjs --base <ref> --run [-- <node --test options>]
//
// Prints { mode: "all" | "selected" | "none", node, browser, reasons }. With
// --run it runs the selected node tests through the test runner. The graph is
// read from the working tree, so --head should be the checked-out commit.

export function affectedTests({ root, base, head = "HEAD", files, threshold }) {
  const changed = files ?? (base ? changedFiles(root, base, head) : null);
  return selectAffected({ changed, source: workingTree(root), threshold });
}

function summary(result) {
  const lines = [
    `mode: ${result.mode}`,
    `node tests: ${result.node.length}`,
    `browser specs: ${result.browser.length}`,
    ...result.reasons.map((reason) => `  ${reason}`),
  ];
  return lines.join("\n");
}

// Runs the selected node:test files the way scripts/test.mjs runs a strategy.
async function runNodeTests(root, files, options) {
  const runner = path.join(root, "scripts/test-runner.mjs");
  if (fs.existsSync(runner)) {
    const { runTestFiles } = await import(pathToFileURL(runner).href);
    return runTestFiles({
      root,
      files,
      nodeArgs: ["--test-concurrency=4", ...options],
      label: "affected",
      retry: process.env.AGENTPIER_TEST_RETRY_FAILED_FILES === "1",
      testTimeout: Number(process.env.AGENTPIER_TEST_TIMEOUT_MS) || undefined,
      neverRetry: ["tests/property/"],
    });
  }
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "tests/helpers/tmux-reaper.js"),
      "--test",
      "--test-concurrency=4",
      ...options,
      ...files,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (child.error) throw child.error;
  return child.status ?? 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      files: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      run: { type: "boolean", default: false },
      threshold: { type: "string", default: String(defaultThreshold) },
    },
  });
  const threshold = Number(values.threshold);
  if (!(threshold > 0 && threshold <= 1))
    throw new Error("--threshold must be in (0, 1]");
  if (values.files && values.base) throw new Error("Use either --base or --files");
  const root = path.resolve(import.meta.dirname, "..");
  const base = values.base ?? process.env.AGENTPIER_AFFECTED_BASE;
  if (!values.files && !base) throw new Error("Name a --base ref or --files");
  const result = affectedTests({
    root,
    base,
    head: values.head,
    files: values.files ? positionals : undefined,
    threshold,
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : summary(result));
  if (!values.run) return;
  if (!result.node.length) {
    console.log("No node tests are affected.");
    return;
  }
  process.exitCode = await runNodeTests(
    root,
    result.node,
    values.files ? [] : positionals,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
