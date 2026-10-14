// Runs OpenClaw's own apply_patch (2026.9.9 dist, exposed under VITEST) for each
// patch read as JSON from stdin, each in a fresh workspace, and prints what it
// touched: { added, modified, deleted } or { error }. Run with the runtime's Node:
//   node openclaw-apply-patch.mjs <openclaw dist directory> <scratch directory>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.VITEST = "1";
const [dist, scratch] = process.argv.slice(2);
const file = fs
  .readdirSync(dist)
  .find((name) => /^core-coding-tools-.*\.mjs$/.test(name));
await import(pathToFileURL(path.join(dist, file)).href);
const { applyPatch } = globalThis[Symbol.for("openclaw.applyPatchTestApi")];
let input = "";
for await (const chunk of process.stdin) input += chunk;
const results = [];
for (const [n, patch] of JSON.parse(input).entries()) {
  const workspace = path.join(scratch, String(n));
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes/existing.md"), "a\n");
  // Instruction files exist, so updates, deletes and moves onto them can apply;
  // a link to the workspace itself reaches them under another name.
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "a\n");
  fs.writeFileSync(path.join(workspace, "SOUL.md"), "a\n");
  fs.symlinkSync(".", path.join(workspace, "selflink"));
  try {
    const { summary } = await applyPatch(patch, {
      cwd: workspace,
      root: workspace,
      workspaceOnly: true,
    });
    results.push(summary);
  } catch (error) {
    results.push({ error: String(error?.message).slice(0, 200) });
  }
}
process.stdout.write(JSON.stringify(results));
