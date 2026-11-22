import fs from "node:fs";
import path from "node:path";

/**
 * OpenClaw 2026.11.6 starts each next turn from the session's own tools, so a tool-
 * search directory tool the model called by name is no longer declared and its call
 * and result are replayed as assistant text (openclaw#202415). AgentPier's
 * `hydrated-tools-kept` patches (runtime-bundle-patches.js) keep such tools for the
 * next turn. This guard reads the installed package, independent of the patch list:
 * it fails while the next-turn preparation still resets the tool list without the
 * hydrated tools, until the patches are carried forward or upstream's fix (#202436)
 * is pinned and the guard updated.
 */
const definition = /\bfunction createSessionPrepareNextTurnWithContext\s*\(/;
const reset = /tools: v \? m\.slice\(\) : c\.context\.tools\?\.slice\(\)/;
const kept = /keepHydrated/;

function* scripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(file);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) yield file;
  }
}

/** Every script defining the next-turn preparation, as `{ file, resets, keeps }`. */
export function hydratedToolsSites(packageDir) {
  const found = [];
  for (const file of scripts(path.join(packageDir, "dist"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!definition.test(text)) continue;
    found.push({
      file: path.relative(packageDir, file).split(path.sep).join("/"),
      resets: reset.test(text),
      keeps: kept.test(text),
    });
  }
  return found;
}

/** Throws unless the package keeps hydrated directory tools for the next turn. */
export function assertHydratedToolsKept(packageDir) {
  const found = hydratedToolsSites(packageDir);
  if (!found.length)
    throw Error(
      `No createSessionPrepareNextTurnWithContext found in ${packageDir}/dist; update the hydrated tools guard.`,
    );
  const dropping = found.filter((site) => site.resets || !site.keeps);
  if (dropping.length)
    throw Error(
      `OpenClaw drops hydrated tool-search tools from the next turn: ${dropping
        .map((site) => site.file)
        .join(
          ", ",
        )}. Carry the hydrated-tools-kept patches forward (runtime-bundle-patches.js).`,
    );
  return found;
}
