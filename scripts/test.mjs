import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const strategies = ["unit", "integration", "blackbox", "property", "matrix"];
const [strategy = "all", ...options] = process.argv.slice(2);
if (strategy !== "all" && !strategies.includes(strategy)) {
  throw new Error(`Unknown test strategy: ${strategy}`);
}
const root = path.resolve(import.meta.dirname, "..");
function collect(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collect(file)
      : entry.name.endsWith(".test.js")
        ? [file]
        : [];
  });
}
const files = (
  strategy === "all"
    ? collect(path.join(root, "tests"))
    : collect(path.join(root, "tests", strategy))
).sort();
if (!files.length) throw new Error(`No ${strategy} tests were discovered`);
const child = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=4", ...options, ...files],
  { cwd: root, stdio: "inherit" },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
