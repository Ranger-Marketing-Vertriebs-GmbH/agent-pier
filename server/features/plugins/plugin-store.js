import { catalogAccount, catalogMetadata, remoteMarketplace } from "./codex-catalog.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { executePluginCommand } from "./plugin-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectTools } from "../accounts/account-store.js";
import { problem } from "../../lib/storage.js";
import {
  object,
  marketName,
  marketSource,
  safePath,
  selector,
  redacted,
  marketplaceRow,
  pluginRow,
} from "./plugin-schema.js";
import { cliDriver } from "../clis/drivers.js";
import { isCodingCli } from "../clis/catalog.js";
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
    // Called with the (resolved) account id when a plugin change starts or ends, so
    // its `busy` flag changes (assigned by the wiring: the live `job.plugins` topic).
    this.onChange = null;
  }
  /** Calls `onChange(id)`; a failing listener is logged, never thrown. */
  changed(id) {
    try {
      this.onChange?.(id);
    } catch {
      console.error("AgentPier could not announce a plugin change.");
    }
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
    const driver = cliDriver(account.tool);
    // The config root the profile starts with: its first native root, or the home one.
    const initialRoot =
      account.kind === "managed"
        ? path.join(cwd, driver.profileFiles.roots[0])
        : driver.configRoot({}, this.home);
    safePath(initialRoot, boundary);
    const env = this.accounts.environment(id);
    const root = driver.configRoot(env, env.HOME);
    safePath(root, boundary);
    for (const file of [
      ...driver.profileFiles.configFiles,
      ...driver.plugins.configFolders,
      ...(catalog ? driver.plugins.catalogFiles : []),
    ])
      if (
        catalog &&
        file === "plugins" &&
        this.sharedProfiles &&
        account.kind === "managed" &&
        fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        const expected = path.join(
          cliDriver("codex").configRoot({}, this.home),
          "plugins",
        );
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
      configArgs: this.accounts.codexCredentialArgs(id),
      command: this.resolveTool(account.tool, env),
    };
  }
  empty(ctx) {
    return {
      tool: ctx.tool,
      available: !!ctx.command,
      reason: ctx.command ? null : serverMessages.common.cliNotInstalled,
      note: serverMessages.plugins.restartRequiredNotice,
      noteCodes: ["restartRequired"],
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
  inventory(ctx, selected = ctx) {
    return cliDriver(ctx.tool).plugins.inventory(this, ctx, selected);
  }
  /** The inventory of a CLI that lists its plugins with `plugin list`. */
  async nativeInventory(ctx) {
    const result = this.empty(ctx);
    if (!ctx.command) return result;
    const { cliList } = cliDriver(ctx.tool).plugins;
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
      enable: cliList.enable,
      update: cliList.update,
      install: true,
    };
    // Builds `claudeMarketplaceRemovalNotice` or `codexActivationNotice` from the
    // CLI's `noteCode`; keep both keys in the server messages.
    result.note += serverMessages.plugins[`${cliList.noteCode}Notice`];
    result.noteCodes.push(cliList.noteCode);
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
    // A shell account is refused later, when its context is resolved.
    if (!isCodingCli(tool)) return { action, pluginId: selector(input.pluginId) };
    return cliDriver(tool).plugins.selection(action, input);
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
    this.changed(id);
    try {
      if (!remote) this.sharedProfiles?.migrate(id, { allowBusy: true });
      await Promise.all(
        [...this.readScopes]
          .filter(([, scope]) => scope.id === id)
          .map(([key]) => this.reads.get(key)),
      );
      const ctx = this.context(id);
      const { plugins } = cliDriver(ctx.tool);
      const selected = catalogAccount(this, ctx, selectedId);
      if (!ctx.command) throw problem(serverMessages.common.cliNotInstalled, 409);
      const list = await this.inventory(ctx, selected || ctx);
      const execution = remote ? selected : ctx;
      this.cache.set(selected ? JSON.stringify([id, selected.id]) : id, list);
      this.accounts.get(id);
      const { action, pluginId, marketplace } = value;
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
        if (action === "install" && plugins.catalogInstall) {
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
      if (plugins.removeFromConfig && action === "remove")
        plugins.removeFromConfig(ctx, pluginId, () => this.accounts.get(ctx.id));
      else await this.execute(execution, plugins.actionArgs(action, value), true);
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
      this.changed(id);
    }
  }
  async close() {
    this.closed = true;
    for (const process of this.processes)
      process.cancel(serverMessages.plugins.shutdownCancelled);
    await Promise.allSettled([...this.processes].map((process) => process.completed));
  }
}
