import {
  catalogAccount,
  catalogMetadata,
  codexInventory,
  remoteMarketplace,
} from "./codex-catalog.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { executePluginCommand } from "./plugin-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { randomUUID, createHash } from "node:crypto";

import { modify, applyEdits } from "jsonc-parser";
import { detectTools } from "../accounts/account-store.js";
import { problem } from "../../lib/storage.js";
import {
  object,
  npmPattern,
  npmName,
  npmVersion,
  selector,
  marketName,
  npmSpec,
  marketSource,
  safePath,
  configFile,
  redacted,
  marketplaceRow,
  pluginRow,
} from "./plugin-schema.js";
export class PluginStore {
  constructor({
    accounts,
    home = os.homedir(),
    resolveTool,
    run,
    listTimeout = 30000,
    mutationTimeout = 180000,
    sharedProfiles,
  } = {}) {
    this.accounts = accounts;
    this.sharedProfiles = sharedProfiles;
    this.home = path.resolve(home);
    this.resolveTool =
      resolveTool ||
      ((tool, env) => detectTools(env).find((item) => item.id === tool)?.path);
    this.runner = run;
    this.listTimeout = listTimeout;
    this.mutationTimeout = mutationTimeout;
    this.locks = new Set();
    this.reads = new Map();
    this.readScopes = new Map();
    this.cache = new Map();
    this.processes = new Set();
    this.closed = false;
  }
  isBusy(id) {
    if (this.sharedProfiles) id = this.sharedProfiles.resolve(id);
    return (
      this.locks.has(id) || [...this.readScopes.values()].some((scope) => scope.id === id)
    );
  }
  context(id, { catalog = false } = {}) {
    if (this.sharedProfiles && !catalog) id = this.sharedProfiles.resolve(id);
    const account = this.accounts.get(id);
    const boundary =
      account.kind === "managed" ? path.resolve(this.accounts.dataDir) : this.home;
    if (account.tool === "shell")
      throw problem(serverMessages.plugins.shellManagementUnavailable, 409);
    const cwd = account.kind === "managed" ? this.accounts.profile(id) : this.home;
    safePath(cwd, boundary);
    if (account.kind === "managed")
      for (const directory of ["codex", "claude", "config", "data", "state", "cache"])
        safePath(path.join(cwd, directory), boundary);
    const initialRoot =
      account.kind === "managed"
        ? path.join(cwd, account.tool === "opencode" ? "config/opencode" : account.tool)
        : path.join(
            this.home,
            account.tool === "opencode" ? ".config/opencode" : `.${account.tool}`,
          );
    safePath(initialRoot, boundary);
    const env = this.accounts.environment(id);
    const root =
      account.tool === "codex"
        ? env.CODEX_HOME || path.join(env.HOME, ".codex")
        : account.tool === "claude"
          ? env.CLAUDE_CONFIG_DIR || path.join(env.HOME, ".claude")
          : path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, ".config"), "opencode");
    safePath(root, boundary);
    for (const file of account.tool === "opencode"
      ? [
          "config.json",
          "opencode.json",
          "opencode.jsonc",
          "tui.json",
          "tui.jsonc",
          "plugins",
          "plugin",
        ]
      : account.tool === "codex"
        ? ["config.toml", "plugins", ...(catalog ? ["auth.json"] : [])]
        : ["settings.json", "plugins"])
      if (
        catalog &&
        file === "plugins" &&
        this.sharedProfiles &&
        account.kind === "managed" &&
        fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        const expected = path.join(this.home, ".codex", "plugins");
        safePath(expected, this.home);
        if (path.resolve(root, fs.readlinkSync(path.join(root, file))) !== expected)
          throw problem(serverMessages.plugins.linkedConfigReadOnly, 409);
      } else safePath(path.join(root, file), boundary);
    return {
      id,
      tool: account.tool,
      account,
      root,
      boundary,
      cwd,
      env,
      command: this.resolveTool(account.tool, env),
    };
  }
  empty(ctx) {
    return {
      tool: ctx.tool,
      available: !!ctx.command,
      reason: ctx.command ? null : serverMessages.common.cliNotInstalled,
      note: serverMessages.plugins.restartRequiredNotice,
      installed: [],
      marketplaces: [],
      catalog: [],
      capabilities: {
        marketplaces: false,
        enable: false,
        update: false,
        install: false,
      },
      busy: this.locks.has(ctx.id),
    };
  }
  execute(ctx, args, mutation = false) {
    return executePluginCommand(ctx, args, this, mutation);
  }
  async json(ctx, args) {
    const output = await this.execute(ctx, args);
    try {
      return JSON.parse(output);
    } catch {
      throw problem(serverMessages.plugins.unsupportedCliJson, 409);
    }
  }
  opencodeInventory(ctx) {
    const files = [
      "config.json",
      "opencode.json",
      "opencode.jsonc",
      "tui.json",
      "tui.jsonc",
    ]
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
  inventory(ctx, selected = ctx) {
    return ctx.tool === "codex"
      ? codexInventory(this, ctx, selected)
      : this.nativeInventory(ctx);
  }
  async nativeInventory(ctx) {
    const result = this.empty(ctx);
    if (!ctx.command) return result;
    if (ctx.tool === "opencode") {
      result.installed = this.opencodeInventory(ctx).installed;
      const help = await this.execute(ctx, ["--help"]);
      result.capabilities.install = /plugin\s+<module>/.test(help);
      result.note = serverMessages.plugins.openCodeConfigurationNotice;
      if (!result.capabilities.install)
        result.reason = serverMessages.plugins.openCodeInstallerUnavailable;
      return result;
    }
    const list = await this.json(ctx, ["plugin", "list", "--json", "--available"]);
    if (!object(list) || !Array.isArray(list.installed) || !Array.isArray(list.available))
      throw problem(serverMessages.plugins.unsupportedPluginList, 409);
    const markets = await this.json(ctx, ["plugin", "marketplace", "list", "--json"]);
    const rows = Array.isArray(markets) ? markets : markets?.marketplaces;
    if (!Array.isArray(rows))
      throw problem(serverMessages.plugins.unsupportedMarketplaceList, 409);
    result.installed = list.installed.map((item) => pluginRow(item, ctx.tool, true));
    const installed = new Set(result.installed.map((item) => item.id));
    result.catalog = list.available.map((item) => ({
      ...pluginRow(item, ctx.tool, false),
      installed: installed.has(item.pluginId || item.id),
    }));
    result.marketplaces = rows.map((item) => marketplaceRow(item, ctx.tool));
    result.capabilities = {
      marketplaces: true,
      enable: ctx.tool === "claude",
      update: ctx.tool === "claude",
      install: true,
    };
    if (ctx.tool === "claude")
      result.note += serverMessages.plugins.claudeMarketplaceRemovalNotice;
    else result.note += serverMessages.plugins.codexActivationNotice;
    return result;
  }
  async list(id, selectedId) {
    if (this.sharedProfiles) id = this.sharedProfiles.resolve(id);
    if (this.closed) throw problem(serverMessages.plugins.serviceStopping, 503);
    const ctx = this.context(id);
    const selected = catalogAccount(this, ctx, selectedId);
    const key = selected ? JSON.stringify([id, selected.id]) : id;
    const empty = () => ({
      ...this.empty(ctx),
      ...(selected ? catalogMetadata(this, selected) : {}),
    });
    if (this.locks.has(id)) return { ...(this.cache.get(key) || empty()), busy: true };
    if (this.reads.has(key)) return this.reads.get(key);
    this.readScopes.set(key, { id, catalogId: selected?.id });
    const reading = this.inventory(ctx, selected || ctx)
      .then((result) => {
        this.accounts.get(id);
        if (selected) this.accounts.get(selected.id);
        this.cache.set(key, result);
        return { ...result, busy: this.locks.has(id) };
      })
      .catch((error) => {
        if (error.status === 409 || error.status === 502) {
          const result = {
            ...empty(),
            available: false,
            reason: redacted(error.message, ctx.env),
          };
          this.cache.set(key, result);
          return result;
        }
        throw error;
      })
      .finally(() => {
        this.reads.delete(key);
        this.readScopes.delete(key);
      });
    this.reads.set(key, reading);
    return reading;
  }
  validate(input, tool) {
    if (
      !object(input) ||
      ![
        "install",
        "remove",
        "enable",
        "disable",
        "update",
        "marketplace-add",
        "marketplace-remove",
        "marketplace-update",
      ].includes(input.action)
    )
      throw problem(serverMessages.plugins.unknownAction);
    const action = input.action;
    if (action === "marketplace-add")
      return { action, source: marketSource(input.source) };
    if (action.startsWith("marketplace-"))
      return { action, marketplace: marketName(input.marketplace) };
    if (tool === "opencode")
      return {
        action,
        ...(action === "install"
          ? { source: npmSpec(input.source || input.pluginId) }
          : { pluginId: npmSpec(input.pluginId) }),
      };
    return { action, pluginId: selector(input.pluginId) };
  }
  async mutate(id, input) {
    if (this.sharedProfiles) id = this.sharedProfiles.resolve(id);
    if (this.closed) throw problem(serverMessages.plugins.serviceStopping, 503);
    const account = this.accounts.get(id);
    const value = this.validate(input, account.tool);
    const selectedId = input.catalogAccountId;
    const remote =
      account.tool === "codex" && value.pluginId?.endsWith(`@${remoteMarketplace}`);
    // Validate selection before acquiring ownership or changing shared configuration.
    catalogAccount(this, this.context(id), selectedId);
    if (this.locks.has(id))
      throw problem(serverMessages.plugins.operationAlreadyRunning, 409);
    this.locks.add(id);
    this.sharedProfiles?.busy.add(id);
    try {
      if (!remote) this.sharedProfiles?.migrate(id, { allowBusy: true });
      await Promise.all(
        [...this.readScopes]
          .filter(([, scope]) => scope.id === id)
          .map(([key]) => this.reads.get(key)),
      );
      const ctx = this.context(id);
      const selected = catalogAccount(this, ctx, selectedId);
      if (!ctx.command) throw problem(serverMessages.common.cliNotInstalled, 409);
      const list = await this.inventory(ctx, selected || ctx);
      const execution = remote ? selected : ctx;
      this.cache.set(selected ? JSON.stringify([id, selected.id]) : id, list);
      this.accounts.get(id);
      const { action, pluginId, source, marketplace } = value;
      if (action.startsWith("marketplace-")) {
        if (!list.capabilities.marketplaces)
          throw problem(serverMessages.plugins.marketplacesUnsupported, 409);
        if (action !== "marketplace-add") {
          const match = list.marketplaces.find((item) => item.name === marketplace);
          if (!match) throw problem(serverMessages.plugins.marketplaceNotFound, 404);
          if (
            match[action === "marketplace-remove" ? "removable" : "updatable"] === false
          )
            throw problem(serverMessages.plugins.detectedMarketplaceReadOnly, 409);
        }
      } else {
        if (action === "install" && !list.capabilities.install)
          throw problem(serverMessages.plugins.installationUnsupported, 409);
        if (
          (["enable", "disable"].includes(action) && !list.capabilities.enable) ||
          (action === "update" && !list.capabilities.update)
        )
          throw problem(serverMessages.plugins.actionUnsupported, 409);
        if (action === "install" && ctx.tool !== "opencode") {
          if (!list.catalog.some((item) => item.id === pluginId))
            throw problem(serverMessages.plugins.catalogPluginNotFound, 404);
          if (list.installed.some((item) => item.id === pluginId))
            throw problem(serverMessages.plugins.alreadyInstalled, 409);
        } else if (action !== "install") {
          const match = list.installed.find((item) => item.id === pluginId);
          if (!match) throw problem(serverMessages.plugins.notFound, 404);
          if (!match.removable) throw problem(serverMessages.plugins.readOnly, 409);
        }
      }
      if (ctx.tool === "opencode" && action === "remove") {
        this.removeOpenCode(ctx, pluginId);
      } else {
        let args;
        if (ctx.tool === "opencode") args = ["plugin", source, "--global"];
        else if (action.startsWith("marketplace-")) {
          const operation = action.slice(12);
          args = [
            "plugin",
            "marketplace",
            ctx.tool === "codex" && operation === "update" ? "upgrade" : operation,
            source || marketplace,
            ...(ctx.tool === "codex"
              ? ["--json"]
              : ["add", "remove"].includes(operation)
                ? ["--scope", "user"]
                : []),
          ];
        } else if (ctx.tool === "codex")
          args = ["plugin", action === "install" ? "add" : "remove", pluginId, "--json"];
        else
          args = [
            "plugin",
            action === "remove" ? "uninstall" : action,
            pluginId,
            "--scope",
            "user",
            ...(action === "remove" ? ["--keep-data"] : []),
          ];
        await this.execute(execution, args, true);
      }
      this.accounts.get(id);
      if (selected) this.accounts.get(selected.id);
      this.cache.clear();
      return {
        ok: true,
        message: serverMessages.plugins.configurationUpdated,
      };
    } finally {
      this.locks.delete(id);
      this.sharedProfiles?.busy.delete(id);
    }
  }
  removeOpenCode(ctx, id) {
    const { files, installed } = this.opencodeInventory(ctx);
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
    this.accounts.get(ctx.id);
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
  async close() {
    this.closed = true;
    for (const process of this.processes)
      process.cancel(serverMessages.plugins.shutdownCancelled);
    await Promise.allSettled([...this.processes].map((process) => process.completed));
  }
}
