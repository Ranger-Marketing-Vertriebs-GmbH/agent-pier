import path from "node:path";
import { parseArgs } from "node:util";
import { runTestFiles } from "./test-runner.mjs";
import { defaultMaxFlaky } from "./test-retry.mjs";

// Run named node:test files, for CI steps that select their own suites:
//   node scripts/test-files.mjs [--label NAME] [--concurrency N] [--retry]
//     [--max-flaky N] [--test-timeout MS] [--no-skips]
//     [--never-retry PATH-PREFIX]... <files...>
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: "string", default: "" },
    concurrency: { type: "string", default: "1" },
    retry: { type: "boolean", default: false },
    "max-flaky": { type: "string", default: String(defaultMaxFlaky) },
    "test-timeout": { type: "string" },
    "no-skips": { type: "boolean", default: false },
    "never-retry": { type: "string", multiple: true, default: [] },
  },
});
if (!positionals.length) throw new Error("No test files were named");
for (const name of ["concurrency", "test-timeout"])
  if (values[name] !== undefined && !/^[1-9][0-9]*$/.test(values[name]))
    throw new Error(`--${name} must be a positive integer`);
if (!/^[0-9]+$/.test(values["max-flaky"]))
  throw new Error("--max-flaky must be a non-negative integer");
process.exitCode = runTestFiles({
  root: path.resolve(import.meta.dirname, ".."),
  files: positionals,
  nodeArgs: [`--test-concurrency=${values.concurrency}`],
  label: values.label,
  retry: values.retry,
  maxFlaky: Number(values["max-flaky"]),
  testTimeout: values["test-timeout"] && Number(values["test-timeout"]),
  noSkips: values["no-skips"],
  neverRetry: values["never-retry"],
});
