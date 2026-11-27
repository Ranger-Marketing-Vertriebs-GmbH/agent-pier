// Runs OpenClaw's own apply_patch for each patch read as JSON from stdin, each in a
// fresh workspace, and prints what it touched: { added, modified, deleted } or
// { error }. Since 2026.11.6 the dist exposes no test API for it, so this builds the
// tool as the agent gets it: createCoreCodingTools with only apply_patch switched on,
// kept to the workspace. Run with the runtime's Node:
//   node openclaw-apply-patch.mjs <openclaw dist directory> <scratch directory>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dist, scratch] = process.argv.slice(2);
// One chunk holds the tools and exports them under a minified name; a second one
// re-exports the factory under its own name.
let createCoreCodingTools;
for (const name of fs.readdirSync(dist).sort()) {
  if (!/^core-coding-tools-.*\.mjs$/.test(name)) continue;
  const module = await import(pathToFileURL(path.join(dist, name)).href);
  if (typeof module.createCoreCodingTools !== "function") continue;
  createCoreCodingTools = module.createCoreCodingTools;
  break;
}
if (!createCoreCodingTools)
  throw new Error("No core-coding-tools chunk exports createCoreCodingTools.");

function applyPatchTool(workspace) {
  const tool = createCoreCodingTools({
    // Any value but "disabled" and "full": apply_patch without exec and process.
    shellTools: "apply-patch",
    applyPatchEnabled: true,
    applyPatchWorkspaceOnly: true,
    includeBaseCodingTools: false,
    codingRoot: workspace,
    containmentRoot: workspace,
  }).find((entry) => entry.name === "apply_patch");
  if (!tool) throw new Error("createCoreCodingTools built no apply_patch tool.");
  return tool;
}

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
  const tool = applyPatchTool(workspace);
  try {
    const { details } = await tool.execute(`patch-${n}`, { input: patch });
    results.push(details.summary);
  } catch (error) {
    results.push({ error: String(error?.message).slice(0, 200) });
  }
}
process.stdout.write(JSON.stringify(results));
