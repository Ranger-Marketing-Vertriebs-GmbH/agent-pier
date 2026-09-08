import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const roots = ["server", "web", "scripts", "tests"];
const limit = 600;
const violations = [];
let checked = 0;
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspect(file);
    else if (/\.(?:m?js|jsx|css)$/.test(entry.name)) {
      const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").length;
      checked++;
      if (lines > limit)
        violations.push(
          `${path.relative(root, file)}: ${lines} lines (maximum ${limit})`,
        );
    }
  }
}
for (const name of roots) inspect(path.join(root, name));
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Structure check passed: ${checked} source/test files, at most ${limit} lines each.`,
  );
