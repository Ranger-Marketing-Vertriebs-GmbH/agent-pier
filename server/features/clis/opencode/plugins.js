import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { modify, applyEdits } from "jsonc-parser";
import { serverMessages } from "../../../lib/i18n/de.js";
import { problem } from "../../../lib/storage.js";
import {
  configFile,
  npmName,
  npmPattern,
  npmSpec,
  npmVersion,
  safePath,
} from "../../plugins/plugin-schema.js";
import { configFiles } from "./profile-files.js";

// See codex/plugins.js. OpenCode plugins live in its config files and folders.
export const configFolders = ["plugins", "plugin"];
export const catalogFiles = [];
export const catalogInstall = false;

export async function inventory(store, ctx) {
  const result = store.empty(ctx);
  if (!ctx.command) return result;
  result.installed = configured(ctx).installed;
  const help = await store.execute(ctx, ["--help"]);
  result.capabilities.install = /plugin\s+<module>/.test(help);
  result.note = serverMessages.plugins.openCodeConfigurationNotice;
  result.noteCodes = ["openCodeConfiguration"];
  if (!result.capabilities.install)
    result.reason = serverMessages.plugins.openCodeInstallerUnavailable;
  return result;
}

export const selection = (action, input) => ({
  action,
  ...(action === "install"
    ? { source: npmSpec(input.source || input.pluginId) }
    : { pluginId: npmSpec(input.pluginId) }),
});

export const actionArgs = (_action, { source }) => ["plugin", source, "--global"];

/** Plugins named in the config files and the plugin folders. */
export function configured(ctx) {
  const files = configFiles
    .map((name) => configFile(path.join(ctx.root, name), ctx.boundary))
    .filter(Boolean);
  const entries = new Map();
  for (const file of files)
    for (const item of file.data.plugin || []) {
      const spec =
        typeof item === "string"
          ? item
          : Array.isArray(item) && typeof item[0] === "string"
            ? item[0]
            : null;
      if (!spec) throw problem(serverMessages.plugins.unsupportedEntryFormat, 409);
      const npm = npmPattern.test(spec);
      if (!entries.has(spec))
        entries.set(spec, {
          id: npm
            ? spec
            : `external:${createHash("sha256").update(spec).digest("hex").slice(0, 24)}`,
          name: npm ? npmName(spec) : serverMessages.plugins.externalPlugin,
          description: npm
            ? serverMessages.plugins.globalPackageScope
            : serverMessages.plugins.externalSourceScope,
          version: npm ? npmVersion(spec) : null,
          enabled: true,
          marketplace: "",
          scope: "global",
          removable: npm,
        });
    }
  for (const directory of ["plugin", "plugins"]) {
    const folder = path.join(ctx.root, directory);
    safePath(folder, ctx.boundary);
    let children;
    try {
      children = fs.readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const child of children)
      if (
        /\.(?:js|ts|mjs|cjs)$/.test(child.name) &&
        (child.isFile() || child.isSymbolicLink())
      ) {
        const id = `file:${directory}/${child.name}`;
        entries.set(id, {
          id,
          name: child.name,
          description: serverMessages.plugins.automaticLocalPlugin,
          version: null,
          enabled: true,
          marketplace: "",
          scope: "global",
          removable: false,
        });
      }
  }
  return { files, installed: [...entries.values()] };
}

/** Removes npm plugin `id` from every config file; `recheck()` runs before writing. */
export function removeFromConfig(ctx, id, recheck) {
  const { files, installed } = configured(ctx);
  if (!installed.some((item) => item.id === id && item.removable))
    throw problem(serverMessages.plugins.missingOrReadOnly, 404);
  if (
    installed.some(
      (item) => item.removable && item.id !== id && npmName(item.id) === npmName(id),
    )
  )
    throw problem(serverMessages.plugins.multipleVersionsConfigured, 409);
  const edits = files
    .filter((file) =>
      (file.data.plugin || []).some(
        (item) => (Array.isArray(item) ? item[0] : item) === id,
      ),
    )
    .map((file) => {
      let next = file.text;
      for (let index = file.data.plugin.length - 1; index >= 0; index--)
        if (
          (Array.isArray(file.data.plugin[index])
            ? file.data.plugin[index][0]
            : file.data.plugin[index]) === id
        )
          next = applyEdits(
            next,
            modify(next, ["plugin", index], undefined, {
              formattingOptions: { insertSpaces: true, tabSize: 2 },
            }),
          );
      return { ...file, next };
    });
  // Validate every document before writing, and preserve unrelated JSONC text.
  for (const edit of edits) {
    safePath(edit.file, ctx.boundary);
    if (fs.readFileSync(edit.file, "utf8") !== edit.text)
      throw problem(serverMessages.plugins.configChanged, 409);
  }
  recheck();
  for (const edit of edits) {
    safePath(edit.file, ctx.boundary);
    if (fs.readFileSync(edit.file, "utf8") !== edit.text)
      throw problem(serverMessages.plugins.configChanged, 409);
    const temporary = `${edit.file}.agentpier-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, edit.next, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, edit.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
