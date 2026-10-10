import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const exportList = /export\s*\{([^}]*)\}/g;
const importList = /import\s*\{([^}]*)\}\s*from/g;
const names = (list, side) =>
  list
    .split(",")
    .map((entry) => entry.trim().split(/\s+as\s+/))
    .filter(([local]) => local)
    .map(([local, alias = local]) => (side === "local" ? local : alias));

// OpenClaw bundles internals into hash-named chunks (`service-m6MonO39.mjs`) and
// exports them under minified aliases (`CronService as t`). Both change on every
// upstream build, so internals are found by the original symbol name in the
// chunk's export list instead of by file name. Never copies or patches the package.
//
// Returns { [symbol]: { path, alias } }, also for code importing in another process.
export function locateOpenClawExports(packageRoot, symbols) {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const dist = path.join(packageRoot, "dist");
  const found = new Map(symbols.map((symbol) => [symbol, []]));
  for (const file of fs.readdirSync(dist).sort()) {
    if (!/\.m?js$/.test(file)) continue;
    const source = fs.readFileSync(path.join(dist, file), "utf8");
    if (!symbols.some((symbol) => source.includes(symbol))) continue;
    // Barrel chunks import a symbol and export it again; only its definer counts.
    const imported = new Set(
      [...source.matchAll(importList)].flatMap(([, list]) => names(list, "alias")),
    );
    for (const [, list] of source.matchAll(exportList)) {
      const locals = names(list, "local");
      names(list, "alias").forEach((alias, index) => {
        if (!imported.has(locals[index])) found.get(locals[index])?.push({ file, alias });
      });
    }
  }
  const located = {};
  for (const [symbol, matches] of found) {
    if (matches.length !== 1)
      throw Error(
        `OpenClaw ${version}: expected one dist module exporting ${symbol}, found ` +
          (matches.length
            ? matches.map(({ file }) => file).join(", ")
            : "none; requalify the native contracts for this version"),
      );
    const [{ file, alias }] = matches;
    located[symbol] = { path: path.join(dist, file), alias };
  }
  return located;
}

export async function importOpenClawExports(packageRoot, symbols) {
  const resolved = {};
  for (const [symbol, { path: file, alias }] of Object.entries(
    locateOpenClawExports(packageRoot, symbols),
  ))
    resolved[symbol] = (await import(pathToFileURL(file)))[alias];
  return resolved;
}
