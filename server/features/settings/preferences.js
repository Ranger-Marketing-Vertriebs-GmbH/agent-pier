import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readJSON, writePrivate, problem } from "../../lib/storage.js";

export class Preferences {
  constructor({ dataDir, home, accounts }) {
    this.accounts = accounts;
    this.home = home;
    this.file = path.join(dataDir, "preferences.json");
    const saved = readJSON(this.file, {});
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      (saved.defaultCwd !== undefined &&
        (typeof saved.defaultCwd !== "string" || !path.isAbsolute(saved.defaultCwd)))
    )
      throw problem(serverMessages.settings.invalidSavedPreferences);
    this.value = saved;
  }
  get() {
    const accounts = this.accounts?.list() || [];
    const defaultAccountIds = Object.fromEntries(
      Object.entries(this.value.defaultAccountIds || {}).filter(([tool, id]) =>
        accounts.some((account) => this.eligible(account, tool) && account.id === id),
      ),
    );
    return { defaultCwd: this.value.defaultCwd || this.home, defaultAccountIds };
  }
  eligible(account, tool) {
    return (
      ["codex", "claude", "opencode"].includes(tool) &&
      account.tool === tool &&
      ["local", "managed"].includes(account.kind) &&
      !account.provider &&
      !account.internal
    );
  }
  accountDefaults(changes) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes))
      throw problem("Invalid default account selection.");
    const next = { ...this.get().defaultAccountIds };
    for (const [tool, id] of Object.entries(changes)) {
      if (!["codex", "claude", "opencode"].includes(tool))
        throw problem("Default accounts require a coding CLI.");
      if (id === null) {
        delete next[tool];
        continue;
      }
      const account = this.accounts?.list().find((account) => account.id === id);
      if (!account || !this.eligible(account, tool))
        throw problem("Choose an existing native account for the selected CLI.");
      next[tool] = id;
    }
    return next;
  }
  async update(body) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["defaultCwd", "defaultAccountIds"].includes(key))
    )
      throw problem(serverMessages.settings.invalidPreferences);
    const defaultCwd = Object.hasOwn(body, "defaultCwd")
      ? await this.directory(body.defaultCwd)
      : undefined;
    // Merge after asynchronous path validation so concurrent preference writes survive.
    const next = { ...this.value };
    if (Object.hasOwn(body, "defaultAccountIds"))
      next.defaultAccountIds = this.accountDefaults(body.defaultAccountIds);
    if (defaultCwd !== undefined) next.defaultCwd = defaultCwd;
    writePrivate(this.file, next);
    this.value = next;
    return this.get();
  }
  async directory(value) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw problem(serverMessages.common.workingDirectoryRequired);
    const input =
      value === "~"
        ? this.home
        : value.startsWith("~/")
          ? path.join(this.home, value.slice(2))
          : value;
    if (!path.isAbsolute(input))
      throw problem(serverMessages.common.absoluteDirectoryRequired);
    let defaultCwd;
    try {
      defaultCwd = await fs.realpath(input);
      if (!(await fs.stat(defaultCwd)).isDirectory()) throw Error();
    } catch {
      throw problem(serverMessages.common.workingDirectoryUnavailable);
    }
    return defaultCwd;
  }
}
