import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { craftManagedKeys } from "./craft-config.js";

const modes = ["clean-room", "deep"];

/** The owner's choice for Craft Anything's session row: `{ mode }`, clean-room by default. */
export function cleanCraftSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const mode = source.mode ?? "clean-room";
  if (!modes.includes(mode)) throw problem(serverMessages.craft.invalidMode, 400);
  return { mode };
}

/**
 * The row's arguments: always restricted (consent-gated, machine-acting and network
 * tools refused before Craft Anything reads its settings), with web and capture
 * tools, and the owner's mode.
 */
export const craftArgs = (settings) => [
  "mcp",
  "--restricted",
  "--allow-web",
  "--allow-capture",
  settings.mode === "deep" ? "--deep" : "--clean-room",
];

/**
 * The installed CLI (a managedReaComponent result) through the `<root>/craft-anything`
 * link, keeping the version's top folder: for the pinned version this is
 * craftBinaryPath(root, entry), so it changes with every update.
 */
export const craftCommand = (root, component) =>
  path.join(
    root,
    "craft-anything",
    path.relative(component.directory, component.home),
    "craft-anything-cli",
  );

/**
 * The env patch turning the row's `current` env into `wanted` for Craft Anything's
 * keys only; the owner's own keys are never named.
 */
export function craftEnvPatch(current, wanted) {
  const have = current ?? {};
  const patch = {};
  for (const key of craftManagedKeys) {
    if (Object.hasOwn(wanted, key)) {
      if (have[key] !== wanted[key]) patch[key] = wanted[key];
    } else if (Object.hasOwn(have, key)) patch[key] = null;
  }
  return patch;
}

/**
 * What changes on row `server` (`env` its values) so it runs `wanted` ({ command,
 * args, env }): command and args as a whole, env for the managed keys only.
 */
export function craftRowPatch(server, env, wanted) {
  const patch = {};
  if (server.command !== wanted.command) patch.command = wanted.command;
  if (JSON.stringify(server.args ?? []) !== JSON.stringify(wanted.args))
    patch.args = wanted.args;
  const envPatch = craftEnvPatch(env, wanted.env);
  if (Object.keys(envPatch).length) patch.env = envPatch;
  return patch;
}
