import path from "node:path";
import { parseArgs } from "node:util";
import { runTestFiles } from "./test-runner.mjs";

// Run named node:test files, for CI steps that select their own suites:
//   node scripts/test-files.mjs [--label NAME] [--concurrency N] [--retry]
//     [--no-skips] <files...>
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: "string", default: "" },
    concurrency: { type: "string", default: "1" },
    retry: { type: "boolean", default: false },
    "no-skips": { type: "boolean", default: false },
  },
});
if (!positionals.length) throw new Error("No test files were named");
if (!/^[1-9][0-9]*$/.test(values.concurrency))
  throw new Error("--concurrency must be a positive integer");
process.exitCode = runTestFiles({
  root: path.resolve(import.meta.dirname, ".."),
  files: positionals,
  nodeArgs: [`--test-concurrency=${values.concurrency}`],
  label: values.label,
  retry: values.retry,
  noSkips: values["no-skips"],
});
