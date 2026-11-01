import { record } from "../../../../extensions/mcp-config.js";
import { applyMcp, mcpSections, mcpSnapshot } from "./mcp-servers.js";
import { applyShell, shellSections } from "./shell.js";
import { nativeTools } from "../runtime-config.js";

// Compiled server names; anything else cannot be addressed as a dotted path.
const pathName = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;

/**
 * A JSON merge patch from `current` to `target`: keys `target` lacks become null.
 * Redacted secret values in `current` never equal the real ones, so they are
 * always rewritten.
 */
function mergeDiff(current, target) {
  const patch = {};
  for (const key of Object.keys(current)) if (!(key in target)) patch[key] = null;
  for (const [key, value] of Object.entries(target))
    patch[key] =
      record(value) && record(current[key]) ? mergeDiff(current[key], value) : value;
  return patch;
}

/**
 * What a live MCP apply writes (mcp-changes.js): the `snapshot` the store compiles
 * now (mcpSnapshot) and `build(config)`, the `config.patch` that gives the running
 * configuration its `mcp` block and global `tools.allow`. The list is the start's
 * own (`webTools`: the start's web tools snapshot, whose tools it appended) with the
 * shell tools while some agent has shell (they apply hot), so it equals what a start
 * writes.
 */
export function mcpLive({ profiles, inputs, webTools }) {
  const sections = mcpSections({ profiles, ...inputs });
  const snapshot = mcpSnapshot(sections);
  const global = { tools: { allow: [...nativeTools, ...(webTools?.tools || [])] } };
  const target = applyMcp(applyShell(global, shellSections({ profiles })), sections);
  const build = (config) => {
    const current = record(config.mcp?.servers) ? config.mcp.servers : {};
    const servers = target.mcp?.servers || {};
    const patch = { tools: { allow: target.tools.allow } };
    if (Object.keys(current).length || Object.keys(servers).length)
      patch.mcp = { servers: mergeDiff(current, servers) };
    // A merge patch cannot shorten or drop an array; OpenClaw needs each one listed.
    const arrays = Object.entries(current)
      .filter(([name, server]) => pathName.test(name) && Array.isArray(server?.args))
      .map(([name]) => `mcp.servers.${name}.args`);
    return { patch, replacePaths: ["tools.allow", ...arrays] };
  };
  return { snapshot, build };
}
